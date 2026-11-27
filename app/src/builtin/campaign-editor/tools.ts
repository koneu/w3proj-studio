// The campaign changes of the AI tools (MCP set_campaign_info, campaign_info), on the document war3campaign.w3f.json
// holds and the campaign's string table: the General section's texts, the interface race and the chapter buttons'
// texts, as the Campaign Editor edits them (a text that is a TRIGSTR reference is changed in war3campaign.wts).

import { StringTable } from "../../lib/formats/wts";
import { CHAPTER_SHOWN, type ChapterButton } from "./chapters";

export interface ToolCampaign {
  name: string; difficulty: string; author: string; description: string; race: number;
  chapters: ChapterButton[]; mapOrder: { unknown: string; map: string }[];
  [more: string]: unknown;
}

/** The interface races, by the number the file stores. */
export const CAMPAIGN_RACES = ["human", "orc", "undead", "nightelf"] as const;
const TEXTS = ["name", "difficulty", "author", "description"] as const;

/** The text behind a value: a TRIGSTR reference's string, else the value. */
const textOf = (value: string, table: StringTable | null) => (table ? table.resolve(value) : value);

/** The campaign as campaign_info shows it, texts read through the string table. */
export function describeCampaign(info: ToolCampaign, table: StringTable | null) {
  return {
    name: textOf(info.name, table), difficulty: textOf(info.difficulty, table), author: textOf(info.author, table), description: textOf(info.description, table),
    race: CAMPAIGN_RACES[info.race] ?? info.race,
    chapters: (info.chapters ?? []).map((c, i) => ({ number: i + 1, chapter: textOf(c.chapter, table), title: textOf(c.title, table), map: c.map, shown: !!(c.flags & CHAPTER_SHOWN) })),
    maps: (info.mapOrder ?? []).map((m) => m.map),
  };
}

/**
 * set_campaign_info on `info` and the campaign's string table (null without one): the texts given (name, difficulty,
 * author, description), the interface race, and per chapter button (`chapters`: by `number`, from 1) its two texts
 * and whether the campaign screen shows it from the start. A text whose value is a TRIGSTR reference the table has
 * is changed there, as in the Campaign Editor; any other in the document. Something that isn't a text, a race or a
 * chapter of the campaign refuses the call. Whether anything changed (the table says so for itself: `dirty`).
 */
export function setCampaignInfo(info: ToolCampaign, table: StringTable | null, args: Record<string, unknown>): boolean {
  let changed = false;
  const setText = (holder: Record<string, unknown>, key: string, value: unknown, label: string) => {
    if (typeof value !== "string") throw new Error(`${label} must be text.`);
    const now = holder[key] as string, ref = StringTable.ref(now);
    if (ref !== null && table?.has(ref)) table.set(ref, value);
    else if (now !== value) { holder[key] = value; changed = true; }
  };
  for (const key of TEXTS) if (args[key] !== undefined) setText(info, key, args[key], key);
  if (args.race !== undefined) {
    const race = CAMPAIGN_RACES.indexOf(args.race as (typeof CAMPAIGN_RACES)[number]);
    if (race < 0) throw new Error(`race must be one of: ${CAMPAIGN_RACES.join(", ")}.`);
    if (info.race !== race) { info.race = race; changed = true; }
  }
  if (args.chapters !== undefined) {
    if (!Array.isArray(args.chapters)) throw new Error("chapters must be a list, like [{ number: 1, title: \"The Defense of Strahnbrad\" }].");
    for (const item of args.chapters as Record<string, unknown>[]) {
      const n = item?.number;
      const c = Number.isInteger(n) ? info.chapters[(n as number) - 1] : undefined;
      if (!c) throw new Error(`chapters: there's no chapter button ${String(n)}; the campaign has ${info.chapters.length} (number counts from 1).`);
      const unknown = Object.keys(item).filter((k) => !["number", "chapter", "title", "shown"].includes(k));
      if (unknown.length) throw new Error(`chapters: a chapter takes number, chapter, title and shown, not ${unknown.join(", ")}. Maps are added and removed in the Campaign Editor.`);
      if (item.chapter !== undefined) setText(c as unknown as Record<string, unknown>, "chapter", item.chapter, `chapter ${n}'s chapter text`);
      if (item.title !== undefined) setText(c as unknown as Record<string, unknown>, "title", item.title, `chapter ${n}'s title`);
      if (item.shown !== undefined) {
        if (typeof item.shown !== "boolean") throw new Error(`chapter ${String(n)}: shown must be true or false.`);
        const flags = item.shown ? c.flags | CHAPTER_SHOWN : c.flags & ~CHAPTER_SHOWN;
        if (flags !== c.flags) { c.flags = flags; changed = true; }
      }
    }
  }
  return changed;
}
