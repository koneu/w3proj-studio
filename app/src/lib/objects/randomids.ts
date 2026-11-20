// The special object ids that stand for "any object of a kind and level", picked when the game starts: in random groups
// (war3map.w3i unitTables) and item tables (itemTables, and placed objects' own item sets).
//
// Found with the World Editor (we-drive, 2026-11-12: a map whose random group held candidate ids, opened, its Random
// Groups dialog read, a new set made there with Random in each position, saved; the script it wrote says what each id
// is). No map of the game or of smoketest_maps has one in a random group; item tables of the game's melee maps use the
// item ones.
// - "YYU" + level: a random neutral hostile unit, ChooseRandomCreep(level). The level is the character code minus '0'
//   ("YYU3" level 3, "YYU:" 10, "YYUB" 18), '/' any level (-1). The editor offers Any and levels 0 to 20.
// - "YYB" + anything: a random neutral passive building, ChooseRandomNPBuilding() ("YYB/", "YYB0", "YYBb" alike). The
//   editor writes "YYB/".
// - "Y" + class + "I" + level: a random item of a class ('Y' any class, 'i' permanent … 'o' miscellaneous) and level
//   ('/' any). The editor offers Any and levels 0 to 8, and the classes below.
// The editor's file keeps them as they are; a random group's id is one whatever the position's type ("YYI3" in a
// unit position is a random item all the same).
// - "Z" + low byte + "I" + high byte: a random item whose item set entry (a placed object's Items Dropped, "Choose
//   Item") was given an equipment type or a tag (we-drive, branch we-batch-5: five entries saved, their script read).
//   The two bytes are one number, class + 9 × equipment + 90 × tag + 810 × (level + 1), equipment and tag 0 for any,
//   else their EQUIPMENT_TYPE_ / ITEMTAG_TYPE_ number + 1; level 2 Permanent Head Droppable is 0x0a45, "ZEI\n". With
//   both any the editor writes the "Y" form.

/** A random item's equipment type and tag: EQUIPMENT_TYPE_<name> and ITEMTAG_TYPE_<name> numbers, undefined for any. */
export interface ItemFilter { equipment?: number; tag?: number }

export type RandomId =
  | { kind: "creep"; level: number }
  | { kind: "building" }
  | ({ kind: "item"; level: number; itemClass: number } & ItemFilter);

/** EQUIPMENT_TYPE_<name> by number (common.j; 9 is ANY), ITEMTAG_TYPE_<name> by number (8 is ANY). */
export const EQUIPMENT_TYPES = ["NONE", "HEAD", "CHEST", "GLOVES", "BOOTS", "RING", "PRIMARY", "OFFHAND", "TRINKET"];
export const ITEM_TAGS = ["UNDEFINED", "DROPPABLE", "QUESTREWARD", "BOSSDROP", "SECRET", "PUZZLE", "WORLD", "SHOP"];

/** The four bytes of an id as the codecs write it (4 characters, or "0x" and 8 hex digits for one that isn't
 *  printable), undefined for anything else. */
function idBytes(id: string): number[] | undefined {
  if (id.length === 4) return [...id].map((c) => c.charCodeAt(0));
  if (/^0x[0-9a-fA-F]{8}$/.test(id)) return [2, 4, 6, 8].map((k) => parseInt(id.slice(k, k + 2), 16));
  return undefined;
}
/** An id of four bytes as the codecs write it (idBytes). */
const bytesId = (b: number[]) =>
  b.every((x) => x >= 0x20 && x < 0x7f) ? String.fromCharCode(...b) : `0x${b.map((x) => x.toString(16).padStart(2, "0")).join("")}`;

/** Item classes by number (war3mapUnits.doo randomClass, ITEM_TYPE_<name> in the script): the id's second letter. */
export const ITEM_CLASSES: readonly { char: string; label: string; type: string }[] = [
  { char: "Y", label: "Any Class", type: "ANY" },
  { char: "i", label: "Permanent", type: "PERMANENT" },
  { char: "j", label: "Charged", type: "CHARGED" },
  { char: "k", label: "Power Up", type: "POWERUP" },
  { char: "l", label: "Artifact", type: "ARTIFACT" },
  { char: "m", label: "Purchasable", type: "PURCHASABLE" },
  { char: "n", label: "Campaign", type: "CAMPAIGN" },
  { char: "o", label: "Miscellaneous", type: "MISCELLANEOUS" },
];

/** The highest levels the World Editor offers: random creeps, random items. */
export const MAX_CREEP_LEVEL = 20, MAX_ITEM_LEVEL = 8;

const levelChar = (level: number) => (level < 0 ? "/" : String.fromCharCode(48 + level));
/** The level of an id's level character, or undefined for one that is no level. */
function levelOf(c: string): number | undefined {
  if (c === "/") return -1;
  const code = c.charCodeAt(0);
  return code >= 48 && code < 127 ? code - 48 : undefined;
}

/** The id of a random object (levels below 0 are any level). */
export function randomObjectId(r: RandomId): string {
  if (r.kind === "creep") return `YYU${levelChar(r.level)}`;
  if (r.kind === "building") return "YYB/";
  const cls = ITEM_CLASSES[r.itemClass];
  if (!cls) throw new Error(`no item class ${r.itemClass}`);
  if (r.equipment !== undefined || r.tag !== undefined) {
    const e = r.equipment === undefined ? 0 : r.equipment + 1, t = r.tag === undefined ? 0 : r.tag + 1;
    if (e > EQUIPMENT_TYPES.length || t > ITEM_TAGS.length || r.level > MAX_ITEM_LEVEL) throw new Error("no such equipment type, tag or level");
    const v = r.itemClass + 9 * e + 90 * t + 810 * (Math.max(-1, r.level) + 1);
    return bytesId([0x5a, v & 0xff, 0x49, v >> 8]);
  }
  return `Y${cls.char}I${levelChar(r.level)}`;
}

/** The "Z" form of a random item (see the top), undefined for bytes that aren't one. */
function filteredItem(b: number[]): RandomId | undefined {
  if (b[0] !== 0x5a || b[2] !== 0x49) return undefined;
  const v = b[1] | (b[3] << 8);
  const itemClass = v % 9, e = Math.floor(v / 9) % 10, t = Math.floor(v / 90) % 9, level = Math.floor(v / 810) - 1;
  if (itemClass >= ITEM_CLASSES.length || level > MAX_ITEM_LEVEL) return undefined;
  return { kind: "item", level, itemClass, ...(e ? { equipment: e - 1 } : {}), ...(t ? { tag: t - 1 } : {}) };
}

/** What a random object's id stands for, or undefined for any other id. */
export function parseRandomId(id: string): RandomId | undefined {
  if (typeof id !== "string") return undefined;
  const bytes = idBytes(id);
  if (bytes?.[0] === 0x5a) return filteredItem(bytes);
  if (id.length !== 4 || id[0] !== "Y") return undefined;
  if (id.startsWith("YYU")) {
    const level = levelOf(id[3]);
    return level === undefined ? undefined : { kind: "creep", level };
  }
  if (id.startsWith("YYB")) return { kind: "building" };
  if (id[2] !== "I") return undefined;
  const itemClass = ITEM_CLASSES.findIndex((c) => c.char === id[1]);
  const level = levelOf(id[3]);
  return itemClass < 0 || level === undefined ? undefined : { kind: "item", level, itemClass };
}

/** The World Editor's name of a random object ("Random Level 3 Neutral Hostile Unit", "Random Any Level Permanent
 *  Item"), or undefined for any other id. */
export function randomIdLabel(id: string): string | undefined {
  const r = parseRandomId(id);
  if (!r) return undefined;
  if (r.kind === "building") return "Random Neutral Passive Building";
  const level = r.level < 0 ? "Any Level" : `Level ${r.level}`;
  if (r.kind === "creep") return `Random ${level} Neutral Hostile Unit`;
  return r.itemClass === 0 ? `Random ${level} Item` : `Random ${level} ${ITEM_CLASSES[r.itemClass].label} Item`;
}

/** The random objects a random group's position of a type offers (0 unit, 1 building, 2 item), as the World Editor's
 *  Random choice there does: any level first. */
export function randomChoices(positionType: number): { id: string; label: string }[] {
  const levels = (max: number) => [-1, ...Array.from({ length: max + 1 }, (_, i) => i)];
  let ids: string[];
  if (positionType === 0) ids = levels(MAX_CREEP_LEVEL).map((level) => randomObjectId({ kind: "creep", level }));
  else if (positionType === 1) ids = [randomObjectId({ kind: "building" })];
  else if (positionType === 2) ids = ITEM_CLASSES.flatMap((_, itemClass) => levels(MAX_ITEM_LEVEL).map((level) => randomObjectId({ kind: "item", level, itemClass })));
  else ids = [];
  return ids.map((id) => ({ id, label: randomIdLabel(id)! }));
}
