import type { Disposable } from "../extensions/api";
import { nextEnabled } from "./menus";

type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper: h("div.cls", { onclick }, child, ...). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}`,
  attrs: Record<string, any> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name as K);
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    // A textarea's text has no attribute; it is the value property.
    else if (k === "value" && el instanceof HTMLTextAreaElement) el.value = String(v);
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** Moves the keys to `el` from a click or change handler of a button, checkbox or select: now, and once more
 *  after the event. WebKitGTK (Linux) focuses the clicked control after its handlers ran, which would take the
 *  keys back; WebView2 (Windows) doesn't, and there the second call changes nothing. */
export function focusAfterClick(el: { focus(options?: FocusOptions): void; readonly isConnected: boolean }): void {
  const focus = () => { if (el.isConnected) el.focus({ preventScroll: true }); };
  focus();
  setTimeout(focus);
}

export function disposable(fn: () => void): Disposable {
  let done = false;
  return { dispose: () => { if (!done) { done = true; fn(); } } };
}

export class Emitter<T> {
  private listeners = new Set<(v: T) => void>();
  on(fn: (v: T) => void): Disposable {
    this.listeners.add(fn);
    return disposable(() => this.listeners.delete(fn));
  }
  fire(v: T) {
    for (const l of [...this.listeners]) {
      try { l(v); } catch (e) { console.error(e); }
    }
  }
}

/** Minimal glob: "*" within a segment, "**" across segments; a pattern
 *  without "/" matches the file name only. */
export function globMatch(pattern: string, path: string): boolean {
  const target = pattern.includes("/") ? path : path.split("/").pop()!;
  const re = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp(`^${re}$`, "i").test(target);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What the menu bar adds to a menu: left and right go to the next menu. */
export interface MenuKeys {
  /** Start on the first entry, as when opened by keyboard. */
  first?: boolean;
  side?(step: 1 | -1): void;
  escape?(): void;
}

let closeOpen: (() => void) | null = null;
export const closeContextMenu = () => closeOpen?.();

/** A context menu at a screen point; closes on choice, Escape or a click elsewhere. Up, down and
 *  Enter work in it. */
export function showContextMenu(at: { x: number; y: number }, items: import("../extensions/api").MenuItem[], keys: MenuKeys = {}) {
  closeOpen?.();
  const close = () => { menu.remove(); closeOpen = null; window.removeEventListener("mousedown", outside, true); window.removeEventListener("keydown", key, true); };
  const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const choices = items.filter((it) => it !== "-");
  const enabled = choices.map((it) => !it.disabled);
  const rows: HTMLElement[] = [];
  let active = -1;
  const setActive = (i: number) => { rows[active]?.classList.remove("active"); active = i; rows[i]?.classList.add("active"); };
  const choose = (i: number) => { const it = choices[i]; if (!it || it.disabled) return; close(); it.run(); };
  const key = (e: KeyboardEvent) => {
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { take(); close(); keys.escape?.(); }
    else if (e.key === "ArrowDown") { take(); setActive(nextEnabled(enabled, active, 1)); }
    else if (e.key === "ArrowUp") { take(); setActive(nextEnabled(enabled, active, -1)); }
    else if ((e.key === "Enter" || e.key === " ") && active >= 0) { take(); choose(active); }
    else if (keys.side && e.key === "ArrowLeft") { take(); keys.side(-1); }
    else if (keys.side && e.key === "ArrowRight") { take(); keys.side(1); }
  };
  // A menu with an on/off entry has a column for the check mark in every row (as VS Code's): the labels line up,
  // whether the entry is on or off.
  const checks = choices.some((it) => it.checked !== undefined);
  const menu = h(`div.context-menu${checks ? ".has-checks" : ""}`, {}, ...items.map((it) => {
    if (it === "-") return h("div.context-menu-sep");
    const i = rows.length;
    // An on/off entry: the mark is drawn by the stylesheet (::before), so the row's text stays its label.
    const toggle = it.checked !== undefined;
    const row = h(`div.context-menu-item${it.disabled ? ".disabled" : ""}${toggle ? ".toggle" : ""}${it.checked ? ".checked" : ""}`, {
      title: it.hint ?? "",
      role: toggle ? "menuitemcheckbox" : "menuitem",
      ...(toggle ? { "aria-checked": String(it.checked) } : {}),
      onclick: () => choose(i),
      onmouseenter: () => { if (!it.disabled) setActive(i); },
    }, it.label, ...(it.shortcut ? [h("span.context-menu-shortcut", {}, it.shortcut)] : []));
    rows.push(row);
    return row;
  }));
  closeOpen = close;
  document.body.append(menu);
  if (keys.first) setActive(nextEnabled(enabled, -1, 1));
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - r.height - 4))}px`;
  window.addEventListener("mousedown", outside, true);
  window.addEventListener("keydown", key, true);
}

/** The part of the browser's clipboard that copying needs (so a test can stand in for it). */
export interface ClipboardLike { writeText(text: string): Promise<void> }

/** Puts text on the clipboard. Resolves false (never throws) when there is no clipboard or it
 *  refuses, so a button can say so instead of failing silently. */
export async function copyText(text: string, clip: ClipboardLike | undefined = globalThis.navigator?.clipboard): Promise<boolean> {
  if (!clip) return false;
  try { await clip.writeText(text); return true; } catch { return false; }
}

/** A small "Copy" button for error messages: it copies `text()` and briefly says what happened. */
export function copyButton(text: string | (() => string), cls = "copy-error"): HTMLButtonElement {
  const b = h(`button.${cls}`, { title: "Copy this error message to the clipboard" }, "Copy") as HTMLButtonElement;
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await copyText(typeof text === "function" ? text() : text);
    b.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });
  return b;
}

/** The view an editor shows in place of itself when it can't open a file: the message, what can be
 *  done about it (`extra`, e.g. a button) and a Copy button for the message. Use this for every
 *  editor's failure, so the text can always be pasted into a report. */
export function errorView(message: string, ...extra: (Node | string | null | undefined | false)[]): HTMLDivElement {
  return h("div.editor-error", {}, `${message} `, ...extra, copyButton(message));
}
