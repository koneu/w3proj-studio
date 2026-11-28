// Known values of fields the World Editor offers a list for, where the list is too long for a drop-down: an
// ability's order strings and a building's ground texture (uber splat). Chosen in a searchable list
// (filepicker's pickChoice); the text box beside it still takes any value.

import type { FieldMeta, KindData } from "../../lib/objects/metadata";

export interface Choice { value: string; label: string }

/** Field types with such a list, and what the list is called. */
export const CHOICE_TYPES: Record<string, { title: string; placeholder: string }> = {
  orderString: { title: "Choose an order string", placeholder: "Search by words of the order or of an ability using it" },
  uberSplat: { title: "Choose a ground texture", placeholder: "Search by words of the name or the code" },
};

/** The rows of Splats\\UberSplatData.slk as choices: the code is stored, the comment says what it is. */
export function splatChoices(rows: readonly Record<string, string>[]): Choice[] {
  return rows.filter((r) => /^\w{4}$/.test(r.Name ?? "") && r.Name !== "INIT")
    .map((r) => ({ value: r.Name, label: r.comment && r.comment !== r.Name ? `${r.comment} (${r.Name})` : r.Name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every order string the game's abilities use, each with the abilities using it ("thunderclap · Thunder Clap",
 *  "attack · 3 abilities"): the game knows no other list of them. */
export function orderChoices(kd: Pick<KindData, "baseIds" | "names" | "fieldsFor" | "defaultValue" | "levels">): Choice[] {
  const users = new Map<string, Set<string>>();
  for (const id of kd.baseIds) {
    for (const f of kd.fieldsFor(id)) {
      if (f.type !== "orderString") continue;
      const value = (kd.defaultValue(id, f as FieldMeta, f.repeat ? 1 : 0) ?? "").trim();
      if (!value || value === "_" || value === "-") continue;
      if (!users.has(value)) users.set(value, new Set());
      users.get(value)!.add(kd.names.get(id) ?? id);
    }
  }
  return [...users].sort((a, b) => a[0].localeCompare(b[0])).map(([value, names]) => {
    const list = [...names];
    return { value, label: `${value} · ${list.length > 2 ? `${list[0]} and ${list.length - 1} more` : list.join(", ")}` };
  });
}

/** Music to choose from: the labels of the game's music table (UI\\SoundInfo\\Music.slk), which the interface's
 *  music fields store ("HumanDefeat"), each with its file, or how many it plays in turn. */
export function musicChoices(rows: readonly Record<string, string>[]): Choice[] {
  return rows.filter((r) => r.SoundName && r.SoundName !== "_" && r.FileNames && r.FileNames !== "_").map((r) => {
    const files = r.FileNames.split(",").map((f) => f.trim()).filter(Boolean);
    return { value: r.SoundName, label: `${r.SoundName} · ${files.length > 1 ? `${files.length} files` : files[0].replace(/^.*[\\/]/, "")}` };
  }).sort((a, b) => a.value.localeCompare(b.value));
}
