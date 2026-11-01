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
