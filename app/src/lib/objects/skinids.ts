// Which section of the game's skin tables (Units\UnitSkin.txt & co.) holds a type's art. Most sections are
// spelled as the type id in the kind's data table, but some only in another case: the doodads Yosh [YOsh],
// Lcsy [LCsy], Ycgd [YCgd], Lccn [LCcn], YOgo [YOGO], the ability Aisy [AIsy], the buffs BNss [Bnss] and
// Xesn [XEsn]. Ids that differ only in case are different types across kinds (ability Aspt, doodad ASpt;
// eops / EOps, brpb / Brpb), and within one (abilities AChV and AChv), so a type's own spelling wins, and
// another case is looked for only among its own kind's sections.

/** Per object kind: its skin tables and the `skinType` of its sections there (abilities and buffs share
 *  AbilitySkin.txt; a section without a skinType counts for every kind of its file). */
export const SKIN_KINDS: Record<string, { files: readonly string[]; types: readonly string[] }> = {
  w3u: { files: ["Units\\UnitSkin.txt"], types: ["unit"] },
  w3t: { files: ["Units\\ItemSkin.txt"], types: ["item"] },
  w3b: { files: ["Units\\DestructableSkin.txt"], types: ["destructable"] },
  w3d: { files: ["Doodads\\DoodadSkins.txt"], types: ["doodad"] },
  w3a: { files: ["Units\\AbilitySkin.txt"], types: ["ability"] },
  w3h: { files: ["Units\\AbilitySkin.txt"], types: ["buff", "effect"] },
  w3q: { files: ["Units\\UpgradeSkin.txt"], types: ["upgrade"] },
};

/** "War3.w3mod:Doodads/DoodadSkins.txt" or "Doodads\\DoodadSkins.txt" → "doodads/doodadskins.txt". */
const fileKey = (path: string) => path.replace(/^.*:/, "").replace(/\\/g, "/").toLowerCase();

/** Whether a game file (with or without its storage prefix, either slash) is one of the kind's skin tables. */
export function isSkinFileOf(kind: string, path: string): boolean {
  const key = fileKey(path);
  return SKIN_KINDS[kind]?.files.some((f) => fileKey(f) === key) ?? false;
}

/** One kind's skin sections, to find a type's among them. */
export class SkinIds {
  private exact = new Set<string>();
  private lower = new Map<string, string>();
  /** `sections`: the section names of the kind's skin tables with their `skinType` (as parseIni gives them). */
  constructor(kind: string, sections: Iterable<[string, string | undefined]>) {
    const types = SKIN_KINDS[kind]?.types ?? [];
    for (const [id, skinType] of sections) {
      const type = skinType?.trim().toLowerCase();
      if (type && !types.includes(type)) continue;
      this.exact.add(id);
      if (!this.lower.has(id.toLowerCase())) this.lower.set(id.toLowerCase(), id);
    }
  }
  /** The section with a type's art: its own spelling when the kind has that, else the kind's section spelled in
   *  another case, else undefined. */
  section(id: string): string | undefined {
    return this.exact.has(id) ? id : this.lower.get(id.toLowerCase());
  }
}
