// The Object Placer's "Random…" dialog: a Random Unit, Random Building or Random Item to place, chosen when the
// game starts, either at random by level (an item also by class) or from a random group of Map Properties (the
// World Editor's Random / Group choices, WESTRING_RNDDLG_RANDOM and _RANDGROUP).

import { h } from "../../workbench/dom";
import { keyOf } from "../../lib/keys";
import { ITEM_CLASSES, positionsFor, type RandomGroup, type RandomSpec, type RandomWhat } from "../../lib/terrain/randomplace";

const WHATS: [RandomWhat, string][] = [["unit", "Random Unit"], ["building", "Random Building"], ["item", "Random Item"]];
const MAX_LEVEL = 20;

/** Asks what to place; null when cancelled. `last` is what was chosen before. */
export function askRandom(host: HTMLElement, groups: readonly RandomGroup[], last: RandomSpec | null): Promise<RandomSpec | null> {
  return new Promise((resolve) => {
    const what = h("select.random-what", {}, ...WHATS.map(([v, label]) => h("option", { value: v, selected: v === (last?.what ?? "unit") }, label)));
    const byLevel = h("input.random-by-level", { type: "radio", name: "random-by", checked: last?.by !== "group" });
    const byGroup = h("input.random-by-group", { type: "radio", name: "random-by", checked: last?.by === "group" });
    const level = h("select.random-level", {}, h("option", { value: "-1" }, "Any"),
      ...Array.from({ length: MAX_LEVEL + 1 }, (_, i) => h("option", { value: String(i) }, String(i))));
    level.value = String(last?.by === "level" ? last.level : -1);
    const itemClass = h("select.random-class", {}, ...ITEM_CLASSES.map((c, i) => h("option", { value: String(i) }, c)));
    itemClass.value = String(last?.by === "level" ? last.itemClass ?? 0 : 0);
    const group = h("select.random-group");
    const position = h("select.random-position");
    const error = h("div.newmap-error");
    const levelRow = h("label.newmap-row", {}, h("span.newmap-label", {}, "Level"), level);
    const classRow = h("label.newmap-row", {}, h("span.newmap-label", {}, "Class"), itemClass);
    const buildingNote = h("div.muted", {}, "Any neutral passive building (a tavern, a goblin merchant, …).");
    const groupRows = [h("label.newmap-row", {}, h("span.newmap-label", {}, "Group"), group), h("label.newmap-row", {}, h("span.newmap-label", {}, "Position"), position)];

    /** The groups with a position for this kind of object. */
    const usable = () => groups.filter((g) => positionsFor(g, what.value as RandomWhat).length);
    const fillPositions = () => {
      const g = groups.find((x) => String(x.number) === group.value);
      const keep = position.value;
      position.replaceChildren(...(g ? positionsFor(g, what.value as RandomWhat) : []).map((p) => h("option", { value: String(p) }, `Position ${p + 1}`)));
      if ([...position.options].some((o) => o.value === keep)) position.value = keep;
      else if (last?.by === "group" && String(last.group) === group.value) position.value = String(last.position);
    };
    const fillGroups = () => {
      const keep = group.value || (last?.by === "group" ? String(last.group) : "");
      const list = usable();
      group.replaceChildren(...list.map((g) => h("option", { value: String(g.number) }, `${g.number}: ${g.name}`)));
      if (list.some((g) => String(g.number) === keep)) group.value = keep;
      fillPositions();
    };
    const sync = () => {
      const w = what.value as RandomWhat, inGroup = byGroup.checked;
      fillGroups();
      levelRow.hidden = inGroup || w === "building";
      classRow.hidden = inGroup || w !== "item";
      buildingNote.hidden = inGroup || w !== "building";
      for (const r of groupRows) r.hidden = !inGroup;
      byGroup.disabled = !usable().length;
      byGroup.parentElement!.title = byGroup.disabled ? `No random group of Map Properties has a position for ${w === "item" ? "items" : `${w}s`}.` : "";
      if (byGroup.disabled && inGroup) { byLevel.checked = true; sync(); }
    };
    what.addEventListener("change", sync);
    byLevel.addEventListener("change", sync);
    byGroup.addEventListener("change", sync);
    group.addEventListener("change", fillPositions);

    const close = (v: RandomSpec | null) => { overlay.remove(); resolve(v); };
    const ok = () => {
      const w = what.value as RandomWhat;
      if (byGroup.checked) {
        if (!group.value || !position.value) { error.textContent = "Choose a group and a position."; return; }
        close({ what: w, by: "group", group: Number(group.value), position: Number(position.value) });
        return;
      }
      close({ what: w, by: "level", level: w === "building" ? -1 : Number(level.value), ...(w === "item" ? { itemClass: Number(itemClass.value) } : {}) });
    };
    const overlay = h("div.picker-overlay.newmap-overlay.random-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); },
      onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Escape") close(null); if (keyOf(e) === "Enter") ok(); },
    }, h("div.picker.newmap-dialog.random-dialog", {},
      h("div.picker-header", {}, h("strong", {}, "Place a random object"), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(null) }, "×")),
      h("p.muted", {}, "Chosen when the game starts. Placed as the question mark; Cycle Random Groups shows what a group's lines put there."),
      h("label.newmap-row", {}, h("span.newmap-label", {}, "Place"), what),
      h("div.newmap-row", {}, h("span.newmap-label", {}, "Choose"),
        h("label", {}, byLevel, " Random"), h("label", {}, byGroup, " From a random group")),
      levelRow, classRow, buildingNote, ...groupRows,
      error,
      h("div.newmap-buttons", {}, h("button", { onclick: () => close(null) }, "Cancel"), h("button.primary", { onclick: ok }, "Place"))));
    sync();
    host.append(overlay);
    overlay.focus();
  });
}
