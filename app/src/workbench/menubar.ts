// The bar along the top: File, Edit and so on. Menus are built when opened, so commands of an
// extension loaded later are there. By keyboard: Alt alone goes to the bar, Alt and a letter opens
// a menu, and the arrow keys, Enter and Esc do the rest.

import type { MenuItem } from "../extensions/api";
import { keyOf } from "../lib/keys";
import { closeContextMenu, h, showContextMenu } from "./dom";
import { menuFor, type Menu, type MenuEntry } from "./menus";

export class MenuBar {
  readonly root = h("div.menubar");
  /** The menu showing, while a dropdown is open. */
  private open: string | null = null;
  /** Where the keyboard was before the bar, to go back to. */
  private before: HTMLElement | null = null;
  /** Alt is down, and nothing else happened since: letting go goes to the bar. */
  private altAlone = false;

  constructor(private menus: () => Menu[], private run: (command: string) => void, private blocked: (when: MenuEntry["when"]) => string | undefined) {
    this.root.addEventListener("keydown", (e) => this.barKey(e));
    window.addEventListener("keydown", (e) => this.globalKey(e), true);
    window.addEventListener("keyup", (e) => {
      if (keyOf(e) !== "Alt" || !this.altAlone) return;
      this.altAlone = false;
      e.preventDefault();
      this.toggleBar();
    }, true);
    // Alt and a click means something in the terrain view, and Alt+Tab leaves the window.
    window.addEventListener("mousedown", () => { this.altAlone = false; }, true);
    window.addEventListener("blur", () => { this.altAlone = false; });
  }

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

  private buttons() { return [...this.root.children] as HTMLElement[]; }

  private showing() { return document.querySelector(".context-menu") ? this.open : null; }

  private inBar() { return this.buttons().includes(document.activeElement as HTMLElement); }

  private enter(button: HTMLElement) {
    if (!this.inBar()) this.before = document.activeElement as HTMLElement | null;
    button.focus();
  }

  private leave() {
    this.before?.focus();
    if (this.inBar()) (document.activeElement as HTMLElement).blur();
    this.before = null;
  }

  private toggleBar() {
    if (this.showing()) { closeContextMenu(); this.leave(); return; }
    if (this.inBar()) { this.leave(); return; }
    const first = this.buttons()[0];
    if (first) this.enter(first);
  }

  private neighbour(button: HTMLElement, step: 1 | -1) {
    const list = this.buttons();
    return list[(list.indexOf(button) + step + list.length) % list.length];
  }

  private globalKey(e: KeyboardEvent) {
    const key = keyOf(e);
    if (key === "Alt") {
      if (!e.repeat) this.altAlone = !e.ctrlKey && !e.shiftKey && !e.metaKey;
      return;
    }
    this.altAlone = false;
    // Ctrl with Alt is AltGr, which types characters on many keyboards.
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || key.length !== 1) return;
    const name = menuFor(this.menus().map((m) => m.name), key);
    const button = this.buttons().find((b) => b.textContent === name);
    if (!name || !button) return;
    e.preventDefault();
    e.stopPropagation();
    this.enter(button);
    this.show(name, button, true);
  }

  /** The keys while a button of the bar has the focus and no menu is open. */
  private barKey(e: KeyboardEvent) {
    const button = e.target as HTMLElement;
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    const key = keyOf(e);
    if (key === "ArrowRight") { take(); this.neighbour(button, 1).focus(); }
    else if (key === "ArrowLeft") { take(); this.neighbour(button, -1).focus(); }
    else if (key === "Escape") { take(); this.leave(); }
    else if (key === "ArrowDown" || key === "Enter" || key === " ") { take(); this.show(button.textContent ?? "", button, true); }
  }

  private show(name: string, button: HTMLElement, keyboard = false) {
    const menu = this.menus().find((m) => m.name === name);
    if (!menu) return;
    const items: MenuItem[] = menu.groups.flatMap((group, i) => [
      ...(i ? ["-" as const] : []),
      ...group.map((e) => {
        const why = this.blocked(e.when);
        return { label: e.title, shortcut: e.shortcut, run: () => { this.leave(); this.run(e.id); }, disabled: !!why, ...(why ? { hint: why } : {}) };
      }),
    ]);
    const r = button.getBoundingClientRect();
    showContextMenu({ x: r.left, y: r.bottom }, items, {
      first: keyboard,
      side: (step) => {
        const next = this.neighbour(button, step);
        if (keyboard) next.focus();
        this.show(next.textContent ?? "", next, keyboard);
      },
      ...(keyboard ? { escape: () => button.focus() } : {}),
    });
    this.open = name;
  }
}
