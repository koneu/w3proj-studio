// The form over a day/night lighting model, used by the editor of a lighting model (a tab) and by the Lighting side
// bar: per light its intensities, colours over the day and direction.

import type { Key, Light, LightModel, Prop, Track } from "../../lib/model/dnclight";
import { h } from "../../workbench/dom";
import { lightNumber } from "./numbers";
import { rotationOf, sunAngleOf } from "./sunangle";

/** Whether the rotation's own numbers are unfolded: kept over the form's redraws. */
let rotationOpen = false;

export interface FormHost {
  /** The model as it is now (an undo puts another one in its place). */
  model(): LightModel;
  /** After every change to the model; `group` keeps dragging in one colour picker one undo step. */
  changed(group?: unknown): void;
  /** A typed value the model's file can't hold: said, and nothing changed. */
  refused(why: string): void;
}

/** The form's sections, one per light; `redraw` makes them again after a change of their shape. */
export function lightForms(host: FormHost, redraw: () => void): HTMLElement[] {
  const model = host.model();
  const changed = (group?: unknown) => host.changed(group);
  const seq = model.sequences[0] ?? { start: 0, end: 60000 };
  const span = Math.max(1, seq.end - seq.start);
  /** Animation time ↔ hour of the game day (the "Stand" sequence spans one day). */
  const toHour = (t: number) => ((t - seq.start) / span) * 24;
  const toTime = (hour: number) => Math.round(seq.start + (hour / 24) * span);

  /** A number the model's file stores as a 32-bit float (or, with `limits`, within them): a typed value it can't hold is
   *  refused with why, the box shows the value kept, and the model stays as it was. */
  const num = (label: string, get: () => number, set: (v: number) => void, step = "0.05", limits: { min?: number; max?: number } = {}) => {
    const shown = () => String(Number(get().toPrecision(6)));
    const input = h("input.form-input.form-num.lighting-num", { type: "number", step, value: shown() });
    input.addEventListener("change", () => {
      const t = lightNumber(input.value, label, limits);
      if ("refused" in t) { host.refused(t.refused); input.value = shown(); return; }
      set(t.value);
      changed();
    });
    return input;
  };
  // Light colours are stored blue, green, red (the game's night colour reads as blue that way).
  const hex = (c: number[]) => "#" + [c[2], c[1], c[0]].map((v) => Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255).toString(16).padStart(2, "0")).join("");
  const unhex = (s: string) => [5, 3, 1].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  const row = (label: string, ...control: (Node | string)[]) => h("div.form-row", {}, h("span.form-label", {}, label), h("div.form-control", {}, ...control));

  /** The in or out tangent of a Hermite/Bezier key: one number per component of the value. */
  const tangent = (k: Key, side: "inTan" | "outTan", width: number) => {
    const v = (k[side] ??= new Array(width).fill(0));
    return h("span", {}, ...v.map((_, c) => num(`${side === "inTan" ? "In" : "Out"} tangent${width > 1 ? " " + "xyzw"[c] : ""}`, () => v[c], (x) => { v[c] = x; }, "0.05")));
  };

  /** Keyframe table of a track: hour (for day tracks), value editor, remove; plus "Add key". */
  const trackEditor = (t: Track, width: number, value: (k: { value: number[] }) => Node, dayTime: boolean, redraw: () => void) => {
    const body = h("tbody", {}, ...t.keys.map((k, i) => h("tr", {},
      h("td", {}, dayTime
        ? num("Hour", () => toHour(k.time), (v) => { k.time = toTime(v); t.keys.sort((a, b) => a.time - b.time); redraw(); }, "0.25", { min: 0, max: 24 })
        : h("span.muted", {}, String(k.time))),
      h("td", {}, value(k)),
      ...(t.interp > 1 ? (["inTan", "outTan"] as const).map((side) => h("td.lighting-tangent", {}, tangent(k, side, width))) : []),
      h("td", {}, t.keys.length > 1 ? h("button.icon-button", { title: "Remove this key", onclick: () => { t.keys.splice(i, 1); changed(); redraw(); } }, "×") : null))));
    const add = h("button", { onclick: () => {
      // A new key halfway between the last two (or after the only one), same value as before it.
      const last = t.keys[t.keys.length - 1];
      const prev = t.keys[t.keys.length - 2];
      const time = prev ? Math.round((prev.time + last.time) / 2) : Math.min(seq.end, last.time + 1000);
      const zero = new Array(width).fill(0);
      t.keys.push({ time, value: [...last.value], ...(t.interp > 1 ? { inTan: [...zero], outTan: [...zero] } : {}) });
      t.keys.sort((a, b) => a.time - b.time);
      changed();
      redraw();
    } }, "Add key");
    return h("div", {}, h("table.form-table.lighting-keys", {},
      h("thead", {}, h("tr", {}, h("th", {}, dayTime ? "Hour" : "Time"), h("th", {}, "Value"), ...(t.interp > 1 ? [h("th", { title: "Hermite/Bezier: the slope arriving at the key" }, "In tangent"), h("th", { title: "The slope leaving the key" }, "Out tangent")] : []), h("th", {}))), body), add);
  };

  /** A colour over the day: gradient preview and keys, or one colour. */
  const colorProp = (p: Prop, redraw: () => void) => {
    if (!("track" in p)) {
      const pick = h("input", { type: "color", value: hex(p.value), oninput: () => { p.value = unhex(pick.value); changed(pick); } });
      return pick;
    }
    const t = p.track;
    const stops = t.keys.map((k) => `${hex(k.value)} ${(toHour(k.time) / 24 * 100).toFixed(1)}%`).join(", ");
    return h("div", {},
      h("div.lighting-gradient", { style: { background: `linear-gradient(to right, ${stops})` }, title: "0:00 → 24:00" }),
      trackEditor(t, 3, (k) => h("input", { type: "color", value: hex(k.value), oninput: (e: Event) => { k.value = unhex((e.target as HTMLInputElement).value); changed(e.target); } }), true, redraw));
  };

  /** A number: fixed, or keys over the day. */
  const numberProp = (p: Prop, redraw: () => void) => ("track" in p
    ? trackEditor(p.track, 1, (k) => num("Value", () => k.value[0], (v) => { k.value = [v]; }), true, redraw)
    : num("Value", () => p.value[0], (v) => { p.value = [v]; }));

  /** Where the light comes from, per key: as a sun angle, and (folded away) as the rotation the file stores. Typing an
   *  angle writes that key's rotation (sunangle.ts); a key nobody types into keeps its rotation as it is. */
  const directionEditor = (t: Track, redraw: () => void) => {
    const angle = (k: Key, part: "direction" | "height") => num(part === "direction" ? "Sun direction" : "Sun height",
      () => sunAngleOf(k.value)[part],
      (v) => { k.value = rotationOf({ ...sunAngleOf(k.value), [part]: v }); redraw(); },
      "1", part === "direction" ? { min: 0, max: 360 } : { min: -90, max: 90 });
    const hourOf = (k: Key) => h("td.muted", {}, `${Number(toHour(k.time).toFixed(2))} h`);
    const raw = h("details.lighting-rotation", { open: rotationOpen, ontoggle: () => { rotationOpen = raw.open; } },
      h("summary", {}, "As a rotation (quaternion x, y, z, w)"),
      h("table.form-table.lighting-keys", {}, h("tbody", {}, ...t.keys.map((k) => h("tr", {},
        hourOf(k),
        ...[0, 1, 2, 3].map((c) => h("td", {}, num(`Rotation ${"xyzw"[c]}`, () => k.value[c], (v) => { k.value[c] = v; redraw(); }, "0.01"))))))));
    return h("div", {},
      h("small.muted", {}, "Where the sun stands: direction in degrees (0 east, 90 north, 180 west, 270 south) and height above the horizon (90 straight above)."),
      h("table.form-table.lighting-keys.lighting-sun", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Hour"), h("th", {}, "Direction °"), h("th", {}, "Height °"))),
        h("tbody", {}, ...t.keys.map((k) => h("tr", {}, hourOf(k), h("td", {}, angle(k, "direction")), h("td", {}, angle(k, "height")))))),
      raw);
  };

  const lightForm = (l: Light, redraw: () => void) => h("section.form-section", {},
    h("h3", {}, `${l.name} (${["omnidirectional", "directional", "ambient"][l.type] ?? "light"})`),
    row("Intensity", numberProp(l.intensity, redraw)),
    row("Colour", colorProp(l.color, redraw)),
    row("Ambient intensity", numberProp(l.ambIntensity, redraw)),
    row("Ambient colour", colorProp(l.ambColor, redraw)),
    row("Shadow intensity", num("Shadow intensity", () => l.shadowIntensity, (v) => { l.shadowIntensity = v; })),
    l.rotation ? row("Direction", directionEditor(l.rotation, redraw)) : null,
  );

  return model.lights.map((l) => lightForm(l, redraw));
}
