import { keyOf } from "../lib/keys";
import { copyButton, h } from "./dom";

type Severity = "info" | "warning" | "error";

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** What a key means to a question opened by the Delete key. A key still held from opening it repeats,
 *  and has to mean nothing: only a new press answers. Typing in a field stays typing. Any other key
 *  moves on, like arrows to another object: the question was about what was selected before, so it
 *  goes, or the next Delete would answer it for something else. */
export function deleteQuestionKey(e: { key: string; code?: string; repeat: boolean; target: unknown }): "yes" | "no" | "away" | null {
  const key = keyOf(e);
  if (MODIFIERS.has(key)) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const typing = t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || !!t?.isContentEditable;
  if (key === "Delete") return e.repeat || typing ? null : "yes";
  if (key === "Escape") return e.repeat ? null : "no";
  return "away";
}

export class Notifications {
  private root = h("div.notifications");

  constructor(host: HTMLElement) {
    host.append(this.root);
  }

  /** `expires`: the question goes away after this many ms, answered with nothing. `byKey`: the action
   *  the Delete key takes; Escape cancels, and so does moving on, by a click elsewhere or another key
   *  (see deleteQuestionKey). */
  show(severity: Severity, message: string, actions: string[] = [], expires?: number, byKey?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      let timer = 0;
      const onKey = (e: KeyboardEvent) => {
        const answer = deleteQuestionKey(e);
        if (answer === "away") { close(); return; }
        if (!answer) { if (keyOf(e) === "Delete" && e.repeat) { e.preventDefault(); e.stopPropagation(); } return; }
        // It answers this, and mustn't reach the list behind and ask again.
        e.preventDefault();
        e.stopPropagation();
        close(answer === "yes" ? byKey : undefined);
      };
      const onPress = (e: MouseEvent) => { if (!toast.contains(e.target as Node)) close(); };
      const close = (result?: string) => {
        clearTimeout(timer);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("mousedown", onPress, true);
        toast.remove();
        resolve(result);
      };
      const toast = h(
        `div.toast.${severity}`,
        {},
        h("span.toast-icon", {}, severity === "error" ? "✕" : severity === "warning" ? "!" : "i"),
        h("div.toast-body", {}, message),
        h(
          "div.toast-actions",
          {},
          ...actions.map((a) => h("button", { onclick: () => close(a) }, a === byKey ? `${a} (Del)` : a)),
          // An error can be pasted into a report.
          severity === "error" ? copyButton(message) : null,
          h("button.toast-close", { title: "Close", onclick: () => close() }, "×"),
        ),
      );
      this.root.append(toast);
      if (byKey) {
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("mousedown", onPress, true);
      }
      // Toasts that ask something stay until answered.
      if (expires) timer = window.setTimeout(() => close(), expires);
      else if (!actions.length) timer = window.setTimeout(() => close(), severity === "error" ? 12000 : 6000);
    });
  }
}

/** Status bar progress indicator, shown while any task is running. */
export class Progress {
  private running = new Map<number, string>();
  private next = 0;
  constructor(private el: HTMLElement) {
    this.render();
  }
  async run<T>(title: string, task: () => Promise<T>): Promise<T> {
    const id = this.next++;
    this.running.set(id, title);
    this.render();
    try {
      return await task();
    } finally {
      this.running.delete(id);
      this.render();
    }
  }
  private render() {
    const titles = [...this.running.values()];
    this.el.hidden = titles.length === 0;
    this.el.textContent = titles.length ? `⟳ ${titles[titles.length - 1]}` : "";
  }
}
