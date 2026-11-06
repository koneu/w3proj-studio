// The window's top bar, as in VS Code: the menus on the left, a box in the middle that names the
// project and opens the commands, and the window's own buttons on the right. The window has no
// frame of its own, so dragging, resizing by the edges and closing are looked after here and by Tauri.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./dom";

export class TitleBar {
  readonly root: HTMLElement;
  private label = h("span.titlebar-search-label");

  constructor(menus: HTMLElement, openCommands: () => void) {
    const drag = { "data-tauri-drag-region": "" };
    const act = (work: (w: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) => () => void work(getCurrentWindow()).catch(() => {});
    this.root = h("div.titlebar", drag,
      menus,
      h("div.titlebar-middle", drag,
        h("button.titlebar-search", { title: "Show All Commands (Ctrl+Shift+P)", onclick: openCommands }, "⌕ ", this.label)),
      h("div.titlebar-window", {},
        h("button.titlebar-button", { title: "Minimize", "aria-label": "Minimize", onclick: act((w) => w.minimize()) }, "—"),
        h("button.titlebar-button", { title: "Maximize", "aria-label": "Maximize", onclick: act((w) => w.toggleMaximize()) }, "▢"),
        h("button.titlebar-button.titlebar-close", { title: "Close", "aria-label": "Close", onclick: act((w) => w.close()) }, "✕")));
    this.show(null);
  }

  /** The name in the middle, and the window's own title. */
  show(project: string | null) {
    this.label.textContent = project ?? "W3Proj Studio";
    document.title = project ? `${project} - W3Proj Studio` : "W3Proj Studio";
  }

  /** Closing with unsaved work asks first, however the window is closed. `settle` says whether to go on. */
  guardClose(unsaved: () => number, settle: () => Promise<boolean>) {
    try {
      const w = getCurrentWindow();
      void w.onCloseRequested(async (e) => {
        if (!unsaved()) return;
        e.preventDefault();
        if (await settle()) await w.destroy();
      });
    } catch { /* No window here: the smoke test's fake backend. */ }
  }
}
