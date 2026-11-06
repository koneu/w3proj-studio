// What the Object Manager lists: the map's contents by type, and which
// triggers use each thing (generated globals gg_…, object codes, variables).

import { ownerOf } from "../../lib/terrain/owner";
import { placedName, ident, type PlacedJson } from "../../lib/script/jass";
import type { TriggerFile } from "../../lib/triggers/wtg";

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
  /** A custom object: tells whether it's used anywhere (see markUnused). */
  custom?: boolean;
  /** Nothing uses it. */
  unused?: boolean;
}

type Placed = PlacedJson & { position: number[]; player?: number };

const NEUTRAL: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Victim", 26: "Neutral Extra", 27: "Neutral Passive" };
const owner = (player?: number) => { const p = ownerOf(player); return p === undefined ? "" : NEUTRAL[p] ?? `Player ${p + 1}`; };
const at = (p: Placed) => `(${Math.round(p.position[0])}, ${Math.round(p.position[1])})`;

/** What object data holds per object (field values are strings, ints, reals). */
export interface ObjectEntry { id?: string; base: string; mods?: { value: unknown }[]; sets?: { mods: { value: unknown }[] }[] }

/** Which object uses which of `ids`: values of its fields ("Y01q,Y01w" for abilities and the
 *  like). Key: the id used; value: the users' labels with where they go. */
export function objectRefs(kinds: { ext: string; label: string; objects: ObjectEntry[] }[], ids: ReadonlySet<string>, nameOf: (id: string) => string): Map<string, Map<string, Target>> {
  const out = new Map<string, Map<string, Target>>();
  for (const { ext, label, objects } of kinds) {
    for (const o of objects) {
      const self = o.id ?? o.base;
      for (const m of [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)]) {
        if (typeof m.value !== "string") continue;
        for (const token of m.value.split(/[,;\s]+/)) {
          if (token === self || !ids.has(token)) continue;
          let users = out.get(token);
          if (!users) out.set(token, (users = new Map()));
          users.set(`${label}: ${nameOf(self)}`, { kind: "object", ext, id: self });
        }
      }
    }
  }
  return out;
}

/** Those of `ids` that a text mentions as a whole word: JASS 'h000', Lua FourCC("h000"), JSON "h000". */
export function idsInText(text: string, ids: ReadonlySet<string>): string[] {
  return [...new Set(text.match(/(?<![A-Za-z0-9])[A-Za-z0-9]{4}(?![A-Za-z0-9])/g) ?? [])].filter((t) => ids.has(t));
}

/** Marks custom objects nothing uses, returning how many. `isUsed` should rather say yes: this
 *  invites deleting what it lists. */
export function markUnused(nodes: Node[], isUsed: (ref: string) => boolean): number {
  let n = 0;
  for (const node of nodes) {
    if (node.custom && node.ref) { node.unused = !isUsed(node.ref); if (node.unused) n++; }
    if (node.children) n += markUnused(node.children, isUsed);
  }
  return n;
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
  /** Object data of every type (standard objects' changes too). */
  objects: { ext: string; label: string; objects: ObjectEntry[] }[];
  /** Texts that can mention object ids: the map script, placed objects, map info. */
  texts: string[];
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
      children: k.ids.map((o): Node => ({ label: `${c.nameOf(o.id)}`, detail: `${o.id} ← ${o.base}`, ref: o.id, custom: true, target: { kind: "object", ext: k.ext, id: o.id } })),
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
