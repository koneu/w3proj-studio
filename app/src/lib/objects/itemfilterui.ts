// Choose Item's two limits of a random item as two choices, for every place a random item is picked (a placed object's
// and a doodad's drops, the map's item tables and its random groups). Plain DOM: lib has no workbench.

import { ANY_EQUIPMENT, ANY_TAG, EQUIPMENT_LABELS, ITEM_TAG_LABELS, parseRandomId } from "./randomids";

export interface ItemFilterSelects {
  elements: HTMLSelectElement[];
  /** The chosen equipment type's and tag's numbers, -1 for any (randomids.ts withItemFilter). */
  equipment(): number;
  tag(): number;
  /** Shows the limits of the random item `id`; for any other id the choices stay (they are for the next pick). */
  show(id: string): void;
}

function choice(prop: string, title: string, any: string, labels: readonly string[]): HTMLSelectElement {
  const select = document.createElement("select");
  select.dataset.prop = prop;
  select.title = title;
  select.append(...[any, ...labels].map((label, i) => {
    const option = document.createElement("option");
    option.value = String(i - 1);
    option.textContent = label;
    return option;
  }));
  return select;
}

/** `pre`: in front of the two data-props (random-equipment, random-tag). */
export function itemFilterSelects(pre = ""): ItemFilterSelects {
  const equipment = choice(`${pre}random-equipment`, "Only random items of this equipment type", ANY_EQUIPMENT, EQUIPMENT_LABELS);
  const tag = choice(`${pre}random-tag`, "Only random items with this tag", ANY_TAG, ITEM_TAG_LABELS);
  return {
    elements: [equipment, tag],
    equipment: () => Number(equipment.value),
    tag: () => Number(tag.value),
    show(id) {
      const r = parseRandomId(id);
      if (r?.kind !== "item") return;
      equipment.value = String(r.equipment ?? -1);
      tag.value = String(r.tag ?? -1);
    },
  };
}
