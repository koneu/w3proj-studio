// Field editors by metadata type, as the World Editor offers them:
// - object codes and lists of them (unitCode, abilityList, techList, …): chosen
//   in the object browser, lists as removable chips;
// - the types UI\UnitEditorData.txt defines: one choice (attackType, armorType,
//   …), a comma list (targetList, pathingList…), or bit flags (…Flags).

import type { W3Api } from "../../extensions/api";
import type { ObjectsService } from "../../extensions/services";
import { parseIni, westring } from "../../lib/formats/text";
import { loadWorldEditStrings } from "../../lib/objects/metadata";
import { h } from "../../workbench/dom";

/** Metadata types holding one object code, and the object kinds offered. */
export const OBJECT_CODE: Record<string, string[]> = {
  unitCode: ["w3u"], abilCode: ["w3a"], upgradeCode: ["w3q"], heroAbilityCode: ["w3a"],
};
/** Metadata types holding a comma list of object codes. */
export const OBJECT_LIST: Record<string, string[]> = {
  unitList: ["w3u"], abilityList: ["w3a"], heroAbilityList: ["w3a"], itemList: ["w3t"], upgradeList: ["w3q"],
  techList: ["w3u", "w3q", "w3t"], buffList: ["w3h"], abilitySkinList: ["w3a"], unitSkinList: ["w3u"], effectList: ["w3h"],
};

export interface EditorType {
  /** one value, a comma list of values, or bit flags (bit n = entry with value n). */
  shape: "single" | "list" | "flags";
  /** `alone`: a list value that stands for the whole list ("*", every tileset) and is never stored beside others. */
  entries: { value: string; label: string; alts: string[]; alone?: boolean }[];
}

/** UnitEditorData types stored as comma lists whose name doesn't end in "List". */
const LISTS = new Set(["unitClass"]);

let typesPromise: Promise<Map<string, EditorType>> | null = null;
/** The value types of UI\UnitEditorData.txt with their labels (WorldEditStrings). */
export function loadEditorTypes(w3: W3Api): Promise<Map<string, EditorType>> {
  typesPromise ??= (async () => {
    // The three files are asked together; the strings are the ones the object data's labels use (parsed once).
    const unitData = w3.game.readText("UI\\UnitEditorData.txt");
    const worldData = w3.game.readText("UI\\WorldEditData.txt").catch(() => "");
    unitData.catch(() => {});
    const strings = await loadWorldEditStrings(w3);
    const out = new Map<string, EditorType>();
    for (const [name, sec] of parseIni(await unitData)) {
      const entries: EditorType["entries"] = [];
      for (const [k, v] of sec) {
        if (!/^\d+$/.test(k)) continue;
        const [value, label] = v.split(",");
        // A few labels name strings the game no longer has: the value says more than the key.
        const text = label ? westring(strings, label) : value;
        entries.push({ value, label: text.startsWith("WESTRING_") ? value : text, alts: (sec.get(`${k}_alt`) ?? "").split(",").filter(Boolean) });
      }
      if (!entries.length) continue;
      // unitClass is stored as a comma list too ("giant,undead"), though its name doesn't say so.
      out.set(name, { shape: /Flags$/.test(name) ? "flags" : /List/.test(name) || LISTS.has(name) ? "list" : "single", entries });
    }
    for (const [name, t] of worldEditTypes(parseIni(await worldData), (key) => westring(strings, key), out)) out.set(name, t);
    return out;
  })();
  typesPromise.catch(() => { typesPromise = null; });
  return typesPromise;
}

/** The value types the World Editor fills from other tables than UnitEditorData: a doodad's and a destructable's
 *  category and the tilesets (UI\WorldEditData.txt), and an ability's lightning effects (UnitEditorData's
 *  lightningEffect, stored as a list). Only those whose table has entries. */
export function worldEditTypes(data: ReadonlyMap<string, ReadonlyMap<string, string>>, label: (key: string) => string, unitTypes: ReadonlyMap<string, EditorType>): Map<string, EditorType> {
  const out = new Map<string, EditorType>();
  const section = (name: string) => [...(data.get(name) ?? [])].filter(([k]) => /^[a-z]$/i.test(k)).map(([k, v]) => {
    const key = v.split(",")[0].trim(), text = label(key);
    return { value: k.toUpperCase(), label: !text || text.startsWith("WESTRING_") ? k.toUpperCase() : text, alts: [] };
  });
  const put = (name: string, shape: EditorType["shape"], entries: EditorType["entries"]) => { if (entries.length) out.set(name, { shape, entries }); };
  put("doodadCategory", "single", section("DoodadCategories"));
  put("destructableCategory", "single", section("DestructibleCategories"));
  const tilesets = section("TileSets").sort((a, b) => a.label.localeCompare(b.label));
  put("tilesetList", "list", tilesets.length ? [{ value: "*", label: "All tilesets", alts: [], alone: true }, ...tilesets] : []);
  put("lightningList", "list", unitTypes.get("lightningEffect")?.entries ?? []);
  return out;
}

/** What a value of an editor type (a choice, a comma list, bit flags) shows as: its labels ("nightelf" →
 *  "Night Elf", "giant,undead" → "Giant, Undead"), or undefined when it has none. The object browser's
 *  field filters match it as well as the stored value. */
export function shownValue(t: EditorType | undefined, raw: string | undefined): string | undefined {
  if (!t || raw === undefined) return undefined;
  const labelOf = (v: string) => {
    const l = v.toLowerCase();
    return t.entries.find((e) => e.value.toLowerCase() === l || e.alts.some((a) => a.toLowerCase() === l))?.label;
  };
  let labels: (string | undefined)[];
  if (t.shape === "flags") {
    const bits = Number(raw) || 0;
    labels = t.entries.filter((e) => (bits & (1 << Number(e.value))) !== 0).map((e) => e.label);
  } else if (t.shape === "list") {
    labels = listItems(raw).map((s) => labelOf(s) ?? s);
  } else labels = [labelOf(raw.trim())];
  if (!labels.length || labels.some((l) => l === undefined)) return undefined;
  return labels.join(", ");
}

/** Several selected objects whose values differ: `each` changes each object's own value. */
export interface MixedValues { values: string[]; each(change: (old: string) => number | string): void }

const listItems = (value: string) => value.split(",").map((s) => s.trim()).filter((s) => s && s !== "_");

/** A comma list with one entry put in or taken out (its alternative spellings count as it). */
export function setListValue(old: string, value: string, alts: string[], on: boolean): string {
  const same = new Set([value, ...alts].map((s) => s.toLowerCase()));
  const rest = listItems(old).filter((s) => !same.has(s.toLowerCase()));
  return (on ? [...rest, value] : rest).join(",");
}

/** setListValue for an editor type's entry: one that stands alone ("*") replaces the list when ticked and
 *  leaves it when another entry is. */
export function tickListValue(t: EditorType, old: string, e: EditorType["entries"][number], on: boolean): string {
  if (on && e.alone) return e.value;
  const alone = new Set(t.entries.filter((x) => x.alone).map((x) => x.value.toLowerCase()));
  const kept = on ? listItems(old).filter((s) => !alone.has(s.toLowerCase())).join(",") : old;
  return setListValue(kept, e.value, e.alts, on);
}

/** How many of `values` a check applies to, as a checkbox shows it. */
export function checkState(values: string[], has: (value: string) => boolean): { checked: boolean; indeterminate: boolean } {
  const n = values.filter(has).length;
  return { checked: n === values.length && n > 0, indeterminate: n > 0 && n < values.length };
}

/** One choice, a list of checkboxes, or flag checkboxes for an editor type. */
export function typeEditor(t: EditorType, current: number | string, numeric: boolean, onCommit: (v: number | string) => void, mixed?: MixedValues): HTMLElement {
  if (t.shape === "single") {
    const value = String(current);
    const known = t.entries.some((e) => e.value.toLowerCase() === value.toLowerCase() || e.alts.includes(value.toLowerCase()));
    const sel = h("select.obj-select", { onchange: () => onCommit(numeric ? Number(sel.value) : sel.value) },
      ...(known ? [] : [h("option", { value, selected: true }, mixed ? "(mixed)" : value || "(none)")]),
      ...t.entries.map((e) => h("option", { value: e.value, selected: e.value.toLowerCase() === value.toLowerCase() || e.alts.includes(value.toLowerCase()) }, e.label)));
    return sel;
  }
  if (t.shape === "flags") {
    const bits = Number(current) || 0;
    const boxes = t.entries.map((e) => {
      const bit = 1 << Number(e.value);
      const state = mixed ? checkState(mixed.values, (v) => ((Number(v) || 0) & bit) !== 0) : { checked: (bits & bit) !== 0, indeterminate: false };
      const box = h("input", { type: "checkbox", checked: state.checked, indeterminate: state.indeterminate, onchange: () => {
        if (mixed) { mixed.each((old) => (box.checked ? (Number(old) || 0) | bit : (Number(old) || 0) & ~bit)); return; }
        const now = t.entries.reduce((n, x, i) => (boxes[i].box.checked ? n | (1 << Number(x.value)) : n), 0);
        onCommit(now);
      } }) as HTMLInputElement;
      return { box, el: h("label.obj-check", {}, box, e.label) };
    });
    return h("div.obj-checks", {}, ...boxes.map((b) => b.el));
  }
  // A comma list of values (alternative spellings count as the value).
  // "_" is how SLKs and maps write an empty list.
  const holds = (list: string, e: EditorType["entries"][number]) => {
    const have = new Set(listItems(list).map((s) => s.toLowerCase()));
    return have.has(e.value.toLowerCase()) || e.alts.some((a) => have.has(a.toLowerCase()));
  };
  const boxes = t.entries.map((e, n) => {
    const state = mixed ? checkState(mixed.values, (v) => holds(v, e)) : { checked: holds(String(current), e), indeterminate: false };
    return h("input", { type: "checkbox", checked: state.checked, indeterminate: state.indeterminate, onchange: () => {
      const on = (boxes[n] as HTMLInputElement).checked;
      if (mixed) { mixed.each((old) => tickListValue(t, old, e, on)); return; }
      // The boxes in the table's order, as before; a value that stands alone ("*") isn't kept beside others.
      const ticked = t.entries.filter((x, i) => (boxes[i] as HTMLInputElement).checked && (x === e || (on ? !x.alone && !e.alone : true)));
      // A value the table doesn't list (a tileset letter of an extended editor) stays, unless the whole list is replaced.
      const unknown = on && e.alone ? [] : listItems(String(current)).filter((s) => !t.entries.some((x) => holds(s, x)));
      onCommit([...ticked.map((x) => x.value), ...unknown].join(","));
    } });
  });
  return h("div.obj-checks", {}, ...t.entries.map((e, i) => h("label.obj-check", {}, boxes[i], e.label)));
}

/** An object code (one) or a list of them, chosen in the object browser. */
export function objectEditor(objects: ObjectsService, host: HTMLElement, kinds: string[], list: boolean, current: number | string,
  onCommit: (v: string) => void, mixed = false): HTMLElement {
  const ids = String(current).split(",").map((s) => s.trim()).filter((s) => s && s !== "_");
  const pick = async () => (await objects.pick(host, { title: list ? "Add" : "Choose", kinds }))?.id;
  const chip = (id: string, i: number) => {
    const name = h("span.obj-chip-name", {}, id);
    // Among the field's own kinds: every kind asked had all seven kinds' game tables read for the first chip shown,
    // and an id two kinds share (a buff and a destructable B000) took the other kind's name.
    void objects.name(id, kinds).then((n) => { if (n) name.textContent = `${n} (${id})`; });
    return h("span.obj-chip", { title: id }, name,
      h("button.icon-button", { title: list ? "Remove from the list" : "Clear", onclick: () => onCommit(ids.filter((_, j) => j !== i).join(",")) }, "×"));
  };
  return h("div.obj-chips", {},
    ...ids.map(chip),
    mixed ? h("span.muted", {}, "mixed") : null,
    h("button.obj-chip-add", { title: mixed ? "Replaces the value of all selected objects" : "", onclick: async () => {
      const id = await pick();
      if (id) onCommit(list ? [...ids, id].join(",") : id);
    } }, mixed ? "Set all…" : list ? "+ Add" : ids.length ? "Change…" : "Choose…"));
}
