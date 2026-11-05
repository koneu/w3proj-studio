// Object Placer: placing units, items, doodads and destructables as a tool
// group of the terrain editor (service "w3.terrain"). One object per click,
// or Scatter (forests): a click or drag fills the brush, spaced by the
// objects' footprints, with random variation, facing and scale. Start locations: one per
// player, placing it again moves it; saving adds/moves/removes the map's players to match.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import {
  OBJECTS_SERVICE, TERRAIN_SERVICE,
  type ObjectsService, type PlacedEntry, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance,
} from "../../extensions/services";
import { TEAM_COLORS } from "../../lib/model/renderer";
import { heightAt } from "../../lib/terrain/w3e";
import { capped, readMapDoc, requireProject } from "../../lib/formats/mapdoc";
import { placedList, placedTypes, type PlacedThing } from "./placedinfo";
import { readArea } from "../../lib/terrain/area";
import { h } from "../../workbench/dom";

const NEUTRALS: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Extra", 26: "Neutral Victim", 27: "Neutral Passive" };
const ownerName = (n: number) => (n < 24 ? `Player ${n + 1} (${TEAM_COLORS[n]?.[0] ?? "?"})` : NEUTRALS[n] ?? `Player ${n + 1}`);

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(w3.mcp.registerTool("list_placed", async (args) => {
    const { kind, id, player, limit } = args;
    requireProject(w3);
    const key = kind === "doodads" ? "doodads" : "units";
    const file = await readMapDoc<Record<string, PlacedThing[]>>(w3, key === "units" ? "map/war3mapUnits.doo.json" : "map/war3map.doo.json");
    const all = file?.[key] ?? [];
    const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
    const names = new Map<string, string | undefined>();
    for (const type of new Set(all.map((p) => p.id))) names.set(type, await objects.name(type).catch(() => undefined));
    const area = await readArea(w3, args);
    if (typeof id === "string" || typeof player === "number" || area) {
      return capped(placedList(all, names, typeof id === "string" ? id : undefined, typeof player === "number" ? player : undefined, area), limit, 200);
    }
    return { placed: all.length, types: capped(placedTypes(all, names), limit, 200) };
  }));
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "objects", title: "Objects", order: 20, create: (ed) => placer(w3, ed) }));
  });
}

function placer(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  /** Type chosen with "Place…". */
  let placing: { kind: string; id: string; name: string } | null = null;
  let owner = 0, scatter = false, size = 2;
  const respect = () => w3.settings.get<boolean>("terrain.placement.respectPathing");
  const deg = (d: number) => (d * Math.PI) / 180;

  /** Ghost preview at the pointer: the latest request wins (fit checks are async). */
  let ghostSeq = 0;
  const showGhost = async (g: [number, number, number] | null) => {
    const seq = ++ghostSeq;
    if (!g || !placing || scatter) { ed.objects.setGhost(null); return; }
    const { kind, id } = placing;
    const type = ed.objects.type(id);
    const angle = type?.fixedRot != null ? deg(type.fixedRot) : deg(270);
    let ok = true;
    if (respect()) {
      const occ = await ed.objects.occupancy();
      ok = await occ.fits(kind, id, g[0], g[1], angle);
    }
    if (seq !== ghostSeq) return;
    ed.objects.setGhost({ id, x: g[0], y: g[1], angle, player: kind === "w3u" ? owner : undefined, ok });
  };

  const START = { kind: "w3u", id: "sloc", name: "Start Location" };
  const isStart = () => placing?.id === START.id;

  /** Places the owner's start location, or moves the one it has (same entry, so the file keeps
   *  its order and editor id); one undo step. Snapped to 64 like the game's maps' (730 of 732). */
  const placeStart = (pos: [number, number, number]) => {
    if (owner >= 24) { w3.window.showWarning("Start locations are for players 1–24, not neutral players."); return; }
    const x = Math.round(pos[0] / 64) * 64, y = Math.round(pos[1] / 64) * 64;
    const old = ed.objects.list().find((o) => o.id === START.id && o.player === owner);
    if (old) {
      const before = [...old.position] as [number, number, number], after: [number, number, number] = [x, y, heightAt(ed.terrain, x, y)];
      const set = (p: [number, number, number]) => { old.position = [...p]; ed.objects.update([old]); };
      set(after);
      ed.pushEdit({ undo: () => set(before), redo: () => set(after), terrain: false, objects: true });
      return;
    }
    const e = ed.objects.create(START.kind, START.id, { x, y, angle: deg(270), player: owner });
    if (typeof e === "string") { w3.window.showError(e); return; }
    ed.objects.insert([e]);
    ed.pushEdit({ undo: () => ed.objects.remove([e]), redo: () => ed.objects.insert([e]), terrain: false, objects: true });
  };

  /** A scatter drag: everything it places is one undo step. */
  let drag: { entries: PlacedEntry[]; last: [number, number, number]; queue: Promise<void> } | null = null;

  /** Places the chosen object at `pos`, or (with `stroke`) fills the brush there. */
  const placeAt = async (pos: [number, number, number], stroke?: { entries: PlacedEntry[] }) => {
    if (!placing) return;
    if (isStart()) { if (!stroke) placeStart(pos); return; }
    const { kind, id, name } = placing;
    const type = ed.objects.type(id);
    const occ = respect() || stroke ? await ed.objects.occupancy() : null;
    const fp = occ ? await occ.footprint(kind, id) : null;
    const facing = () => (type?.fixedRot != null ? deg(type.fixedRot) : stroke ? Math.random() * Math.PI * 2 : deg(270));

    const spots: { x: number; y: number; angle: number }[] = [];
    if (!stroke) {
      const angle = facing();
      if (respect() && fp && !(await occ!.fits(kind, id, pos[0], pos[1], angle))) {
        w3.window.showWarning(`No room for ${name} here (its footprint overlaps blocked ground or another object). Turn off "Respect pathing" to place it anyway.`);
        return;
      }
      spots.push({ x: pos[0], y: pos[1], angle });
    } else {
      // A jittered grid over the brush, spaced by the footprint (wider at lower density).
      const density = Math.min(1, Math.max(0.05, w3.settings.get<number>("terrain.placement.scatterDensity") ?? 1));
      const spacing = Math.max(64, fp ? Math.max(fp.width, fp.height) * 32 : 128) / Math.sqrt(density);
      const radius = size * 128;
      for (let gy = -radius; gy <= radius; gy += spacing) {
        for (let gx = -radius; gx <= radius; gx += spacing) {
          const x = pos[0] + gx + (Math.random() - 0.5) * spacing * 0.6, y = pos[1] + gy + (Math.random() - 0.5) * spacing * 0.6;
          if (Math.hypot(x - pos[0], y - pos[1]) > radius) continue;
          const angle = facing();
          // Snap to the pathing grid like the World Editor (cell centres for trees).
          const sx = Math.round(x / 32) * 32, sy = Math.round(y / 32) * 32;
          if (fp) {
            if (respect()) {
              if (!(await occ!.fits(kind, id, sx, sy, angle))) continue;
              await occ!.mark(kind, id, sx, sy, angle);
            } else if ([...spots, ...stroke.entries.map((e) => ({ x: e.position[0], y: e.position[1] }))]
              .some((s) => Math.hypot(s.x - sx, s.y - sy) < spacing * 0.75)) continue;
          }
          spots.push({ x: sx, y: sy, angle });
        }
      }
      if (!spots.length) return;
    }

    const entries: PlacedEntry[] = [];
    for (const s of spots) {
      const e = ed.objects.create(kind, id, { x: s.x, y: s.y, angle: s.angle, player: kind === "w3u" ? owner : undefined });
      if (typeof e === "string") { w3.window.showError(e); return; }
      if (stroke) {
        if ((type?.numVar ?? 1) > 1) e.variation = Math.floor(Math.random() * type!.numVar);
        if (type?.randScale && type.maxScale > type.minScale) {
          const k = type.minScale + Math.random() * (type.maxScale - type.minScale);
          e.scale = [k, k, k];
        }
      }
      entries.push(e);
    }
    ed.objects.insert(entries);
    if (stroke) stroke.entries.push(...entries);
    else ed.pushEdit({ undo: () => ed.objects.remove(entries), redo: () => ed.objects.insert(entries), terrain: false, objects: true });
  };

  // ---- toolbar -----------------------------------------------------------------------
  const hint = h("span.terrain-place-hint");
  const toggle = (label: string, title: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h("input", { type: "checkbox", checked: get(), onchange: () => { set(box.checked); ed.focus(); } });
    return h("label.terrain-place-opt", { title }, box, ` ${label}`);
  };
  const ownerSel = h("select", { title: "Owner of placed units", onchange: () => { owner = Number(ownerSel.value); ed.focus(); } },
    ...Array.from({ length: 28 }, (_, i) => h("option", { value: String(i), selected: i === owner }, ownerName(i))));
  const ownerWrap = h("span.terrain-tool-opt", {}, "for ", ownerSel);
  const sizeWrap = h("label.terrain-tool-opt", { title: "Scatter brush radius in tiles" }, "Size ",
    h("input", { type: "range", min: "1", max: "10", value: String(size), oninput: (e: Event) => { size = Number((e.target as HTMLInputElement).value); } }));
  const densityWrap = h("label.terrain-place-opt", { title: "Scatter density: 100% packs objects as close as their footprints allow (setting terrain.placement.scatterDensity)" }, "Density ",
    h("input", { type: "range", min: "10", max: "100", value: String(Math.round((w3.settings.get<number>("terrain.placement.scatterDensity") ?? 1) * 100)),
      onchange: (e: Event) => { void w3.settings.set("terrain.placement.scatterDensity", Number((e.target as HTMLInputElement).value) / 100); ed.focus(); } }));
  const update = () => {
    hint.textContent = !placing ? "Choose what to place."
      : isStart() ? "Placing the start location: click the ground (moves it if the player has one) · Esc to stop"
      : `Placing ${placing.name} (${placing.id}): click the ground · Esc to stop`;
    ownerWrap.hidden = placing?.kind !== "w3u";
    sizeWrap.hidden = densityWrap.hidden = !scatter || isStart();
  };
  const choose = async () => {
    try {
      const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
      const r = await objects.pick(ed.host, { title: "Place…", kinds: ["w3u", "w3t", "w3b", "w3d"] });
      if (r) placing = { kind: r.kind, id: r.id, name: r.name };
    } catch (e) {
      w3.window.showError(String((e as Error).message ?? e));
    }
    update();
    ed.focus();
  };
  const toolbar = h("div.terrain-group-tools", {},
    h("button", { title: "Choose a unit, item, doodad or destructable", onclick: () => void choose() }, "Place…"),
    h("button", { title: "Place or move a player's start location; saving adds, moves or removes the map's players to match",
      onclick: () => { placing = START; update(); ed.focus(); } }, "Start location"),
    hint, ownerWrap,
    toggle("Scatter", "Click or drag to fill the brush with this object, spaced by its footprint, with random variation, facing and scale",
      () => scatter, (v) => { scatter = v; update(); void showGhost(null); }),
    sizeWrap, densityWrap,
    toggle("Respect pathing", "Only place where the object's footprint is free (no cliffs, deep water or other objects); setting terrain.placement.respectPathing",
      () => respect(), (v) => void w3.settings.set("terrain.placement.respectPathing", v)),
  );
  update();

  return {
    toolbar,
    activate() { if (!placing) void choose(); },
    deactivate() { ed.setBrush(null); void showGhost(null); },
    pointerDown(p) {
      if (!ed.editable || !placing || !p.ground) return false;
      if (!scatter || isStart()) { void placeAt(p.ground); return true; }
      const d = { entries: [] as PlacedEntry[], last: p.ground, queue: Promise.resolve() };
      d.queue = placeAt(p.ground, d);
      drag = d;
      return true;
    },
    pointerMove(p) {
      ed.setBrush(scatter && placing && !isStart() && p.ground ? { x: p.ground[0], y: p.ground[1], r: size * 128, rgb: [140, 230, 140] } : null);
      void showGhost(p.ground);
      const d = drag;
      // Fills again once the pointer moved half a brush radius.
      if (p.down && d && p.ground && Math.hypot(p.ground[0] - d.last[0], p.ground[1] - d.last[1]) >= size * 64) {
        const g = p.ground;
        d.last = g;
        d.queue = d.queue.then(() => placeAt(g, d));
      }
    },
    pointerUp() {
      const d = drag;
      drag = null;
      if (!d) return;
      void d.queue.then(() => {
        if (!d.entries.length) { if (placing) w3.window.showWarning(`No free room for ${placing.name} under the brush.`); return; }
        const entries = d.entries;
        ed.pushEdit({ undo: () => ed.objects.remove(entries), redo: () => ed.objects.insert(entries), terrain: false, objects: true });
      });
    },
    pointerLeave() { ed.setBrush(null); void showGhost(null); },
    keyDown(e) {
      if (e.key === "Escape" && placing) { placing = null; update(); void showGhost(null); return true; }
      return false;
    },
  };
}
