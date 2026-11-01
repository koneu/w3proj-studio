import type { StatusBarItem } from "../extensions/api";
import { h } from "./dom";

export class StatusBar {
  readonly root = h("div.statusbar");
  private left = h("div.statusbar-left");
  private right = h("div.statusbar-right");
  readonly progress = h("span.statusbar-item.progress");

  constructor(private run: (command: string) => void) {
    this.left.append(this.progress);
    this.root.append(this.left, this.right);
  }

  add(opts: { id: string; text: string; tooltip?: string; command?: string; align?: "left" | "right"; priority?: number }): StatusBarItem {
    const el = h("span.statusbar-item", { "data-id": opts.id });
    const side = opts.align === "right" ? this.right : this.left;
    el.dataset.priority = String(opts.priority ?? 0);
    const after = [...side.children].find((c) => Number((c as HTMLElement).dataset.priority ?? 0) < (opts.priority ?? 0));
    side.insertBefore(el, after ?? null);
    let command = opts.command;
    el.addEventListener("click", () => command && this.run(command));
    const item: StatusBarItem = {
      get text() { return el.textContent ?? ""; },
      set text(v) { el.textContent = v; el.hidden = !v; },
      get tooltip() { return el.title; },
      set tooltip(v) { el.title = v; },
      get command() { return command; },
      set command(v) { command = v; el.classList.toggle("clickable", !!v); },
      dispose: () => el.remove(),
    };
    item.text = opts.text;
    item.tooltip = opts.tooltip ?? "";
    item.command = command;
    return item;
  }
}
