import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { TILESETS } from "../../lib/terrain/tilesets";
import { OBJECTS_SERVICE, TERRAIN_SERVICE, type ObjectsService, type TerrainEditorHandle, type TerrainToolGroupInstance } from "../../extensions/services";
import { TerrainToolRegistry } from "./toolhost";
import { h } from "../../workbench/dom";
import { decodeImage } from "../../lib/image/index.ts";
import { TEAM_COLORS, type Vec3 } from "../../lib/model/renderer";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { loadKind } from "../../lib/objects/metadata";
import { cliffList, planCliffs, type CliffType } from "./cliffs";
import { loadSkins, ObjectLoader, placement, type Placed } from "./objects";
import { buildMinimap, minimapSettings } from "./minimapgen";
import { askNewMap, createMap, type NewMapPreset } from "./newmap";
import { compileExpr, compileFilter, evalFor, type ObjVars } from "./massedit";
import { Occupancy } from "./occupancy";
import { buildPathingMap, loadPathingData, type PathingData } from "./pathmap";
import { predictShadows } from "./shadowmap";
import { updateShadows } from "./shadows";
import { loadPlacedFile, newEntry, savePlacedFile, type PlacedFile } from "./placement";
import { BLIGHT_TEXTURE, TerrainRenderer, type Marker, type ObjectInstance } from "./renderer";
import { heightAt, parseW3e, writeW3e, type Terrain } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath, writeTerrainBytes } from "../../lib/terrain/w3etext";
import { startLocations, syncPlayers, type PlayerInfo } from "../../lib/terrain/startlocations";
import { cameraBounds, playableSize, resizeGrid, resizeProblem, resizeTerrain, worldRect, type Sides } from "../../lib/terrain/resize";

/** The project's terrain file (binary war3map.w3e or text war3map.w3e.txt), or null. */
const projectTerrain = (w3: W3Api) => terrainPath(w3.workspace.files().map((f) => f.path));
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
  // A campaign's chapter map (…/maps/<file>) also uses the campaign's custom objects.
  const root = w3.workspace.project()?.root;
  const campaign = root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root)?.[1] : undefined;
  if (campaign) {
    for (const k of ["w3u", "w3t", "w3b", "w3d"]) {
      try {
        const j = JSON.parse(await w3.workspace.readText(`${campaign}\\map\\war3campaign.${k}.json`)) as { custom?: { id?: string; base: string }[] };
        for (const o of j.custom ?? []) if (o.id && !out.has(o.id)) out.set(o.id, o.base);
      } catch { /* no campaign object data of this kind */ }
    }
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
  const toolGroups = new TerrainToolRegistry(() => w3.commands.execute("w3.terrain.open").then(() => undefined));
  ctx.subscriptions.push(
    w3.services.provide(TERRAIN_SERVICE, toolGroups),
    w3.commands.register("w3.terrain.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      const path = projectTerrain(w3);
      if (!path) throw new Error("This project has no war3map.w3e.");
      await w3.editors.open(path, "w3.terrainViewer");
    }),
    // Shows a world point in the terrain editor (opening it first); used by the Object Manager.
    w3.commands.register("w3.terrain.showPoint", async (x?: number, y?: number) => {
      if (typeof x !== "number" || typeof y !== "number") return w3.commands.execute("w3.terrain.open");
      toolGroups.pendingLook = [x, y];
      await w3.commands.execute("w3.terrain.open");
      if (toolGroups.look && toolGroups.pendingLook) { toolGroups.look(x, y); toolGroups.pendingLook = null; }
    }),
    // `opts` (other extensions): dialog preset, and a step before the map is created (and opened).
    w3.commands.register("w3.map.new", async (opts?: NewMapPreset & { beforeCreate?(o: { dir: string; name: string }): Promise<void> }) => {
      const o = await askNewMap(w3, opts ?? {});
      if (!o) return null;
      // The new map opens as the project: unsaved changes are settled first.
      if (!(await w3.editors.closeAllAsking())) return null;
      await opts?.beforeCreate?.(o);
      await w3.window.withProgress(`Creating ${o.name}…`, () => createMap(w3, o));
      return o.dir;
    }),

    // Activity bar entry (like the World Editor's terrain palette): map facts and
    // a way into the 3D view.
    w3.views.register("w3.terrain.overview", {
      render(el) {
        if (!w3.workspace.project()) {
          el.append(h("div.view-empty", {}, "Open or import a project to view its terrain."));
          return;
        }
        const path = projectTerrain(w3);
        if (!path) {
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
        readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }).then((buf) => {
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
          savedW3e = await readTerrainBytes(doc.path, doc);
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
          if (!path) { status(row, "missing"); return; }
          let img = tileImages.get(id);
          if (!img) {
            img = readGroundTexture(w3, doc, path).then(({ buf, name }) => ({ img: decodeImage(buf, name).mip(0), name }));
            tileImages.set(id, img);
          }
          img.then(({ img: mip, name }) => {
            // The list may have changed meanwhile; only the current index gets it.
            if (terrain.groundTiles[i] !== id) return;
            renderer.setGroundTexture(i, mip);
            row.title = name;
            status(row, "ok");
            redraw();
          }).catch((e) => status(row, "missing", `${path}: ${(e as Error).message ?? e}`));
        };
        /** Decoded ground textures by tile id. */
        const tileImages = new Map<string, Promise<{ img: ReturnType<ReturnType<typeof decodeImage>["mip"]>; name: string }>>();
        /** Rebuilds the side list and the renderer's textures after the tile list changed. */
        const syncTileList = async () => {
          texList.replaceChildren();
          const paths = await tilePaths(w3);
          terrain.groundTiles.forEach((_, i) => loadTile(i, paths));
        };

        /** Changes the map's ground tile list: `tiles` is the new list, `map`
         *  gives each old index's new index. Corners and cliff types are
         *  remapped; one undo step. */
        const changeTileList = (tiles: string[], map: (oldIndex: number) => number) => {
          const snap = () => ({
            ground: [...terrain.groundTiles], cliffs: [...terrain.cliffTiles], custom: terrain.customTilesetsRaw,
            tex: terrain.corners.map((c) => c.texture), ctex: terrain.corners.map((c) => c.cliffTexture),
          });
          const restore = (v: ReturnType<typeof snap>) => {
            terrain.groundTiles = [...v.ground];
            terrain.cliffTiles = [...v.cliffs];
            terrain.customTilesetsRaw = v.custom;
            terrain.customTilesets = v.custom !== 0;
            terrain.corners.forEach((c, i) => { c.texture = v.tex[i]; c.cliffTexture = v.ctex[i]; });
            void syncTileList();
          };
          const before = snap();
          // Cliff types follow the ground tile order (see cliffs.ts).
          const types = cliffData?.types ?? new Map<string, CliffType>();
          const oldCliffs = cliffList(terrain, types);
          terrain.groundTiles = [...tiles];
          const newCliffs = cliffList(terrain, types);
          for (const c of terrain.corners) {
            c.texture = map(c.texture);
            if (c.cliffTexture < 15 && oldCliffs.length) {
              const type = oldCliffs[c.cliffTexture];
              const ni = type ? newCliffs.indexOf(type) : -1;
              // A removed tile's cliffs take the replacement's cliff type (or the first).
              c.cliffTexture = ni >= 0 ? ni : Math.max(0, newCliffs.findIndex((t) => t.groundTile === tiles[c.texture]));
            }
          }
          // Stored cliff list: the derived order first, then entries no tile uses.
          const derived = newCliffs.map((t) => t.cliffID);
          terrain.cliffTiles = [...derived, ...before.cliffs.filter((id) => !derived.includes(id) && !oldCliffs.some((t) => t.cliffID === id))];
          terrain.customTilesets = true;
          terrain.customTilesetsRaw = 1;
          const after = snap();
          pushEdit({ undo: () => restore(before), redo: () => restore(after), terrain: true, objects: false });
          void syncTileList();
          replanCliffs();
          renderer.terrainChanged();
          minimapStale = true;
          redraw();
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
          const list = [...loader.missing];
          // Click: the placed objects whose model uses the texture.
          const users = (tex: string) => {
            const models = loader.modelsUsing(tex);
            return renderer.batches.flatMap((b) => b.instances).filter((i) => i.pick?.placed && models.has(i.pick.model.toLowerCase())).map((i) => i.pick!.placed);
          };
          // Textures missing in models the map imports are the map's to fix; the game's own models
          // have a few broken references too (the DE Sheep names textures in the wrong folder).
          const mapFiles = new Set(w3.workspace.project() ? w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()) : []);
          const fromMap = (tex: string) => [...loader.modelsUsing(tex)].some((m) => mapFiles.has(`map/${m.replace(/\\/g, "/")}`));
          const ours = list.filter(([p]) => fromMap(p)), game = list.filter(([p]) => !fromMap(p));
          const line = ([p, e]: [string, string], cls: string) => h(`div.${cls}.clickable`, { title: `${p}: ${e}\nClick: show the objects using it`,
            onclick: () => showEntries(users(p)) }, `${p}: ${e}`);
          texInfo.replaceChildren(
            ours.length ? `${ours.length} texture${ours.length === 1 ? "" : "s"} of the map's models not found` : "",
            ...ours.slice(0, 3).map((x) => line(x, "model-warn")),
            ...(game.length ? [h("details.terrain-game-tex", {},
              h("summary", { title: "The game's own models reference these, but the game data doesn't have them there. Nothing the map can fix." },
                `${game.length} texture${game.length === 1 ? "" : "s"} missing in the game's own models`),
              ...game.slice(0, 20).map((x) => line(x, "muted")))] : []));
          texInfo.title = list.map(([p, e]) => `${p}: ${e}`).join("\n");
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
          // Stored paths look like "War3.w3mod:_HD.w3mod:Doodads/…". Only the art
          // layers of the current graphics mode count: HD has cliff variations
          // the classic art lacks.
          const mode = w3.settings.get<string>("game.graphicsMode") ?? "hd";
          const skip = mode === "sd" ? /_(hd|de)\.w3mod:/i : mode === "hd" ? /_de\.w3mod:/i : null;
          const files = new Set(list.filter((p) => !skip?.test(p)).map((p) => p.slice(p.lastIndexOf(":") + 1).toLowerCase()));
          cliffData = { types, exists: (p) => files.has(p.replace(/\\/g, "/").toLowerCase()) };
          await replanCliffs();
        }).catch((e) => { cliffInfo.textContent = `Cliffs: ${(e as Error).message ?? e}`; });

        // ---- placed objects -----------------------------------------------------------
        let dooFile: PlacedFile | null = null, unitsFile: PlacedFile | null = null;
        /** Start locations as last saved: the map's players follow their changes (see syncPlayers). */
        let savedStarts = new Map<number, number[]>();
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
          // Each problem shows its objects when clicked; those without a model can be removed at once.
          const found = [...d.problems, ...u.problems];
          const broken = found.flatMap((p) => p.items);
          problems.replaceChildren(
            ...found.slice(0, 20).map((p) => h("div.model-warn.clickable", {
              title: `${p.message}\nClick: show ${p.items.length === 1 ? "the object" : `the ${p.items.length} objects`}`,
              onclick: () => showEntries(p.items),
            }, `${p.message} (${p.items.length})`)),
            ...(found.length > 20 ? [h("div.muted", {}, `… ${found.length - 20} more`)] : []),
            ...(broken.length && editable ? [h("button.terrain-cleanup", {
              title: "Deletes every placed object whose model doesn't load or whose id is unknown (one undo step)",
              onclick: async () => {
                const c = await w3.window.showWarning(`Delete ${broken.length} placed object${broken.length === 1 ? "" : "s"} without a model? (Ctrl+Z undoes it)`, "Delete", "Cancel");
                if (c === "Delete") deleteEntries(broken);
              },
            }, `Remove ${broken.length} without a model`)] : []));
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
            savedStarts = startLocations(uf?.list ?? []);
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
        const deleteSelected = () => deleteEntries(selectedEntries());
        /** Deletes placements as one undo step. */
        const deleteEntries = (entries: Placed[]) => {
          // Each entry with its file and index, so undo restores the order.
          const items = entries.map((entry) => ({ entry, f: fileOf(entry)! })).filter((x) => x.f)
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
        // ---- mass edit, select by type/filter, face point ---------------------------------
        const skinOf = (p: Placed) => objCtx?.skins.get(p.id) ?? objCtx?.skins.get(objCtx.bases.get(p.id) ?? "");
        const DEG = 180 / Math.PI;
        const varsOf = (p: Placed): ObjVars => ({
          x: p.position[0], y: p.position[1], z: p.position[2],
          facing: (((p.angle * DEG) % 360) + 360) % 360, scale: p.scale[0], variation: p.variation,
          owner: p.player !== undefined ? p.player + 1 : 0,
        });
        type MassField = "x" | "y" | "z" | "facing" | "scale" | "variation" | "owner";
        /** Applies new values to entries as one undo step (x/y moves keep objects on the ground). */
        const applyMass = (entries: Placed[], change: (p: Placed, i: number) => Partial<Props> | null) => {
          const before = entries.map(snapshot);
          let n = 0;
          entries.forEach((p, i) => { const c = change(p, i); if (c) { Object.assign(p, c); n++; } });
          if (!n) return;
          const after = entries.map(snapshot);
          const set = (v: Props[]) => entries.forEach((p, i) => Object.assign(p, structuredClone(v[i])));
          pushEdit({ undo: () => set(before), redo: () => set(after), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Sets `field` of every entry to the expression's value; returns an error message or null. */
        const massEdit = (entries: Placed[], field: MassField, src: string): string | null => {
          let node;
          try { node = compileExpr(src); } catch (e) { return (e as Error).message; }
          const vals = entries.map((p, i) => { const v = varsOf(p); return evalFor(node, v, v[field], i, entries.length); });
          if (vals.some((v) => !Number.isFinite(v))) return "the expression gives no number for some objects";
          applyMass(entries, (p, i) => {
            const v = vals[i];
            switch (field) {
              case "x": case "y": {
                const x = field === "x" ? v : p.position[0], y = field === "y" ? v : p.position[1];
                return { position: [x, y, heightAt(terrain, x, y)] };
              }
              case "z": return { position: [p.position[0], p.position[1], v] };
              case "facing": return { angle: v / DEG };
              case "scale": return v > 0 ? { scale: [v, v, v] } : null;
              case "variation": return { variation: Math.max(0, Math.min((skinOf(p)?.numVar ?? 1) - 1, Math.round(v))) };
              case "owner": return p.player !== undefined ? { player: Math.max(0, Math.min(27, Math.round(v) - 1)) } : null;
            }
          });
          return null;
        };
        /** Every placed object with a model (the groups not hidden). */
        const allPlaced = (): { p: Placed; kind: string; id: string }[] => {
          const out: { p: Placed; kind: string; id: string }[] = [];
          for (const b of renderer.batches) {
            if ((b.group !== "doodads" && b.group !== "units") || renderer.hiddenGroups.has(b.group)) continue;
            for (const inst of b.instances) if (inst.pick) out.push({ p: inst.pick.placed, kind: inst.pick.kind, id: inst.pick.id });
          }
          return out;
        };
        const selectSameTypes = () => {
          const ids = new Set(selectedEntries().map((p) => p.id));
          selectEntries(allPlaced().filter((o) => ids.has(o.id)).map((o) => o.p));
        };
        /** Selects every object matching a filter; returns an error message or null. */
        const selectMatching = async (src: string): Promise<string | null> => {
          let test;
          try { test = compileFilter(src); } catch (e) { return (e as Error).message; }
          const names = new Map<string, string>();
          for (const k of ["w3u", "w3t", "w3b", "w3d"]) {
            const kd = await loadKind(w3, k).catch(() => null);
            if (kd) for (const [id, n] of kd.names) names.set(id, n);
          }
          const nameOf = (id: string) => names.get(id) ?? names.get(objCtx?.bases.get(id) ?? "") ?? id;
          const found = allPlaced().filter((o) => boxKinds.has(o.kind) && test({ ...varsOf(o.p), id: o.id, kind: o.kind, name: nameOf(o.id) })).map((o) => o.p);
          selectEntries(found);
          if (!found.length) w3.window.showInfo("No objects match.");
          return null;
        };
        /** "Face point": the selection turns toward the pointer until a click (apply) or Esc. */
        let facing: { entries: Placed[]; before: Pose[] } | null = null;
        const startFacing = () => {
          const entries = selectedEntries();
          if (!editable || !entries.length) return;
          facing = { entries, before: entries.map(poseOf) };
          modeHint.textContent = "Facing the pointer: click to apply · Esc to cancel";
          canvas.focus();
        };
        const faceToward = (g: Vec3) => {
          for (const p of facing!.entries) setPlacement(p, [...p.position], Math.atan2(g[1] - p.position[1], g[0] - p.position[0]));
          refreshGroupRings();
        };
        const endFacing = (apply: boolean) => {
          const f = facing;
          if (!f) return;
          facing = null;
          modeHint.textContent = "";
          if (apply) moveEdits(f.entries, f.before);
          else { f.entries.forEach((p, i) => setPlacement(p, [...f.before[i].position], f.before[i].angle)); refreshGroupRings(); }
        };
        const modeHint = h("span.terrain-place-hint");

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
          const nameEl = h("div.terrain-sel-name", {}, p.id === "sloc" ? "Start location" : p.id);
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
            h("div.terrain-sel-actions.wrap", {},
              h("button", { title: "Select every object of this type", onclick: selectSameTypes }, "Select all of this type"),
              ...(editable ? [h("button", { title: "Turn toward the pointer (F); click to apply", onclick: startFacing }, "Face point")] : [])),
            ...(editable ? [h("div.muted", {}, "Drag it to move · [ ] to turn · F face point · Del to delete")] : []),
          );
          renderer.setSelection(ringOf(inst));
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
        /** Selection ring radius per type: the collision size (units) or the
         *  pathing footprint (buildings, doodads, destructables), like the game. */
        const ringRadius = new Map<string, number>();
        const ringLoading = new Set<string>();
        const radiusOf = (kind: string, id: string): number | undefined => {
          const key = `${kind}:${id}`;
          if (ringRadius.has(key)) return ringRadius.get(key);
          if (!ringLoading.has(key)) {
            ringLoading.add(key);
            void (async () => {
              pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (x) => objCtx?.bases.get(x));
              const data = await pathingData;
              const texRadius = async (path?: string) => { const t = path ? await data.texture(path) : null; return t ? Math.max(t.width, t.height) * 16 : undefined; };
              let r: number | undefined;
              if (kind === "w3t") r = 24;
              else if (kind === "w3u") { const sh = data.unitShape(id); r = (await texRadius(sh?.path)) ?? sh?.collision ?? 32; }
              else r = (await texRadius(data.placedTex(id)?.path)) ?? 32;
              ringRadius.set(key, Math.max(16, r));
              refreshRings();
            })().catch(() => { ringRadius.set(key, 32); });
          }
          return undefined;
        };
        const ringOf = (inst: ObjectInstance) => {
          const [, , , sr] = inst.sphere!, pl = inst.pick!.placed;
          // Until the size is known: a modest share of the model bounds.
          const r = radiusOf(inst.pick!.kind, inst.pick!.id) ?? Math.min(96, Math.max(24, sr * 0.4));
          // Centred on the object position (model bounds can be off-centre).
          return { x: pl.position[0], y: pl.position[1], r, rgb: (pl.player !== undefined && pl.player < 24 ? TEAM_COLORS[pl.player][1] : [120, 255, 120]) as Vec3 };
        };
        /** Click target per object: the same radius as its selection ring. */
        const pickRadius = (inst: ObjectInstance) =>
          radiusOf(inst.pick!.kind, inst.pick!.id) ?? Math.min(96, Math.max(24, (inst.sphere?.[3] ?? 64) * 0.4));
        /** Redraws the selection rings (after a size became known). */
        const refreshRings = () => {
          const insts = (group.length ? group : selected?.pick ? [selected.pick.placed] : []).map(findInstance).filter((i): i is ObjectInstance => !!i?.pick);
          renderer.setSelection(insts.map(ringOf));
          redraw();
        };
        /** Moves the view to entries (the first one) and selects those that have a model. */
        const showEntries = (entries: Placed[]) => {
          if (!entries.length) return;
          // Close enough to see one object (objects without a model are only markers).
          renderer.distance = Math.min(renderer.distance, 1600);
          look(entries[0].position[0], entries[0].position[1]);
          selectEntries(entries);
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
            return h("div.terrain-sel-row", {}, h("span.muted", {}, `${c.n} ×`), name,
              h("button.icon-button.terrain-sel-open", {
                title: `Open ${c.id} in the Object Editor`,
                onclick: () => w3.commands.execute("w3.objectEditor.open", c.kind, c.id).catch((e) => w3.window.showError(String(e))),
              }, "↗"));
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
          // "Edit all": an expression per field, applied to every selected object.
          const vars = group.map(varsOf);
          const common = (k: MassField) => {
            const vs = vars.map((v) => v[k]);
            return vs.every((v) => Math.abs(v - vs[0]) < 1e-3) ? fmt(vs[0]) : "mixed";
          };
          const massField = (label: string, k: MassField, title: string) => {
            const input = h("input.terrain-sel-expr", {
              type: "text", placeholder: common(k), title,
              onkeydown: (e: KeyboardEvent) => {
                if (e.key !== "Enter" || !input.value.trim()) return;
                const err = massEdit(group, k, input.value.trim());
                input.classList.toggle("invalid", !!err);
                input.title = err ? `${err}\n\n${title}` : title;
                if (!err) input.value = "";
              },
            });
            return h("div.terrain-sel-row", {}, h("span.muted", {}, label), input);
          };
          const help = "Enter a number or an expression, applied to each object: v = current value, i = index, n = count, x y z facing scale of the object; random(1..1.2), randint(0,9), round(v, 32), min, max, abs, sin/cos (degrees). Examples: x+64 · random(0..360) · i*90 · v*1.1";
          const quick = (label: string, title: string, fn: () => void) => h("button", { title, onclick: fn }, label);
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            h("div.terrain-sel-name", {}, `${group.length} objects selected`),
            list,
            h("div.terrain-sel-actions", {}, quick("Select all of these types", "Select every object of the selected types", selectSameTypes)),
            ...(editable ? [
              ...(ownerSel ? [h("div.terrain-sel-row", {}, h("span.muted", {}, `Owner (${units.length})`), ownerSel)] : []),
              h("div.terrain-sel-sub.muted", { title: help }, "Edit all (Enter applies; hover for help)"),
              massField("X", "x", help), massField("Y", "y", help), massField("Z", "z", help),
              massField("Facing", "facing", help), massField("Scale", "scale", help), massField("Variation", "variation", help),
              h("div.terrain-sel-actions.wrap", {},
                quick("Face point", "Turn every selected object toward the pointer (F); click to apply", startFacing),
                quick("Random facing", "A random facing for each object", () => void massEdit(group, "facing", "random(0..360)")),
                quick("Random variation", "A random model variation for each object", () => applyMass(group, (p) => {
                  const n = skinOf(p)?.numVar ?? 1;
                  return n > 1 ? { variation: Math.floor(Math.random() * n) } : null;
                })),
                quick("Random scale", "A random scale within each type's own range (game data)", () => applyMass(group, (p) => {
                  const sk = skinOf(p);
                  if (!sk || sk.maxScale <= sk.minScale) return null;
                  const k = sk.minScale + Math.random() * (sk.maxScale - sk.minScale);
                  return { scale: [k, k, k] };
                })),
                quick("Drop to ground", "Set every object's height to the ground under it", () => applyMass(group, (p) => ({ position: [p.position[0], p.position[1], heightAt(terrain, p.position[0], p.position[1])] }))),
                h("button", { title: "Delete all selected (Del)", onclick: deleteSelected }, `Delete ${group.length}`)),
              h("div.muted", {}, "Drag one to move all · [ ] turn each · F face point · Del delete · Ctrl+click adds/removes · Shift+box adds"),
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
          const inst = renderer.pickObject(ray, pickRadius);
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
            filterInput, h("button", { title: "Select every object matching the filter", onclick: () => void runFilter() }, "Select matching"),
            modeHint);
        }
        const filterHelp = "Select all objects matching every condition (and the Box selects kinds): field op value, op = != < > <= >= or : (contains). Fields: id, kind (unit, item, destructable, doodad), owner (Player 1 = 1), name, x, y, z, facing, scale, variation. Examples: kind=unit owner=1 · name:tree scale>1.1 · id=LTlt";
        const filterInput = h("input.terrain-filter", {
          type: "text", placeholder: "Filter, e.g. kind=unit owner=1 · name:tree", title: filterHelp,
          onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void runFilter(); },
        });
        const runFilter = async () => {
          if (!filterInput.value.trim()) return;
          const err = await selectMatching(filterInput.value.trim());
          filterInput.classList.toggle("invalid", !!err);
          filterInput.title = err ? `${err}\n\n${filterHelp}` : filterHelp;
        };

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
        /** Rewrites a project JSON document of the format engine (or its raw file when the project keeps it raw). */
        /** Edits a JSON-backed map file in either project form; `change` returning false skips the write. */
        const editDoc = async (name: string, change: (d: Record<string, unknown>) => void | boolean) => {
          const root = w3.workspace.project()!.root, path = `map/${name}`;
          const json = await w3.workspace.readText(`${path}.json`).catch(() => null);
          const raw = json === null ? await w3.backend.invoke<string>("codec_decode", { root, path }).catch(() => null) : null;
          if (json === null && raw === null) return;
          const d = JSON.parse((json ?? raw)!) as Record<string, unknown>;
          if (change(d) === false) return;
          if (json !== null) await w3.workspace.writeText(`${path}.json`, await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${path}.json`, text: JSON.stringify(d) }));
          else await w3.backend.invoke("codec_write", { root, path, text: JSON.stringify(d) });
        };
        /** Map Size and Camera Bounds (see TerrainEditorHandle.resizeMap). */
        const resizeMap = async (change: Sides, complements: Sides): Promise<{ removed: number }> => {
          if (!editable) throw new Error("This map is read-only.");
          const problem = resizeProblem(terrain, change, complements);
          if (problem) throw new Error(problem);
          // Everything (terrain, objects, other tabs) saved first: the files are rewritten below.
          await editorApi.save?.();
          const next = resizeTerrain(terrain, change);
          const rect = worldRect(next);
          const inside = (x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.bottom && y <= rect.top;
          // Start locations aren't removed but moved into the map (a player needs one).
          const pb = cameraBounds(next, complements);
          const clamp = (x: number, y: number): [number, number] => [Math.min(Math.max(x, pb[0]), pb[2]), Math.min(Math.max(y, pb[1]), pb[3])];
          let removed = 0;
          for (const f of [dooFile, unitsFile]) {
            if (!f) continue;
            for (const p of f.list) if (p.id === "sloc" && !inside(p.position[0], p.position[1])) [p.position[0], p.position[1]] = clamp(p.position[0], p.position[1]);
            const keep = f.list.filter((p) => inside(p.position[0], p.position[1]));
            removed += f.list.length - keep.length;
            f.list.splice(0, f.list.length, ...keep);
            await savePlacedFile(w3, f);
          }
          await writeTerrainBytes(doc.path, writeW3e(next), doc);
          await editDoc("war3map.w3i", (info) => {
            info.cameraComplements = [...complements];
            info.cameraBounds = cameraBounds(next, complements);
            [info.playableWidth, info.playableHeight] = playableSize(next, complements);
            for (const pl of (info.players as { start: number[] }[] | undefined) ?? []) if (!inside(pl.start[0], pl.start[1])) [pl.start[0], pl.start[1]] = clamp(pl.start[0], pl.start[1]);
          });
          // Regions are clipped to the map (those left outside go).
          await editDoc("war3map.w3r", (d) => {
            type R = { left: number; right: number; bottom: number; top: number };
            const list = (d.regions as R[] | undefined) ?? [];
            for (const r of list) {
              r.left = Math.max(r.left, rect.left); r.right = Math.min(r.right, rect.right);
              r.bottom = Math.max(r.bottom, rect.bottom); r.top = Math.min(r.top, rect.top);
            }
            d.regions = list.filter((r) => r.right > r.left && r.top > r.bottom);
          });
          const shd = await w3.workspace.readBytes("map/war3map.shd").catch(() => null);
          if (shd) await w3.workspace.writeBytes("map/war3map.shd", resizeGrid(shd, terrain, change, 4));
          // Pathing and minimap from the new terrain. Pathing Editor overrides are by cell, so they
          // only apply while the size stays.
          const rf = (p: string) => readFile(w3, doc, p);
          const doodads = dooFile?.list ?? [];
          const { wpm } = await buildPathingMap(w3, next, doodads, rf, w3.settings.get<number>("terrain.pathing.deepWater"));
          if (change.every((c) => c === 0)) filterPathing(wpm);
          await w3.workspace.writeBytes("map/war3map.wpm", wpm);
          await w3.workspace.writeBytes("map/war3mapMap.blp", await buildMinimap(w3, next, doodads, rf, minimapSettings(w3), w3.settings.get<number>("terrain.minimap.jpegQuality")));
          // The editor opens again on the new terrain.
          void (async () => {
            await w3.editors.close(doc.path);
            await w3.editors.open(doc.path, "w3.terrainViewer");
          })().catch((e) => w3.window.showError(String(e)));
          return { removed };
        };
        const handle: TerrainEditorHandle = {
          terrain, editable, redraw, host: el, resizeMap,
          terrainChanged: () => { renderer.terrainChanged(); doc.setDirty(true); redraw(); },
          commitTerrain,
          ensureGroundTile: (id) => ensureTile(id),
          groundTileUsage: () => {
            const n = terrain.groundTiles.map(() => 0);
            for (const c of terrain.corners) if (c.texture < n.length) n[c.texture]++;
            return n;
          },
          moveGroundTile: (from, to) => {
            const t = terrain.groundTiles;
            if (from === to || from < 0 || to < 0 || from >= t.length || to >= t.length) return;
            const order = t.map((_, i) => i);
            order.splice(to, 0, order.splice(from, 1)[0]);
            const inverse = new Map(order.map((old, nw) => [old, nw]));
            changeTileList(order.map((i) => t[i]), (old) => inverse.get(old) ?? old);
          },
          removeGroundTile: (index, replacement) => {
            const t = terrain.groundTiles;
            if (index === replacement || index < 0 || index >= t.length || replacement < 0 || replacement >= t.length) return;
            const tiles = t.filter((_, i) => i !== index);
            const shift = (i: number) => (i > index ? i - 1 : i);
            changeTileList(tiles, (old) => shift(old === index ? replacement : old));
          },
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
            list: () => [...(unitsFile?.list ?? []), ...(dooFile?.list ?? [])],
            update: () => {
              objectsTouched = true;
              void rebuildObjects();
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
          lookAt: (x, y) => { renderer.target = [x, y, heightAt(terrain, x, y)]; redraw(); },
          view: () => ({ target: [...renderer.target], yaw: renderer.yaw, pitch: renderer.pitch, distance: renderer.distance, fov: renderer.fov }),
          setView: (v) => {
            if (v.target) renderer.target = [...v.target];
            Object.assign(renderer, Object.fromEntries((["yaw", "pitch", "distance", "fov"] as const).filter((k) => v[k] !== undefined).map((k) => [k, v[k]])));
            redraw();
          },
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
        // A point pick for another module (trigger parameters): banner, click on the ground, Esc cancels.
        const pickBanner = h("div.terrain-pick-banner", { hidden: true });
        el.append(pickBanner);
        const syncPick = () => {
          const p = toolGroups.picking;
          pickBanner.hidden = !p;
          if (p) pickBanner.replaceChildren(h("span", {}, p.prompt), h("span.muted", {}, " · Esc to cancel"),
            h("button", { onclick: () => toolGroups.picking?.finish(undefined) }, "Cancel"));
        };
        syncPick();
        const stopPick = toolGroups.onChange(syncPick);
        const live = () => ({ units: unitsFile?.list ?? [], doodads: dooFile?.list ?? [] });
        /** While picking objects: the accepted placement nearest to a ground point, if close enough. */
        const pickTarget = (g: [number, number, number] | null): Placed | null => {
          const o = toolGroups.picking?.objects;
          if (!o || !g) return null;
          const list = (o.file === "units" ? unitsFile?.list : dooFile?.list) ?? [];
          let best: Placed | null = null, bestD = o.radius ?? 128;
          for (const e of list) {
            const d = Math.hypot(e.position[0] - g[0], e.position[1] - g[1]);
            if (d <= bestD && o.accept(e)) { best = e; bestD = d; }
          }
          return best;
        };
        let pickRing = false;
        const showPickTarget = (t: Placed | null) => {
          if (!t && !pickRing) return;
          pickRing = !!t;
          renderer.setBrush(t ? { x: t.position[0], y: t.position[1], r: 64, rgb: [1, 0.85, 0.2] } : null);
          redraw();
        };
        // However the pick ends (click, Esc, Cancel, another pick), the ring goes.
        const stopPickRing = toolGroups.onChange(() => { if (!toolGroups.picking) showPickTarget(null); });
        toolGroups.livePlacements = live;
        const look = (x: number, y: number) => { renderer.target = [x, y, heightAt(terrain, x, y)]; redraw(); };
        toolGroups.look = look;
        if (toolGroups.pendingLook) { const [px, py] = toolGroups.pendingLook; toolGroups.pendingLook = null; requestAnimationFrame(() => look(px, py)); }
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
        const initial = { yaw: renderer.yaw, pitch: renderer.pitch, distance: renderer.distance, fov: renderer.fov };
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
          if (toolGroups.picking && e.button === 0) {
            e.preventDefault();
            const g = groundAt(e);
            const target = pickTarget(g);
            showPickTarget(null);
            if (g) toolGroups.picking.finish({ x: g[0], y: g[1], ...(target ? { object: target } : {}) });
            return;
          }
          const gi = activeInst();
          if (gi && e.button === 0 && gi.pointerDown?.({ ground: groundAt(e), event: e, down: false })) {
            e.preventDefault();
            groupDrag = true;
            return;
          }
          if (facing) {
            e.preventDefault();
            endFacing(e.button === 0);
            return;
          }
          if (e.button === 0) {
            const rect = canvas.getBoundingClientRect();
            const inst = editable && !e.ctrlKey && !e.shiftKey ? renderer.pickObject(renderer.ray(e.clientX - rect.left, e.clientY - rect.top), pickRadius) : null;
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
          if (toolGroups.picking?.objects) { showPickTarget(pickTarget(groundAt(e))); return; }
          activeInst()?.pointerMove?.({ ground: groundAt(e), event: e, down: groupDrag });
          if (groupDrag) return;
          if (facing) { const g = groundAt(e); if (g) faceToward(g); return; }
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
        // Undo/redo anywhere in the editor (toolbars, panels), except while typing.
        el.addEventListener("keydown", (e) => {
          const t = e.target as HTMLElement;
          if (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "range", "button"].includes((t as HTMLInputElement).type))) return;
          if (!(e.ctrlKey || e.metaKey)) return;
          if (e.key === "z" || e.key === "Z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
          else if (e.key === "y" || e.key === "Y") { e.preventDefault(); redo(); }
        });
        // Arrow keys scroll like in the World Editor.
        canvas.addEventListener("keydown", (e) => {
          if (toolGroups.picking && e.key === "Escape") { e.preventDefault(); showPickTarget(null); toolGroups.picking.finish(undefined); return; }
          if (activeInst()?.keyDown?.(e)) { e.preventDefault(); return; }
          const step = canvas.clientHeight / 6;
          if (e.key === "Escape") { if (facing) endFacing(false); else clearSelection(); return; }
          if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !activeGroup) { e.preventDefault(); startFacing(); return; }
          if (editable && selectedEntries().length && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelected(); return; }
          if (editable && selectedEntries().length && (e.key === "[" || e.key === "]")) { e.preventDefault(); rotateSelected(e.key === "[" ? 15 : -15); return; }
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

        const editorApi = {
          save: editable ? async () => {
            const w3e = writeW3e(terrain);
            await writeTerrainBytes(doc.path, w3e, doc);
            if (objectsTouched) {
              for (const f of [dooFile, unitsFile]) if (f) await savePlacedFile(w3, f);
              // Placed, moved or deleted start locations add, move or remove the map's players.
              if (unitsFile) {
                const starts = startLocations(unitsFile.list);
                let changes: string[] = [];
                await editDoc("war3map.w3i", (info) => {
                  changes = syncPlayers(info as unknown as PlayerInfo, starts, savedStarts);
                  return changes.length > 0;
                });
                savedStarts = starts;
                if (changes.length) void w3.window.showInfo(`Map players: ${changes.join(", ")}.`);
              }
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
                await w3.workspace.writeBytes("map/war3mapMap.blp", await buildMinimap(w3, terrain, doodads, rf, minimapSettings(w3), cfg<number>("minimap.jpegQuality")));
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
            stopPick();
            stopPickRing();
            if (toolGroups.livePlacements === live) toolGroups.livePlacements = null;
            if (toolGroups.look === look) toolGroups.look = null;
            for (const g of groupInsts.values()) g.dispose?.();
            cancelAnimationFrame(raf);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            renderer.dispose();
          },
        };
        return editorApi;
      },
    }),
  );
}
