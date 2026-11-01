import type { OutputChannel } from "../extensions/api";
import { h } from "./dom";

/** Bottom panel with named log channels. */
export class OutputPanel {
  readonly root = h("div.panel", { hidden: true });
  private select = h("select.panel-select");
  private body = h("pre.panel-body");
  private channels = new Map<string, string[]>();
  private current = "";

  constructor() {
    this.select.addEventListener("change", () => this.showChannel(this.select.value));
    this.root.append(
      h(
        "div.panel-header",
        {},
        h("span.panel-title", {}, "Output"),
        this.select,
        h("button.icon-button", { title: "Clear", onclick: () => this.clear(this.current) }, "⌫"),
        h("button.icon-button", { title: "Close panel", onclick: () => this.toggle(false) }, "×"),
      ),
      this.body,
    );
  }

  channel(name: string): OutputChannel {
    if (!this.channels.has(name)) {
      this.channels.set(name, []);
      this.select.append(h("option", { value: name }, name));
      if (!this.current) this.showChannel(name);
    }
    return {
      append: (line) => this.append(name, line),
      clear: () => this.clear(name),
      show: () => { this.showChannel(name); this.toggle(true); },
    };
  }

  toggle(show = this.root.hidden) {
    this.root.hidden = !show;
  }

  private append(name: string, line: string) {
    const time = new Date().toLocaleTimeString();
    const lines = this.channels.get(name)!;
    lines.push(`[${time}] ${line}`);
    if (lines.length > 5000) lines.splice(0, lines.length - 5000);
    if (name === this.current) {
      this.body.append(`[${time}] ${line}\n`);
      this.body.scrollTop = this.body.scrollHeight;
    }
  }

  private clear(name: string) {
    this.channels.set(name, []);
    if (name === this.current) this.body.textContent = "";
  }

  private showChannel(name: string) {
    this.current = name;
    this.select.value = name;
    this.body.textContent = (this.channels.get(name) ?? []).join("\n") + "\n";
    this.body.scrollTop = this.body.scrollHeight;
  }
}
