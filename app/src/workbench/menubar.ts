// The bar along the top: File, Edit and so on. Menus are built when opened, so commands of an
// extension loaded later are there.

import type { MenuItem } from "../extensions/api";
import { h, showContextMenu } from "./dom";
import type { Menu } from "./menus";

export class MenuBar {
  readonly root = h("div.menubar");
  /** The menu showing, while a dropdown is open. */
  private open: string | null = null;

  constructor(private menus: () => Menu[], private run: (command: string) => void) {}

  /** Call when commands were added. */
  render() {
    this.root.replaceChildren(...this.menus().map(({ name }) => {
      let wasOpen = false;
      const button = h("button.menubar-item", {
        // Pressing the button of an open menu closes it first (a press outside it): remember that.
        onmousedown: () => { wasOpen = this.showing() === name; },
        onclick: () => { if (wasOpen) this.open = null; else this.show(name, button); },
        onmouseenter: () => { const now = this.showing(); if (now && now !== name) this.show(name, button); },
      }, name);
      return button;
    }));
  }

  private showing() { return document.querySelector(".context-menu") ? this.open : null; }

  private show(name: string, button: HTMLElement) {
    const menu = this.menus().find((m) => m.name === name);
    if (!menu) return;
    const items: MenuItem[] = menu.groups.flatMap((group, i) => [
      ...(i ? ["-" as const] : []),
      ...group.map((e) => ({ label: e.title, shortcut: e.shortcut, run: () => this.run(e.id) })),
    ]);
    const r = button.getBoundingClientRect();
    showContextMenu({ x: r.left, y: r.bottom }, items);
    this.open = name;
  }
}
