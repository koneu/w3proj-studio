import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { decodeImage } from "../image-viewer/decode/index.ts";
import { TEAM_COLORS, type Vec3 } from "../model-viewer/renderer";
import { loadKind, parseSlk } from "../object-editor/metadata";
import { planCliffs, type CliffType } from "./cliffs";
import { loadSkins, ObjectLoader, type Placed } from "./objects";
import { TerrainRenderer, type Marker, type ObjectInstance } from "./renderer";
import { applyHeight, applyLayer, paintTexture, Stroke, type HeightTool, type LayerTool } from "./tools";
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

/** A placed-objects file (war3map.doo / war3mapUnits.doo) as JSON: the
 *  unpacked `.json` form if the project has it, else decoded on the fly. */
async function readPlaced(w3: W3Api, name: string, key: "doodads" | "units"): Promise<Placed[]> {
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const path = `map/${name}`;
  let text: string;
  if (files.has(`${path}.json`.toLowerCase())) text = await w3.workspace.readText(`${path}.json`);
  else if (files.has(path.toLowerCase())) text = await w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()!.root, path });
  else return [];
  return (JSON.parse(text)[key] ?? []) as Placed[];
}

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
        /** Undo history; `at` strokes are applied, `savedAt` matches the file. */
        const history: Stroke[] = [];
        let at = 0, savedAt = 0;
        const changed = () => {
          replanCliffs();
          renderer.terrainChanged();
          doc.setDirty(at !== savedAt);
          redraw();
        };
        const undo = () => { if (at > 0) { history[--at].undo(terrain); changed(); } };
        const redo = () => { if (at < history.length) { history[at++].redo(terrain); changed(); } };
        let stroke: { s: Stroke; target: number; last: number } | null = null;
        /** One brush application at a ground point. */
        const applyAt = (p: Vec3) => {
          if (!stroke) return;
          const brush = { x: p[0], y: p[1], radius: size };
          const did = tool === "paint"
            ? paintTexture(terrain, brush, paintTex, stroke.s)
            : isLayerTool(tool)
            ? applyLayer(terrain, brush, tool, stroke.target, stroke.s)
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
          const target = !c ? 0 : tool === "cliffUp" ? c.layer + 1 : tool === "cliffDown" ? c.layer - 1 : groundHeight(c);
          stroke = { s: new Stroke(tool), target, last: performance.now() };
          applyAt(p);
        };
        const endStroke = () => {
          if (!stroke) return;
          if (stroke.s.finish(terrain)) {
            history.length = at;
            history.push(stroke.s);
            at = history.length;
            if (isLayerTool(stroke.s.label as Tool)) { replanCliffs(); renderer.terrainChanged(); redraw(); }
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

        if (!doc.path.startsWith("game:") && w3.workspace.project()) {
          Promise.all([
            readPlaced(w3, "war3map.doo", "doodads").catch(() => [] as Placed[]),
            readPlaced(w3, "war3mapUnits.doo", "units").catch(() => [] as Placed[]),
            loadSkins(w3),
            customBases(w3),
          ]).then(async ([doodads, units, skins, bases]) => {
            markerList.replaceChildren(markerToggle("doodads", "Doodads", doodads.length), markerToggle("units", "Units & items", units.length));
            const marker = (p: Placed, rgb: Vec3): Marker => ({ x: p.position[0], y: p.position[1], z: p.position[2], rgb });
            // Units take their player's colour; neutral players (24+) show as Coal.
            const team = (p: Placed) => (p.player !== undefined && p.player < TEAM_COLORS.length ? p.player : NEUTRAL);
            const baseOf = (id: string) => bases.get(id);
            const [d, u] = await Promise.all([loader.load("doodads", doodads, skins, () => 0, baseOf), loader.load("units", units, skins, team, baseOf)]);
            renderer.batches.push(...d.batches, ...u.batches);
            // Objects without a model (start locations, unknown ids) stay markers.
            renderer.setMarkers("doodads", d.unresolved.map((p) => marker(p, [90, 200, 90])));
            renderer.setMarkers("units", u.unresolved.map((p) => marker(p, p.id === "sloc" ? [255, 255, 255] : TEAM_COLORS[team(p)][1])));
            const errors = [...d.errors, ...u.errors];
            problems.replaceChildren(...errors.slice(0, 20).map((e) => h("div.model-warn", { title: e }, e)),
              ...(errors.length > 20 ? [h("div.muted", {}, `… ${errors.length - 20} more`)] : []));
            redraw();
          });
        }

        // ---- selection --------------------------------------------------------------
        const selInfo = h("div.terrain-selection.muted", {}, "Click a unit, item, doodad or destructable.");
        const row = (label: string, value: string) => h("div.terrain-sel-row", {}, h("span.muted", {}, label), h("span", {}, value));
        const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
        const selectObject = (inst: ObjectInstance) => {
          const p = inst.pick!, pl = p.placed;
          const nameEl = h("div.terrain-sel-name", {}, p.id);
          loadKind(w3, p.kind).then((k) => {
            const base = k.names.get(p.base ?? p.id);
            if (base) nameEl.textContent = p.base ? `${p.id} (custom, based on ${base})` : base;
          }).catch(() => { /* raw id stays */ });
          const owner = pl.player === undefined ? null : pl.player < 24 ? `Player ${pl.player + 1} (${TEAM_COLORS[pl.player]?.[0] ?? "?"})` : "Neutral";
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            nameEl,
            row("Type", `${KIND_LABELS[p.kind] ?? p.kind} · ${p.id}${p.base ? ` ← ${p.base}` : ""}`),
            ...(owner ? [row("Owner", owner)] : []),
            row("Position", pl.position.map(fmt).join(", ")),
            row("Facing", `${fmt((pl.angle * 180) / Math.PI)}°`),
            row("Scale", pl.scale.map(fmt).join(", ")),
            row("Variation", String(pl.variation)),
            row("Model", p.model),
            h("button", { onclick: () => w3.commands.execute("w3.objectEditor.open", p.kind, p.id).catch((e) => w3.window.showError(String(e))) }, "Open in Object Editor"),
          );
          const [x, y, , r] = inst.sphere!;
          renderer.setSelection({ x, y, r: Math.min(400, Math.max(40, r * 0.8)), rgb: pl.player !== undefined && pl.player < 24 ? TEAM_COLORS[pl.player][1] : [120, 255, 120] });
          redraw();
        };
        const clearSelection = () => {
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
            for (const [k, b] of buttons) b.classList.toggle("active", k === t);
            texWrap.hidden = t !== "paint";
            strengthWrap.hidden = t !== "raise" && t !== "lower";
            showBrush(null);
          };
          const tools: [Tool, string, string][] = [
            ["select", "Select", "Select units and doodads"], ["raise", "Raise", "Raise the ground"], ["lower", "Lower", "Lower the ground"],
            ["plateau", "Plateau", "Level to the height where the stroke starts"], ["smooth", "Smooth", "Smooth bumps"], ["paint", "Paint", "Paint a ground texture"],
            ["cliffUp", "Cliff ↑", "Raise a cliff level (one above where the stroke starts)"], ["cliffDown", "Cliff ↓", "Lower a cliff level"],
            ["shallow", "Shallow water", "Shallow water (one level below ground)"], ["deep", "Deep water", "Deep water (two levels below ground)"],
            ["dry", "Dry", "Remove water and return to ground level"],
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
            h("button", { title: "Undo (Ctrl+Z)", onclick: undo }, "↶"),
            h("button", { title: "Redo (Ctrl+Y)", onclick: redo }, "↷"),
          );
          setTool("select");
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
          if (e.button === 1) e.preventDefault();
          drag = { x: e.clientX, y: e.clientY, button: e.button };
          press = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
        });
        canvas.addEventListener("mousemove", (e) => {
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
          if (e.key === "Escape") return clearSelection();
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
        const onUp = () => { drag = null; endStroke(); };
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
