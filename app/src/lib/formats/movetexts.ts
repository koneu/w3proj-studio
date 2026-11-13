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
// the field, as `// Units: h000 (Lit Unit), Tip (Tooltip - Basic)`; levels share it. An upgrade's comment names the
// game's upgrade it is based on (all its level names, "Iron Forged Swords,Steel Forged Swords,…"), even when the map
// renames it. Trigger strings aren't covered (not checked in the World Editor yet).
//
// The full list of fields (we-drive, 2026-11-13, a literal in every text field of every kind, and in the art, tech
// and data fields that take text; evidence in target/evidence/moveto-fields): the Text category of each kind, but
// not the abilities' order strings (aord, aoru, aoro, aorf) nor the art one (uepa); and the upgrades' class and
// effects (gcls, gef1-gef4), but not their codes (gco1-gco4). Icons, models, sounds, attachment points, tech lists,
// tilesets, categories, races and an ability's data stay literal.
//
// A map's per-language string tables (`_Locales\deDE.w3mod\war3map.wts`, one per language; the game's own melee maps
// carry eleven, each a full copy of war3map.wts with every number translated or not): the World Editor's save leaves
// them byte for byte (we-drive, 2026-11-13, a copy of lit.w3m with a German table holding 1-3 and a German-only 50,
// target/evidence/movetexts-locales): its new strings are missing there, the string it dropped from war3map.wts stays
// there, and it numbers its new strings without looking at them, so its string 50 took the number of the German-only
// one. (It keeps such a table only when war3map.imp lists it; one it doesn't list is gone after the save.) Move Texts
// does better: its new strings go into every language's table too, with the same text and comment (to be translated
// there; a table that replaces war3map.wts whole would otherwise show the bare reference), and they are numbered after
// every number of every table. Strings it drops leave war3map.wts only: a language's table keeps its translations, and
// its numbers stay taken.

import { StringTable, appendStrings, removeStrings, wtsCutLines } from "./wts";

/** The object fields whose literal texts move. */
export const MOVED_FIELDS: ReadonlySet<string> = new Set([
  // Units and items.
  "unam", "unsf", "utip", "utub", "ides", "upro", "uhot", "utpr", "uawt", "ucun", "ucut",
  // Destructables, doodads.
  "bnam", "bsuf", "dnam",
  // Abilities.
  "anam", "ansf", "atp1", "aub1", "aut1", "auu1", "aret", "arut", "ahky", "auhk", "arhk",
  // Buffs/effects.
  "fnam", "fnsf", "ftip", "fube",
  // Upgrades.
  "gnam", "gnsf", "gtp1", "gub1", "ghk1", "gcls", "gef1", "gef2", "gef3", "gef4",
]);

/** The object kinds in the order their strings are numbered (the World Editor's Object Editor tabs). */
export const OBJECT_KINDS = ["w3u", "w3t", "w3b", "w3d", "w3a", "w3h", "w3q"] as const;

/** A kind as the World Editor's comments name it. */
export const KIND_LABELS: Record<string, string> = {
  w3u: "Units", w3t: "Items", w3b: "Destructibles", w3d: "Doodads", w3a: "Abilities", w3h: "Buffs/Effects", w3q: "Upgrades",
};

/** The name field of each kind, for the object's name in a comment. Upgrades have none: theirs is the game's. */
const NAME_FIELD: Record<string, string | undefined> = { w3u: "unam", w3t: "unam", w3b: "bnam", w3d: "dnam", w3a: "anam", w3h: "fnam" };

/** A field's metadata column and label as the World Editor's comments give them (English game data): for when the
 *  game's metadata can't be read. */
export const FALLBACK_FIELDS: Record<string, { field: string; label: string }> = {
  unam: { field: "Name", label: "Name" },
  unsf: { field: "EditorSuffix", label: "Name - Editor Suffix" },
  utip: { field: "Tip", label: "Tooltip - Basic" },
  utub: { field: "Ubertip", label: "Tooltip - Extended" },
  ides: { field: "Description", label: "Description" },
  upro: { field: "Propernames", label: "Proper Names" },
  uhot: { field: "Hotkey", label: "Hotkey" },
  utpr: { field: "Revivetip", label: "Tooltip - Revive" },
  uawt: { field: "Awakentip", label: "Tooltip - Awaken" },
  ucun: { field: "Casterupgradename", label: "Caster Upgrade Names" },
  ucut: { field: "Casterupgradetip", label: "Caster Upgrade Tips" },
  bnam: { field: "Name", label: "Name" },
  bsuf: { field: "EditorSuffix", label: "Editor Suffix" },
  dnam: { field: "Name", label: "Name" },
  anam: { field: "Name", label: "Name" },
  ansf: { field: "EditorSuffix", label: "Editor Suffix" },
  atp1: { field: "Tip", label: "Tooltip - Normal" },
  aub1: { field: "Ubertip", label: "Tooltip - Normal - Extended" },
  aut1: { field: "Untip", label: "Tooltip - Turn Off" },
  auu1: { field: "Unubertip", label: "Tooltip - Turn Off - Extended" },
  aret: { field: "Researchtip", label: "Tooltip - Learn" },
  arut: { field: "Researchubertip", label: "Tooltip - Learn - Extended" },
  ahky: { field: "Hotkey", label: "Hotkey - Normal" },
  auhk: { field: "Unhotkey", label: "Hotkey - Turn Off" },
  arhk: { field: "Researchhotkey", label: "Hotkey - Learn" },
  fnam: { field: "EditorName", label: "Name (Editor Only)" },
  fnsf: { field: "EditorSuffix", label: "Editor Suffix" },
  ftip: { field: "Bufftip", label: "Tooltip" },
  fube: { field: "Buffubertip", label: "Tooltip - Extended" },
  gnam: { field: "Name", label: "Name" },
  gnsf: { field: "EditorSuffix", label: "Editor Suffix" },
  gtp1: { field: "Tip", label: "Tooltip" },
  gub1: { field: "Ubertip", label: "Tooltip - Extended" },
  ghk1: { field: "Hotkey", label: "Hotkey" },
  gcls: { field: "class", label: "Class" },
  gef1: { field: "effect1", label: "Effect 1" },
  gef2: { field: "effect2", label: "Effect 2" },
  gef3: { field: "effect3", label: "Effect 3" },
  gef4: { field: "effect4", label: "Effect 4" },
};

export interface TextMod { field: string; type?: string; level?: number; data?: number; value: unknown }
export interface TextObject { base: string; id?: string; mods?: TextMod[]; sets?: { flag?: number; mods: TextMod[] }[] }
export interface TextObjectFile { original?: TextObject[]; custom?: TextObject[]; [key: string]: unknown }
export interface TextMapInfo { players?: { name?: unknown }[]; forces?: { name?: unknown }[]; [key: string]: unknown }

export interface MoveTextsInput {
  /** war3map.wts, or null when the map has none (one is made). */
  wts: string | null;
  /** The languages' string tables (`map/_Locales/deDE.w3mod/war3map.wts`), path as given: the new strings go into each
   *  too, and no new string takes a number one of them has. */
  locales?: { path: string; wts: string }[];
  /** war3map.w3i as its JSON, or null. */
  info: TextMapInfo | null;
  /** The object files as their JSON: main (war3map.w3u) and Skin (war3mapSkin.w3u) ones, any order. */
  objects: { path: string; kind: string; skin: boolean; doc: TextObjectFile }[];
  /** The map's other texts that may refer to strings (scripts, triggers, other JSON forms): nothing they refer to is
   *  dropped. */
  otherTexts: Iterable<string>;
  /** Strings referred to from files that can't be read as text (raw map files). */
  otherRefs?: Iterable<number>;
  /** Numbers no new string may take, though nothing refers to them now: the strings an earlier drop recorded
   *  (lib/formats/prunedstrings), which come back with their old texts when a reference does. */
  reserved?: Iterable<number>;
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
  /** The languages' tables that changed (paths as given): each with the new strings added. */
  locales: { path: string; wts: string }[];
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
/** The line ends new blocks get: the table's own, CRLF for a new table or one of a single line (as the editor writes). */
const eolOf = (wts: string | null) => (wts === null || wts.includes("\r\n") || !wts.includes("\n") ? "\r\n" : "\n");

/** A language's string table in the project (`map/_Locales/deDE.w3mod/war3map.wts`), any case. */
export const LOCALE_WTS = /^map\/_locales\/[^/]+\.w3mod\/war3map\.wts$/i;

/** See the top. Pure: the inputs are left as they are; the result holds what changed. Throws rather than give a
 *  table that wouldn't read back as written. */
export function moveTexts(input: MoveTextsInput): MoveTextsResult {
  const table = input.wts === null ? null : new StringTable(input.wts);
  const resolve = (v: string) => (table ? table.resolve(v) : v);
  const otherTexts = [...input.otherTexts];
  // New numbers go on after the highest string, and after the highest reference and recorded dropped string too: a
  // reference to a string the table lacks would otherwise come to show a new text.
  let next = 1;
  if (table) for (const [n] of table.entries()) next = Math.max(next, n + 1);
  const before = new Set<number>(input.otherRefs ?? []);
  for (const t of otherTexts) refsIn(t, before);
  refsIn(JSON.stringify(input.info ?? null), before);
  for (const f of input.objects) refsIn(JSON.stringify(f.doc), before);
  for (const n of before) next = Math.max(next, n + 1);
  for (const n of input.reserved ?? []) next = Math.max(next, n + 1);
  // And after every number of the languages' tables: a string only one of them has would otherwise show there in place
  // of the new one.
  const locales = (input.locales ?? []).map((l) => ({ ...l, table: new StringTable(l.wts) }));
  for (const l of locales) for (const [n] of l.table.entries()) next = Math.max(next, n + 1);
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
        const named = nameField === undefined ? undefined
          : [...parts].reverse().flatMap((p) => modsOf(p.o)).find((m) => m.field === nameField && typeof m.value === "string" && m.value !== "");
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
    const out = appendStrings(removeStrings(base, droppedSet), blocks, eolOf(input.wts));
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
  // The languages' tables: the new strings added, nothing dropped (each keeps its translations).
  const localeOut: { path: string; wts: string }[] = [];
  if (blocks.length) {
    for (const l of locales) {
      const out = appendStrings(l.wts, blocks, eolOf(l.wts));
      const back = new StringTable(out);
      for (const b of blocks) {
        if (back.get(b.num)?.replace(/\r\n/g, "\n") !== b.text) throw new Error(`string ${b.num} wouldn't read back as written in ${l.path}; nothing was changed.`);
      }
      for (const [n, v] of l.table.entries()) {
        if (back.get(n) !== v) throw new Error(`string ${n} of ${l.path} wouldn't stay as it is; nothing was changed.`);
      }
      localeOut.push({ path: l.path, wts: out });
    }
  }
  return {
    wts, locales: localeOut, info,
    objects: copies.filter((f) => f.changed).map((f) => ({ path: f.path, doc: f.doc })),
    added: blocks.map((b) => b.num), dropped, kept,
  };
}
