// Editing one of the map's lights in the Lighting side bar, beside the terrain view, which shows the light as it is
// edited at the preview's time. Only an editor's tab can hold unsaved changes in the app, so here every change is saved
// to the light's file as it is made (a moment after, while a colour is dragged), with Undo and Redo of its own; the
// terrain view takes the light from memory, not waiting for the file.

import type { W3Api } from "../../extensions/api";
import type { LightPreview, LightPreviewService } from "../../extensions/services";
import { readLightMdl, writeLightMdl, type LightModel } from "../../lib/model/dnclight";
import { Listeners } from "../../lib/listeners";
import { bindUndoKeys, History } from "../../lib/undo";
import type { LightKind } from "../../lib/terrain/lightslots";
import { h } from "../../workbench/dom";
import { exportLight } from "./export";
import { lightForms, type FormHost } from "./form";

/** How long after a change the file is written: one write for the many steps of a dragged colour. */
const SAVE_AFTER = 300;

interface Open { kind: LightKind; file: string; root: string; model: LightModel; history: History; element: HTMLElement; unbind: () => void }

export function lightSession(w3: W3Api, refresh: () => void) {
  let now: Open | null = null;
  /** The preview's time of day (0–24) and whether the terrain view shows it; kept from one light to the next. */
  let hour = 12, previewing = true;
  const changes = new Listeners<void>();
  const preview: LightPreviewService = {
    current(): LightPreview | null {
      if (!now || !previewing || now.root !== w3.workspace.project()?.root) return null;
      return { root: now.root, hour, terrain: now.kind === "terrain" ? now.model : null, unit: now.kind === "unit" ? now.model : null };
    },
    onDidChange: (listener) => changes.add(listener),
  };
  const shown = () => changes.fire(undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The writes in order; each takes the model as it is when its turn comes. */
  let writes: Promise<void> = Promise.resolve();
  let pending: Open | null = null;
  const write = (): Promise<void> => {
    clearTimeout(timer);
    const o = pending;
    pending = null;
    if (o) {
      writes = writes.then(async () => {
        // Another project open by now: its files are left alone.
        if (o.root !== w3.workspace.project()?.root) return;
        await w3.workspace.writeText(`map/${o.file}`, writeLightMdl(o.model));
      }).catch((e) => void w3.window.showError(`The light couldn't be saved: ${(e as Error).message ?? e}`));
    }
    return writes;
  };
  const saveSoon = (o: Open) => {
    pending = o;
    clearTimeout(timer);
    timer = setTimeout(() => void write(), SAVE_AFTER);
  };

  const close = async () => {
    const o = now;
    if (!o) return;
    await write();
    o.unbind();
    now = null;
    shown();
  };

  const open = async (kind: LightKind, file: string) => {
    await close();
    const path = `map/${file}`;
    if (w3.editors.unsavedPaths().some((p) => p.toLowerCase() === path.toLowerCase())) throw new Error(`${file} has unsaved changes in its editor tab: save or close that first.`);
    const model = readLightMdl(await w3.workspace.readText(path));
    if (!model.lights.length) throw new Error(`${file} has no lights.`);
    const element = h("div.lighting-session");
    const o: Open = { kind, file, root: w3.workspace.project()!.root, model, element, history: null!, unbind: () => {} };
    const body = h("div.lighting-forms.lighting-editor");
    const host: FormHost = {
      model: () => o.model,
      changed: (group) => { o.history.commit(group); buttons(); shown(); saveSoon(o); },
      refused: (why) => void w3.window.showError(why),
    };
    const render = (): void => { body.replaceChildren(...lightForms(host, render)); };
    o.history = new History(() => JSON.stringify(o.model), (state) => { o.model = JSON.parse(state) as LightModel; render(); buttons(); shown(); saveSoon(o); });
    const undo = h("button", { title: "Undo (Ctrl+Z)", onclick: () => { o.history.undo(); } }, "↶");
    const redo = h("button", { title: "Redo (Ctrl+Y)", onclick: () => { o.history.redo(); } }, "↷");
    const buttons = () => { undo.disabled = !o.history.canUndo; redo.disabled = !o.history.canRedo; };
    const clock = (v: number) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`;
    const time = h("span.lighting-time", {}, clock(hour));
    const slider = h("input.lighting-hour", { type: "range", min: "0", max: "23.95", step: "0.05", value: String(hour), title: "The time of day the terrain view shows the light at", oninput: () => {
      hour = Number(slider.value);
      time.textContent = clock(hour);
      shown();
    } });
    const box = h("input", { type: "checkbox", checked: previewing, onchange: () => { previewing = box.checked; shown(); } });
    element.append(
      h("label.lighting-row", { title: "The map's terrain view shows this light as you edit it, at the time below" }, box, " Preview in the terrain view"),
      h("div.lighting-row.lighting-clock", {}, h("span", {}, "Time"), slider, time),
      h("div.lighting-row", {}, undo, " ", redo, " ",
        h("button", { title: "Save the light as it is now to a file (.mdx or .mdl), the World Editor's Export Current Values", onclick: () => void exportLight(w3, o.model).catch((e) => w3.window.showError(String((e as Error).message ?? e))) }, "Export…"), " ",
        h("button", { title: "Close the form. Every change is saved already", onclick: () => void close().then(refresh) }, "Done")),
      h("div.lighting-row.muted", {}, "Changes are saved as you make them. Times are hours of the game day."),
      body,
    );
    o.unbind = bindUndoKeys(element, () => o.history.undo(), () => o.history.redo(), (e) => w3.keybindings.commandsFor(e));
    render();
    buttons();
    now = o;
    shown();
    refresh();
  };

  return {
    preview, open, close,
    isOpen: (kind: LightKind, file: string) => !!now && now.kind === kind && now.file === file && now.root === w3.workspace.project()?.root,
    element: () => now?.element ?? null,
    dispose: () => { void close(); },
  };
}
