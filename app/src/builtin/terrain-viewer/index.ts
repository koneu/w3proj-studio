import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { decodeImage } from "../image-viewer/decode/index.ts";
import { TEAM_COLORS, type Vec3 } from "../model-viewer/renderer";
import { parseSlk } from "../object-editor/metadata";
import { planCliffs, type CliffType } from "./cliffs";
import { loadSkins, ObjectLoader, type Placed } from "./objects";
import { TerrainRenderer, type Marker } from "./renderer";
import { parseW3e } from "./w3e";

const PATH = "map/war3map.w3e";
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
        let terrain;
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
        Promise.all([w3.game.readText("TerrainArt\\CliffTypes.slk"), w3.game.list()]).then(async ([slk, list]) => {
          const types = new Map(parseSlk(slk).filter((r) => r.cliffID).map((r) => [r.cliffID, r as unknown as CliffType]));
          // Stored paths look like "War3.w3mod:_HD.w3mod:Doodads/…"; any layer will do.
          const files = new Set(list.map((p) => p.slice(p.lastIndexOf(":") + 1).toLowerCase()));
          const { requests, groundOverrides } = planCliffs(terrain, types, (p) => files.has(p.replace(/\\/g, "/").toLowerCase()));
          const { batches, failed } = await loader.loadModels("cliffs", requests);
          const broken = new Set(failed.map((f) => f.index));
          renderer.batches.push(...batches.map((b) => ({ ...b, followGround: true })));
          renderer.setCliffTiles(new Set(requests.flatMap((r, i) => (broken.has(i) ? [] : r.tiles))), groundOverrides);
          const tiles = requests.reduce((n, r) => n + r.tiles.length, 0);
          cliffInfo.textContent = `${tiles.toLocaleString()} cliff tiles · ${requests.length} cliff models${failed.length ? ` · ${failed.length} failed` : ""}`;
          if (failed.length) cliffInfo.title = failed.map((f) => f.error).join("\n");
          redraw();
        }).catch((e) => { cliffInfo.textContent = `Cliffs: ${(e as Error).message ?? e}`; });

        if (!doc.path.startsWith("game:") && w3.workspace.project()) {
          Promise.all([
            readPlaced(w3, "war3map.doo", "doodads").catch(() => [] as Placed[]),
            readPlaced(w3, "war3mapUnits.doo", "units").catch(() => [] as Placed[]),
            loadSkins(w3),
          ]).then(async ([doodads, units, skins]) => {
            markerList.replaceChildren(markerToggle("doodads", "Doodads", doodads.length), markerToggle("units", "Units & items", units.length));
            const marker = (p: Placed, rgb: Vec3): Marker => ({ x: p.position[0], y: p.position[1], z: p.position[2], rgb });
            // Units take their player's colour; neutral players (24+) show as Coal.
            const team = (p: Placed) => (p.player !== undefined && p.player < TEAM_COLORS.length ? p.player : NEUTRAL);
            const [d, u] = await Promise.all([loader.load("doodads", doodads, skins, () => 0), loader.load("units", units, skins, team)]);
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

        const tiles = `${terrain.width - 1} × ${terrain.height - 1}`;
        const side = h("div.model-side", {},
          h("h3", {}, TILESETS[terrain.tileset] ?? `Tileset ${terrain.tileset}`),
          h("div.model-facts", {},
            h("div", {}, `w3e v${terrain.version} · ${tiles} tiles`),
            h("div", {}, `${terrain.groundTiles.length} ground · ${terrain.cliffTiles.length} cliff textures`),
            cliffInfo, texInfo,
          ),
          h("h4", {}, `Ground textures (${terrain.groundTiles.length})`), texList,
          h("h4", {}, "Placed objects"), markerList, problems,
        );

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
              h("span.muted", {}, "Drag or arrow keys: pan · Right-drag: rotate · Wheel: zoom")),
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
        canvas.addEventListener("mousedown", (e) => { canvas.focus(); drag = { x: e.clientX, y: e.clientY, button: e.button }; });
        // Arrow keys scroll like in the World Editor.
        canvas.addEventListener("keydown", (e) => {
          const step = canvas.clientHeight / 6;
          const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (!d) return;
          e.preventDefault();
          pan(d[0], d[1]);
        });
        const onMove = (e: MouseEvent) => {
          if (!drag) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.x = e.clientX; drag.y = e.clientY;
          if (drag.button === 0) {
            pan(dx, dy);
          } else {
            renderer.yaw -= dx * 0.01;
            renderer.pitch = Math.max(0.15, Math.min(1.55, renderer.pitch + dy * 0.01));
          }
          redraw();
        };
        const onUp = () => { drag = null; };
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
