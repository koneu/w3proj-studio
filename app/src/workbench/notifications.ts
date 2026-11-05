import { h } from "./dom";

type Severity = "info" | "warning" | "error";

export class Notifications {
  private root = h("div.notifications");

  constructor(host: HTMLElement) {
    host.append(this.root);
  }

  /** `expires`: the question goes away after this many ms, answered with nothing. */
  show(severity: Severity, message: string, actions: string[] = [], expires?: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      let timer = 0;
      const close = (result?: string) => {
        clearTimeout(timer);
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
          ...actions.map((a) => h("button", { onclick: () => close(a) }, a)),
          h("button.toast-close", { title: "Close", onclick: () => close() }, "×"),
        ),
      );
      this.root.append(toast);
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
