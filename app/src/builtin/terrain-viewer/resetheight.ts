// Reset Height Field's dialog (the World Editor's Advanced menu): flat over the cliff levels, or Random, with its
// Skip water areas, Variation and Smoothing (lib/terrain/wholemap.ts randomizeHeightField). Like the World Editor's,
// the Random settings show only with Random ticked and start from its defaults each time.

import { h } from "../../workbench/dom";
import { keyOf } from "../../lib/keys";
import { RANDOM_DEFAULTS, RANDOM_MAX_SMOOTHING, RANDOM_MAX_VARIATION, type RandomHeights } from "../../lib/terrain/wholemap";

/** What the command does: flat, or Random (settings left out are the dialog's defaults). */
export type ResetHeightRequest = { random: false } | ({ random: true } & Partial<RandomHeights>);

/** The Random settings of a request, defaults filled in; null for the flat reset. */
export function randomSettings(req: ResetHeightRequest): RandomHeights | null {
  if (!req.random) return null;
  return {
    variation: req.variation ?? RANDOM_DEFAULTS.variation,
    smoothing: req.smoothing ?? RANDOM_DEFAULTS.smoothing,
    skipWater: req.skipWater ?? RANDOM_DEFAULTS.skipWater,
  };
}

/** The height a variation setting reaches either way (it moves by whole steps of 6.4: 1/20 of a cliff level). */
const reach = (variation: number) => `±${(Math.ceil(variation / 2) * 6.4).toFixed(1).replace(/\.0$/, "")}`;

/** The dialog. Resolves with the request, or null when cancelled. */
export function askResetHeight(): Promise<ResetHeightRequest | null> {
  return new Promise((resolve) => {
    const random = h("input.reset-height-random", { type: "checkbox" });
    const skipWater = h("input.reset-height-skip-water", { type: "checkbox", checked: RANDOM_DEFAULTS.skipWater });
    const variationValue = h("span.reset-height-value");
    const smoothingValue = h("span.reset-height-value");
    const variation = h("input.newmap-input.reset-height-variation", { type: "range", min: "0", max: String(RANDOM_MAX_VARIATION), step: "1", value: String(RANDOM_DEFAULTS.variation) });
    const smoothing = h("input.newmap-input.reset-height-smoothing", { type: "range", min: "0", max: String(RANDOM_MAX_SMOOTHING), step: "1", value: String(RANDOM_DEFAULTS.smoothing) });
    const show = () => {
      variationValue.textContent = `${variation.value} (${reach(Number(variation.value))})`;
      smoothingValue.textContent = smoothing.value;
      for (const row of randomRows) row.hidden = !random.checked;
      note.textContent = random.checked
        ? "Adds noise to the ground as it is, then smooths it; cliff levels and water stay."
        : "Every corner's ground back to flat over its cliff level; cliff levels and water stay.";
    };
    variation.addEventListener("input", show);
    smoothing.addEventListener("input", show);
    random.addEventListener("change", show);
    const close = (v: ResetHeightRequest | null) => { overlay.remove(); resolve(v); };
    const ok = () => close(random.checked
      ? { random: true, variation: Number(variation.value), smoothing: Number(smoothing.value), skipWater: skipWater.checked }
      : { random: false });
    const row = (label: string, ...content: HTMLElement[]) => h("label.newmap-row", {}, h("span.newmap-label", {}, label), ...content);
    const randomRows = [
      h("label.newmap-row.reset-height-check", {}, skipWater, " Skip water areas"),
      row("Variation", variation, variationValue),
      row("Smoothing", smoothing, smoothingValue),
    ];
    const note = h("div.muted");
    const overlay = h("div.picker-overlay.newmap-overlay.reset-height-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); },
      onkeydown: (e: KeyboardEvent) => {
        if (keyOf(e) === "Escape") close(null);
        if (keyOf(e) === "Enter") ok();
      },
    }, h("div.picker.newmap-dialog.random-dialog.reset-height-dialog", {},
      h("div.picker-header", {}, h("strong", {}, "Reset Height Field"), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(null) }, "×")),
      h("label.newmap-row.reset-height-check", {}, random, " Random"),
      ...randomRows,
      note,
      h("div.newmap-buttons", {},
        h("button", { onclick: () => close(null) }, "Cancel"),
        h("button.primary", { onclick: ok }, "Reset"))));
    show();
    document.body.append(overlay);
    random.focus();
  });
}
