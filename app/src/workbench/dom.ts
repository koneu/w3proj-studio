import type { Disposable } from "../extensions/api";

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

/** A context menu at a screen point; closes on choice, Escape or a click elsewhere. */
export function showContextMenu(at: { x: number; y: number }, items: import("../extensions/api").MenuItem[]) {
  document.querySelector(".context-menu")?.remove();
  const close = () => { menu.remove(); window.removeEventListener("mousedown", outside, true); window.removeEventListener("keydown", key, true); };
  const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const menu = h("div.context-menu", {}, ...items.map((it) => it === "-"
    ? h("div.context-menu-sep")
    : h(`div.context-menu-item${it.disabled ? ".disabled" : ""}`, {
      title: it.hint ?? "",
      onclick: () => { if (it.disabled) return; close(); it.run(); },
    }, it.label, ...(it.shortcut ? [h("span.context-menu-shortcut", {}, it.shortcut)] : []))));
  document.body.append(menu);
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - r.height - 4))}px`;
  window.addEventListener("mousedown", outside, true);
  window.addEventListener("keydown", key, true);
}
