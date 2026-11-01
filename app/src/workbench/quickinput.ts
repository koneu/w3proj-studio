import type { QuickPickItem } from "../extensions/api";
import { h } from "./dom";

/** Subsequence match; returns a score (lower is better) or -1. */
function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    gaps += found - ti;
    ti = found + 1;
  }
  return 100 + gaps;
}

/** The single overlay used for the command palette, quick picks and input boxes. */
export class QuickInput {
  private root = h("div.quick-input", { hidden: true });
  private input = h("input.quick-input-box", { spellcheck: false });
  private list = h("div.quick-input-list");
  private message = h("div.quick-input-message");
  private close: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.root.append(this.input, this.message, this.list);
    host.append(this.root);
    document.addEventListener("mousedown", (e) => {
      if (!this.root.hidden && !this.root.contains(e.target as Node)) this.close?.();
    });
  }

  pick<T>(items: QuickPickItem<T>[], opts: { placeholder?: string; value?: string } = {}): Promise<QuickPickItem<T> | undefined> {
    this.close?.();
    return new Promise((resolve) => {
      let shown: QuickPickItem<T>[] = [];
      let active = 0;
      const render = () => {
        const q = this.input.value.trim();
        shown = items
          .map((it) => ({ it, s: fuzzy(q, `${it.label} ${it.description ?? ""}`) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => a.s - b.s)
          .map((x) => x.it);
        active = Math.min(active, Math.max(0, shown.length - 1));
        this.list.replaceChildren(
          ...shown.slice(0, 200).map((it, i) =>
            h(
              `div.quick-input-item${i === active ? ".active" : ""}`,
              { onmousedown: (e: MouseEvent) => { e.preventDefault(); finish(it); } },
              h("span.label", {}, it.label),
              it.description ? h("span.description", {}, it.description) : null,
              it.detail ? h("div.detail", {}, it.detail) : null,
            ),
          ),
        );
        this.list.children[active]?.scrollIntoView({ block: "nearest" });
        this.message.textContent = shown.length ? "" : "No matching results";
      };
      const finish = (it: QuickPickItem<T> | undefined) => {
        cleanup();
        resolve(it);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") { active = Math.min(active + 1, shown.length - 1); render(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
        else if (e.key === "Enter") { finish(shown[active]); e.preventDefault(); }
        else if (e.key === "Escape") { finish(undefined); e.preventDefault(); }
      };
      const cleanup = this.open(opts.placeholder ?? "", opts.value ?? "", render, onKey, () => finish(undefined));
      render();
    });
  }

  ask(opts: { prompt?: string; value?: string; placeholder?: string } = {}): Promise<string | undefined> {
    this.close?.();
    return new Promise((resolve) => {
      const finish = (v: string | undefined) => { cleanup(); resolve(v); };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter") { finish(this.input.value); e.preventDefault(); }
        else if (e.key === "Escape") { finish(undefined); e.preventDefault(); }
      };
      const cleanup = this.open(opts.placeholder ?? "", opts.value ?? "", () => {}, onKey, () => finish(undefined));
      this.list.replaceChildren();
      this.message.textContent = opts.prompt ? `${opts.prompt} (Enter to confirm, Esc to cancel)` : "";
      this.input.select();
    });
  }

  private open(placeholder: string, value: string, onInput: () => void, onKey: (e: KeyboardEvent) => void, onClose: () => void) {
    this.input.placeholder = placeholder;
    this.input.value = value;
    this.message.textContent = "";
    this.root.hidden = false;
    this.input.addEventListener("input", onInput);
    this.input.addEventListener("keydown", onKey);
    this.close = onClose;
    queueMicrotask(() => this.input.focus());
    return () => {
      this.input.removeEventListener("input", onInput);
      this.input.removeEventListener("keydown", onKey);
      this.root.hidden = true;
      this.close = null;
    };
  }
}
