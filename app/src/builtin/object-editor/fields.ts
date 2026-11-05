// Field editors by metadata type, as the World Editor offers them:
// - object codes and lists of them (unitCode, abilityList, techList, …): chosen
//   in the object browser, lists as removable chips;
// - the types UI\UnitEditorData.txt defines: one choice (attackType, armorType,
//   …), a comma list (targetList, pathingList…), or bit flags (…Flags).

import type { W3Api } from "../../extensions/api";
import type { ObjectsService } from "../../extensions/services";
import { parseIni, westring } from "../../lib/formats/text";
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
  entries: { value: string; label: string; alts: string[] }[];
}

/** UnitEditorData types stored as comma lists whose name doesn't end in "List". */
const LISTS = new Set(["unitClass"]);

let typesPromise: Promise<Map<string, EditorType>> | null = null;
/** The value types of UI\UnitEditorData.txt with their labels (WorldEditStrings). */
export function loadEditorTypes(w3: W3Api): Promise<Map<string, EditorType>> {
  typesPromise ??= (async () => {
    const strings = new Map<string, string>();
    for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
    }
    const out = new Map<string, EditorType>();
    for (const [name, sec] of parseIni(await w3.game.readText("UI\\UnitEditorData.txt"))) {
      const entries: EditorType["entries"] = [];
      for (const [k, v] of sec) {
        if (!/^\d+$/.test(k)) continue;
        const [value, label] = v.split(",");
        entries.push({ value, label: label ? westring(strings, label) : value, alts: (sec.get(`${k}_alt`) ?? "").split(",").filter(Boolean) });
      }
      if (!entries.length) continue;
      // unitClass is stored as a comma list too ("giant,undead"), though its name doesn't say so.
      out.set(name, { shape: /Flags$/.test(name) ? "flags" : /List/.test(name) || LISTS.has(name) ? "list" : "single", entries });
    }
    return out;
  })();
  typesPromise.catch(() => { typesPromise = null; });
  return typesPromise;
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
      if (mixed) { mixed.each((old) => setListValue(old, e.value, e.alts, (boxes[n] as HTMLInputElement).checked)); return; }
      onCommit(t.entries.filter((_, i) => (boxes[i] as HTMLInputElement).checked).map((x) => x.value).join(","));
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
    void objects.name(id).then((n) => { if (n) name.textContent = `${n} (${id})`; });
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
