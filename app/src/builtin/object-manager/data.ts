// What the Object Manager lists: the map's contents by type, and which
// triggers use each thing (generated globals gg_…, object codes, variables).

import { placedName, ident, type PlacedJson } from "../../lib/script/jass";
import type { Param, TriggerFile } from "../../lib/triggers/wtg";

/** Where a double-click goes. */
export type Target =
  | { kind: "object"; ext: string; id: string }
  | { kind: "point"; x: number; y: number }
  | { kind: "trigger"; name: string }
  | { kind: "variables" }
  | { kind: "sounds" }
  | { kind: "imports" };

export interface Node {
  label: string;
  detail?: string;
  /** Key for the triggers using it (gg_ name, object code, "udg:<name>"). */
  ref?: string;
  target?: Target;
  children?: Node[];
}

type Placed = PlacedJson & { position: number[]; player?: number };

const NEUTRAL: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Victim", 26: "Neutral Extra", 27: "Neutral Passive" };
const owner = (p?: number) => (p === undefined ? "" : NEUTRAL[p] ?? `Player ${p + 1}`);
const at = (p: Placed) => `(${Math.round(p.position[0])}, ${Math.round(p.position[1])})`;

/** Triggers by what they refer to: gg_ globals, 4-character object codes, udg:<variable>. */
export function triggerRefs(file: TriggerFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, t: string) => { let s = out.get(key); if (!s) out.set(key, (s = new Set())); s.add(t); };
  for (const it of file.items) {
    if (!("ecas" in it) || it.type === 16) continue;
    const visitP = (p: Param) => {
      if (p.type === 1 && p.value) add(p.value.startsWith("gg_") ? p.value : `udg:${p.value}`, it.name);
      if (p.type === 3 && /^.{4}$/.test(p.value)) add(p.value, it.name);
      p.call?.params.forEach(visitP);
      if (p.index) visitP(p.index);
    };
    type E = { params: Param[]; children: E[] };
    const walk = (e: E) => { e.params.forEach(visitP); e.children.forEach(walk); };
    (it.ecas as E[]).forEach(walk);
  }
  return out;
}

export interface MapContents {
  units: Placed[];
  doodads: Placed[];
  /** Object kind of a type id: "w3u", "w3t", "w3b", "w3d" (from the object data). */
  kindOf: (id: string) => string;
  nameOf: (id: string) => string;
  custom: { ext: string; label: string; ids: { id: string; base: string }[] }[];
  regions: { name: string; left: number; right: number; bottom: number; top: number }[];
  cameras: { name: string; targetX: number; targetY: number }[];
  sounds: { name: string; file: string; flags: number }[];
  triggers: TriggerFile | null;
  imports: string[];
}

/** The tree: groups by type, with counts. */
export function buildTree(c: MapContents): Node[] {
  const placedGroup = (title: string, list: Placed[], ext: string, prefix: string): Node => {
    const byType = new Map<string, Placed[]>();
    for (const p of list) byType.set(p.id, [...(byType.get(p.id) ?? []), p]);
    const children = [...byType].map(([id, ps]): Node => ({
      label: `${c.nameOf(id)} (${ps.length})`, detail: id, ref: id, target: { kind: "object", ext, id },
      children: ps.map((p): Node => {
        const g = placedName(p, prefix);
        return { label: `${c.nameOf(id)} ${g.slice(-4)}`, detail: `${owner(p.player)} ${at(p)}`.trim(), ref: g, target: { kind: "point", x: p.position[0], y: p.position[1] } };
      }),
    })).sort((a, b) => a.label.localeCompare(b.label));
    return { label: `${title} (${list.length})`, children };
  };
  const unitList = c.units.filter((u) => u.id !== "sloc" && c.kindOf(u.id) !== "w3t");
  const items = c.units.filter((u) => c.kindOf(u.id) === "w3t");
  const starts = c.units.filter((u) => u.id === "sloc");
  const destructables = c.doodads.filter((d) => c.kindOf(d.id) === "w3b");
  const doodads = c.doodads.filter((d) => c.kindOf(d.id) !== "w3b");
  const triggerItems = c.triggers?.items.filter((i) => "ecas" in i && i.type !== 16) ?? [];
  const groups: Node[] = [
    placedGroup("Units", unitList, "w3u", "unit"),
    placedGroup("Items", items, "w3t", "item"),
    placedGroup("Destructables", destructables, "w3b", "dest"),
    placedGroup("Doodads", doodads, "w3d", "doodad"),
    { label: `Start locations (${starts.length})`, children: starts.map((s): Node => ({ label: owner(s.player) || "Start location", detail: at(s), target: { kind: "point", x: s.position[0], y: s.position[1] } })) },
    { label: `Custom objects (${c.custom.reduce((n, k) => n + k.ids.length, 0)})`, children: c.custom.filter((k) => k.ids.length).map((k): Node => ({
      label: `${k.label} (${k.ids.length})`,
      children: k.ids.map((o): Node => ({ label: `${c.nameOf(o.id)}`, detail: `${o.id} ← ${o.base}`, ref: o.id, target: { kind: "object", ext: k.ext, id: o.id } })),
    })) },
    { label: `Regions (${c.regions.length})`, children: c.regions.map((r): Node => ({
      label: r.name, ref: `gg_rct_${ident(r.name)}`, target: { kind: "point", x: (r.left + r.right) / 2, y: (r.bottom + r.top) / 2 },
    })) },
    { label: `Cameras (${c.cameras.length})`, children: c.cameras.map((cam): Node => ({
      label: cam.name, ref: `gg_cam_${ident(cam.name)}`, target: { kind: "point", x: cam.targetX, y: cam.targetY },
    })) },
    { label: `Sounds and music (${c.sounds.length})`, children: c.sounds.map((s): Node => ({
      label: s.name.replace(/^gg_snd_/, ""), detail: s.flags & 8 ? "music" : s.file, ref: s.name, target: { kind: "sounds" },
    })) },
    { label: `Triggers (${triggerItems.length})`, children: triggerItems.map((t): Node => ({ label: t.name, ref: `gg_trg_${ident(t.name)}`, target: { kind: "trigger", name: t.name } })) },
    { label: `Variables (${c.triggers?.variables.length ?? 0})`, children: (c.triggers?.variables ?? []).map((v): Node => ({
      label: v.name, detail: `${v.type}${v.isArray ? "[]" : ""}`, ref: `udg:${v.name}`, target: { kind: "variables" },
    })) },
    { label: `Imported files (${c.imports.length})`, children: c.imports.map((p): Node => ({ label: p, target: { kind: "imports" } })) },
  ];
  return groups;
}
