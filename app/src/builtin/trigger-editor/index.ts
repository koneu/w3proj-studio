// Trigger Editor: war3map.wtg / war3map.wct as the World Editor's trigger
// module shows them. Left: the map (header script), variables, and the
// categories with their triggers, comments and variables. Right: the selected
// trigger's comment and its events, conditions and actions as text (or its
// custom script). Read-only for now; the files round-trip byte-exactly through
// lib/triggers, so editing can build on the same model.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, type ObjectsService } from "../../extensions/services";
import { StringTable } from "../../lib/formats/wts";
import { decodeImage } from "../../lib/image/index.ts";
import { branchLabels, ecaText, type DisplayContext } from "../../lib/triggers/display";
import { ACTION, CONDITION, EVENT, parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import { parseWct, parseWtg, textTriggers, type CustomTextFile, type Eca, type Item, type Param, type TriggerFile, type TriggerItem, type Variable } from "../../lib/triggers/wtg";
import { parseIni } from "../../lib/formats/text";
import { h } from "../../workbench/dom";

const WTG = "map/war3map.wtg", WCT = "map/war3map.wct";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.commands.register("w3.triggers.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      if (!w3.workspace.files().some((f) => f.path.toLowerCase() === WTG)) throw new Error("This project has no war3map.wtg.");
      await w3.editors.open(WTG, "w3.triggerEditor");
    }),
    w3.editors.registerProvider("w3.triggerEditor", {
      async resolve(el, doc) {
        el.classList.add("trig-editor");
        el.append(h("div.muted.trig-loading", {}, "Reading triggers…"));
        const data = await triggerData(w3);
        const file = parseWtg(await doc.readBytes(), data);
        const wctBytes = doc.path.startsWith("game:") ? null : await w3.workspace.readBytes(WCT).catch(() => null);
        const custom = wctBytes ? parseWct(wctBytes, textTriggers(file).length) : null;
        const wtsText = await w3.workspace.readText("map/war3map.wts").catch(() => null);
        const strings = wtsText !== null ? new StringTable(wtsText) : null;
        const names = await objectNames(w3, file);
        const display: DisplayContext = { data, string: (v) => strings?.resolve(v) ?? v, objectName: (id) => names.get(id) };
        el.replaceChildren();
        new TriggerView(w3, el, file, custom, data, display);
        return {};
      },
    }),
  );
}

/** TriggerData with WESTRING_ names resolved, loaded once. */
let dataPromise: Promise<TriggerData> | null = null;
function triggerData(w3: W3Api): Promise<TriggerData> {
  dataPromise ??= (async () => {
    const strings = new Map<string, string>();
    for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
    }
    return parseTriggerData(await w3.game.readText("UI\\TriggerData.txt"), strings);
  })();
  dataPromise.catch(() => { dataPromise = null; });
  return dataPromise;
}

/** Names of the object ids the triggers mention (raw codes and gg_unit_xxxx globals). */
async function objectNames(w3: W3Api, file: TriggerFile): Promise<Map<string, string>> {
  const ids = new Set<string>();
  const visitParam = (p: Param) => {
    if (p.type === 3 && p.value.length === 4) ids.add(p.value);
    const g = /^gg_(?:unit|item|dest)_(.{4})_\d+$/.exec(p.value);
    if (g) ids.add(g[1]);
    p.call?.params.forEach(visitParam);
    if (p.index) visitParam(p.index);
  };
  const visit = (e: Eca) => { e.params.forEach(visitParam); e.children.forEach(visit); };
  for (const it of file.items) if ("ecas" in it) it.ecas.forEach(visit);
  const out = new Map<string, string>();
  const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
  if (!objects) return out;
  await Promise.all([...ids].map(async (id) => {
    const n = await objects.name(id).catch(() => undefined);
    if (n) out.set(id, n);
  }));
  return out;
}

/** Icons of the trigger categories (ReplaceableTextures\WorldEditUI\Actions-*.blp) as data URLs. */
const iconCache = new Map<string, Promise<string | null>>();
function icon(w3: W3Api, path: string): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  let p = iconCache.get(path.toLowerCase());
  if (!p) {
    p = (async () => {
      const file = /\.\w+$/.test(path) ? path : `${path}.blp`;
      const mip = decodeImage(await w3.game.read(file), file).mip(0);
      const canvas = document.createElement("canvas");
      canvas.width = mip.width;
      canvas.height = mip.height;
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
      return canvas.toDataURL();
    })().catch(() => null);
    iconCache.set(path.toLowerCase(), p);
  }
  return p;
}

type Selection = { kind: "header" } | { kind: "variables" } | { kind: "item"; item: Item };

class TriggerView {
  private tree = h("div.trig-tree");
  private detail = h("div.trig-detail");
  private selected: Selection = { kind: "header" };
  private collapsed = new Set<number>();
  private children = new Map<number, Item[]>();

  constructor(private w3: W3Api, el: HTMLElement, private file: TriggerFile, private custom: CustomTextFile | null,
    private data: TriggerData, private ctx: DisplayContext) {
    for (const it of file.items) {
      // Categories start as the file left them (expanded or not).
      if ((it.type === 2 || it.type === 4) && !it.expanded) this.collapsed.add(it.id);
      if (it.type === 1) continue;
      const list = this.children.get(it.parent) ?? [];
      list.push(it);
      this.children.set(it.parent, list);
    }
    el.append(this.tree, this.detail);
    this.renderTree();
    this.renderDetail();
  }

  private customText(t: TriggerItem): string | null {
    const i = textTriggers(this.file).indexOf(t);
    return i >= 0 ? this.custom?.texts[i] ?? null : null;
  }

  private row(label: string, cls: string, depth: number, sel: Selection, opts: { toggle?: number; title?: string } = {}) {
    const active = this.selected.kind === sel.kind && (sel.kind !== "item" || (this.selected.kind === "item" && this.selected.item === sel.item));
    const caret = opts.toggle !== undefined
      ? h("span.trig-caret", { onclick: (e: Event) => { e.stopPropagation(); this.toggle(opts.toggle!); } }, this.collapsed.has(opts.toggle) ? "▸" : "▾")
      : h("span.trig-caret");
    return h(`div.trig-row.${cls}${active ? ".active" : ""}`, {
      style: { paddingLeft: `${6 + depth * 14}px` }, title: opts.title ?? "",
      onclick: () => { this.selected = sel; this.renderTree(); this.renderDetail(); },
      ondblclick: () => { if (opts.toggle !== undefined) this.toggle(opts.toggle); },
    }, caret, h("span.trig-label", {}, label));
  }

  private toggle(id: number) {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.renderTree();
  }

  private renderTree() {
    const rows: HTMLElement[] = [];
    const root = this.file.items.find((i) => i.type === 1);
    rows.push(this.row(root?.name || this.w3.workspace.project()?.name || "Map", "trig-map", 0, { kind: "header" }, { title: "Map header: custom script code" }));
    rows.push(this.row(`Variables (${this.file.variables.length})`, "trig-vars", 0, { kind: "variables" }));
    const walk = (parent: number, depth: number) => {
      for (const it of this.children.get(parent) ?? []) {
        if (it.type === 2 || it.type === 4) {
          rows.push(this.row(it.name, it.type === 4 ? "trig-cat" : "trig-lib", depth, { kind: "item", item: it }, { toggle: it.id }));
          if (!this.collapsed.has(it.id)) walk(it.id, depth + 1);
        } else if (it.type === 64) {
          rows.push(this.row(it.name, "trig-var", depth, { kind: "item", item: it }));
        } else if ("ecas" in it) {
          const cls = it.type === 16 ? "trig-comment" : it.isCustom ? "trig-custom" : "trig-gui";
          const r = this.row(it.name, cls, depth, { kind: "item", item: it });
          if (!it.enabled) r.classList.add("off");
          rows.push(r);
        }
      }
    };
    walk(root ? root.id : -1, 1);
    this.tree.replaceChildren(...rows);
  }

  private renderDetail() {
    const s = this.selected;
    if (s.kind === "header") {
      const header = this.custom?.header;
      this.detail.replaceChildren(
        h("h2", {}, "Map script header"),
        ...(this.custom?.comment ? [h("p.trig-desc", {}, this.custom.comment)] : []),
        header ? h("pre.trig-code", {}, header) : h("p.muted", {}, "No custom script code."));
      return;
    }
    if (s.kind === "variables") { this.detail.replaceChildren(h("h2", {}, "Variables"), this.variablesTable(this.file.variables)); return; }
    const it = s.item;
    if (it.type === 64) {
      const v = this.file.variables.find((x) => x.id === it.id);
      this.detail.replaceChildren(h("h2", {}, it.name), v ? this.variablesTable([v]) : h("p.muted", {}, "Variable not found."));
      return;
    }
    if (!("ecas" in it)) {
      const n = (this.children.get(it.id) ?? []).length;
      this.detail.replaceChildren(h("h2", {}, it.name), h("p.muted", {}, `Category · ${n} item${n === 1 ? "" : "s"}`));
      return;
    }
    const badges = [
      !it.enabled && "Disabled", it.initiallyOff && "Initially off", it.isCustom && "Custom text", it.runOnInit && "Run on map initialization",
      it.type === 16 && "Comment",
    ].filter(Boolean) as string[];
    const parts: (HTMLElement | null)[] = [
      h("h2", {}, it.name, ...badges.map((b) => h("span.trig-badge", {}, b))),
      it.description ? h("p.trig-desc", {}, it.description) : null,
    ];
    if (it.type === 16) { this.detail.replaceChildren(...parts.filter((x): x is HTMLElement => !!x)); return; }
    if (it.isCustom) {
      const text = this.customText(it);
      parts.push(text ? h("pre.trig-code", {}, text) : h("p.muted", {}, "No custom text stored for this trigger."));
    } else {
      for (const [kind, label] of [[EVENT, "Events"], [CONDITION, "Conditions"], [ACTION, "Actions"]] as const) {
        const list = it.ecas.filter((e) => e.kind === kind);
        parts.push(h("div.trig-section", {}, label), h("div.trig-ecas", {}, ...list.map((e) => this.ecaNode(e))));
      }
    }
    this.detail.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }

  private ecaNode(e: Eca): HTMLElement {
    const img = h("img.trig-icon", { alt: "" });
    const f = this.data.find(e.kind, e.name);
    const cat = f ? this.data.categories.get(f.category) : undefined;
    void icon(this.w3, cat?.icon ?? "").then((url) => { if (url) img.src = url; else img.classList.add("none"); });
    const line = h(`div.trig-eca${e.enabled ? "" : ".off"}`, { title: e.name }, img, h("span", {}, ecaText(e, this.ctx)));
    if (!e.children.length) return line;
    const labels = branchLabels(e.name);
    const groups = [...new Set(e.children.map((c) => c.group ?? 0))].sort((a, b) => a - b);
    return h("div.trig-block", {}, line, ...groups.map((g) => h("div.trig-branch", {},
      h("div.trig-branch-label", {}, labels[g] ?? "Actions"),
      ...e.children.filter((c) => (c.group ?? 0) === g).map((c) => this.ecaNode(c)))));
  }

  private variablesTable(vars: Variable[]): HTMLElement {
    if (!vars.length) return h("p.muted", {}, "No variables.");
    const typeName = (t: string) => this.data.types.get(t)?.name ?? t;
    return h("table.trig-vars-table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Array"), h("th", {}, "Initial value"))),
      h("tbody", {}, ...vars.map((v) => h("tr", {},
        h("td", {}, h("code", { title: `udg_${v.name} in the script` }, v.name)),
        h("td", {}, typeName(v.type)),
        h("td", {}, v.isArray ? `[${v.arraySize}]` : ""),
        h("td", {}, v.initialized
          ? this.data.presets.get(v.initialValue)?.name ?? this.ctx.string?.(v.initialValue) ?? v.initialValue
          : h("span.muted", {}, "default"))))));
  }
}
