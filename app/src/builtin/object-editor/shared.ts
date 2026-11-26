import { StringTable } from "../../lib/formats/wts";

/** The object data kinds the Object Editor edits: file extension, plural label, singular name. */
export const KINDS: { ext: string; label: string; singular: string }[] = [
  { ext: "w3u", label: "Units", singular: "unit" },
  { ext: "w3t", label: "Items", singular: "item" },
  { ext: "w3a", label: "Abilities", singular: "ability" },
  { ext: "w3h", label: "Buffs/Effects", singular: "buff" },
  { ext: "w3b", label: "Destructables", singular: "destructable" },
  { ext: "w3d", label: "Doodads", singular: "doodad" },
  { ext: "w3q", label: "Upgrades", singular: "upgrade" },
];
/** Plural label per kind extension. */
export const KIND_LABELS: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.ext, k.label]));

/** Icon (command button art) field per object kind; destructables and doodads have none. */
export const ICON_FIELD: Record<string, string> = { w3u: "uico", w3t: "iico", w3a: "aart", w3h: "fart", w3q: "gar1" };

/** The model field of the kinds with one model to look at, and the field counting its variations. */
export const MODEL_FIELD: Record<string, { model: string; variations?: string }> = {
  w3u: { model: "umdl" }, w3t: { model: "ifil" }, w3d: { model: "dfil", variations: "dvar" }, w3b: { model: "bfil", variations: "bvar" },
};

/** The text a "TRIGSTR_n" value stands for in a string table; null when the value is no reference or the table has no such string. */
export function trigstrText(table: StringTable, v: unknown): string | null {
  const n = typeof v === "string" ? StringTable.ref(v) : null;
  return n !== null && table.has(n) ? table.get(n)! : null;
}
