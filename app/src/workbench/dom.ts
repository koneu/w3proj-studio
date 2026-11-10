import type { Disposable } from "../extensions/api";
import { keyOf } from "../lib/keys";
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
    const k = keyOf(e);
    if (k === "Escape") { take(); close(); keys.escape?.(); }
    else if (k === "ArrowDown") { take(); setActive(nextEnabled(enabled, active, 1)); }
    else if (k === "ArrowUp") { take(); setActive(nextEnabled(enabled, active, -1)); }
    else if ((k === "Enter" || k === " ") && active >= 0) { take(); choose(active); }
    else if (keys.side && k === "ArrowLeft") { take(); keys.side(-1); }
    else if (keys.side && k === "ArrowRight") { take(); keys.side(1); }
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

/** The prefix of the remembered widths of sashes in the webview's storage (this machine, not a project). */
export const SASH_PREFIX = "w3.sash:";

/** A width dragged to: `start` moved by `dx`, kept within min and max (min wins when the room is smaller). */
export function sashWidth(start: number, dx: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, start + dx)));
}

/** A width as remembered, or null for none (absent, or not a positive number). */
export function storedSashWidth(text: string | null): number | null {
  const n = text === null ? NaN : Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** A sash, as in VS Code: a handle on the right edge of `pane` (which it goes into, so `pane` needs a position)
 *  that sets the pane's width by dragging; a double click puts `initial` back. `apply` sets the width (a CSS
 *  variable, so the layout can still limit it); the width is remembered under `key`, for every editor of the kind.
 *  `max`: the most it may be now (the room beside it). */
export function widthSash(opts: { key: string; pane: HTMLElement; apply: (px: number) => void; initial: number; min: number; max: () => number },
  storage: StorageLike | undefined = globalThis.localStorage): HTMLElement {
  const key = SASH_PREFIX + opts.key;
  const read = () => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  /** The width last set: what is remembered, even where the layout shows less (a narrow window). */
  let width = 0;
  const set = (px: number) => { width = px; opts.apply(px); };
  set(Math.max(opts.min, storedSashWidth(read()) ?? opts.initial));
  let drag: { x: number; width: number; id: number } | null = null;
  const sash = h("div.sash", {
    title: "Drag to resize; double-click for the default width",
    onpointerdown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { x: e.clientX, width: opts.pane.getBoundingClientRect().width, id: e.pointerId };
      // A pointer the browser doesn't know (a made-up event) can't be captured: the drag still works over the sash.
      try { sash.setPointerCapture(e.pointerId); } catch { /* not captured */ }
      sash.classList.add("active");
    },
    onpointermove: (e: PointerEvent) => {
      if (drag?.id === e.pointerId) set(sashWidth(drag.width, e.clientX - drag.x, opts.min, opts.max()));
    },
    onpointerup: (e: PointerEvent) => end(e),
    onpointercancel: (e: PointerEvent) => end(e),
    ondblclick: () => {
      try { storage?.removeItem(key); } catch { /* not remembered */ }
      set(opts.initial);
    },
  });
  const end = (e: PointerEvent) => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    sash.classList.remove("active");
    if (sash.hasPointerCapture(e.pointerId)) sash.releasePointerCapture(e.pointerId);
    try { storage?.setItem(key, String(width)); } catch { /* not remembered */ }
  };
  opts.pane.append(sash);
  return sash;
}
