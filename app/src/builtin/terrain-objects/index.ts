// Object Placer: placing units, items, doodads and destructables as a tool
// group of the terrain editor (service "w3.terrain"). One object per click,
// or Scatter (forests): a click or drag fills the brush, spaced by the
// objects' footprints, with random variation, facing and scale. Start locations: one per
// player, placing it again moves it; saving adds/moves/removes the map's players to match.
// One at a time, an object takes the toolbar's look (lib/terrain/randomplace): a chosen or random
// variation, random rotation and random scale. "Random…" places a Random Unit, Building or Item.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import {
  OBJECTS_SERVICE, TERRAIN_SERVICE,
  type ObjectsService, type PlacedEntry, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance,
} from "../../extensions/services";
import { TEAM_COLORS } from "../../lib/model/renderer";
import { heightAt } from "../../lib/terrain/w3e";
import { capped, mapStrings, readMapDoc, readMapDocStrict, requireProject } from "../../lib/formats/mapdoc";
import { applyRandom, autoCycleAfterPlace, placeAngle, DEFAULT_FACING, RANDOM_IDS, RANDOM_SCALES, randomName, rollLook, rotatesRandomly, type Look, type LookOptions, type RandomGroup, type RandomScale, type RandomSpec } from "../../lib/terrain/randomplace";
import { askRandom } from "./randomdialog";
import { placedList, placedTypes, type PlacedThing } from "./placedinfo";
import { readArea } from "../../lib/terrain/area";
import { h } from "../../workbench/dom";

const NEUTRALS: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Extra", 26: "Neutral Victim", 27: "Neutral Passive" };
const ownerName = (n: number) => (n < 24 ? `Player ${n + 1} (${TEAM_COLORS[n]?.[0] ?? "?"})` : NEUTRALS[n] ?? `Player ${n + 1}`);

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(w3.mcp.registerTool("list_placed", async (args) => {
    const { kind, id, player, limit, all: everything } = args;
    requireProject(w3);
    const key = kind === "doodads" ? "doodads" : "units";
    const file = await readMapDoc<Record<string, PlacedThing[]>>(w3, key === "units" ? "map/war3mapUnits.doo.json" : "map/war3map.doo.json");
    const all = file?.[key] ?? [];
    const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
    const names = new Map<string, string | undefined>();
    for (const type of new Set(all.map((p) => p.id))) names.set(type, await objects.name(type).catch(() => undefined));
    const area = await readArea(w3, args);
    if (everything === true || typeof id === "string" || typeof player === "number" || area) {
      return capped(placedList(all, names, typeof id === "string" ? id : undefined, typeof player === "number" ? player : undefined, area), limit, everything === true ? 20000 : 200);
    }
    return { placed: all.length, types: capped(placedTypes(all, names), limit, 200) };
  }));
  ctx.subscriptions.push(w3.commands.register("w3.terrainObjects.toggleAutoCycleRandomGroups", () =>
    w3.settings.set("terrain.placement.autoCycleRandomGroups", w3.settings.get<boolean>("terrain.placement.autoCycleRandomGroups", true) === false)));
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "objects", title: "Objects", order: 20, create: (ed) => placer(w3, ed) }));
  });
}

function placer(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  /** Type chosen with "Place…", or a random unit, building or item chosen with "Random…". */
  let placing: { kind: string; id: string; name: string; random?: RandomSpec } | null = null;
  let owner = 0, scatter = false, size = 2;
  const respect = () => w3.settings.get<boolean>("terrain.placement.respectPathing");
  const deg = (d: number) => (d * Math.PI) / 180;

  /** A variation chosen in the toolbar for the type being placed; null: random or the first (the setting). */
  let chosenVariation: number | null = null;
  const lookOptions = (): LookOptions => ({
    variation: chosenVariation,
    randomVariation: w3.settings.get<boolean>("terrain.placement.randomVariation") === true,
    randomRotation: w3.settings.get<boolean>("terrain.placement.randomRotation", true) !== false,
    randomScale: w3.settings.get<RandomScale>("terrain.placement.randomScale") ?? "symmetric",
  });
  /** How the next single placement looks: rolled ahead, so the ghost shows what a click places. */
  let next: Look | null = null;
  let lastGround: [number, number, number] | null = null;
  const reroll = () => {
    next = placing ? rollLook(ed.objects.type(placing.id), lookOptions()) : null;
    void showGhost(lastGround);
  };

  /** Ghost preview at the pointer: the latest request wins (fit checks are async). */
  let ghostSeq = 0;
  const showGhost = async (g: [number, number, number] | null) => {
    const seq = ++ghostSeq;
    if (!g || !placing || scatter) { ed.objects.setGhost(null); return; }
    const { kind, id } = placing;
    const type = ed.objects.type(id);
    const angle = next?.angle ?? (type?.fixedRot != null ? deg(type.fixedRot) : deg(DEFAULT_FACING));
    let ok = true;
    const [x, y] = kind === "w3u" ? await ed.objects.buildingSpot(id, g[0], g[1]) : g;
    if (respect()) {
      const occ = await ed.objects.occupancy();
      ok = ed.objects.backdrop(kind, x, y) || await occ.fits(kind, id, x, y, angle);
    }
    ok = ok && ed.objects.inBounds(x, y);
    if (seq !== ghostSeq) return;
    ed.objects.setGhost({ id, x, y, angle, variation: next?.variation, player: kind === "w3u" ? owner : undefined, ok });
  };

  const START = { kind: "w3u", id: "sloc", name: "Start Location" };
  const isStart = () => placing?.id === START.id;

  /** Places the owner's start location, or moves the one it has (same entry, so the file keeps
   *  its order and editor id); one undo step. Snapped to 64 like the game's maps' (730 of 732). */
  const placeStart = (pos: [number, number, number]) => {
    if (owner >= 24) { w3.window.showWarning("Start locations are for players 1–24, not neutral players."); return; }
    const x = Math.round(pos[0] / 64) * 64, y = Math.round(pos[1] / 64) * 64;
    if (!ed.objects.inBounds(x, y)) { w3.window.showWarning(ed.objects.refusedOutside("that is")); return; }
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

  const autoCycle = () => w3.settings.get<boolean>("terrain.placement.autoCycleRandomGroups", true) !== false;

  /** Places the chosen object at `pos`, or (with `stroke`) fills the brush there. */
  const placeAt = async (pos: [number, number, number], stroke?: { entries: PlacedEntry[] }) => {
    if (!placing) return;
    if (isStart()) { if (!stroke) placeStart(pos); return; }
    const { kind, id, name, random } = placing;
    const type = ed.objects.type(id);
    // Taken before the waits below: a click places what its ghost showed, even if the pointer moved on meanwhile.
    const look = stroke ? null : next ?? rollLook(type, lookOptions());
    const occ = respect() || stroke ? await ed.objects.occupancy() : null;
    const fp = occ ? await occ.footprint(kind, id) : null;
    const facing = () => placeAngle(type, lookOptions().randomRotation);

    const spots: { x: number; y: number; angle: number }[] = [];
    if (!stroke) {
      const angle = look!.angle;
      const [x, y] = kind === "w3u" ? await ed.objects.buildingSpot(id, pos[0], pos[1]) : pos;
      if (!ed.objects.inBounds(x, y)) {
        w3.window.showWarning(ed.objects.refusedOutside("that is"));
        return;
      }
      if (respect() && fp && !ed.objects.backdrop(kind, x, y) && !(await occ!.fits(kind, id, x, y, angle))) {
        w3.window.showWarning(`No room for ${name} here (its footprint overlaps blocked ground or another object). Turn off "Respect pathing" to place it anyway.`);
        return;
      }
      spots.push({ x, y, angle });
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
          const [sx, sy] = kind === "w3u" ? await ed.objects.buildingSpot(id, Math.round(x / 32) * 32, Math.round(y / 32) * 32) : [Math.round(x / 32) * 32, Math.round(y / 32) * 32];
          if (!ed.objects.inBounds(sx, sy)) continue;
          if (fp) {
            if (respect()) {
              if (!ed.objects.backdrop(kind, sx, sy) && !(await occ!.fits(kind, id, sx, sy, angle))) continue;
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
      } else {
        e.variation = look!.variation;
        e.scale = [...look!.scale];
      }
      if (random) applyRandom(e as unknown as Record<string, unknown>, random);
      entries.push(e);
    }
    ed.objects.insert(entries);
    autoCycleAfterPlace(random, autoCycle(), (step) => void ed.cycleRandomGroups(step).catch(() => undefined));
    if (stroke) stroke.entries.push(...entries);
    else {
      ed.pushEdit({ undo: () => ed.objects.remove(entries), redo: () => ed.objects.insert(entries), terrain: false, objects: true });
      // The next one looks different again (when anything is random).
      if (placing?.id === id) reroll();
    }
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
  // Per placement (not Scatter, which always varies): Variation, Random Rotation and Random Scale, as the World
  // Editor's palettes and Tools › Random Doodad Scaling. Settings, so they stay for the next session.
  const variationSel = h("select.terrain-place-variation", { title: "Variation of the placed object: one of the type's, or a random one each time (setting terrain.placement.randomVariation)",
    onchange: () => {
      if (variationSel.value === "random") { chosenVariation = null; void w3.settings.set("terrain.placement.randomVariation", true); }
      else { chosenVariation = Number(variationSel.value); void w3.settings.set("terrain.placement.randomVariation", false); }
      reroll();
      ed.focus();
    } });
  const variationWrap = h("label.terrain-tool-opt", {}, "Variation ", variationSel);
  const rotationWrap = toggle("Random rotation", "Each placed object faces a random way (types with a fixed rotation keep theirs); setting terrain.placement.randomRotation",
    () => w3.settings.get<boolean>("terrain.placement.randomRotation", true) !== false, (v) => { void w3.settings.set("terrain.placement.randomRotation", v).then(reroll); });
  rotationWrap.classList.add("terrain-place-rotation");
  const scaleSel = h("select.terrain-place-scale", { title: "Random Scale within the type's scale range: the same on every axis (symmetric), each axis on its own (asymmetric), only the height (Z) or only the width (XY); setting terrain.placement.randomScale",
    onchange: () => { void w3.settings.set("terrain.placement.randomScale", scaleSel.value).then(reroll); ed.focus(); } },
    ...RANDOM_SCALES.map(([v, label]) => h("option", { value: v, selected: v === lookOptions().randomScale }, label)));
  const scaleWrap = h("label.terrain-tool-opt", {}, "Random scale ", scaleSel);
  /** The variations of the type being placed (and Random); what was chosen stays while the type does. */
  const fillVariations = () => {
    const n = placing && !isStart() ? ed.objects.type(placing.id)?.numVar ?? 1 : 1;
    variationSel.replaceChildren(h("option", { value: "random" }, "Random"), ...Array.from({ length: n }, (_, i) => h("option", { value: String(i) }, String(i + 1))));
    variationSel.value = chosenVariation !== null && chosenVariation < n ? String(chosenVariation) : lookOptions().randomVariation ? "random" : "0";
    variationWrap.hidden = n <= 1 || scatter;
  };
  const update = () => {
    hint.textContent = !placing ? "Choose what to place: Place…, Random… or Start location."
      : isStart() ? "Placing the start location: click the ground (moves it if the player has one) · Esc to stop"
      : `Placing ${placing.name} (${placing.id}): click the ground · Esc to stop`;
    ownerWrap.hidden = placing?.kind !== "w3u";
    sizeWrap.hidden = densityWrap.hidden = !scatter || isStart();
    const type = placing && !isStart() ? ed.objects.type(placing.id) : null;
    fillVariations();
    rotationWrap.hidden = !placing || isStart() || scatter || type?.fixedRot != null || !rotatesRandomly(type);
    scaleWrap.hidden = !placing || isStart() || scatter || !(type?.randScale && type.maxScale > type.minScale);
  };
  /** Starts placing another type: its look is rolled anew, a variation chosen for the last one doesn't carry over. */
  const startPlacing = (p: typeof placing) => {
    if (p?.id !== placing?.id || p?.random !== placing?.random) chosenVariation = null;
    placing = p;
    update();
    reroll();
  };
  const choose = async () => {
    try {
      const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
      const r = await objects.pick(ed.host, { title: "Place…", kinds: ["w3u", "w3t", "w3b", "w3d"] });
      if (r) startPlacing({ kind: r.kind, id: r.id, name: r.name });
    } catch (e) {
      w3.window.showError(String((e as Error).message ?? e));
    }
    update();
    ed.focus();
  };
  /** Random Unit, Building or Item, by level or from one of Map Properties' random groups. */
  let lastRandom: RandomSpec | null = null;
  const chooseRandom = async () => {
    try {
      const strings = await mapStrings(w3).catch(() => (v: string) => v);
      // A file that isn't there has no groups; one that can't be read is said, and only Random is offered.
      const info = await readMapDocStrict<{ unitTables?: RandomGroup[] }>(w3, "map/war3map.w3i.json").catch((e) => {
        w3.window.showWarning(`Map Properties couldn't be read, so its random groups aren't offered: ${(e as Error).message ?? e}`);
        return null;
      });
      const groups = (info?.unitTables ?? []).map((g) => ({ ...g, name: strings(g.name) }));
      const spec = await askRandom(ed.host, groups, lastRandom);
      if (spec) {
        lastRandom = spec;
        const id = RANDOM_IDS[spec.what];
        startPlacing({ kind: spec.what === "item" ? "w3t" : "w3u", id, name: randomName(spec, groups), random: spec });
      }
    } catch (e) {
      w3.window.showError(String((e as Error).message ?? e));
    }
    ed.focus();
  };
  const select = async (what: { kind: string; id: string; player?: number }) => {
    if (what.id === START.id) startPlacing(START);
    else if (/^[uib]DNR$/.test(what.id)) {
      // A random object chosen from the map: random again, of any level (Random… sets the rest).
      const spec: RandomSpec = { what: what.id === "iDNR" ? "item" : what.id === "bDNR" ? "building" : "unit", by: "level", level: -1 };
      startPlacing({ kind: spec.what === "item" ? "w3t" : "w3u", id: what.id, name: randomName(spec), random: spec });
    } else {
      const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
      startPlacing({ kind: what.kind, id: what.id, name: await objects.name(what.id, [what.kind]).catch(() => undefined) ?? what.id });
    }
    if (what.kind === "w3u" && typeof what.player === "number" && what.player >= 0 && what.player < 28) { owner = what.player; ownerSel.value = String(owner); }
    update();
    void showGhost(null);
    return true;
  };
  const toolbar = h("div.terrain-group-tools", {},
    h("button", { title: "Choose a unit, item, doodad or destructable", onclick: () => void choose() }, "Place…"),
    h("button.terrain-place-random", { title: "Place a Random Unit, Random Building or Random Item: chosen when the game starts, by level or from a random group of Map Properties",
      onclick: () => void chooseRandom() }, "Random…"),
    h("button", { title: "Place or move a player's start location; saving adds, moves or removes the map's players to match",
      onclick: () => { startPlacing(START); ed.focus(); } }, "Start location"),
    hint, ownerWrap, variationWrap, rotationWrap, scaleWrap,
    toggle("Scatter", "Click or drag to fill the brush with this object, spaced by its footprint, with random variation, facing and scale",
      () => scatter, (v) => { scatter = v; update(); void showGhost(null); }),
    sizeWrap, densityWrap,
    toggle("Auto cycle random groups", "After placing a unit or item from a random group, show the next line of the groups, as Cycle Random Groups - Next; setting terrain.placement.autoCycleRandomGroups",
      () => autoCycle(), (v) => void w3.settings.set("terrain.placement.autoCycleRandomGroups", v)),
    toggle("Respect pathing", "Only place where the object's footprint is free (no cliffs, deep water or other objects); setting terrain.placement.respectPathing",
      () => respect(), (v) => void w3.settings.set("terrain.placement.respectPathing", v)),
  );
  update();

  return {
    toolbar,
    select,
    // No activate: opening the tab asks nothing (the object browser lay over the view and this toolbar); Place… and
    // the hint are there.
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
      lastGround = p.ground ?? null;
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
    pointerLeave() { lastGround = null; ed.setBrush(null); void showGhost(null); },
    // Escape (the view's Cancel) stops placing.
    cancel() {
      if (!placing) return false;
      placing = null; update(); void showGhost(null);
      return true;
    },
  };
}
