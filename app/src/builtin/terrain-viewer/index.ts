import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { decodeImage } from "../image-viewer/decode/index.ts";
import { TEAM_COLORS, type Vec3 } from "../model-viewer/renderer";
import { loadKind, parseSlk } from "../object-editor/metadata";
import { planCliffs, type CliffType } from "./cliffs";
import { loadSkins, ObjectLoader, placement, type Placed } from "./objects";
import { loadPlacedFile, newEntry, savePlacedFile, type PlacedFile } from "./placement";
import { TerrainRenderer, type Marker, type ObjectInstance } from "./renderer";
import { applyHeight, applyLayer, paintTexture, Stroke, waterLevelAt, type HeightTool, type LayerTarget, type LayerTool } from "./tools";
import { groundHeight, parseW3e, writeW3e, type Terrain } from "./w3e";

const PATH = "map/war3map.w3e";
/** The note about derived files (pathing, shadows) is shown once per session. */
let warnedDerived = false;
/** TEAM_COLORS index used for neutral players. */
const NEUTRAL = 20;

const TILESETS: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "Lordaeron Fall", G: "Underground",
  I: "Icecrown Glacier", J: "Dalaran Ruins", K: "Black Citadel", L: "Lordaeron Summer", N: "Northrend",
  O: "Outland", Q: "Village Fall", V: "Village", W: "Lordaeron Winter", X: "Dalaran", Y: "Cityscape", Z: "Sunken Ruins",
};

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
  const rows = parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk"));
  return new Map(rows.filter((r) => r.tileID).map((r) => [r.tileID, `${r.dir}\\${r.file}.blp`]));
}

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
  ctx.subscriptions.push(
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
        try {
          terrain = parseW3e(await doc.readBytes());
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
        type Tool = "select" | HeightTool | LayerTool | "paint";
        const LAYER_TOOLS: Tool[] = ["cliffUp", "cliffDown", "shallow", "deep", "dry"];
        const isLayerTool = (t: Tool): t is LayerTool => LAYER_TOOLS.includes(t);
        const editable = !doc.readOnly;
        let tool: Tool = "select", size = 2, strength = 16, paintTex = 0;
        /** One undoable change: a terrain stroke or an object edit. */
        interface Edit { undo(): void; redo(): void; terrain: boolean; objects: boolean }
        /** Undo history; `at` edits are applied, `savedAt` matches the files. */
        const history: Edit[] = [];
        let at = 0, savedAt = 0;
        const changed = (e: Edit) => {
          if (e.terrain) { replanCliffs(); renderer.terrainChanged(); }
          if (e.objects) { objectsTouched = true; void rebuildObjects(); }
          doc.setDirty(at !== savedAt);
          redraw();
        };
        const undo = () => { if (at > 0) { const e = history[--at]; e.undo(); changed(e); } };
        const redo = () => { if (at < history.length) { const e = history[at++]; e.redo(); changed(e); } };
        const pushEdit = (e: Edit) => {
          history.length = at;
          history.push(e);
          at = history.length;
          doc.setDirty(at !== savedAt);
        };
        let stroke: { s: Stroke; target: number; layer: LayerTarget; last: number } | null = null;
        /** One brush application at a ground point. */
        const applyAt = (p: Vec3) => {
          if (!stroke) return;
          const brush = { x: p[0], y: p[1], radius: size };
          const did = tool === "paint"
            ? paintTexture(terrain, brush, paintTex, stroke.s)
            : isLayerTool(tool)
            ? applyLayer(terrain, brush, tool, stroke.layer, stroke.s)
            : applyHeight(terrain, brush, tool as HeightTool, tool === "plateau" ? stroke.target : strength, stroke.s);
          if (did) {
            renderer.terrainChanged();
            doc.setDirty(true);
            redraw();
          }
        };
        const groundAt = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          return renderer.pickGround(renderer.ray(e.clientX - rect.left, e.clientY - rect.top));
        };
        const startStroke = (e: MouseEvent) => {
          const p = groundAt(e);
          if (!p) return;
          const c = terrain.corners[Math.round((p[1] - terrain.offsetY) / 128) * terrain.width + Math.round((p[0] - terrain.offsetX) / 128)];
          // Cliff tools step one level from the start point; water goes one or
          // two levels below it, with the surface at its original height.
          const step = tool === "cliffUp" ? 1 : tool === "cliffDown" ? -1 : tool === "shallow" ? -1 : tool === "deep" ? -2 : 0;
          const layer: LayerTarget = c
            ? { layer: Math.max(0, Math.min(15, c.layer + step)), waterLevel: waterLevelAt(c.height - 8) }
            : { layer: 2 };
          stroke = { s: new Stroke(tool), target: c ? groundHeight(c) : 0, layer, last: performance.now() };
          applyAt(p);
        };
        const endStroke = () => {
          if (!stroke) return;
          const s = stroke.s;
          if (s.finish(terrain)) {
            pushEdit({ undo: () => s.undo(terrain), redo: () => s.redo(terrain), terrain: true, objects: false });
            if (isLayerTool(s.label as Tool)) { replanCliffs(); renderer.terrainChanged(); redraw(); }
          }
          doc.setDirty(at !== savedAt);
          stroke = null;
        };
        const BRUSH_COLORS: Record<Tool, Vec3> = {
          select: [0, 0, 0], raise: [120, 220, 255], lower: [255, 150, 90], plateau: [255, 230, 120], smooth: [190, 160, 255], paint: [140, 255, 140],
          cliffUp: [255, 200, 120], cliffDown: [220, 140, 80], shallow: [110, 190, 255], deep: [60, 120, 255], dry: [210, 190, 150],
        };
        const showBrush = (e: MouseEvent | null) => {
          const p = e && tool !== "select" ? groundAt(e) : null;
          renderer.setBrush(p ? { x: p[0], y: p[1], r: size * 128, rgb: BRUSH_COLORS[tool] } : null);
          redraw();
          return p;
        };

        // ---- side panel ---------------------------------------------------------
        const texList = h("div.model-list");
        const markerList = h("div.model-list");
        const status = (row: HTMLElement, cls: string, title?: string) => {
          row.firstElementChild!.className = `model-dot ${cls}`;
          if (title) row.title = title;
        };
        tilePaths(w3).then((paths) => {
          texList.replaceChildren(...terrain.groundTiles.map((id, i) => {
            const path = paths.get(id);
            const row = h("div.model-row", { title: path ?? id }, h("span.model-dot.pending", {}, "●"), h("span", {}, `${id} `), h("small.muted", {}, path?.split("\\").pop() ?? "unknown tile"));
            if (!path) status(row, "missing");
            else readGroundTexture(w3, doc, path).then(({ buf, name }) => {
              renderer.setGroundTexture(i, decodeImage(buf, name).mip(0));
              row.title = name;
              status(row, "ok");
              redraw();
            }).catch((e) => status(row, "missing", `${path}: ${(e as Error).message ?? e}`));
            return row;
          }));
        }).catch((e) => texList.replaceChildren(h("div.model-warn", {}, `Terrain.slk: ${(e as Error).message ?? e}`)));

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
          // Keep the selection on the same entry.
          const entry = selected?.pick?.placed;
          const again = entry ? findInstance(entry) : null;
          if (again) selectObject(again); else if (selected) clearSelection();
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
            unitsFile = uf;
            objCtx = { skins, bases };
            await rebuildObjects();
          });
        }
        const fileOf = (entry: Placed) => (dooFile?.list.includes(entry) ? dooFile : unitsFile?.list.includes(entry) ? unitsFile : null);
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
          redraw();
        };
        const moveEdit = (entry: Placed, before: { position: [number, number, number]; angle: number }) => {
          const after = { position: [...entry.position] as [number, number, number], angle: entry.angle };
          pushEdit({
            undo: () => setPlacement(entry, [...before.position], before.angle),
            redo: () => setPlacement(entry, [...after.position], after.angle),
            terrain: false, objects: false,
          });
        };
        const deleteSelected = () => {
          const entry = selected?.pick?.placed;
          const f = entry ? fileOf(entry) : null;
          if (!entry || !f) return;
          const i = f.list.indexOf(entry);
          const doIt = () => { f.list.splice(f.list.indexOf(entry), 1); };
          doIt();
          clearSelection();
          pushEdit({ undo: () => { f.list.splice(i, 0, entry); }, redo: doIt, terrain: false, objects: true });
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
          const entry = selected?.pick?.placed;
          if (!entry) return;
          const before = { position: [...entry.position] as [number, number, number], angle: entry.angle };
          setPlacement(entry, [...entry.position], entry.angle + (deg * Math.PI) / 180);
          moveEdit(entry, before);
        };
        /** Type chosen with "Place…"; each click on the ground places one. */
        let placing: { kind: string; id: string; name: string } | null = null;
        /** Owner of placed units (kept between placements). */
        let placeOwner = 0;
        const placeHint = h("span.terrain-place-hint");
        const setPlacing = (p: typeof placing) => {
          placing = p;
          if (!p) { placeHint.replaceChildren(); return; }
          const owner = h("select", { title: "Owner of placed units", onchange: () => { placeOwner = Number(owner.value); canvas.focus(); } },
            ...Array.from({ length: 28 }, (_, i) => h("option", { value: String(i), selected: i === placeOwner }, ownerName(i))));
          placeHint.replaceChildren(`Placing ${p.name} (${p.id}): click the ground · Esc to stop`, ...(p.kind === "w3u" ? [" · for ", owner] : []));
        };
        const placeAt = (pos: Vec3) => {
          if (!placing) return;
          const f = placing.kind === "w3u" || placing.kind === "w3t" ? unitsFile : dooFile;
          if (!f) { w3.window.showError(`This project has no ${placing.kind === "w3u" || placing.kind === "w3t" ? "war3mapUnits.doo" : "war3map.doo"}.`); return; }
          const entry = newEntry(f, placing.id, [pos[0], pos[1], pos[2]], placing.kind === "w3u" ? placeOwner : undefined);
          if (!entry) { w3.window.showError(`${f.name} has no entries to take the layout from yet.`); return; }
          f.list.push(entry);
          pushEdit({ undo: () => { f.list.splice(f.list.indexOf(entry), 1); }, redo: () => { f.list.push(entry); }, terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        const choosePlacement = async () => {
          const kinds: [string, string][] = [["w3u", "Unit"], ["w3t", "Item"], ["w3b", "Destructable"], ["w3d", "Doodad"]];
          const items: { label: string; description: string; value: { kind: string; id: string; name: string } }[] = [];
          for (const [kind, label] of kinds) {
            const k = await loadKind(w3, kind).catch(() => null);
            if (!k) continue;
            for (const id of k.baseIds) {
              const name = k.names.get(id) ?? id;
              items.push({ label: name, description: `${id} · ${label}`, value: { kind, id, name } });
            }
            for (const [id, base] of objCtx?.bases ?? []) {
              if (!k.names.has(base)) continue;
              const name = `${k.names.get(base)} (custom)`;
              items.push({ label: name, description: `${id} · ${label}`, value: { kind, id, name } });
            }
          }
          const pick = await w3.window.quickPick(items, { placeholder: "What to place (name or id)…" });
          if (pick?.value) { setTool("select"); setPlacing(pick.value); canvas.focus(); }
        };

        // ---- selection --------------------------------------------------------------
        const selInfo = h("div.terrain-selection.muted", {}, "Click a unit, item, doodad or destructable.");
        const row = (label: string, value: string) => h("div.terrain-sel-row", {}, h("span.muted", {}, label), h("span", {}, value));
        const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
        let selected: ObjectInstance | null = null;
        const selectObject = (inst: ObjectInstance) => {
          selected = inst;
          const p = inst.pick!, pl = p.placed;
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
            nameEl,
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
          selInfo.className = "terrain-selection muted";
          selInfo.replaceChildren("Click a unit, item, doodad or destructable.");
          renderer.setSelection(null);
          redraw();
        };
        const pickAt = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          const ray = renderer.ray(e.clientX - rect.left, e.clientY - rect.top);
          const inst = renderer.pickObject(ray);
          // The ground isn't selectable; it's edited with brushes.
          if (inst) selectObject(inst); else clearSelection();
        };

        const tiles = `${terrain.width - 1} × ${terrain.height - 1}`;
        const side = h("div.model-side", {},
          h("h3", {}, TILESETS[terrain.tileset] ?? `Tileset ${terrain.tileset}`),
          h("div.model-facts", {},
            h("div", {}, `w3e v${terrain.version} · ${tiles} tiles`),
            h("div", {}, `${terrain.groundTiles.length} ground · ${terrain.cliffTiles.length} cliff textures`),
            cliffInfo, texInfo,
          ),
          h("h4", {}, `Ground textures (${terrain.groundTiles.length})`), texList,
          h("h4", {}, "Selection"), selInfo,
          h("h4", {}, "Placed objects"), markerList, problems,
        );

        let setToolRef: (t: Tool) => void = () => {};
        const setTool = (t: Tool) => setToolRef(t);
        function toolBar() {
          const buttons = new Map<Tool, HTMLButtonElement>();
          const texSelect = h("select", { title: "Ground texture to paint", onchange: () => { paintTex = Number(texSelect.value); } },
            ...terrain.groundTiles.map((id, i) => h("option", { value: String(i) }, id)));
          tilePaths(w3).then((paths) => terrain.groundTiles.forEach((id, i) => {
            const o = texSelect.options[i];
            const file = paths.get(id)?.split("\\").pop()?.replace(/\.blp$/i, "");
            if (o && file) o.textContent = `${id} · ${file}`;
          })).catch(() => { /* ids only */ });
          const texWrap = h("span.terrain-tool-opt", {}, texSelect);
          const strengthWrap = h("label.terrain-tool-opt", { title: "Height change per application at the brush centre" }, "Strength ",
            h("input", { type: "range", min: "2", max: "64", value: String(strength), oninput: (e: Event) => { strength = Number((e.target as HTMLInputElement).value); } }));
          const setTool = (t: Tool) => {
            tool = t;
            setPlacing(null);
            for (const [k, b] of buttons) b.classList.toggle("active", k === t);
            texWrap.hidden = t !== "paint";
            strengthWrap.hidden = t !== "raise" && t !== "lower";
            showBrush(null);
          };
          const tools: [Tool, string, string][] = [
            ["select", "Select", "Select units and doodads"], ["raise", "Raise", "Raise the ground"], ["lower", "Lower", "Lower the ground"],
            ["plateau", "Plateau", "Level to the height where the stroke starts"], ["smooth", "Smooth", "Smooth bumps"], ["paint", "Paint", "Paint a ground texture"],
            ["cliffUp", "Cliff ↑", "Raise a cliff level (one above where the stroke starts)"], ["cliffDown", "Cliff ↓", "Lower a cliff level"],
            ["shallow", "Shallow water", "Water one level below where the stroke starts"], ["deep", "Deep water", "Water two levels below where the stroke starts"],
            ["dry", "Dry", "Remove water (use Cliff ↑ to raise the ground again)"],
          ];
          const bar = h("div.model-toolbar.terrain-tools", {},
            ...tools.map(([t, label, title]) => {
              const b = h("button", { title, onclick: () => setTool(t) }, label);
              buttons.set(t, b);
              return b;
            }),
            h("label.terrain-tool-opt", { title: "Brush radius in tiles" }, "Size ",
              h("input", { type: "range", min: "1", max: "10", value: String(size), oninput: (e: Event) => { size = Number((e.target as HTMLInputElement).value); } })),
            strengthWrap, texWrap,
            h("button", { title: "Place units, items, doodads or destructables", onclick: () => { void choosePlacement(); } }, "Place…"),
            h("button", { title: "Undo (Ctrl+Z)", onclick: undo }, "↶"),
            h("button", { title: "Redo (Ctrl+Y)", onclick: redo }, "↷"),
          );
          setToolRef = setTool;
          setTool("select");
          bar.append(placeHint);
          return bar;
        }

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
              h("span.muted", {}, "Drag, middle-drag or arrow keys: pan · Right-drag: rotate · Wheel: zoom")),
            ...(editable ? [toolBar()] : []),
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
        /** An object being dragged to a new place. */
        let objDrag: { entry: Placed; before: { position: [number, number, number]; angle: number }; moved: boolean } | null = null;
        canvas.tabIndex = 0;
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        /** Where the left button went down; a release close by is a click (select). */
        let press: { x: number; y: number } | null = null;
        canvas.addEventListener("mousedown", (e) => {
          canvas.focus();
          if (e.button === 0 && tool !== "select") {
            e.preventDefault();
            startStroke(e);
            return;
          }
          if (e.button === 0 && placing) {
            const p = groundAt(e);
            if (p) placeAt(p);
            return;
          }
          if (e.button === 0 && editable) {
            const rect = canvas.getBoundingClientRect();
            const inst = renderer.pickObject(renderer.ray(e.clientX - rect.left, e.clientY - rect.top));
            // Only the selected object moves, so drags over forests still pan.
            if (inst?.pick && inst === selected) {
              const entry = inst.pick.placed;
              objDrag = { entry, before: { position: [...entry.position] as [number, number, number], angle: entry.angle }, moved: false };
              return;
            }
          }
          if (e.button === 1) e.preventDefault();
          drag = { x: e.clientX, y: e.clientY, button: e.button };
          press = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
        });
        canvas.addEventListener("mousemove", (e) => {
          if (objDrag) {
            const p = groundAt(e);
            if (p) {
              objDrag.moved = true;
              setPlacement(objDrag.entry, [p[0], p[1], renderer.groundHeight(p[0], p[1])], objDrag.entry.angle);
            }
            return;
          }
          if (drag) return;
          const p = showBrush(e);
          // Re-apply while held, a few times per second.
          if (stroke && p && performance.now() - stroke.last > 40) {
            stroke.last = performance.now();
            applyAt(p);
          }
        });
        canvas.addEventListener("mouseleave", () => { if (!stroke) showBrush(null); });
        canvas.addEventListener("mouseup", (e) => {
          if (e.button === 0 && press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) pickAt(e);
          press = null;
        });
        // Arrow keys scroll like in the World Editor.
        canvas.addEventListener("keydown", (e) => {
          const step = canvas.clientHeight / 6;
          if (e.key === "Escape") { if (placing) setPlacing(null); else clearSelection(); return; }
          if (editable && selected && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelected(); return; }
          if (editable && selected && (e.key === "[" || e.key === "]")) { e.preventDefault(); rotateSelected(e.key === "[" ? 15 : -15); return; }
          if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
          if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
          const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (!d) return;
          e.preventDefault();
          pan(d[0], d[1]);
        });
        const onMove = (e: MouseEvent) => {
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
        const onUp = () => {
          drag = null;
          endStroke();
          if (objDrag?.moved) moveEdit(objDrag.entry, objDrag.before);
          objDrag = null;
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
            await doc.writeBytes(writeW3e(terrain));
            if (objectsTouched) {
              for (const f of [dooFile, unitsFile]) if (f) await savePlacedFile(w3, f);
            }
            savedAt = at;
            doc.setDirty(false);
            if (!warnedDerived) {
              warnedDerived = true;
              w3.window.showWarning("Saved war3map.w3e. The pathing map (war3map.wpm), shadows and minimap aren't regenerated yet; open and save the map in the World Editor before you release it.");
            }
          } : undefined,
          focus: () => canvas.focus(),
          dispose: () => {
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
