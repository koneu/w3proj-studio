// Gameplay Constants (war3mapMisc.txt) and Game Interface (war3mapSkin.txt),
// like the World Editor's Advanced menu. Every value the game has is listed
// (Units\MiscMetaData.slk / UI\SkinMetaData.slk) with its default from the
// game's files; the map's file holds only the values it changes, so editing a
// value adds or changes one line and "reset" removes it. Texts that are TRIGSTR
// references are edited in war3map.wts.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { readIni, setIniValue } from "../../lib/formats/iniedit";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { StringTable } from "../../lib/formats/wts";
import { h } from "../../workbench/dom";

const MISC = "map/war3mapMisc.txt", SKIN = "map/war3mapSkin.txt", WTS = "map/war3map.wts";
type Mode = "misc" | "skin";

interface Field {
  /** Section in the map's file ("Misc", "CustomSkin", "TWN1", …) and key. */
  section: string;
  key: string;
  label: string;
  type: string;
  /** The game's value (and for interface values, what each race uses). */
  def: string;
  races?: [string, string][];
  min?: string;
  max?: string;
}

const SECTION_TITLES: Record<string, string> = {
  CustomSkin: "Interface", Errors: "Error Messages", FrameDef: "Interface Texts", Categories: "Categories",
  Misc: "Gameplay", HERO: "Hero Dependencies", TALT: "Altar Dependencies",
};
const sectionTitle = (s: string) => SECTION_TITLES[s] ?? (/^TWN(\d)$/.exec(s) ? `Town Hall Tier ${s.slice(3)}` : s);

/** The fields of a mode with labels and defaults, loaded once. */
const fieldCache = new Map<Mode, Promise<Field[]>>();
function loadFields(w3: W3Api, mode: Mode): Promise<Field[]> {
  let p = fieldCache.get(mode);
  if (!p) {
    p = (async () => {
      const text = (f: string) => w3.game.readText(f).catch(() => "");
      const strings = new Map<string, string>();
      for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
        for (const sec of parseIni(await text(f)).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
      }
      const label = (name: string, key: string) => (name.startsWith("WESTRING_") ? strings.get(name.toUpperCase()) ?? key : key).replace(/&/g, "");
      const lookup = (ini: Map<string, Map<string, string>>[], section: string, key: string) => {
        for (const m of ini) {
          const sec = [...m].find(([s]) => s.toLowerCase() === section.toLowerCase())?.[1];
          const v = sec && [...sec].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
          if (v !== undefined) return v;
        }
        return undefined;
      };
      if (mode === "misc") {
        // Later files win (MiscGame over MiscData); per-object sections are in ItemFunc.txt.
        const files = (await Promise.all(["Units\\MiscGame.txt", "Units\\MiscData.txt", "Units\\ItemFunc.txt"].map(text))).map(parseIni);
        return parseSlk(await text("Units\\MiscMetaData.slk")).filter((r) => r.field).map((r) => ({
          section: r.section, key: r.field, label: label(r.displayName, r.field), type: r.type,
          // Values may be followed by a comment ("0.75 // for cancelled construction").
          def: (lookup(files, r.section, r.field) ?? "").replace(/\s*\/\/.*$/, "").trim(), min: r.minVal, max: r.maxVal,
        }));
      }
      const skins = parseIni(await text("UI\\war3skins.txt"));
      const races = (skins.get("Main")?.get("Skins") ?? "Human,Orc,NightElf,Undead").split(",").map((s) => s.trim()).filter(Boolean);
      // Interface values come per race and game version (_V1 Frozen Throne, _V0 Reign of Chaos).
      const skinValue = (section: string, key: string) => {
        const sec = [...skins].find(([s]) => s.toLowerCase() === section.toLowerCase())?.[1];
        if (!sec) return undefined;
        for (const k of [key, `${key}_V1`, `${key}_V0`]) {
          const v = [...sec].find(([x]) => x.toLowerCase() === k.toLowerCase())?.[1];
          if (v !== undefined) return v;
        }
        return undefined;
      };
      const errors = parseIni(await text("Units\\CommandStrings.txt")), categories = parseIni(await text("Units\\UnitGlobalStrings.txt"));
      const frame = new Map<string, string>();
      for (const m of (await text("UI\\FrameDef\\GlobalStrings.fdf")).matchAll(/^\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"/gm)) frame.set(m[1].toUpperCase(), m[2]);
      return parseSlk(await text("UI\\SkinMetaData.slk")).filter((r) => r.field).map((r): Field => {
        let def = "", raceValues: [string, string][] | undefined;
        if (r.section === "CustomSkin") {
          raceValues = races.map((race): [string, string] => [race, skinValue(race, r.field) ?? ""]).filter(([, v]) => v);
          def = skinValue("Default", r.field) ?? raceValues[0]?.[1] ?? "";
        } else if (r.section === "Errors") def = lookup([errors], "Errors", r.field) ?? "";
        else if (r.section === "Categories") def = lookup([categories], "Categories", r.field) ?? "";
        else if (r.section === "FrameDef") def = frame.get(r.field.toUpperCase()) ?? "";
        return { section: r.section, key: r.field, label: label(r.displayName, r.field), type: r.type, def, races: raceValues };
      });
    })();
    p.catch(() => fieldCache.delete(mode));
    fieldCache.set(mode, p);
  }
  return p;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  /** Opens the map's file, creating an empty one first (the game's values apply until one changes). */
  const open = async (path: string) => {
    if (!w3.workspace.project()) throw new Error("Open or import a project first.");
    if (!w3.workspace.files().some((f) => f.path.toLowerCase() === path.toLowerCase())) {
      await w3.workspace.writeText(path, "");
      await w3.workspace.refresh();
    }
    const real = w3.workspace.files().find((f) => f.path.toLowerCase() === path.toLowerCase())?.path ?? path;
    await w3.editors.open(real, "w3.gameSettings");
  };
  ctx.subscriptions.push(
    w3.commands.register("w3.gameplayConstants.open", () => open(MISC)),
    w3.commands.register("w3.gameInterface.open", () => open(SKIN)),
    w3.editors.registerProvider("w3.gameSettings", {
      async resolve(el, doc) {
        const mode: Mode = /misc\.txt$/i.test(doc.path) ? "misc" : "skin";
        el.append(h("div.muted.gs-loading", {}, "Loading game data…"));
        const [fields, text, wtsText] = await Promise.all([loadFields(w3, mode), doc.readText(), w3.workspace.readText(WTS).catch(() => null)]);
        const view = new SettingsView(w3, el, mode, fields, text, wtsText !== null ? new StringTable(wtsText) : null, !doc.readOnly, (d) => doc.setDirty(d));
        return {
          save: async () => {
            await doc.writeText(view.text);
            await view.saveStrings();
            view.saved();
          },
          focus: () => el.focus(),
          watches: [WTS],
          // A file left empty (opened, nothing changed) isn't kept: the game's values apply anyway.
          dispose: () => {
            if (doc.readOnly) return;
            void w3.workspace.readText(doc.path).then((t) => (t.trim() === "" ? w3.workspace.delete(doc.path) : undefined)).catch(() => {});
          },
        };
      },
    }),
  );
}

interface State { text: string; texts: Map<number, string> }

class SettingsView {
  private query = "";
  private changedOnly = false;
  private undoStack: State[] = [];
  private redoStack: State[] = [];
  private savedAt = 0;
  /** Edited texts of war3map.wts (written on save). */
  private texts = new Map<number, string>();
  private folded = new Set<string>();

  constructor(private w3: W3Api, private el: HTMLElement, private mode: Mode, private fields: Field[], public text: string,
    private strings: StringTable | null, private editable: boolean, private setDirty: (d: boolean) => void) {
    el.classList.add("gs-editor");
    el.tabIndex = -1;
    el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if ((t instanceof HTMLInputElement && t.type !== "checkbox") || t instanceof HTMLTextAreaElement) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { this.step(this.undoStack, this.redoStack); e.preventDefault(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { this.step(this.redoStack, this.undoStack); e.preventDefault(); }
    });
    this.render();
  }

  saved() { this.savedAt = this.undoStack.length; this.setDirty(false); }
  /** Merges the edited texts onto war3map.wts as it is now (other editors may have saved
   *  strings since it was read); `strings` holds the file as read or last saved here. */
  async saveStrings() {
    if (!this.strings || !this.texts.size) return;
    const base = this.strings.serialize();
    const edited = new StringTable(base);
    for (const [n, t] of this.texts) edited.set(n, t);
    const current = await this.w3.workspace.readText(WTS).catch(() => base);
    const merged = StringTable.merge(base, edited, current);
    if (merged !== current) await this.w3.workspace.writeText(WTS, merged);
    this.strings.rebase(merged);
  }

  private change(fn: () => void) {
    if (!this.editable) return;
    this.undoStack.push({ text: this.text, texts: new Map(this.texts) });
    this.redoStack = [];
    if (this.savedAt > this.undoStack.length - 1) this.savedAt = -1;
    fn();
    this.setDirty(this.undoStack.length !== this.savedAt);
    this.render();
  }
  private step(from: State[], to: State[]) {
    const s = from.pop();
    if (!s) return;
    to.push({ text: this.text, texts: new Map(this.texts) });
    this.text = s.text;
    this.texts = s.texts;
    this.setDirty(this.undoStack.length !== this.savedAt);
    this.render();
  }

  /** The map's raw value of a field, if it sets one. */
  private mapValue(ini: Map<string, Map<string, string>>, f: Field) {
    return ini.get(f.section.toLowerCase())?.get(f.key.toLowerCase());
  }
  /** Text shown for a value: TRIGSTR references through the string table. */
  private shown(v: string) {
    const n = StringTable.ref(v.trim());
    if (n === null || !this.strings?.has(n)) return v;
    return this.texts.get(n) ?? this.strings.get(n)!;
  }
  private set(f: Field, value: string | null, current: string | undefined) {
    // A TRIGSTR value edits its string table text.
    const n = current !== undefined ? StringTable.ref(current.trim()) : null;
    if (value !== null && n !== null && this.strings?.has(n)) { this.change(() => { this.texts.set(n, value); }); return; }
    this.change(() => { this.text = setIniValue(this.text, f.section, f.key, value); });
  }

  private control(f: Field, current: string | undefined): HTMLElement {
    const value = current ?? f.def;
    if (f.type === "bool") {
      return h("input", { type: "checkbox", checked: value.trim() === "1", disabled: !this.editable,
        onchange: (e: Event) => this.set(f, (e.target as HTMLInputElement).checked ? "1" : "0", current) });
    }
    const numeric = ["int", "real", "unreal"].includes(f.type);
    const input = h("input.gs-input", {
      type: numeric ? "number" : "text", value: this.shown(value), readOnly: !this.editable, step: f.type === "int" ? "1" : "any",
      // Some values aren't in the game's files (the game supplies them itself).
      placeholder: value === "" ? "game default (not in the game data)" : "",
      min: f.min && /^-?\d/.test(f.min) ? f.min : undefined, max: f.max && /^-?\d/.test(f.max) ? f.max : undefined,
      title: f.type.endsWith("List") || f.type.endsWith("Table") ? "Comma-separated values" : "",
      onchange: () => { if (input.value !== this.shown(value)) this.set(f, input.value, current); },
    });
    return input;
  }

  render() {
    const scroll = this.el.querySelector(".gs-list")?.scrollTop ?? 0;
    const ini = readIni(this.text);
    const q = this.query.trim().toLowerCase();
    const rows = this.fields.filter((f) => {
      if (this.changedOnly && this.mapValue(ini, f) === undefined) return false;
      // Every word somewhere in the name, key or section ("hero level" finds "Hero Maximum Level").
      const hay = `${f.label} ${f.key} ${f.section}`.toLowerCase();
      return !q || q.split(/\s+/).every((w) => hay.includes(w));
    });
    const changed = this.fields.filter((f) => this.mapValue(ini, f) !== undefined).length;
    const bySection = new Map<string, Field[]>();
    for (const f of rows) bySection.set(f.section, [...(bySection.get(f.section) ?? []), f]);
    const search = h("input.gs-search", { type: "search", placeholder: "Filter by name or key", value: this.query,
      oninput: () => {
        const caret = search.selectionStart ?? search.value.length;
        this.query = search.value;
        this.render();
        // The redrawn box keeps the focus and the cursor where it was.
        const box = this.el.querySelector(".gs-search") as HTMLInputElement | null;
        box?.focus();
        box?.setSelectionRange(caret, caret);
      } });
    const list = h("div.gs-list", {}, ...[...bySection].flatMap(([section, fs]) => {
      const fold = this.folded.has(section) && !q;
      return [
        h("div.gs-section", { onclick: () => { if (fold) this.folded.delete(section); else this.folded.add(section); this.render(); } },
          `${fold ? "▸" : "▾"} ${sectionTitle(section)}`, h("small.muted", {}, ` ${fs.length}`)),
        ...(fold ? [] : fs.sort((a, b) => a.label.localeCompare(b.label)).map((f) => {
          const current = this.mapValue(ini, f);
          const isSet = current !== undefined;
          const raceInfo = f.races && f.races.length > 1 && new Set(f.races.map(([, v]) => v)).size > 1
            ? `\nPer race: ${f.races.map(([r, v]) => `${r}: ${v}`).join(" · ")}` : "";
          return h(`div.gs-row${isSet ? ".set" : ""}`, { title: `${f.section} › ${f.key} (${f.type})\nDefault: ${this.shown(f.def) || "(empty)"}${raceInfo}` },
            h("span.gs-label", {}, f.label),
            h("span.gs-control", {}, this.control(f, current)),
            h("span.gs-default.muted", {}, isSet ? `default ${this.shown(f.def) || "(empty)"}` : ""),
            isSet && this.editable ? h("button.icon-button", { title: "Reset to the game's value (removes it from the map)", onclick: () => this.set(f, null, undefined) }, "↺") : h("span"));
        })),
      ];
    }));
    const file = this.mode === "misc" ? "war3mapMisc.txt" : "war3mapSkin.txt";
    this.el.replaceChildren(
      h("div.gs-toolbar", {},
        h("strong", {}, this.mode === "misc" ? "Gameplay Constants" : "Game Interface"),
        search,
        h("label.gs-check", {}, h("input", { type: "checkbox", checked: this.changedOnly, onchange: (e: Event) => { this.changedOnly = (e.target as HTMLInputElement).checked; this.render(); } }), " Changed only"),
        h("span.muted", {}, `${changed} of ${this.fields.length} changed in ${file}`),
        changed && this.editable ? h("button", { title: "Remove every changed value (the game's values apply)", onclick: () => this.change(() => {
          for (const f of this.fields) if (this.mapValue(readIni(this.text), f) !== undefined) this.text = setIniValue(this.text, f.section, f.key, null);
        }) }, "Reset all") : null),
      rows.length ? list : h("p.muted.gs-empty", {}, this.changedOnly ? "The map changes none of these values." : "Nothing matches."));
    const l = this.el.querySelector(".gs-list");
    if (l) l.scrollTop = scroll;
    const a = document.activeElement;
    if ((!a || a === document.body || !a.isConnected) && this.el.isConnected) this.el.focus({ preventScroll: true });
  }
}
