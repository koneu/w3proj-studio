// What the Object Manager lists: the map's contents by type, and which
// triggers use each thing (generated globals gg_…, object codes, variables).

import { ownerOf } from "../../lib/terrain/owner";
import { placedName, ident, type PlacedJson } from "../../lib/script/jass";
import type { TriggerFile } from "../../lib/triggers/wtg";
import { idsUsedBy } from "../../lib/objects/refs";

/** Tells which project (root) the rows belong to, and whether a finished build is still
 *  wanted: a build started for one project is dropped once the project changed, even if
 *  the user switched back to it (the newer build is the one that counts). */
export class ProjectGuard {
  private gen = 0;
  private current: string | null;
  constructor(root: string | null) { this.current = root; }
  /** Starts a build: the token to give back to `valid`. */
  begin(): number { return ++this.gen; }
  /** Call on every workspace change; true when the project is another one now. */
  switched(root: string | null): boolean {
    if (root === this.current) return false;
    this.current = root;
    this.gen++;
    return true;
  }
  /** Is `root` open without the guard having been told yet (the workspace sets the project
   *  first and fires its change event later, and fires none if opening fails half way)? */
  stale(root: string | null): boolean { return root !== this.current; }
  /** Is the build of `token` still for the open project? */
  valid(token: number, root: string | null): boolean { return token === this.gen && root === this.current; }
  /** Does something made for `root` (a rendered row) still belong to the project `open` now? */
  owns(root: string | null, open: string | null): boolean { return root === this.current && open === this.current; }
}

/** Where a double-click goes. */
export type Target =
  | { kind: "object"; ext: string; id: string }
  | { kind: "point"; x: number; y: number; /** A placed object: selected too. */ id?: string; editorId?: number }
  | { kind: "trigger"; name: string }
  | { kind: "variables"; /** The variable, for renaming and deleting it. */ name?: string }
  | { kind: "sounds"; /** The sound (gg_snd_…) and its file, for playing, renaming and deleting it. */ name?: string; file?: string }
  | { kind: "imports"; /** The import's archive path, for renaming (Change path) and deleting (Remove) it in the Import Manager. */ path?: string };

/** What the Object Manager's menu offers for an entry: Edit Object Properties (going to it in its editor), and where
 *  the owning editor can do it, Rename Object, Delete Object and Play Sound. */
export interface NodeActions { edit: boolean; rename: boolean; remove: boolean; play: boolean }
export function nodeActions(n: Node): NodeActions {
  const t = n.target;
  const own = !!n.item || (!!t && ((t.kind === "object" && n.custom === true) || t.kind === "trigger" || (t.kind === "variables" && !!t.name) || (t.kind === "sounds" && !!t.name) || (t.kind === "imports" && !!t.path)));
  return { edit: !!t, rename: own, remove: own || n.placed === true, play: t?.kind === "sounds" && !!t.file };
}

/** What Edit Object Properties runs for an entry: a region or camera is selected in its tab of the terrain editor (and
 *  centred there); other entries go to their target (`go`). */
export function editCommand(n: Node): { command: string; args: unknown[] } | null {
  return n.item ? { command: "w3.terrain.groupItemAction", args: [n.item.group, n.item.name, "select"] } : null;
}

/** The triggers (sorted) that use an entry: a region (gg_rct_), camera (gg_cam_), variable (udg:), trigger, sound or object id. */
export function triggersUsing(refs: ReadonlyMap<string, ReadonlySet<string>>, n: Node): string[] {
  return n.ref ? [...(refs.get(n.ref) ?? [])].sort() : [];
}

/** A region or camera: the terrain editor's tab that holds it (w3.terrain.groupItemAction renames and deletes it there). */
export interface ListItem { group: "regions" | "cameras"; name: string }

/** A group row's "Open …" entry: the editor its entries belong to, by command. */
export interface GroupOpen { label: string; command: string; args: unknown[] }

/** A group row's menu (a row with entries under it): Expand or Collapse, and Open … where its entries have an editor.
 *  `filtering`: a filter is on, which opens the groups by itself, so there is nothing to expand or collapse. */
export function groupActions(n: Node, isOpen: boolean, filtering = false): ({ label: string; toggle: true } | { label: string; opens: GroupOpen })[] {
  if (!n.children?.length && !n.opens) return [];
  return [...(n.children?.length && !filtering ? [{ label: isOpen ? "Collapse" : "Expand", toggle: true as const }] : []), ...(n.opens ? [{ label: n.opens.label, opens: n.opens }] : [])];
}

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
  /** A region or camera (renamed and deleted in its terrain tab). */
  item?: ListItem;
  /** A placed unit, item, doodad or destructable: deleted in the terrain editor (no rename: its gg_ name follows from its place in the list). */
  placed?: boolean;
  /** A group: the editor that holds its entries. */
  opens?: GroupOpen;
}

type Placed = PlacedJson & { position: number[]; player?: number };

const NEUTRAL: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Victim", 26: "Neutral Extra", 27: "Neutral Passive" };
const owner = (player?: number) => { const p = ownerOf(player); return p === undefined ? "" : NEUTRAL[p] ?? `Player ${p + 1}`; };
const at = (p: Placed) => `(${Math.round(p.position[0])}, ${Math.round(p.position[1])})`;

/** What object data holds per object (field values are strings, ints, reals). */
export interface ObjectEntry { id?: string; base: string; mods?: { field?: string; value: unknown }[]; sets?: { mods: { field?: string; value: unknown }[] }[] }

/** Which object uses which of `ids`: values of its fields ("Y01q,Y01w" for abilities and the
 *  like). Key: the id used; value: the users' labels with where they go. */
export function objectRefs(kinds: { ext: string; label: string; objects: ObjectEntry[] }[], ids: ReadonlySet<string>, nameOf: (id: string) => string): Map<string, Map<string, Target>> {
  const out = new Map<string, Map<string, Target>>();
  for (const { ext, label, objects } of kinds) {
    for (const o of objects) {
      const self = o.id ?? o.base;
      for (const token of idsUsedBy(o, ids)) {
        let users = out.get(token);
        if (!users) out.set(token, (users = new Map()));
        users.set(`${label}: ${nameOf(self)}`, { kind: "object", ext, id: self });
      }
    }
  }
  return out;
}

/** One kind's object data, saved (war3map.<ext>.json) or as an open Object Editor holds it (with its custom objects'
 *  names). */
export interface KindData { custom?: readonly ObjectEntry[]; original?: readonly ObjectEntry[]; names?: ReadonlyMap<string, string> }

/** The object data of every kind in `kinds` ([ext, label]): an open editor's (`live`) where there is one, else the saved
 *  file's (`saved`, null when absent). The custom ids per kind, every object per kind, and the names the editors show. */
export function objectKinds(kinds: readonly [string, string][], saved: ReadonlyMap<string, KindData | null>, live: ReadonlyMap<string, KindData>):
  { custom: MapContents["custom"]; objects: MapContents["objects"]; names: Map<string, string> } {
  const custom: MapContents["custom"] = [], objects: MapContents["objects"] = [], names = new Map<string, string>();
  for (const [ext, label] of kinds) {
    const file = live.get(ext) ?? saved.get(ext) ?? null;
    const own = (file?.custom ?? []).filter((o): o is ObjectEntry & { id: string } => typeof o.id === "string");
    custom.push({ ext, label, ids: own.map((o) => ({ id: o.id, base: o.base })) });
    objects.push({ ext, label: label.replace(/s$/, ""), objects: [...(file?.original ?? []), ...(file?.custom ?? [])] });
    for (const [id, n] of file?.names ?? []) names.set(id, n);
  }
  return { custom, objects, names };
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
  /** Map Properties' name (its text), playable size and tileset, for the summary; null without war3map.w3i. */
  info?: { name: string; playableWidth: number; playableHeight: number; tileset: string } | null;
}

/** The World Editor's Map Summary (Object Manager): what the map holds, counted per kind, as [label, value] rows. */
export function mapSummary(c: MapContents): [string, string][] {
  const rows: [string, string][] = [];
  if (c.info) rows.push(["Map Name", c.info.name], ["Playable Map Size", `${c.info.playableWidth} × ${c.info.playableHeight}`], ["Tileset", c.info.tileset]);
  const units = c.units.filter((u) => u.id !== "sloc" && c.kindOf(u.id) !== "w3t");
  rows.push(["Total Units", String(units.length)]);
  // Units per owner, in player order (neutral ones after the players).
  const byOwner = new Map<number, number>();
  for (const u of units) { const p = ownerOf(u.player) ?? -1; byOwner.set(p, (byOwner.get(p) ?? 0) + 1); }
  for (const [p, n] of [...byOwner].sort((a, b) => a[0] - b[0])) rows.push([`Units (${owner(p < 0 ? undefined : p) || "no owner"})`, String(n)]);
  const custom = (ext: string) => c.custom.find((k) => k.ext === ext)?.ids.length ?? 0;
  rows.push(
    ["Items", String(c.units.filter((u) => c.kindOf(u.id) === "w3t").length)],
    ["Doodads (Trees/Destructibles)", String(c.doodads.filter((d) => c.kindOf(d.id) === "w3b").length)],
    ["Doodads (Other)", String(c.doodads.filter((d) => c.kindOf(d.id) !== "w3b").length)],
    ["Regions", String(c.regions.length)],
    ["Cameras", String(c.cameras.length)],
    ["Triggers", String(c.triggers?.items.filter((i) => "ecas" in i && i.type !== 16 && !i.isComment).length ?? 0)],
    ["Variables", String(c.triggers?.variables.length ?? 0)],
    ["Sounds", String(c.sounds.length)],
    ["Custom Objects (Total)", String(c.custom.reduce((n, k) => n + k.ids.length, 0))],
    ["Custom Units", String(custom("w3u"))],
    ["Custom Items", String(custom("w3t"))],
    ["Custom Destructibles", String(custom("w3b"))],
    ["Custom Doodads", String(custom("w3d"))],
    ["Custom Abilities", String(custom("w3a"))],
    ["Custom Buffs/Effects", String(custom("w3h"))],
    ["Custom Upgrades", String(custom("w3q"))],
  );
  return rows;
}

/** The tree: groups by type, with counts. */
export function buildTree(c: MapContents): Node[] {
  const OBJECT_EDITOR = (ext: string): GroupOpen => ({ label: "Open Object Editor", command: "w3.objectEditor.open", args: [ext] });
  const TAB = (group: ListItem["group"], label: string): GroupOpen => ({ label, command: "w3.terrain.groupItemAction", args: [group, null, "select"] });
  const placedGroup = (title: string, list: Placed[], ext: string, prefix: string): Node => {
    const byType = new Map<string, Placed[]>();
    // Pushed, not copied: a big map has thousands of trees of one type.
    for (const p of list) { const ps = byType.get(p.id); if (ps) ps.push(p); else byType.set(p.id, [p]); }
    const children = [...byType].map(([id, ps]): Node => ({
      label: `${c.nameOf(id)} (${ps.length})`, detail: id, ref: id, target: { kind: "object", ext, id },
      children: ps.map((p): Node => {
        const g = placedName(p, prefix);
        return { label: `${c.nameOf(id)} ${g.slice(-4)}`, detail: `${owner(p.player)} ${at(p)}`.trim(), ref: g, placed: true, target: { kind: "point", x: p.position[0], y: p.position[1], id, editorId: typeof p.editorId === "number" ? p.editorId : undefined } };
      }),
    })).sort((a, b) => a.label.localeCompare(b.label));
    return { label: `${title} (${list.length})`, children, opens: OBJECT_EDITOR(ext) };
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
    { label: `Start locations (${starts.length})`, opens: { label: "Open Terrain Editor", command: "w3.terrain.open", args: [] },
      children: starts.map((s): Node => ({ label: owner(s.player) || "Start location", detail: at(s), target: { kind: "point", x: s.position[0], y: s.position[1] } })) },
    { label: `Custom objects (${c.custom.reduce((n, k) => n + k.ids.length, 0)})`, children: c.custom.filter((k) => k.ids.length).map((k): Node => ({
      label: `${k.label} (${k.ids.length})`, opens: OBJECT_EDITOR(k.ext),
      children: k.ids.map((o): Node => ({ label: `${c.nameOf(o.id)}`, detail: `${o.id} ← ${o.base}`, ref: o.id, custom: true, target: { kind: "object", ext: k.ext, id: o.id } })),
    })) },
    { label: `Regions (${c.regions.length})`, opens: TAB("regions", "Open Regions Tab"), children: c.regions.map((r): Node => ({
      label: r.name, ref: `gg_rct_${ident(r.name)}`, target: { kind: "point", x: (r.left + r.right) / 2, y: (r.bottom + r.top) / 2 }, item: { group: "regions", name: r.name },
    })) },
    { label: `Cameras (${c.cameras.length})`, opens: TAB("cameras", "Open Cameras Tab"), children: c.cameras.map((cam): Node => ({
      label: cam.name, ref: `gg_cam_${ident(cam.name)}`, target: { kind: "point", x: cam.targetX, y: cam.targetY }, item: { group: "cameras", name: cam.name },
    })) },
    { label: `Sounds and music (${c.sounds.length})`, opens: { label: "Open Sound Editor", command: "w3.sounds.open", args: [] }, children: c.sounds.map((s): Node => ({
      label: s.name.replace(/^gg_snd_/, ""), detail: s.flags & 8 ? "music" : s.file, ref: s.name, target: { kind: "sounds", name: s.name, file: s.file },
    })) },
    { label: `Triggers (${triggerItems.length})`, opens: { label: "Open Trigger Editor", command: "w3.triggers.open", args: [] },
      children: triggerItems.map((t): Node => ({ label: t.name, ref: `gg_trg_${ident(t.name)}`, target: { kind: "trigger", name: t.name } })) },
    { label: `Variables (${c.triggers?.variables.length ?? 0})`, opens: { label: "Open Variables", command: "w3.triggers.variables", args: [] }, children: (c.triggers?.variables ?? []).map((v): Node => ({
      label: v.name, detail: `${v.type}${v.isArray ? "[]" : ""}`, ref: `udg:${v.name}`, target: { kind: "variables", name: v.name },
    })) },
    { label: `Imported files (${c.imports.length})`, opens: { label: "Open Import Manager", command: "w3.imports.open", args: [] },
      children: c.imports.map((p): Node => ({ label: p, target: { kind: "imports", path: p } })) },
  ];
  return groups;
}
