import { h } from "./dom";

type Severity = "info" | "warning" | "error";

/** What a key means to a question opened by the Delete key. A key still held from opening it repeats,
 *  and has to mean nothing: only a new press answers. Typing in a field stays typing. */
export function deleteQuestionKey(e: { key: string; repeat: boolean; target: unknown }): "yes" | "no" | null {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (e.repeat || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return null;
  return e.key === "Delete" ? "yes" : e.key === "Escape" ? "no" : null;
}

export class Notifications {
  private root = h("div.notifications");

  constructor(host: HTMLElement) {
    host.append(this.root);
  }

  /** `expires`: the question goes away after this many ms, answered with nothing. `byKey`: the action
   *  the Delete key takes, and Escape cancels (see deleteQuestionKey). */
  show(severity: Severity, message: string, actions: string[] = [], expires?: number, byKey?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      let timer = 0;
      const onKey = (e: KeyboardEvent) => {
        const answer = deleteQuestionKey(e);
        if (!answer) { if (e.key === "Delete" && e.repeat) { e.preventDefault(); e.stopPropagation(); } return; }
        // It answers this, and mustn't reach the list behind and ask again.
        e.preventDefault();
        e.stopPropagation();
        close(answer === "yes" ? byKey : undefined);
      };
      const close = (result?: string) => {
        clearTimeout(timer);
        window.removeEventListener("keydown", onKey, true);
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
          h("button.toast-close", { title: "Close", onclick: () => close() }, "×"),
        ),
      );
      this.root.append(toast);
      if (byKey) window.addEventListener("keydown", onKey, true);
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
