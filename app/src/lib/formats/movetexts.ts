// Move Texts to String Table: what the World Editor does to a map's texts when it saves it, as a command of its own
// (Studio's save keeps the texts where they are; packing only drops unused strings: builtin/map-project/prunestrings.ts). Literal texts of some object fields and of the players' and forces' names
// go into war3map.wts as new strings, the fields then refer to them ("TRIGSTR_007"), and strings nothing refers to any
// more leave the table.
//
// What the World Editor moves (we-drive on a copy of cliff.w3m with literal texts, 2026-11-10): the object fields
// below, in the main object files and the Skin ones; the players' and forces' names. It leaves literal: models,
// races, target lists (umdl, urac, ua1p, atar), the map's name, author, description, suggested players, and the
// loading-screen and prologue texts. Empty texts stay literal (Firebrand Exarchate Race, saved by it, has some).
// Its new strings go on after the highest number; each object string gets a comment naming the kind, the object and
// the field, as `// Units: h000 (Lit Unit), Tip (Tooltip - Basic)`; levels share it. Trigger strings aren't
// covered (not checked in the World Editor yet).

import { StringTable, appendStrings, removeStrings, wtsCutLines } from "./wts";

/** The object fields whose literal texts move. */
export const MOVED_FIELDS: ReadonlySet<string> = new Set(["unam", "utip", "utub", "upro", "uhot", "anam", "atp1", "aub1", "ansf"]);

/** The object kinds in the order their strings are numbered (the World Editor's Object Editor tabs). */
export const OBJECT_KINDS = ["w3u", "w3t", "w3b", "w3d", "w3a", "w3h", "w3q"] as const;

/** A kind as the World Editor's comments name it. */
export const KIND_LABELS: Record<string, string> = {
  w3u: "Units", w3t: "Items", w3b: "Destructables", w3d: "Doodads", w3a: "Abilities", w3h: "Buffs/Effects", w3q: "Upgrades",
};

/** The name field of each kind, for the object's name in a comment. */
const NAME_FIELD: Record<string, string> = { w3u: "unam", w3t: "unam", w3b: "bnam", w3d: "dnam", w3a: "anam", w3h: "fnam", w3q: "gnam" };

/** A field's metadata column and label as the World Editor's comments give them (English game data): for when the
 *  game's metadata can't be read. */
export const FALLBACK_FIELDS: Record<string, { field: string; label: string }> = {
  unam: { field: "Name", label: "Name" },
  utip: { field: "Tip", label: "Tooltip - Basic" },
  utub: { field: "Ubertip", label: "Tooltip - Extended" },
  upro: { field: "Propernames", label: "Proper Names" },
  uhot: { field: "Hotkey", label: "Hotkey" },
  anam: { field: "Name", label: "Name" },
  atp1: { field: "Tip", label: "Tooltip - Normal" },
  aub1: { field: "Ubertip", label: "Tooltip - Normal - Extended" },
  ansf: { field: "EditorSuffix", label: "Editor Suffix" },
};

export interface TextMod { field: string; type?: string; level?: number; data?: number; value: unknown }
export interface TextObject { base: string; id?: string; mods?: TextMod[]; sets?: { flag?: number; mods: TextMod[] }[] }
export interface TextObjectFile { original?: TextObject[]; custom?: TextObject[]; [key: string]: unknown }
export interface TextMapInfo { players?: { name?: unknown }[]; forces?: { name?: unknown }[]; [key: string]: unknown }

export interface MoveTextsInput {
  /** war3map.wts, or null when the map has none (one is made). */
  wts: string | null;
  /** war3map.w3i as its JSON, or null. */
  info: TextMapInfo | null;
  /** The object files as their JSON: main (war3map.w3u) and Skin (war3mapSkin.w3u) ones, any order. */
  objects: { path: string; kind: string; skin: boolean; doc: TextObjectFile }[];
  /** The map's other texts that may refer to strings (scripts, triggers, other JSON forms): nothing they refer to is
   *  dropped. */
  otherTexts: Iterable<string>;
  /** Strings referred to from files that can't be read as text (raw map files). */
  otherRefs?: Iterable<number>;
  /** A field's metadata column and label (the game's metadata); FALLBACK_FIELDS where it gives none. */
  describe?(kind: string, field: string): { field: string; label: string } | undefined;
  /** A game object's name, for a comment on an object that doesn't name itself. */
  baseName?(kind: string, base: string): string | undefined;
}

/** A text left literal, and why. */
export interface KeptText { where: string; why: string }

export interface MoveTextsResult {
  /** The new war3map.wts, or null when it stays as it is. */
  wts: string | null;
  /** The new war3map.w3i JSON, or null when it stays. */
  info: TextMapInfo | null;
  /** The object files that changed (paths as given), with their new JSON. */
  objects: { path: string; doc: TextObjectFile }[];
  /** The new strings' numbers, in order. */
  added: number[];
  /** The numbers of the strings dropped (nothing referred to them). */
  dropped: number[];
  /** Texts that stay literal although their field moves. */
  kept: KeptText[];
}

/** A reference as the World Editor writes it: at least three digits. */
export const stringRef = (n: number) => `TRIGSTR_${String(n).padStart(3, "0")}`;

/** Every string number a text refers to ("TRIGSTR_7", "TRIGSTR_007"). */
export function refsIn(text: string, into = new Set<number>()): Set<number> {
  for (const m of text.matchAll(/TRIGSTR_(\d+)/g)) into.add(Number(m[1]));
  return into;
}

const modsOf = (o: TextObject): TextMod[] => (o.sets ? o.sets.flatMap((s) => s.mods ?? []) : (o.mods ?? []));
const keyOf = (o: TextObject) => o.id || o.base;
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** See the top. Pure: the inputs are left as they are; the result holds what changed. Throws rather than give a
 *  table that wouldn't read back as written. */
export function moveTexts(input: MoveTextsInput): MoveTextsResult {
  const table = input.wts === null ? null : new StringTable(input.wts);
  const resolve = (v: string) => (table ? table.resolve(v) : v);
  const otherTexts = [...input.otherTexts];
  // New numbers go on after the highest string, and after the highest reference too: a reference to a string the table
  // lacks would otherwise come to show a new text.
  let next = 1;
  if (table) for (const [n] of table.entries()) next = Math.max(next, n + 1);
  const before = new Set<number>(input.otherRefs ?? []);
  for (const t of otherTexts) refsIn(t, before);
  refsIn(JSON.stringify(input.info ?? null), before);
  for (const f of input.objects) refsIn(JSON.stringify(f.doc), before);
  for (const n of before) next = Math.max(next, n + 1);
  const blocks: { num: number; text: string; comment: string | null }[] = [];
  const kept: KeptText[] = [];
  /** The text's new reference, or null when it stays literal. */
  const take = (value: unknown, comment: string | null, where: string): string | null => {
    if (typeof value !== "string" || value === "" || StringTable.ref(value) !== null) return null;
    const text = value.replace(/\r\n/g, "\n");
    if (wtsCutLines(text).length) {
      kept.push({ where, why: "a line of it starts with \"}\", where the game would end the string" });
      return null;
    }
    const num = next++;
    blocks.push({ num, text, comment });
    return stringRef(num);
  };

  // The players' and forces' names, without comments.
  let info: TextMapInfo | null = null;
  if (input.info) {
    const copy = structuredClone(input.info);
    let changed = false;
    copy.players?.forEach((p, i) => {
      const ref = take(p.name, null, `player ${i + 1}'s name`);
      if (ref) { p.name = ref; changed = true; }
    });
    copy.forces?.forEach((f, i) => {
      const ref = take(f.name, null, `force ${i + 1}'s name`);
      if (ref) { f.name = ref; changed = true; }
    });
    if (changed) info = copy;
  }

  // The object files, kind by kind: the game's objects, then the map's own, each with its main file's fields and then
  // its Skin file's.
  const copies = input.objects.map((f) => ({ ...f, doc: structuredClone(f.doc), changed: false }));
  for (const kind of OBJECT_KINDS) {
    const files = copies.filter((f) => f.kind === kind).sort((a, b) => Number(a.skin) - Number(b.skin));
    if (!files.length) continue;
    for (const list of ["original", "custom"] as const) {
      const byKey = new Map<string, { file: (typeof files)[number]; o: TextObject }[]>();
      for (const file of files) {
        for (const o of file.doc[list] ?? []) {
          const k = keyOf(o);
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k)!.push({ file, o });
        }
      }
      for (const [k, parts] of byKey) {
        const nameField = NAME_FIELD[kind];
        // The Skin file's name is the one where both have it (as the World Editor reads them).
        const named = [...parts].reverse().flatMap((p) => modsOf(p.o)).find((m) => m.field === nameField && typeof m.value === "string" && m.value !== "");
        const name = oneLine(named ? resolve(named.value as string) : (input.baseName?.(kind, parts[0].o.base) ?? parts[0].o.base));
        for (const { file, o } of parts) {
          for (const m of modsOf(o)) {
            if (!MOVED_FIELDS.has(m.field) || (m.type !== undefined && m.type !== "string")) continue;
            const about = input.describe?.(kind, m.field) ?? FALLBACK_FIELDS[m.field] ?? { field: m.field, label: m.field };
            const comment = `${KIND_LABELS[kind]}: ${k} (${name}), ${oneLine(about.field)} (${oneLine(about.label)})`;
            const ref = take(m.value, comment, `${file.path}: ${k} ${m.field}${m.level ? ` level ${m.level}` : ""}`);
            if (ref) { m.value = ref; file.changed = true; }
          }
        }
      }
    }
  }

  // What still refers to strings: the files as they are after the move.
  const refs = new Set<number>(input.otherRefs ?? []);
  for (const t of otherTexts) refsIn(t, refs);
  refsIn(JSON.stringify(info ?? input.info ?? null), refs);
  for (const f of copies) refsIn(JSON.stringify(f.doc), refs);
  const dropped = table ? [...table.entries()].map(([n]) => n).filter((n) => !refs.has(n)) : [];
  const droppedSet = new Set(dropped);

  let wts: string | null = null;
  if (blocks.length || dropped.length) {
    const base = input.wts ?? "﻿";
    const eol = input.wts === null || input.wts.includes("\r\n") || !input.wts.includes("\n") ? "\r\n" : "\n";
    const out = appendStrings(removeStrings(base, droppedSet), blocks, eol);
    // Read back: every new string whole, every old one but the dropped as it was.
    const back = new StringTable(out);
    for (const b of blocks) {
      if (back.get(b.num)?.replace(/\r\n/g, "\n") !== b.text) throw new Error(`string ${b.num} wouldn't read back as written; nothing was changed.`);
    }
    if (table) {
      for (const [n, v] of table.entries()) {
        if (!droppedSet.has(n) && back.get(n) !== v) throw new Error(`string ${n} wouldn't stay as it is; nothing was changed.`);
      }
    }
    wts = out;
  }
  return {
    wts, info,
    objects: copies.filter((f) => f.changed).map((f) => ({ path: f.path, doc: f.doc })),
    added: blocks.map((b) => b.num), dropped, kept,
  };
}
