import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { TILESETS } from "../../lib/terrain/tilesets";
import { OBJECTS_SERVICE, TERRAIN_SERVICE, type ObjectsService, type TerrainEditorHandle, type TerrainToolGroupInstance } from "../../extensions/services";
import { TerrainToolRegistry } from "./toolhost";
import { h } from "../../workbench/dom";
import { decodeImage } from "../../lib/image/index.ts";
import { TEAM_COLORS, type Vec3 } from "../../lib/model/renderer";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { loadKind } from "../../lib/objects/metadata";
import { planCliffs, type CliffType } from "./cliffs";
import { loadSkins, ObjectLoader, placement, type Placed } from "./objects";
import type { Rgb } from "./minimap";
import { buildMinimap } from "./minimapgen";
import { Occupancy } from "./occupancy";
import { buildPathingMap, loadPathingData, type PathingData } from "./pathmap";
import { predictShadows } from "./shadowmap";
import { updateShadows } from "./shadows";
import { loadPlacedFile, newEntry, savePlacedFile, type PlacedFile } from "./placement";
import { BLIGHT_TEXTURE, TerrainRenderer, type Marker, type ObjectInstance } from "./renderer";
import { heightAt, parseW3e, writeW3e, type Terrain } from "../../lib/terrain/w3e";

const PATH = "map/war3map.w3e";
/** TEAM_COLORS index used for neutral players. */
const NEUTRAL = 20;


const KIND_LABELS: Record<string, string> = { w3u: "Unit", w3t: "Item", w3b: "Destructable", w3d: "Doodad" };

/** Custom object id → base id, from the project's object data (war3map.w3u.json, …). */
async function customBases(w3: W3Api): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of w3.workspace.files()) {
    if (!/^map\/war3map\.w3[utbd]\.json$/i.test(f.path)) continue;
    try {
      const j = JSON.parse(await w3.workspace.readText(f.path)) as { custom?: { id?: string; base: string }[] };
      for (const o of j.custom ?? []) if (o.id) out.set(o.id, o.base);
    } catch { /* unreadable: no custom ids */ }
  }
  return out;
}

/** Ground tile id → texture path, from TerrainArt\Terrain.slk. */
async function tilePaths(w3: W3Api): Promise<Map<string, string>> {
  return new Map([...(await tileCatalog(w3))].map(([id, t]) => [id, t.path]));
}

/** Every ground tile type the game knows: texture path and a readable name. */
async function tileCatalog(w3: W3Api): Promise<Map<string, { path: string; name: string }>> {
  const rows = parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk"));
  return new Map(rows.filter((r) => r.tileID).map((r) => [r.tileID, { path: `${r.dir}\\${r.file}.blp`, name: r.comment || r.file }]));
}

/** Maps hold at most this many ground tile types (World Editor limit). */
const MAX_GROUND_TILES = 16;

/** A game file, or the map's imported replacement of it. */
async function readFile(w3: W3Api, doc: EditorDocument, path: string): Promise<Uint8Array> {
  if (!doc.path.startsWith("game:") && w3.workspace.project()) {
    try { return await w3.workspace.readBytes(`map/${path.replace(/\\/g, "/")}`); } catch { /* use the game's */ }
  }
  return w3.game.read(path);
}

/** A ground tile texture. The map's own import wins; otherwise HD/DE modes use
 *  the Reforged "_Diffuse" texture (the plain name is the classic one). */
async function readGroundTexture(w3: W3Api, doc: EditorDocument, path: string): Promise<{ buf: Uint8Array; name: string }> {
  if (!doc.path.startsWith("game:") && w3.workspace.project()) {
    try { return { buf: await w3.workspace.readBytes(`map/${path.replace(/\\/g, "/")}`), name: path }; } catch { /* use the game's */ }
  }
  if ((w3.settings.get<string>("game.graphicsMode") ?? "hd") !== "sd") {
    const hd = path.replace(/\.\w+$/, "_Diffuse.blp");
    try { return { buf: await w3.game.read(hd), name: hd }; } catch { /* classic texture */ }
  }
  return { buf: await w3.game.read(path), name: path };
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const toolGroups = new TerrainToolRegistry();
  ctx.subscriptions.push(
    w3.services.provide(TERRAIN_SERVICE, toolGroups),
    w3.commands.register("w3.terrain.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      if (!w3.workspace.files().some((f) => f.path.toLowerCase() === PATH)) throw new Error("This project has no war3map.w3e.");
      await w3.editors.open(PATH, "w3.terrainViewer");
    }),

    // Activity bar entry (like the World Editor's terrain palette): map facts and
    // a way into the 3D view.
    w3.views.register("w3.terrain.overview", {
      render(el) {
        if (!w3.workspace.project()) {
          el.append(h("div.view-empty", {}, "Open or import a project to view its terrain."));
          return;
        }
        if (!w3.workspace.files().some((f) => f.path.toLowerCase() === PATH)) {
          el.append(h("div.view-empty", {}, "This project has no war3map.w3e."));
          return;
        }
        const open = () => w3.commands.execute("w3.terrain.open").catch((e) => w3.window.showError(String(e)));
        const facts = h("div.terrain-facts.muted", {}, "Reading terrain…");
        el.append(
          h("div.tree", {}, h("div.tree-row.obj-kind", { onclick: open, title: "F3" },
            h("span.tree-icon", {}, "›"), h("span.tree-label", {}, "Open 3D view"))),
          facts,
        );
        w3.workspace.readBytes(PATH).then((buf) => {
          const t = parseW3e(buf);
          facts.replaceChildren(
            h("div", {}, TILESETS[t.tileset] ?? `Tileset ${t.tileset}`),
            h("div", {}, `${t.width - 1} × ${t.height - 1} tiles · w3e v${t.version}`),
            h("div", {}, `Ground: ${t.groundTiles.join(", ")}`),
          );
        }).catch((e) => { facts.textContent = String((e as Error).message ?? e); });
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.terrain.overview")),

    w3.editors.registerProvider("w3.terrainViewer", {
      async resolve(el, doc) {
        let terrain: Terrain;
        /** The terrain as last saved: the baseline for updating shadows. */
        let savedW3e: Uint8Array;
        try {
          savedW3e = await doc.readBytes();
          terrain = parseW3e(savedW3e);
        } catch (e) {
          el.append(h("div.editor-error", {}, `Can't read ${doc.path}: ${(e as Error).message} `,
            h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
          return {};
        }
        const canvas = h("canvas.model-canvas");
        let renderer: TerrainRenderer;
        try {
          renderer = new TerrainRenderer(canvas, terrain);
        } catch (e) {
          el.append(h("div.editor-error", {}, `WebGL: ${(e as Error).message}`));
          return {};
        }
        let dirty = true;
        const redraw = () => { dirty = true; };

        // ---- editing ------------------------------------------------------------------
        const editable = !doc.readOnly;
        /** One undoable change: a terrain stroke or an object edit. */
        interface Edit { undo(): void; redo(): void; terrain: boolean; objects: boolean }
        /** Undo history; `at` edits are applied, `savedAt` matches the files. */
        const history: Edit[] = [];
        let at = 0, savedAt = 0;
        /** Set by every edit; the minimap is redrawn on the next save. */
        let minimapStale = false;
        /** Tool groups of other extensions, by group id. */
        const groupInsts = new Map<string, TerrainToolGroupInstance>();
        const notifyGroups = (e: Edit) => { for (const g of groupInsts.values()) g.changed?.({ terrain: e.terrain, objects: e.objects }); };
        const changed = (e: Edit) => {
          notifyGroups(e);
          minimapStale = true;
          occupancyPromise = null;
          if (e.terrain) { replanCliffs(); renderer.terrainChanged(); }
          if (e.objects) { objectsTouched = true; void rebuildObjects(); }
          doc.setDirty(at !== savedAt);
          redraw();
        };
        const undo = () => { if (at > 0) { const e = history[--at]; e.undo(); changed(e); } };
        const redo = () => { if (at < history.length) { const e = history[at++]; e.redo(); changed(e); } };
        const pushEdit = (e: Edit) => {
          notifyGroups(e);
          minimapStale = true;
          occupancyPromise = null;
          history.length = at;
          history.push(e);
          at = history.length;
          doc.setDirty(at !== savedAt);
        };
        const groundAt = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          return renderer.pickGround(renderer.ray(e.clientX - rect.left, e.clientY - rect.top));
        };
        /** A finished terrain stroke as one undo step; objects on the edited
         *  ground follow it (doodads with a fixed height, flag 4, keep theirs). */
        const commitTerrain = (st: { corners: number[]; undo(): void; redo(): void; cliffs?: boolean }) => {
          const follow = groundFollowers(st.corners);
          const setZ = (z: number[]) => follow.forEach((p, i) => { p.position = [p.position[0], p.position[1], z[i]]; });
          const zBefore = follow.map((p) => p.position[2]);
          const zAfter = follow.map((p) => heightAt(terrain, p.position[0], p.position[1]));
          const moved = zAfter.some((z, i) => Math.abs(z - zBefore[i]) > 0.01);
          pushEdit({
            undo: () => { st.undo(); if (moved) setZ(zBefore); },
            redo: () => { st.redo(); if (moved) setZ(zAfter); },
            terrain: true, objects: moved,
          });
          if (moved) { setZ(zAfter); objectsTouched = true; void rebuildObjects(); }
          if (st.cliffs) replanCliffs();
          renderer.terrainChanged();
          redraw();
        };

        // ---- side panel ---------------------------------------------------------
        const texList = h("div.model-list");
        const markerList = h("div.model-list");
        const status = (row: HTMLElement, cls: string, title?: string) => {
          row.firstElementChild!.className = `model-dot ${cls}`;
          if (title) row.title = title;
        };
        const texHeading = h("h4", {}, `Ground textures (${terrain.groundTiles.length})`);
        const groundFacts = h("div");
        /** Adds tile i's row to the side list and loads its texture. */
        const loadTile = (i: number, paths: Map<string, string>) => {
          const id = terrain.groundTiles[i], path = paths.get(id);
          const row = h("div.model-row", { title: path ?? id }, h("span.model-dot.pending", {}, "●"), h("span", {}, `${id} `), h("small.muted", {}, path?.split("\\").pop() ?? "unknown tile"));
          texList.append(row);
          texHeading.textContent = `Ground textures (${terrain.groundTiles.length})`;
          groundFacts.textContent = `${terrain.groundTiles.length} ground · ${terrain.cliffTiles.length} cliff textures`;
          if (!path) status(row, "missing");
          else readGroundTexture(w3, doc, path).then(({ buf, name }) => {
            renderer.setGroundTexture(i, decodeImage(buf, name).mip(0));
            row.title = name;
            status(row, "ok");
            redraw();
          }).catch((e) => status(row, "missing", `${path}: ${(e as Error).message ?? e}`));
        };
        // The tileset's blight texture (UI\WorldEditData.txt, [TileSets]: name,texture).
        w3.game.readText("UI\\WorldEditData.txt").then(async (text) => {
          const entry = parseIni(text).get("TileSets")?.get(terrain.tileset.toLowerCase());
          const path = entry?.split(",")[1]?.trim();
          if (!path) return;
          const { buf, name } = await readGroundTexture(w3, doc, `${path}.blp`);
          renderer.setGroundTexture(BLIGHT_TEXTURE, decodeImage(buf, name).mip(0));
          redraw();
        }).catch(() => { /* blight shows as the placeholder colour */ });
        tilePaths(w3).then((paths) => terrain.groundTiles.forEach((_, i) => loadTile(i, paths)))
          .catch((e) => texList.replaceChildren(h("div.model-warn", {}, `Terrain.slk: ${(e as Error).message ?? e}`)));
        const thumbCache = new Map<string, Promise<string | null>>();
        /** Data URL of a ground texture's first cell (the plain tile). */
        const tileThumb = (path: string) => {
          let p = thumbCache.get(path);
          if (!p) {
            p = readGroundTexture(w3, doc, path).then(({ buf, name }) => {
              const mip = decodeImage(buf, name).mip(0), cell = mip.height / 4;
              const full = document.createElement("canvas");
              full.width = mip.width; full.height = mip.height;
              full.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
              const out = document.createElement("canvas");
              out.width = out.height = 32;
              out.getContext("2d")!.drawImage(full, 0, 0, cell, cell, 0, 0, 32, 32);
              return out.toDataURL();
            }).catch(() => null);
            thumbCache.set(path, p);
          }
          return p;
        };
        /** Index of a ground tile type, adding it to the map's list if needed
         *  (null when the list is full). */
        const ensureTile = async (id: string): Promise<number | null> => {
          const have = terrain.groundTiles.indexOf(id);
          if (have >= 0) return have;
          if (terrain.groundTiles.length >= MAX_GROUND_TILES) {
            w3.window.showWarning(`This map already uses ${MAX_GROUND_TILES} ground tile types, the most a map can have.`);
            return null;
          }
          terrain.groundTiles.push(id);
          // The tile list no longer matches the tileset's default.
          terrain.customTilesets = true;
          terrain.customTilesetsRaw = 1;
          // A tile with its own cliff type adds that type (cliff indices follow the tile order).
          if (cliffData) {
            const ct = [...cliffData.types.values()].find((c) => c.groundTile === id);
            if (ct && !terrain.cliffTiles.includes(ct.cliffID)) terrain.cliffTiles.push(ct.cliffID);
          }
          const added = terrain.groundTiles.length - 1;
          // Load in the background so the stroke starts right away.
          void tilePaths(w3).then((paths) => loadTile(added, paths));
          minimapStale = true;
          return terrain.groundTiles.length - 1;
        };

        const markerToggle = (name: string, label: string, count: number) => {
          const box = h("input", { type: "checkbox", checked: !renderer.hiddenGroups.has(name), onchange: () => {
            if (box.checked) renderer.hiddenGroups.delete(name); else renderer.hiddenGroups.add(name);
            redraw();
          } });
          return h("label.model-row", {}, box, h("span", {}, ` ${label}`), h("small.muted", {}, ` ${count.toLocaleString()}`));
        };
        const problems = h("div.model-list");
        const texInfo = h("div.muted");
        const loader = new ObjectLoader(renderer.gl, (p) => readFile(w3, doc, p), () => {
          redraw();
          const n = loader.missing.size;
          const list = [...loader.missing].map(([p, e]) => `${p}: ${e}`);
          texInfo.replaceChildren(n ? `${n} model texture${n === 1 ? "" : "s"} not found` : "",
            ...list.slice(0, 3).map((l) => h("div.model-warn", { title: l }, l)));
          texInfo.title = list.join("\n");
        });
        const cliffInfo = h("div.muted", {}, "Loading cliffs…");
        /** Cliff types and the game's file list, once loaded. */
        let cliffData: { types: Map<string, CliffType>; exists: (p: string) => boolean } | null = null;
        /** Bumped per re-plan so a slow older one can't overwrite a newer one. */
        let cliffGen = 0;
        /** Places cliff models for the current layers (initially and after edits). */
        async function replanCliffs() {
          if (!cliffData) return;
          const gen = ++cliffGen;
          const { requests, groundOverrides } = planCliffs(terrain, cliffData.types, cliffData.exists);
          const { batches, failed } = await loader.loadModels("cliffs", requests);
          if (gen !== cliffGen) return;
          const broken = new Set(failed.map((f) => f.index));
          const others = renderer.batches.filter((b) => b.group !== "cliffs");
          renderer.batches.length = 0;
          renderer.batches.push(...others, ...batches.map((b) => ({ ...b, followGround: true })));
          renderer.setCliffTiles(new Set(requests.flatMap((r, i) => (broken.has(i) ? [] : r.tiles))), groundOverrides);
          const tiles = requests.reduce((n, r) => n + r.tiles.length, 0);
          cliffInfo.textContent = `${tiles.toLocaleString()} cliff tiles · ${requests.length} cliff models${failed.length ? ` · ${failed.length} failed` : ""}`;
          cliffInfo.title = failed.map((f) => f.error).join("\n");
          redraw();
        }
        Promise.all([w3.game.readText("TerrainArt\\CliffTypes.slk"), w3.game.list()]).then(async ([slk, list]) => {
          const types = new Map(parseSlk(slk).filter((r) => r.cliffID).map((r) => [r.cliffID, r as unknown as CliffType]));
          // Stored paths look like "War3.w3mod:_HD.w3mod:Doodads/…"; any layer will do.
          const files = new Set(list.map((p) => p.slice(p.lastIndexOf(":") + 1).toLowerCase()));
          cliffData = { types, exists: (p) => files.has(p.replace(/\\/g, "/").toLowerCase()) };
          await replanCliffs();
        }).catch((e) => { cliffInfo.textContent = `Cliffs: ${(e as Error).message ?? e}`; });

        // ---- placed objects -----------------------------------------------------------
        let dooFile: PlacedFile | null = null, unitsFile: PlacedFile | null = null;
        /** Doodads as last saved (shadow baseline, like savedW3e). */
        let savedDoodads: Placed[] | null = null;
        let objCtx: { skins: Awaited<ReturnType<typeof loadSkins>>; bases: Map<string, string> } | null = null;
        /** Set once an object was edited: the placement files are saved too. */
        let objectsTouched = false;
        const marker = (p: Placed, rgb: Vec3): Marker => ({ x: p.position[0], y: p.position[1], z: p.position[2], rgb });
        // Units take their player's colour; neutral players (24+) show as Coal.
        const team = (p: Placed) => (p.player !== undefined && p.player < TEAM_COLORS.length ? p.player : NEUTRAL);
        const NEUTRALS: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Extra", 26: "Neutral Victim", 27: "Neutral Passive" };
        const ownerName = (n: number) => (n < 24 ? `Player ${n + 1} (${TEAM_COLORS[n]?.[0] ?? "?"})` : NEUTRALS[n] ?? `Player ${n + 1}`);
        const findInstance = (entry: Placed): ObjectInstance | null => {
          for (const b of renderer.batches) for (const inst of b.instances) if (inst.pick?.placed === entry) return inst;
          return null;
        };
        /** Models for the current entries (initially and after object edits). */
        async function rebuildObjects() {
          if (!objCtx) return;
          const { skins, bases } = objCtx;
          const doodads = dooFile?.list ?? [], units = unitsFile?.list ?? [];
          markerList.replaceChildren(markerToggle("doodads", "Doodads", doodads.length), markerToggle("units", "Units & items", units.length));
          const baseOf = (id: string) => bases.get(id);
          const [d, u] = await Promise.all([loader.load("doodads", doodads, skins, () => 0, baseOf), loader.load("units", units, skins, team, baseOf)]);
          const others = renderer.batches.filter((b) => b.group !== "doodads" && b.group !== "units");
          renderer.batches.length = 0;
          renderer.batches.push(...others, ...d.batches, ...u.batches);
          // Objects without a model (start locations, unknown ids) stay markers.
          renderer.setMarkers("doodads", d.unresolved.map((p) => marker(p, [90, 200, 90])));
          renderer.setMarkers("units", u.unresolved.map((p) => marker(p, p.id === "sloc" ? [255, 255, 255] : TEAM_COLORS[team(p)][1])));
          const errors = [...d.errors, ...u.errors];
          problems.replaceChildren(...errors.slice(0, 20).map((e) => h("div.model-warn", { title: e }, e)),
            ...(errors.length > 20 ? [h("div.muted", {}, `… ${errors.length - 20} more`)] : []));
          // Keep the selection on the same entries.
          if (group.length) selectEntries(group.filter((p) => fileOf(p)));
          else {
            const entry = selected?.pick?.placed;
            const again = entry ? findInstance(entry) : null;
            if (again) selectObject(again); else if (selected) clearSelection();
          }
          redraw();
        }
        if (!doc.path.startsWith("game:") && w3.workspace.project()) {
          Promise.all([
            loadPlacedFile(w3, "war3map.doo", "doodads").catch(() => null),
            loadPlacedFile(w3, "war3mapUnits.doo", "units").catch(() => null),
            loadSkins(w3),
            customBases(w3),
          ]).then(async ([df, uf, skins, bases]) => {
            dooFile = df;
            savedDoodads = structuredClone(df?.list ?? []);
            unitsFile = uf;
            objCtx = { skins, bases };
            await rebuildObjects();
          });
        }
        const fileOf = (entry: Placed) => (dooFile?.list.includes(entry) ? dooFile : unitsFile?.list.includes(entry) ? unitsFile : null);
        /** Placed objects standing on the given corners' tiles that follow the
         *  ground: units, items and doodads without a fixed height (flag 4). */
        const groundFollowers = (corners: number[]): Placed[] => {
          if (!corners.length) return [];
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (const i of corners) {
            const cx = i % terrain.width, cy = Math.floor(i / terrain.width);
            x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
          }
          // Tiles next to a changed corner change too.
          const minX = terrain.offsetX + (x0 - 1) * 128, maxX = terrain.offsetX + (x1 + 1) * 128;
          const minY = terrain.offsetY + (y0 - 1) * 128, maxY = terrain.offsetY + (y1 + 1) * 128;
          const inside = (p: Placed) => p.position[0] >= minX && p.position[0] <= maxX && p.position[1] >= minY && p.position[1] <= maxY;
          const doodads = (dooFile?.list ?? []).filter((p) => !(((p as Placed & { flags?: number }).flags ?? 0) & 4));
          return [...doodads, ...(unitsFile?.list ?? [])].filter(inside);
        };
        /** Moves/turns an entry and its model in place (no rebuild). */
        const setPlacement = (entry: Placed, position: [number, number, number], angle: number) => {
          const inst = findInstance(entry);
          const dx = position[0] - entry.position[0], dy = position[1] - entry.position[1], dz = position[2] - entry.position[2];
          entry.position = position;
          entry.angle = angle;
          objectsTouched = true;
          if (inst?.pick) {
            inst.world = placement(entry, inst.pick.extraScale);
            if (inst.sphere) inst.sphere = [inst.sphere[0] + dx, inst.sphere[1] + dy, inst.sphere[2] + dz, inst.sphere[3]];
            if (inst === selected) selectObject(inst);
          }
          if (group.includes(entry)) groupRingsStale = true;
          redraw();
        };
        /** Group rings are rebuilt once per frame batch of moves, not per object. */
        let groupRingsStale = false;
        const refreshGroupRings = () => {
          if (!groupRingsStale) return;
          groupRingsStale = false;
          renderer.setSelection(group.map(findInstance).filter((i): i is ObjectInstance => !!i?.pick).map(ringOf));
        };
        type Pose = { position: [number, number, number]; angle: number };
        const poseOf = (p: Placed): Pose => ({ position: [...p.position] as [number, number, number], angle: p.angle });
        /** One undo step for moving/turning several entries. */
        const moveEdits = (entries: Placed[], before: Pose[]) => {
          const after = entries.map(poseOf);
          const apply = (poses: Pose[]) => { entries.forEach((e, i) => setPlacement(e, [...poses[i].position], poses[i].angle)); refreshGroupRings(); };
          pushEdit({ undo: () => apply(before), redo: () => apply(after), terrain: false, objects: false });
        };
        const deleteSelected = () => {
          // Each entry with its file and index, so undo restores the order.
          const items = selectedEntries().map((entry) => ({ entry, f: fileOf(entry)! })).filter((x) => x.f)
            .map((x) => ({ ...x, i: x.f.list.indexOf(x.entry) })).sort((a, b) => a.i - b.i);
          if (!items.length) return;
          const doIt = () => { for (const { entry, f } of items) f.list.splice(f.list.indexOf(entry), 1); };
          doIt();
          clearSelection();
          pushEdit({ undo: () => { for (const { entry, f, i } of items) f.list.splice(i, 0, entry); }, redo: doIt, terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Fields the selection panel edits. */
        type Props = Pick<Placed, "player" | "variation" | "scale" | "position" | "angle">;
        const snapshot = (e: Placed): Props => structuredClone({
          ...(e.player !== undefined ? { player: e.player } : {}), variation: e.variation, scale: e.scale, position: e.position, angle: e.angle,
        });
        const editProps = (entry: Placed, change: Partial<Props>) => {
          const before = snapshot(entry);
          Object.assign(entry, change);
          const after = snapshot(entry);
          pushEdit({ undo: () => Object.assign(entry, structuredClone(before)), redo: () => Object.assign(entry, structuredClone(after)), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        const rotateSelected = (deg: number) => {
          const entries = selectedEntries();
          if (!entries.length) return;
          const before = entries.map(poseOf);
          for (const e of entries) setPlacement(e, [...e.position], e.angle + (deg * Math.PI) / 180);
          moveEdits(entries, before);
        };
        /** Blocked ground and object footprints, built when placing needs it
         *  and dropped after any edit. */
        let occupancyPromise: Promise<Occupancy> | null = null;
        let pathingData: Promise<PathingData> | null = null;
        const occupancy = () => {
          occupancyPromise ??= (async () => {
            pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (id) => objCtx?.bases.get(id));
            const kindOf = (id: string) => (objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? ""))?.kind ?? "w3u";
            const placed = [
              ...(dooFile?.list ?? []).map((entry) => ({ entry, kind: "w3d" })),
              ...(unitsFile?.list ?? []).map((entry) => ({ entry, kind: kindOf(entry.id) === "w3t" ? "w3t" : "w3u" })),
            ];
            return Occupancy.build(terrain, await pathingData, placed);
          })();
          return occupancyPromise;
        };

        // ---- selection --------------------------------------------------------------
        const selInfo = h("div.terrain-selection.muted", {}, "Click a unit, item, doodad or destructable.");
        const row = (label: string, value: string) => h("div.terrain-sel-row", {}, h("span.muted", {}, label), h("span", {}, value));
        const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
        let selected: ObjectInstance | null = null;
        const selectObject = (inst: ObjectInstance) => {
          selected = inst;
          const p = inst.pick!, pl = p.placed;
          const iconEl = h("img.terrain-sel-icon", { alt: "", hidden: true });
          void w3.services.get<ObjectsService>(OBJECTS_SERVICE).then((s) => s.icon(p.kind, p.id))
            .then((src) => { if (src) { iconEl.src = src; iconEl.hidden = false; } }).catch(() => { /* no icon */ });
          const nameEl = h("div.terrain-sel-name", {}, p.id);
          loadKind(w3, p.kind).then((k) => {
            const base = k.names.get(p.base ?? p.id);
            if (base) nameEl.textContent = p.base ? `${p.id} (custom, based on ${base})` : base;
          }).catch(() => { /* raw id stays */ });
          const skin = objCtx?.skins.get(p.id) ?? objCtx?.skins.get(p.base ?? "");
          const numVar = skin?.numVar ?? 1;
          // Editable fields commit on Enter/blur; each change is one undo step.
          const num = (value: number, step: string, commit: (v: number) => void) =>
            h("input.terrain-sel-num", { type: "number", step, value: fmt(value), onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) commit(v);
            } });
          const triple = (values: number[], step: string, commit: (v: [number, number, number]) => void) =>
            h("span.terrain-sel-triple", {}, ...values.map((v, i) => num(v, step, (nv) => {
              const next = [...values] as [number, number, number];
              next[i] = nv;
              commit(next);
            })));
          const choice = (value: number, options: [number, string][], commit: (v: number) => void) => {
            if (!options.some(([v]) => v === value)) options.push([value, `#${value}`]);
            const sel = h("select", { onchange: () => commit(Number(sel.value)) },
              ...options.map(([v, label]) => h("option", { value: String(v), selected: v === value }, label)));
            return sel;
          };
          const field = (label: string, el: HTMLElement) => h("div.terrain-sel-row", {}, h("span.muted", {}, label), el);
          const ownerOptions = (): [number, string][] => Array.from({ length: 28 }, (_, i) => [i, ownerName(i)]);
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            h("div.terrain-sel-title", {}, iconEl, nameEl),
            row("Type", `${KIND_LABELS[p.kind] ?? p.kind} · ${p.id}${p.base ? ` ← ${p.base}` : ""}`),
            ...(editable ? [
              ...(pl.player !== undefined ? [field("Owner", choice(pl.player, ownerOptions(), (v) => editProps(pl, { player: v })))] : []),
              field("Position", triple(pl.position, "16", (v) => editProps(pl, { position: v }))),
              field("Facing", num((pl.angle * 180) / Math.PI, "15", (v) => editProps(pl, { angle: (v * Math.PI) / 180 }))),
              field("Scale", triple(pl.scale, "0.1", (v) => editProps(pl, { scale: v }))),
              numVar > 1
                ? field("Variation", choice(pl.variation, Array.from({ length: numVar }, (_, i) => [i, String(i)]), (v) => editProps(pl, { variation: v })))
                : row("Variation", String(pl.variation)),
            ] : [
              ...(pl.player !== undefined ? [row("Owner", ownerName(pl.player))] : []),
              row("Position", pl.position.map(fmt).join(", ")),
              row("Facing", `${fmt((pl.angle * 180) / Math.PI)}°`),
              row("Scale", pl.scale.map(fmt).join(", ")),
              row("Variation", String(pl.variation)),
            ]),
            row("Model", p.model),
            h("div.terrain-sel-actions", {},
              h("button", { onclick: () => w3.commands.execute("w3.objectEditor.open", p.kind, p.id).catch((e) => w3.window.showError(String(e))) }, "Open in Object Editor"),
              ...(editable ? [h("button", { title: "Delete (Del)", onclick: deleteSelected }, "Delete")] : [])),
            ...(editable ? [h("div.muted", {}, "Drag it to move · [ ] to turn · Del to delete")] : []),
          );
          const [x, y, , r] = inst.sphere!;
          renderer.setSelection({ x, y, r: Math.min(400, Math.max(40, r * 0.8)), rgb: pl.player !== undefined && pl.player < 24 ? TEAM_COLORS[pl.player][1] : [120, 255, 120] });
          redraw();
        };
        const clearSelection = () => {
          selected = null;
          group = [];
          selInfo.className = "terrain-selection muted";
          selInfo.replaceChildren("Click a unit, item, doodad or destructable, or drag a box around several.");
          renderer.setSelection(null);
          redraw();
        };

        /** Several selected objects (box or Ctrl+click); `selected` is then null. */
        let group: Placed[] = [];
        /** Object kinds a selection box picks up. */
        const boxKinds = new Set(["w3u", "w3t", "w3b", "w3d"]);
        const ringOf = (inst: ObjectInstance) => {
          const [x, y, , r] = inst.sphere!, pl = inst.pick!.placed;
          return { x, y, r: Math.min(400, Math.max(40, r * 0.8)), rgb: (pl.player !== undefined && pl.player < 24 ? TEAM_COLORS[pl.player][1] : [120, 255, 120]) as Vec3 };
        };
        /** Selects these entries: none clears, one shows its details, more a summary. */
        const selectEntries = (entries: Placed[]) => {
          const insts = entries.map(findInstance).filter((i): i is ObjectInstance => !!i?.pick);
          if (!insts.length) { clearSelection(); return; }
          if (insts.length === 1) { group = []; selectObject(insts[0]); return; }
          selected = null;
          group = insts.map((i) => i.pick!.placed);
          renderer.setSelection(insts.map(ringOf));
          // Summary: counts per type, most common first.
          const counts = new Map<string, { kind: string; id: string; n: number }>();
          for (const i of insts) {
            const key = `${i.pick!.kind}:${i.pick!.id}`;
            const c = counts.get(key) ?? { kind: i.pick!.kind, id: i.pick!.id, n: 0 };
            c.n++;
            counts.set(key, c);
          }
          const rows = [...counts.values()].sort((a, b) => b.n - a.n);
          const list = h("div.terrain-sel-list");
          const shown = rows.slice(0, 12);
          list.append(...shown.map((c) => {
            const name = h("span", {}, c.id);
            loadKind(w3, c.kind).then((k) => { const n = k.names.get(c.id) ?? k.names.get(objCtx?.bases.get(c.id) ?? ""); if (n) name.textContent = n; }).catch(() => { /* id */ });
            return h("div.terrain-sel-row", {}, h("span.muted", {}, `${c.n} ×`), name);
          }), ...(rows.length > shown.length ? [h("div.muted", {}, `… ${rows.length - shown.length} more types`)] : []));
          // Owner for all selected units at once.
          const units = group.filter((p) => p.player !== undefined && objCtx?.skins.get(p.id)?.kind !== "w3t");
          const ownerSel = units.length ? (() => {
            const first = units[0].player!, same = units.every((u) => u.player === first);
            const sel = h("select", { onchange: () => setGroupOwner(units, Number(sel.value)) },
              ...(same ? [] : [h("option", { value: "", selected: true }, "(mixed)")]),
              ...Array.from({ length: 28 }, (_, i) => h("option", { value: String(i), selected: same && i === first }, ownerName(i))));
            return sel;
          })() : null;
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            h("div.terrain-sel-name", {}, `${group.length} objects selected`),
            list,
            ...(editable && ownerSel ? [h("div.terrain-sel-row", {}, h("span.muted", {}, `Owner (${units.length})`), ownerSel)] : []),
            ...(editable ? [
              h("div.terrain-sel-actions", {}, h("button", { title: "Delete all selected (Del)", onclick: deleteSelected }, `Delete ${group.length}`)),
              h("div.muted", {}, "Drag one to move all · [ ] to turn each · Del to delete · Ctrl+click adds/removes · Shift+box adds"),
            ] : []),
          );
          redraw();
        };
        const setGroupOwner = (units: Placed[], player: number) => {
          const before = units.map((u) => u.player);
          const apply = (v: (number | undefined)[]) => units.forEach((u, i) => { u.player = v[i]; });
          apply(units.map(() => player));
          pushEdit({ undo: () => apply(before), redo: () => apply(units.map(() => player)), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Entries currently selected (one or many). */
        const selectedEntries = (): Placed[] => (group.length ? group : selected?.pick ? [selected.pick.placed] : []);

        /** Objects whose position projects into the canvas rectangle (CSS pixels). */
        const objectsInBox = (x0: number, y0: number, x1: number, y1: number): Placed[] => {
          const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
          const out: Placed[] = [];
          for (const b of renderer.batches) {
            if ((b.group !== "doodads" && b.group !== "units") || renderer.hiddenGroups.has(b.group)) continue;
            for (const inst of b.instances) {
              if (!inst.pick || !boxKinds.has(inst.pick.kind)) continue;
              const s = renderer.project(inst.pick.placed.position);
              if (s && s[0] >= ax && s[0] <= bx && s[1] >= ay && s[1] <= by) out.push(inst.pick.placed);
            }
          }
          return out;
        };

        const pickAt = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          const ray = renderer.ray(e.clientX - rect.left, e.clientY - rect.top);
          const inst = renderer.pickObject(ray);
          // Ctrl+click adds or removes an object.
          if (e.ctrlKey || e.metaKey) {
            if (!inst?.pick) return;
            const cur = selectedEntries(), entry = inst.pick.placed;
            selectEntries(cur.includes(entry) ? cur.filter((p) => p !== entry) : [...cur, entry]);
            return;
          }
          // The ground isn't selectable; it's edited with brushes.
          if (inst) { group = []; selectObject(inst); } else clearSelection();
        };

        const tiles = `${terrain.width - 1} × ${terrain.height - 1}`;
        const side = h("div.model-side", {},
          h("h3", {}, TILESETS[terrain.tileset] ?? `Tileset ${terrain.tileset}`),
          h("div.model-facts", {},
            h("div", {}, `w3e v${terrain.version} · ${tiles} tiles`),
            groundFacts,
            cliffInfo, texInfo,
          ),
          texHeading, texList,
          h("h4", {}, "Selection"), selInfo,
          h("h4", {}, "Placed objects"), markerList, problems,
        );

        function selectBar() {
          // Which kinds a selection box picks up.
          return h("div.terrain-group-tools", {},
            h("span.terrain-tool-opt", { title: "Kinds of objects a selection box picks up" }, "Box selects:",
              ...([["w3u", "Units"], ["w3t", "Items"], ["w3b", "Destructables"], ["w3d", "Doodads"]] as const).map(([k, label]) => {
                const cb = h("input", { type: "checkbox", checked: boxKinds.has(k), onchange: () => { if (cb.checked) boxKinds.add(k); else boxKinds.delete(k); canvas.focus(); } });
                return h("label.terrain-place-opt", {}, cb, ` ${label}`);
              })),
            h("span.muted", {}, "Click to select · drag a box · Ctrl+click adds/removes · drag a selected object to move · [ ] turn · Del delete"));
        }

        // ---- tool groups of other extensions ("w3.terrain") --------------------------
        /** wpm bytes (header + cells): applies every group's pathing filter. */
        const filterPathing = (wpm: Uint8Array) => {
          const v = new DataView(wpm.buffer, wpm.byteOffset);
          const w = v.getUint32(8, true), hgt = v.getUint32(12, true);
          for (const g of groupInsts.values()) g.filterPathing?.(wpm.subarray(16), w, hgt);
        };
        /** Latest ghost request (older model loads are dropped). */
        let ghostReq = 0;
        /** File each created entry goes to (set by objects.create). */
        const entryFile = new WeakMap<Placed, PlacedFile>();
        const handle: TerrainEditorHandle = {
          terrain, editable, redraw, host: el,
          terrainChanged: () => { renderer.terrainChanged(); doc.setDirty(true); redraw(); },
          commitTerrain,
          ensureGroundTile: (id) => ensureTile(id),
          groundTileThumb: async (id) => {
            const path = (await tilePaths(w3)).get(id);
            return path ? tileThumb(path) : null;
          },
          objects: {
            type: (id) => {
              const skin = objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? "");
              return skin ? { kind: skin.kind, numVar: skin.numVar, randScale: skin.randScale, minScale: skin.minScale, maxScale: skin.maxScale, fixedRot: skin.fixedRot } : null;
            },
            create: (kind, id, at) => {
              const f = kind === "w3u" || kind === "w3t" ? unitsFile : dooFile;
              if (!f) return `This project has no ${kind === "w3u" || kind === "w3t" ? "war3mapUnits.doo" : "war3map.doo"}.`;
              const entry = newEntry(f, id, [at.x, at.y, heightAt(terrain, at.x, at.y)], at.player);
              if (!entry) return `${f.name} has no entries to take the layout from yet.`;
              entry.angle = at.angle;
              entryFile.set(entry, f);
              return entry;
            },
            insert: (entries) => {
              for (const e of entries) { const f = entryFile.get(e as Placed); if (f && !f.list.includes(e as Placed)) f.list.push(e as Placed); }
              objectsTouched = true;
              void rebuildObjects();
            },
            remove: (entries) => {
              for (const e of entries) { const f = entryFile.get(e as Placed) ?? fileOf(e as Placed); const i = f?.list.indexOf(e as Placed) ?? -1; if (i >= 0) f!.list.splice(i, 1); }
              objectsTouched = true;
              void rebuildObjects();
            },
            setGhost: (g) => {
              ghostReq++;
              if (!g) { renderer.ghost = null; redraw(); return; }
              const skin = objCtx?.skins.get(g.id) ?? objCtx?.skins.get(objCtx.bases.get(g.id) ?? "");
              if (!skin) { renderer.ghost = null; redraw(); return; }
              const req = ghostReq;
              const entry = { id: g.id, variation: g.variation ?? 0, position: [g.x, g.y, heightAt(terrain, g.x, g.y)] as [number, number, number], angle: g.angle, scale: [1, 1, 1] as [number, number, number], player: g.player };
              void loader.modelFor(skin, entry.variation).then((gpu) => {
                if (req !== ghostReq) return;
                renderer.ghost = { gpu, world: placement(entry, skin.modelScale), team: g.player !== undefined && g.player < TEAM_COLORS.length ? g.player : NEUTRAL, ok: g.ok };
                redraw();
              }).catch(() => { renderer.ghost = null; redraw(); });
            },
            occupancy: async () => {
              const occ = await occupancy();
              return {
                footprint: async (kind, id) => { const fp = await occ.footprint(id, kind); return fp && { width: fp.width, height: fp.height }; },
                fits: async (kind, id, x, y, angle) => { const fp = await occ.footprint(id, kind); return !fp || occ.fits(fp, x, y, angle); },
                mark: async (kind, id, x, y, angle) => { const fp = await occ.footprint(id, kind); if (fp) occ.mark(fp, x, y, angle); },
              };
            },
          },
          pushEdit: (e) => pushEdit(e),
          setBrush: (r) => { renderer.setBrush(r); redraw(); },
          setGroundOverlay: (rgba, w, hgt) => { renderer.setGroundOverlay(rgba, w, hgt); redraw(); },
          pathing: async (opts) => {
            const doodads = dooFile?.list ?? [];
            const { wpm } = await buildPathingMap(w3, terrain, doodads, (p) => readFile(w3, doc, p), w3.settings.get<number>("terrain.pathing.deepWater"));
            if (opts?.filtered !== false) filterPathing(wpm);
            const v = new DataView(wpm.buffer, wpm.byteOffset);
            return { cells: wpm.slice(16), width: v.getUint32(8, true), height: v.getUint32(12, true) };
          },
          focus: () => canvas.focus(),
        };
        const tabsEl = h("div.terrain-tabs");
        const builtinBar = selectBar();
        const groupBar = h("div.model-toolbar.terrain-tools", {}, builtinBar);
        /** The active tab: null = the built-in tools. */
        let activeGroup: string | null = null;
        /** A drag taken by the active group's pointerDown. */
        let groupDrag = false;
        const activeInst = () => (activeGroup ? groupInsts.get(activeGroup) ?? null : null);
        const showTab = (id: string | null) => {
          if (id === activeGroup) return;
          activeInst()?.deactivate?.();
          activeGroup = id;
          const inst = activeInst();
          groupBar.replaceChildren(inst ? inst.toolbar : builtinBar);
          renderer.setBrush(null);
          inst?.activate?.();
          renderTabs();
          redraw();
        };
        const renderTabs = () => {
          const tab = (id: string | null, title: string) =>
            h(`button.terrain-tab${id === activeGroup ? ".on" : ""}`, { onclick: () => showTab(id) }, title);
          tabsEl.replaceChildren(tab(null, "Select"), ...toolGroups.all().filter((g) => groupInsts.has(g.id)).map((g) => tab(g.id, g.title)),
            h("span.terrain-tabs-gap"),
            h("button", { title: "Undo (Ctrl+Z)", onclick: undo }, "↶"),
            h("button", { title: "Redo (Ctrl+Y)", onclick: redo }, "↷"));
        };
        const syncGroups = () => {
          const wanted = new Set(toolGroups.all().map((g) => g.id));
          for (const [id, inst] of groupInsts) {
            if (wanted.has(id)) continue;
            if (activeGroup === id) showTab(null);
            inst.dispose?.();
            groupInsts.delete(id);
          }
          for (const g of toolGroups.all()) {
            if (groupInsts.has(g.id)) continue;
            try { groupInsts.set(g.id, g.create(handle)); } catch (e) { w3.window.showError(`${g.title}: ${(e as Error).message ?? e}`); }
          }
          renderTabs();
        };
        const stopGroups = toolGroups.onChange(syncGroups);
        if (editable) queueMicrotask(syncGroups);

        const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
          const box = h("input", { type: "checkbox", checked: get(), onchange: () => { set(box.checked); redraw(); } });
          return h("label.model-toggle", {}, box, ` ${label}`);
        };
        el.append(h("div.model-viewer", {},
          h("div.model-main", {},
            h("div.model-toolbar", {},
              toggle("Water", () => renderer.showWater, (v) => { renderer.showWater = v; }),
              toggle("Tile grid", () => renderer.wireframe, (v) => { renderer.wireframe = v; }),
              toggle("Cliffs", () => !renderer.hiddenGroups.has("cliffs"), (v) => { if (v) renderer.hiddenGroups.delete("cliffs"); else renderer.hiddenGroups.add("cliffs"); }),
              h("button", { title: "Reset camera", onclick: () => resetCamera() }, "⟲"),
              h("span.muted", {}, "Drag: select box · Middle-drag or arrow keys: pan · Right-drag: rotate · Wheel: zoom")),
            ...(editable ? [tabsEl, groupBar] : []),
            h("div.model-stage", {}, canvas)),
          side));

        // ---- camera ------------------------------------------------------------------
        const initial = { yaw: renderer.yaw, pitch: renderer.pitch, distance: renderer.distance };
        const resetCamera = () => { Object.assign(renderer, initial, { target: [...renderer.center] }); redraw(); };
        /** Moves the target over the ground by screen pixels, in the camera's facing. */
        const pan = (dx: number, dy: number) => {
          const s = renderer.distance / Math.max(1, canvas.clientHeight) * 0.9;
          const cy = Math.cos(renderer.yaw), sy = Math.sin(renderer.yaw);
          // The ground follows the pointer: right = (-sin, cos), forward = (-cos, -sin).
          renderer.target[0] += (sy * dx - cy * dy) * s;
          renderer.target[1] += (-cy * dx - sy * dy) * s;
          redraw();
        };
        let drag: { x: number; y: number; button: number } | null = null;
        /** Selected objects being dragged: offsets follow the pointer from `anchor`. */
        let objDrag: { entries: Placed[]; before: Pose[]; anchor: Vec3; moved: boolean } | null = null;
        /** A selection box being dragged (canvas CSS pixels). */
        let box: { x0: number; y0: number; x1: number; y1: number; add: boolean; shown: boolean } | null = null;
        const boxEl = h("div.terrain-select-box", { hidden: true });
        el.append(boxEl);
        const showBox = () => {
          if (!box) { boxEl.hidden = true; return; }
          const rect = canvas.getBoundingClientRect();
          Object.assign(boxEl.style, {
            left: `${rect.left + Math.min(box.x0, box.x1)}px`, top: `${rect.top + Math.min(box.y0, box.y1)}px`,
            width: `${Math.abs(box.x1 - box.x0)}px`, height: `${Math.abs(box.y1 - box.y0)}px`,
          });
          boxEl.hidden = !box.shown;
        };
        canvas.tabIndex = 0;
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        /** Where the left button went down; a release close by is a click (select). */
        let press: { x: number; y: number } | null = null;
        canvas.addEventListener("mousedown", (e) => {
          canvas.focus();
          const gi = activeInst();
          if (gi && e.button === 0 && gi.pointerDown?.({ ground: groundAt(e), event: e, down: false })) {
            e.preventDefault();
            groupDrag = true;
            return;
          }
          if (e.button === 0) {
            const rect = canvas.getBoundingClientRect();
            const inst = editable && !e.ctrlKey && !e.shiftKey ? renderer.pickObject(renderer.ray(e.clientX - rect.left, e.clientY - rect.top)) : null;
            // Dragging a selected object moves the whole selection.
            const entries = selectedEntries();
            const anchor = inst?.pick && entries.includes(inst.pick.placed) ? groundAt(e) : null;
            if (anchor) {
              objDrag = { entries, before: entries.map(poseOf), anchor, moved: false };
              return;
            }
            // Otherwise a click selects, a drag draws a selection box (pan: middle button or arrow keys).
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            box = { x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, shown: false };
            press = { x: e.clientX, y: e.clientY };
            return;
          }
          if (e.button === 1) e.preventDefault();
          drag = { x: e.clientX, y: e.clientY, button: e.button };
          press = null;
        });
        canvas.addEventListener("mousemove", (e) => {
          activeInst()?.pointerMove?.({ ground: groundAt(e), event: e, down: groupDrag });
          if (groupDrag) return;
          if (objDrag) {
            const p = groundAt(e);
            if (p) {
              objDrag.moved = true;
              const dx = p[0] - objDrag.anchor[0], dy = p[1] - objDrag.anchor[1];
              objDrag.entries.forEach((entry, i) => {
                const [x, y] = objDrag!.before[i].position;
                setPlacement(entry, [x + dx, y + dy, heightAt(terrain, x + dx, y + dy)], entry.angle);
              });
              refreshGroupRings();
            }
            return;
          }
          if (drag) return;
        });
        canvas.addEventListener("mouseleave", () => { if (!groupDrag) activeInst()?.pointerLeave?.(); });
        canvas.addEventListener("mouseup", (e) => {
          if (e.button === 0 && press && !box?.shown) pickAt(e);
          press = null;
        });
        // Arrow keys scroll like in the World Editor.
        canvas.addEventListener("keydown", (e) => {
          if (activeInst()?.keyDown?.(e)) { e.preventDefault(); return; }
          const step = canvas.clientHeight / 6;
          if (e.key === "Escape") { clearSelection(); return; }
          if (editable && selectedEntries().length && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelected(); return; }
          if (editable && selectedEntries().length && (e.key === "[" || e.key === "]")) { e.preventDefault(); rotateSelected(e.key === "[" ? 15 : -15); return; }
          if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
          if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
          const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (!d) return;
          e.preventDefault();
          pan(d[0], d[1]);
        });
        const onMove = (e: MouseEvent) => {
          if (box) {
            const rect = canvas.getBoundingClientRect();
            box.x1 = e.clientX - rect.left;
            box.y1 = e.clientY - rect.top;
            if (Math.hypot(box.x1 - box.x0, box.y1 - box.y0) >= 4) box.shown = true;
            showBox();
            return;
          }
          if (!drag) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.x = e.clientX; drag.y = e.clientY;
          if (drag.button === 0 || drag.button === 1) {
            pan(dx, dy);
          } else {
            renderer.yaw -= dx * 0.01;
            renderer.pitch = Math.max(0.15, Math.min(1.55, renderer.pitch + dy * 0.01));
          }
          redraw();
        };
        const onUp = (e: MouseEvent) => {
          if (groupDrag) {
            groupDrag = false;
            activeInst()?.pointerUp?.({ ground: groundAt(e), event: e, down: false });
            return;
          }
          drag = null;
          if (objDrag?.moved) moveEdits(objDrag.entries, objDrag.before);
          objDrag = null;
          if (box?.shown) {
            const found = objectsInBox(box.x0, box.y0, box.x1, box.y1);
            const base = box.add ? selectedEntries() : [];
            selectEntries([...base, ...found.filter((p) => !base.includes(p))]);
          }
          box = null;
          showBox();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        canvas.addEventListener("wheel", (e) => {
          e.preventDefault();
          renderer.distance = Math.max(200, Math.min(renderer.terrain.width * 300, renderer.distance * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
          redraw();
        }, { passive: false });

        // Static scene: draw only when something changed (or the size did).
        let raf = 0, lastSize = "";
        const tick = () => {
          const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
          if (canvas.clientWidth > 0 && (dirty || size !== lastSize)) {
            renderer.render();
            dirty = false;
            lastSize = size;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        return {
          save: editable ? async () => {
            const w3e = writeW3e(terrain);
            await doc.writeBytes(w3e);
            if (objectsTouched) {
              for (const f of [dooFile, unitsFile]) if (f) await savePlacedFile(w3, f);
            }
            savedAt = at;
            doc.setDirty(false);
            const doodads = dooFile?.list ?? (await loadPlacedFile(w3, "war3map.doo", "doodads").catch(() => null))?.list ?? [];
            const rf = (p: string) => readFile(w3, doc, p);
            const cfg = <T,>(key: string) => w3.settings.get<T>(`terrain.${key}`);
            // The pathing map follows terrain and doodads.
            if (cfg<boolean>("pathing.regenerate")) try {
              const { wpm, missing } = await buildPathingMap(w3, terrain, doodads, rf, cfg<number>("pathing.deepWater"));
              filterPathing(wpm);
              await w3.workspace.writeBytes("map/war3map.wpm", wpm);
              if (missing.length) w3.window.showWarning(`Pathing map: no pathing texture for ${missing.join(", ")}; those doodads don't block.`);
            } catch (e) {
              w3.window.showError(`The pathing map (war3map.wpm) couldn't be regenerated: ${(e as Error).message ?? e}`);
            }
            // Shadows: only cells whose prediction changed since the last save.
            if (cfg<boolean>("shadows.update")) try {
              const skins = objCtx?.skins ?? new Map(), baseOf = (id: string) => objCtx?.bases.get(id);
              const sun = { azimuth: cfg<number>("shadows.sunAzimuth"), elevation: cfg<number>("shadows.sunElevation") };
              const before = await predictShadows(parseW3e(savedW3e), savedDoodads ?? doodads, skins, baseOf, rf, sun);
              const after = await predictShadows(terrain, doodads, skins, baseOf, rf, sun);
              const stored = await w3.workspace.readBytes("map/war3map.shd").catch(() => null);
              const shd = updateShadows(stored, before, after);
              if (!stored || shd.some((v, i) => v !== stored[i])) await w3.workspace.writeBytes("map/war3map.shd", shd);
            } catch (e) {
              w3.window.showError(`The shadow map (war3map.shd) couldn't be updated: ${(e as Error).message ?? e}`);
            }
            // The minimap is redrawn when something changed since the last save (by default).
            const minimapMode = cfg<string>("minimap.regenerate");
            if (minimapMode === "always" || (minimapMode !== "never" && minimapStale)) {
              try {
                const params = {
                  groundBrightness: cfg<number>("minimap.groundBrightness"),
                  waterShallowColor: cfg<Rgb>("minimap.waterShallowColor"),
                  waterDeepColor: cfg<Rgb>("minimap.waterDeepColor"),
                  waterOpacityShallow: cfg<number>("minimap.waterOpacityShallow"),
                  waterOpacityDeep: cfg<number>("minimap.waterOpacityDeep"),
                  waterFullDepth: cfg<number>("minimap.waterFullDepth"),
                  objectRadius: cfg<number>("minimap.objectRadius"),
                  blurPasses: cfg<number>("minimap.blurPasses"),
                };
                await w3.workspace.writeBytes("map/war3mapMap.blp", await buildMinimap(w3, terrain, doodads, rf, params, cfg<number>("minimap.jpegQuality")));
                minimapStale = false;
              } catch (e) {
                w3.window.showError(`The minimap (war3mapMap.blp) couldn't be regenerated: ${(e as Error).message ?? e}`);
              }
            }
            savedW3e = w3e;
            savedDoodads = structuredClone(doodads);
            for (const g of groupInsts.values()) {
              await g.save?.().catch((e) => w3.window.showError(`Saving failed: ${(e as Error).message ?? e}`));
            }
          } : undefined,
          focus: () => canvas.focus(),
          dispose: () => {
            stopGroups();
            for (const g of groupInsts.values()) g.dispose?.();
            cancelAnimationFrame(raf);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            renderer.dispose();
          },
        };
      },
    }),
  );
}
