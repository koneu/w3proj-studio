// Colour tools for the fields that hold a text Warcraft III shows (map name, object names and tooltips, strings):
// a toolbar under the field (colour, the player colours, remove colour, line break) and a preview of the text as the
// game shows it. The field itself stays plain text; the tags stay visible in it.

import { insertBreak, type BreakForm, PLAYER_COLORS, plainText, removeColor, renderColorTags, wrapColor, type Edit } from "../lib/text/colortags";
import { h } from "../workbench/dom";

export interface ColorToolsOptions {
  /** Colour of the text without a colour tag in the preview (RRGGBB). */
  defaultColor?: string;
  /** Also fire `change` after each edit made with the toolbar (for fields that commit on it). */
  commit?: boolean;
  /** The line break this field stores: `|n` (string table, object data; the default) or a real line break (texts the
   *  info file holds directly). A real break can't go in a one-line box, so the button is off there. */
  lineBreak?: BreakForm;
}

/** Replaces the text of `field` with `next` as one editing step the field's own undo knows (the changed middle part
 *  is typed over), and puts the selection. */
export function applyEdit(field: HTMLInputElement | HTMLTextAreaElement, next: Edit): void {
  const old = field.value;
  let a = 0;
  while (a < old.length && a < next.text.length && old[a] === next.text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < next.text.length - a && old[old.length - 1 - b] === next.text[next.text.length - 1 - b]) b++;
  if (old !== next.text) {
    // Editors group the typing of one visit of a field into one undo step and end it on blur: a toolbar edit is a step
    // of its own, so the field is told the typing ended before and after it (the focus stays).
    field.dispatchEvent(new Event("blur"));
    field.focus({ preventScroll: true });
    field.setSelectionRange(a, old.length - b);
    const insert = next.text.slice(a, next.text.length - b);
    let done = false;
    try { done = insert ? document.execCommand("insertText", false, insert) : document.execCommand("delete"); } catch { /* falls back below */ }
    if (!done || field.value !== next.text) {
      field.value = next.text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  field.setSelectionRange(next.selStart, next.selEnd);
  if (old !== next.text) field.dispatchEvent(new Event("blur"));
}

/** `field` with the colour tools under it. */
export function withColorTools(field: HTMLInputElement | HTMLTextAreaElement, opts: ColorToolsOptions = {}): HTMLElement {
  let sel: [number, number] = [field.value.length, field.value.length];
  const remember = () => { sel = [field.selectionStart ?? sel[0], field.selectionEnd ?? sel[1]]; };
  for (const ev of ["select", "keyup", "mouseup", "blur", "input", "focus"]) field.addEventListener(ev, remember);

  const run = (make: (text: string, a: number, b: number) => Edit) => {
    const next = make(field.value, sel[0], sel[1]);
    applyEdit(field, next);
    remember();
    if (opts.commit) field.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const keepField = (e: Event) => e.preventDefault();

  const picker = h("input.color-tools-picker", { type: "color", value: "#ffffff", tabIndex: -1 });
  picker.addEventListener("change", () => run((t, a, b) => wrapColor(t, a, b, picker.value)));
  const button = (label: string, title: string, click: () => void, cls = "") => {
    const b = h(`button.color-tools-button${cls}`, { type: "button", title, tabIndex: -1 }, label);
    b.addEventListener("mousedown", keepField);
    b.addEventListener("click", click);
    return b;
  };
  const form = opts.lineBreak ?? "|n";
  const lineBreakButton = () => {
    const b = button("Line break", form === "|n" ? "Insert |n (this text is stored with |n for a line break)" : "Insert a real line break (this text is stored with real line breaks)", () => run((t, a, c) => insertBreak(t, a, c, form)));
    if (form !== "|n" && field instanceof HTMLInputElement) { b.disabled = true; b.title = "This one-line field can't hold a line break"; }
    return b;
  };
  const swatches = PLAYER_COLORS.map((c, i) => {
    const s = button("", `${i < 24 ? `Player ${i + 1}: ` : ""}${c.name} (${c.rgb})`, () => run((t, a, b) => wrapColor(t, a, b, c.rgb)), ".color-tools-swatch");
    s.style.backgroundColor = `#${c.rgb}`;
    return s;
  });
  const bar = h("div.color-tools-bar", { role: "toolbar", "aria-label": "Text colour" },
    button("Color…", "Colour the selection (a pair of tags at the caret without a selection)", () => { picker.click(); }),
    picker,
    h("span.color-tools-swatches", {}, ...swatches),
    button("Remove color", "Take the colour off the selection (the colour around the caret without one)", () => run((t, a, b) => removeColor(t, a, b))),
    lineBreakButton());

  const preview = h("div.color-tools-preview", { title: "Preview as the game shows it" });
  const paint = () => {
    const tagged = /\|[cCrRnN]/.test(field.value) || /[\r\n]/.test(field.value);
    preview.hidden = !tagged;
    if (tagged) renderColorTags(field.value, preview, opts.defaultColor ?? "FFFFFF");
    preview.setAttribute("aria-label", plainText(field.value));
  };
  field.addEventListener("input", paint);
  paint();
  return h("div.color-tools", {}, field, bar, preview);
}
