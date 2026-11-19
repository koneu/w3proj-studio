// The web demo's title bar: the menus and the command box as the desktop app draws them, without the window's own
// buttons (a browser tab has its own). Stands in for workbench/titlebar.ts through the plugin in vite.demo.config.ts.

import { h } from "../workbench/dom";

export class TitleBar {
  readonly root: HTMLElement;
  private label = h("span.titlebar-search-label");

  constructor(menus: HTMLElement, openCommands: () => void) {
    this.root = h("div.titlebar", {},
      menus,
      h("div.titlebar-middle", {},
        h("button.titlebar-search", { title: "Show All Commands (Ctrl+Shift+P)", onclick: openCommands }, "⌕ ", this.label)));
    this.show(null);
  }

  show(project: string | null) {
    this.label.textContent = project ?? "W3Proj Studio";
    document.title = project ? `${project} - W3Proj Studio (web demo)` : "W3Proj Studio (web demo)";
  }

  /** A browser tab has no unsaved-work guard of its own to hook into here; the demo's files are throwaway. */
  guardClose(_unsaved: () => number, _settle: () => Promise<boolean>, _beforeClose?: () => void) {}
}
