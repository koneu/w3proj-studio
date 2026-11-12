// Sound Editor: the map's sounds and music (war3map.w3s.json) like the World
// Editor's Sound Editor. Left: the game's sound files by folder and the map's
// imported ones, with search and playback; "Add as sound" / "Add as music".
// Right: the map's sounds and the selected one's settings. Sounds that play a
// game sound label keep their settings unset (the label's values apply), as
// the World Editor stores them.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { toArchiveName } from "../../lib/formats/archivepath";
import { readImported } from "../../lib/imports";
import { lookupWestring, parseIni, parseSlk } from "../../lib/formats/text";
import { renameInTriggers } from "../../lib/triggers/renamed";
import { ident } from "../../lib/script/names";
import { bindUndoKeys, History } from "../../lib/undo";
import { exportSound, replaceSound } from "./soundfiles";
import { h } from "../../workbench/dom";
import { errorText } from "../../lib/oserror";
import { Listeners } from "../../lib/listeners";
import { SOUNDS_SERVICE, type SoundsService } from "../../extensions/services";
import {
  findLabel, isUnset, labelIndex, logicalPath, newSound, soundName, IMPORTED, LOOPING, MUSIC, SOUND_EXTENSIONS, STOP_OUT_OF_RANGE, THREE_D, UNSET,
  type Sound, type SoundLabel,
} from "./sounds";

const RAW = "map/war3map.w3s", FILE = `${RAW}.json`;
const SOUND_INFO = ["AbilitySounds", "AmbienceSounds", "AnimSounds", "CinematicSounds", "DialogSounds", "DialogueCreepsBase", "DialogueDemonBase",
  "DialogueHumanBase", "DialogueNagaBase", "DialogueNightElfBase", "DialogueOrcBase", "DialogueUndeadBase", "EnvironmentSounds", "SoundAssetCombat",
  "UISounds", "UnitAckSounds", "UnitCombatSounds"];

interface SoundsDoc { format?: string; version: number; sounds: Sound[] }
interface GameSounds {
  /** Logical path → full storage path (first layer found). */
  files: Map<string, string>;
  labels: Map<string, SoundLabel>;
  channels: [number, string][];
  effects: [string, string][];
}

let gameSounds: Promise<GameSounds> | null = null;
function loadGameSounds(w3: W3Api): Promise<GameSounds> {
  gameSounds ??= (async () => {
    const text = (p: string) => w3.game.readText(p).catch(() => "");
    const files = new Map<string, string>();
    for (const full of await w3.game.list()) {
      if (!SOUND_EXTENSIONS.test(full) || !/^War3\.w3mod:/i.test(full)) continue;
      const p = logicalPath(full);
      if (!files.has(p)) files.set(p, full);
    }
    const strings = new Map<string, string>();
    for (const sec of parseIni(await text("UI\\WorldEditStrings.txt")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
    const str = (k: string) => lookupWestring(strings, k) ?? k;
    const wed = parseIni(await text("UI\\WorldEditData.txt"));
    const channels = [...(wed.get("SoundChannels") ?? new Map())].map(([k, v]): [number, string] => [Number(k), str(v.split(",")[1] ?? k)])
      .filter(([k]) => Number.isFinite(k)).sort((a, b) => a[0] - b[0]);
    const effects = parseSlk(await text("UI\\SoundInfo\\EAXDefs.slk")).filter((r) => r.EAXLabel)
      .map((r): [string, string] => [r.EAXLabel, str(r.DisplayText || r.EAXLabel)]);
    const labels = labelIndex(await Promise.all(SOUND_INFO.map(async (n) => parseSlk(await text(`UI\\SoundInfo\\${n}.slk`)))));
    return { files, labels, channels, effects };
  })();
  gameSounds.catch(() => { gameSounds = null; });
  return gameSounds;
}

/** Plays a sound file: imported ones from the project, game ones from storage (other extensions tried). The audio
 *  and its object URL (to stop it and free the URL), or null (said why) when there's nothing to play. */
async function playSoundFile(w3: W3Api, path: string, game: GameSounds | null): Promise<{ audio: HTMLAudioElement; url: string } | null> {
  // Under its name on disk, whatever the case the sound names (as the game finds it).
  let bytes: Uint8Array | null = await readImported(w3, path).catch(() => null);
  if (!bytes && game) {
    const full = game.files.get(path)
      ?? [".flac", ".mp3", ".wav", ".ogg"].map((e) => game.files.get(path.replace(SOUND_EXTENSIONS, e))).find(Boolean);
    bytes = await w3.game.read(full ?? path).catch(() => null);
  }
  if (!bytes) { void w3.window.showWarning(`Can't find ${path}.`); return null; }
  const ext = (/\.(\w+)$/.exec(path)?.[1] ?? "").toLowerCase();
  const type = ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : ext === "wav" ? "audio/wav" : "audio/flac";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const audio = new Audio(url);
  void audio.play().catch((e) => w3.window.showWarning(`Can't play ${path}: ${errorText(e)}`));
  return { audio, url };
}

/** Why `name` (without gg_snd_) can't be the name of `s` among `sounds`, or null if it can. */
export function soundNameProblem(sounds: readonly Sound[], s: Sound, name: string): string | null {
  const n = `gg_snd_${name.trim()}`;
  return !/^gg_snd_[A-Za-z][A-Za-z0-9_]*$/.test(n) || n.endsWith("_") || sounds.some((x) => x !== s && x.name === n)
    ? "Names start with a letter, use letters, digits and _ (not at the end) and are unique." : null;
}

/** The sound played by w3.sounds.play (one at a time). */
let playing: { audio: HTMLAudioElement; url: string } | null = null;
const stopPlaying = () => { playing?.audio.pause(); if (playing) URL.revokeObjectURL(playing.url); playing = null; };

/** The Sound Editor shown last, for the commands of the palette. */
let current: SoundEditor | null = null;
const needEditor = () => {
  if (!current) throw new Error("Open the Sound Editor and select a sound first.");
  return current;
};

/** SoundsService.onDidEdit's listeners. */
const edits = new Listeners();

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const service: SoundsService = {
    liveSounds: () => (current?.canEdit ? current.sounds : null),
    onDidEdit: (listener) => edits.add(listener),
  };
  ctx.subscriptions.push(
    w3.services.provide(SOUNDS_SERVICE, service),
    w3.commands.register("w3.sounds.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      // The JSON form, else the raw file (decoded by the format engine); a map without sounds
      // opens an empty list, and the file is created on the first save.
      const files = new Set(w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
      if (!files.has(FILE) && files.has(RAW)) { await w3.editors.open(RAW, "w3.soundEditor"); return; }
      await w3.editors.open(FILE, "w3.soundEditor");
    }),
    // Plays a sound file (the map's or the game's) without opening anything: the Object Manager's Play Sound.
    w3.commands.register("w3.sounds.play", async (file: unknown) => {
      if (typeof file !== "string" || !file) throw new Error("w3.sounds.play takes a sound file.");
      stopPlaying();
      const game = await loadGameSounds(w3).catch(() => null);
      playing = await playSoundFile(w3, file, game);
      return playing !== null;
    }),
    // Rename or delete a map sound from elsewhere (the Object Manager), as the Sound Editor does by hand: it opens at the
    // sound, and the change is an unsaved undo step there (a rename reaches triggers and regions when saved). Delete asks
    // first. True when it was done.
    w3.commands.register("w3.sounds.soundAction", async (name: unknown, action: unknown, to?: unknown) => {
      if (typeof name !== "string" || (action !== "rename" && action !== "delete")) throw new Error("w3.sounds.soundAction takes a sound name and \"rename\" or \"delete\".");
      if (action === "rename" && (typeof to !== "string" || !to.trim())) throw new Error("Renaming needs a name.");
      await w3.commands.execute("w3.sounds.open");
      const editor = current;
      if (!editor) throw new Error("The Sound Editor didn't open.");
      if (!editor.canEdit) throw new Error("This sound list can't be changed here.");
      const s = editor.select(name);
      if (action === "rename") return editor.rename(s, (to as string).replace(/^gg_snd_/, ""));
      if (!(await w3.window.askDelete(`Delete the sound ${name.replace(/^gg_snd_/, "")}? Triggers and regions using it keep its name.`, "Delete"))) return false;
      // The editor closed during the question: nothing is done.
      if (current !== editor) return false;
      editor.remove(s);
      return true;
    }),
    { dispose: stopPlaying },
    w3.commands.register("w3.sounds.export", () => needEditor().exportCurrent()),
    w3.commands.register("w3.sounds.replace", () => needEditor().replaceCurrent()),
    w3.editors.registerProvider("w3.soundEditor", {
      async resolve(el, doc) {
        // The raw file goes through the format engine both ways.
        const raw = !doc.path.toLowerCase().endsWith(".json");
        const root = w3.workspace.project()!.root;
        const isNew = !raw && !w3.workspace.files().some((f) => f.path.toLowerCase() === doc.path.toLowerCase());
        const sounds: SoundsDoc = isNew ? { format: "w3proj.sounds/1", version: 3, sounds: [] }
          : JSON.parse(raw ? await w3.backend.invoke<string>("codec_decode", { root, path: doc.path }) : await doc.readText());
        sounds.sounds ??= [];
        // Names as last saved, to carry renames into triggers and regions.
        const savedName = new Map(sounds.sounds.map((x) => [x, x.name]));
        // Undo restores into the same sound objects (by a stable id), so the rename tracking holds.
        const ids = new WeakMap<Sound, number>();
        const byId = new Map<number, Sound>();
        const idOf = (x: Sound) => {
          let i = ids.get(x);
          if (i === undefined) { ids.set(x, i = byId.size); byId.set(i, x); }
          return i;
        };
        const history = new History(() => JSON.stringify(sounds.sounds.map((x) => [idOf(x), x])), (state) => {
          sounds.sounds = (JSON.parse(state) as [number, Sound][]).map(([i, data]) => {
            const x = byId.get(i)!;
            for (const k of Object.keys(x)) delete (x as unknown as Record<string, unknown>)[k];
            return Object.assign(x, data);
          });
          doc.setDirty(history.dirty);
          editor.refresh();
          if (current === editor) edits.fire();
        });
        const changed = () => { if (history.commit() && current === editor) edits.fire(); doc.setDirty(history.dirty); };
        const editor = new SoundEditor(w3, el, sounds, changed, !doc.readOnly);
        current = editor;
        const unbindKeys = bindUndoKeys(el, () => history.undo(), () => history.redo(), (e) => w3.keybindings.commandsFor(e));
        void loadGameSounds(w3).then((g) => editor.setGame(g), (e) => editor.setGameError(String(e)));
        return {
          undo: () => { history.undo(); },
          redo: () => { history.redo(); },
          async save() {
            if (raw) await w3.backend.invoke("codec_write", { root, path: doc.path, text: JSON.stringify({ format: "w3proj.sounds/1", ...sounds }) });
            else await doc.writeText(await w3.backend.invoke<string>("codec_canonicalize", { root, path: doc.path, text: JSON.stringify(sounds) }));
            if (isNew) await w3.workspace.refresh();
            const renames = new Map(sounds.sounds.filter((x) => savedName.has(x) && savedName.get(x) !== x.name).map((x) => [savedName.get(x)!, x.name]));
            if (renames.size) await renameReferences(w3, renames);
            for (const x of sounds.sounds) savedName.set(x, x.name);
            history.markSaved();
            doc.setDirty(false);
          },
          dispose: () => {
            editor.dispose();
            unbindKeys();
            if (current === editor) { current = null; edits.fire(); }
          },
        };
      },
    }),
  );
}

/** Renamed sounds in the regions' ambient sounds (the saved file) and in the triggers (w3.triggers.renameGlobals: the
 *  open Trigger Editor or the files, GUI parameters and, after a question, script text). */
async function renameReferences(w3: W3Api, renames: Map<string, string>) {
  const out = w3.output.channel("Sound Editor");
  const root = w3.workspace.project()!.root;
  const regions = await w3.workspace.readText("map/war3map.w3r.json").catch(() => null);
  if (regions) {
    const doc = JSON.parse(regions) as { regions: { sound?: string }[] };
    let n = 0;
    for (const r of doc.regions) if (r.sound && renames.has(r.sound)) { r.sound = renames.get(r.sound)!; n++; }
    if (n) {
      await w3.workspace.writeText("map/war3map.w3r.json", await w3.backend.invoke<string>("codec_canonicalize", { root, path: "map/war3map.w3r.json", text: JSON.stringify(doc) }));
      out.append(`renamed sounds in ${n} region${n === 1 ? "" : "s"}`);
    }
  }
  // A sound's name is its global (gg_snd_…); the Sound Editor only gives names that stay the same as identifiers.
  const pairs = [...renames].map(([from, to]) => [from.replace(/^gg_snd_/, ""), to.replace(/^gg_snd_/, "")] as [string, string])
    .filter(([from, to]) => renames.get(`gg_snd_${from}`) === `gg_snd_${to}` && ident(from) === from && ident(to) === to);
  if (pairs.length) await renameInTriggers(w3, "snd", pairs, "sounds");
}

class SoundEditor {
  private game: GameSounds | null = null;
  private browser = h("div.snd-browser");
  private list = h("div.snd-list");
  private detail = h("div.snd-detail");
  private selectedFile: { path: string; source: "game" | "map" } | null = null;
  private selected: Sound | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private query = "";
  private open = new Set<string>();
  private tab: "game" | "map" = "game";
  private imported: string[] = [];

  constructor(private w3: W3Api, el: HTMLElement, private doc: SoundsDoc, private changed: () => void, private editable: boolean) {
    el.classList.add("snd-editor");
    el.append(h("div.snd-left", {}, this.browser), h("div.snd-right", {}, this.list, this.detail));
    this.imported = w3.workspace.files().map((f) => f.path.replace(/\\/g, "/"))
      .filter((p) => p.startsWith("map/") && SOUND_EXTENSIONS.test(p)).map((p) => toArchiveName(p.slice(4)));
    this.renderBrowser();
    this.renderList();
    this.renderDetail();
  }

  /** Export Sound: the selected sound's file, else the file selected on the left. */
  async exportCurrent() {
    const path = this.selected?.file ?? this.selectedFile?.path;
    if (!path) throw new Error("Select a sound, or a sound file on the left, first.");
    await exportSound(this.w3, path, this.game?.files ?? null);
  }
  /** Replace Internal Sound: the selected sound's file is replaced by one from disk. */
  async replaceCurrent() {
    if (!this.editable) throw new Error("This Sound Editor is read-only.");
    if (!this.selected) throw new Error("Select one of the map's sounds first.");
    await replaceSound(this.w3, this.selected.file);
  }
  private failed = (e: unknown) => void this.w3.window.showError(String((e as Error).message ?? e));

  setGame(g: GameSounds) { this.game = g; this.renderBrowser(); this.renderDetail(); }
  setGameError(msg: string) { this.browser.replaceChildren(h("p.muted", {}, `Game sounds unavailable: ${msg}`)); }
  dispose() { this.stop(); }
  /** After undo/redo: the list and the selected sound (if it's still there). */
  refresh() {
    if (this.selected && !this.doc.sounds.includes(this.selected)) this.selected = null;
    this.renderList();
    this.renderDetail();
  }

  // ---- playback ---------------------------------------------------------------------
  private stop() {
    this.audio?.pause();
    this.audio = null;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
  }
  /** Plays a sound file: imported ones from the project, game ones from storage (other extensions tried). */
  private async play(path: string) {
    this.stop();
    const p = await playSoundFile(this.w3, path, this.game);
    if (p) ({ audio: this.audio, url: this.audioUrl } = p);
  }

  // ---- browser ----------------------------------------------------------------------
  private renderBrowser() {
    const tabs = h("div.snd-tabs", {},
      h(`button${this.tab === "game" ? ".active" : ""}`, { onclick: () => { this.tab = "game"; this.renderBrowser(); } }, "Game sounds"),
      h(`button${this.tab === "map" ? ".active" : ""}`, { onclick: () => { this.tab = "map"; this.renderBrowser(); } }, `Imported (${this.imported.length})`));
    const search = h("input.snd-search", { type: "search", placeholder: "Search files", value: this.query,
      oninput: () => { this.query = search.value; clearTimeout(this.timer); this.timer = setTimeout(() => this.renderFiles(files), 150); } });
    const files = h("div.snd-files");
    const actions = h("div.snd-actions", {},
      h("button", { title: "Play the selected file", onclick: () => this.selectedFile && void this.play(this.selectedFile.path) }, "▶ Play"),
      h("button", { title: "Stop playback", onclick: () => this.stop() }, "■ Stop"),
      h("button", { title: "Save the selected file to a file of your own", onclick: () => this.selectedFile ? void exportSound(this.w3, this.selectedFile.path, this.game?.files ?? null).catch(this.failed) : this.failed(new Error("Select a sound file first.")) }, "Export…"),
      ...(this.editable ? [
        h("button", { onclick: () => this.add(false) }, "Add as sound"),
        h("button", { onclick: () => this.add(true) }, "Add as music"),
      ] : []));
    this.browser.replaceChildren(tabs, search, files, actions);
    this.renderFiles(files);
  }
  private timer: ReturnType<typeof setTimeout> | undefined;

  private renderFiles(box: HTMLElement) {
    const q = this.query.trim().toLowerCase();
    const all = this.tab === "map" ? this.imported : this.game ? [...this.game.files.keys()] : null;
    if (!all) { box.replaceChildren(h("p.muted", {}, "Reading the game's sound files…")); return; }
    const row = (path: string, label: string, depth: number) => {
      const active = this.selectedFile?.path === path;
      return h(`div.snd-file${active ? ".active" : ""}`, {
        style: { paddingLeft: `${8 + depth * 14}px` }, title: path,
        onclick: () => { this.selectedFile = { path, source: this.tab }; this.renderFiles(box); },
        ondblclick: () => void this.play(path),
      }, label);
    };
    // Searching: a flat list of matches (first 500).
    if (q) {
      const hits = all.filter((p) => p.toLowerCase().includes(q));
      box.replaceChildren(...hits.slice(0, 500).map((p) => row(p, p, 0)),
        ...(hits.length > 500 ? [h("p.muted", {}, `${hits.length - 500} more…`)] : []), ...(hits.length ? [] : [h("p.muted", {}, "No matches.")]));
      return;
    }
    // Otherwise folders, opened on click.
    const tree = new Map<string, string[]>();
    for (const p of all) {
      const i = p.lastIndexOf("\\");
      const dir = i < 0 ? "" : p.slice(0, i);
      tree.set(dir, [...(tree.get(dir) ?? []), p]);
    }
    const dirs = [...tree.keys()].sort();
    const rows: HTMLElement[] = [];
    const childDirs = (parent: string) => [...new Set(dirs.filter((d) => d !== parent && (parent === "" ? true : d.startsWith(`${parent}\\`)))
      .map((d) => d.slice(parent ? parent.length + 1 : 0).split("\\")[0]))].sort();
    const walk = (parent: string, depth: number) => {
      for (const name of childDirs(parent)) {
        const dir = parent ? `${parent}\\${name}` : name;
        const isOpen = this.open.has(dir);
        rows.push(h("div.snd-dir", { style: { paddingLeft: `${8 + depth * 14}px` }, onclick: () => {
          if (isOpen) this.open.delete(dir); else this.open.add(dir);
          this.renderFiles(box);
        } }, `${isOpen ? "▾" : "▸"} ${name}`));
        if (isOpen) walk(dir, depth + 1);
      }
      if (parent === "" || this.open.has(parent)) for (const p of (tree.get(parent) ?? []).sort()) rows.push(row(p, p.slice(parent ? parent.length + 1 : 0), depth));
    };
    walk("", 0);
    box.replaceChildren(...rows);
  }

  private add(music: boolean) {
    const f = this.selectedFile;
    if (!f) { void this.w3.window.showWarning("Select a sound file first."); return; }
    const taken = new Set(this.doc.sounds.map((s) => s.name));
    const label = !music && f.source === "game" && this.game ? findLabel(this.game.labels, f.path) : undefined;
    const s = newSound(soundName(f.path, taken), f.path, { music, imported: f.source === "map", label });
    this.doc.sounds.push(s);
    this.selected = s;
    this.changed();
    this.renderList();
    this.renderDetail();
  }

  // ---- the map's sounds ---------------------------------------------------------------
  /** Renames a sound (`name` without gg_snd_) as one undo step; its references follow when saved. False if refused. */
  rename(s: Sound, name: string): boolean {
    const problem = soundNameProblem(this.doc.sounds, s, name);
    if (problem) { void this.w3.window.showError(problem); return false; }
    const n = `gg_snd_${name.trim()}`;
    if (n === s.name) return false;
    s.name = n;
    if (s.variableName !== undefined) s.variableName = n;
    this.changed();
    this.renderList();
    this.renderDetail();
    return true;
  }
  /** Removes a sound from the map's list as one undo step. */
  remove(s: Sound) {
    if (!this.doc.sounds.includes(s)) return;
    this.doc.sounds = this.doc.sounds.filter((x) => x !== s);
    if (this.selected === s) this.selected = null;
    this.changed();
    this.renderList();
    this.renderDetail();
  }
  /** The map's sound `name` (gg_snd_…), selected; throws if there's none. */
  select(name: string): Sound {
    const s = this.doc.sounds.find((x) => x.name === name);
    if (!s) throw new Error(`The map has no sound ${name}.`);
    this.selected = s;
    this.renderList();
    this.renderDetail();
    return s;
  }
  get canEdit() { return this.editable; }
  /** The map's sounds as they are here now (SoundsService.liveSounds). */
  get sounds(): readonly Sound[] { return this.doc.sounds; }

  private renderList() {
    const rows = this.doc.sounds.map((s) => h(`tr.snd-row${this.selected === s ? ".active" : ""}`, {
      onclick: () => { this.selected = s; this.renderList(); this.renderDetail(); },
      ondblclick: () => void this.play(s.file),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        this.selected = s;
        this.renderList();
        this.renderDetail();
        this.w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
          { label: "Export Sound…", run: () => void this.exportCurrent().catch(this.failed) },
          { label: "Replace Internal Sound…", disabled: !this.editable, run: () => void this.replaceCurrent().catch(this.failed) },
        ]);
      },
    },
    h("td", {}, s.name.replace(/^gg_snd_/, "")),
    h("td.muted", {}, s.flags & MUSIC ? "music" : [s.flags & THREE_D ? "3D" : "", s.flags & LOOPING ? "loop" : ""].filter(Boolean).join(" · ") || "sound"),
    h("td.snd-path", { title: s.file }, s.file)));
    this.list.replaceChildren(h("h3", {}, `Sounds in this map (${this.doc.sounds.length})`),
      this.doc.sounds.length
        ? h("table.snd-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Kind"), h("th", {}, "File"))), h("tbody", {}, ...rows))
        : h("p.muted", {}, "No sounds yet: pick a file on the left and add it."));
  }

  private renderDetail() {
    const s = this.selected;
    if (!s) { this.detail.replaceChildren(h("p.muted", {}, "Select a sound to edit its settings.")); return; }
    const ro = !this.editable;
    const set = (f: () => void) => { f(); this.changed(); this.renderList(); };
    const labelled = !!s.assetLabel;
    const text = (value: string, onSet: (v: string) => void, attrs: Record<string, unknown> = {}) => {
      const input = h("input", { type: "text", value, readOnly: ro, ...attrs, onchange: () => onSet(input.value) });
      return input;
    };
    /** Numbers; empty = unset (the label's or game's default) where allowed. */
    const num = (key: keyof Sound, opts: { unset?: number; min?: number; max?: number; int?: boolean; hint?: string } = {}) => {
      const v = s[key] as number;
      const isEmpty = opts.unset !== undefined && (opts.unset === UNSET ? isUnset(v) : v === opts.unset);
      const input = h("input.snd-num", { type: "text", value: isEmpty ? "" : String(Math.round(v * 1000) / 1000), readOnly: ro,
        placeholder: opts.unset !== undefined ? opts.hint ?? "default" : "", onchange: () => {
          const raw = input.value.trim();
          if (raw === "" && opts.unset !== undefined) { set(() => { (s[key] as number) = opts.unset!; }); return; }
          let n = Number(raw);
          if (!Number.isFinite(n)) { input.value = isEmpty ? "" : String(v); return; }
          if (opts.int) n = Math.round(n);
          if (opts.min !== undefined) n = Math.max(opts.min, n);
          if (opts.max !== undefined) n = Math.min(opts.max, n);
          set(() => { (s[key] as number) = n; });
          input.value = String(n);
        } });
      return input;
    };
    const flag = (bit: number, label: string, title = "") => {
      const box = h("input", { type: "checkbox", checked: !!(s.flags & bit), disabled: ro, onchange: () => set(() => { s.flags = box.checked ? s.flags | bit : s.flags & ~bit; this.renderDetail(); }) });
      return h("label.snd-flag", { title }, box, label);
    };
    const select = (value: string, options: [string, string][], onSet: (v: string) => void) => {
      const opts = options.some(([k]) => k === value) ? options : [[value, value] as [string, string], ...options];
      const sel = h("select", { disabled: ro, onchange: () => onSet(sel.value) }, ...opts.map(([k, n]) => h("option", { value: k, selected: k === value }, n)));
      return sel;
    };
    const row = (label: string, ...control: (HTMLElement | string)[]) => h("div.snd-field", {}, h("label", {}, label), h("div", {}, ...control));

    const name = text(s.name.replace(/^gg_snd_/, ""), (v) => {
      if (!this.rename(s, v)) name.value = s.name.replace(/^gg_snd_/, "");
    });
    const music = !!(s.flags & MUSIC);
    const channels = (this.game?.channels ?? []).map(([k, n]): [string, string] => [String(k), n]);
    const parts: HTMLElement[] = [
      h("div.snd-head", {}, h("h3", {}, music ? "Music" : "Sound"),
        h("button", { onclick: () => void this.play(s.file) }, "▶ Play"),
        h("button", { onclick: () => this.stop() }, "■ Stop"),
        h("button", { title: "Save this sound's file to a file of your own", onclick: () => void this.exportCurrent().catch(this.failed) }, "Export…"),
        ...(this.editable ? [h("button", { title: "Put a sound file from disk in this sound's place in the map", onclick: () => void this.replaceCurrent().catch(this.failed) }, "Replace Internal Sound…"), h("button", { onclick: () => this.remove(s) }, "Delete")] : [])),
      row("Name", "gg_snd_", name),
      row("File", text(s.file, (v) => set(() => { s.file = v.trim(); if (s.assetFile) s.assetFile = s.file; })),
        ...(this.editable && this.selectedFile ? [h("button", { title: "Use the file selected on the left", onclick: () => set(() => { s.file = this.selectedFile!.path; this.renderDetail(); }) }, "Use selected file")] : [])),
    ];
    if (labelled) parts.push(h("p.muted.snd-note", {}, `Plays the game's sound label "${s.assetLabel}": empty fields use the label's values.`));
    if (!music) {
      parts.push(
        row("Effect", select(s.eaxEffect, this.game?.effects ?? [], (v) => set(() => { s.eaxEffect = v; }))),
        row("Channel", labelled
          ? select(String(s.channel), [["-1", "(label's channel)"], ...channels], (v) => set(() => { s.channel = Number(v); }))
          : select(String(s.channel), channels, (v) => set(() => { s.channel = Number(v); }))),
        row("Options", flag(LOOPING, "Looping"), flag(THREE_D, "3D sound"), flag(STOP_OUT_OF_RANGE, "Stop when out of range"),
          flag(IMPORTED, "Flag 0x10", "Set on imported sounds by the World Editor; meaning not confirmed")),
      );
    }
    parts.push(
      row("Volume", num("volume", { unset: -1, min: 0, max: 127, int: true, hint: "default" }), h("span.muted", {}, " 0–127")),
      row("Fade in / out rate", num("fadeInRate", { int: true, min: 0 }), " / ", num("fadeOutRate", { int: true, min: 0 })),
    );
    if (!music) {
      const unsetHint = labelled ? "label" : "default";
      parts.push(
        row("Pitch", num("pitch", { unset: UNSET, min: 0, hint: unsetHint }), " variance ", num("pitchVariance", { unset: UNSET, min: 0, hint: unsetHint })),
        row("Priority", num("priority", { unset: -1, int: true })),
      );
      if (s.flags & THREE_D) {
        parts.push(
          h("h4", {}, "3D sound"),
          row("Distances (min / max)", num("minDistance", { unset: UNSET, min: 0, hint: unsetHint }), " / ", num("maxDistance", { unset: UNSET, min: 0, hint: unsetHint })),
          row("Distance cutoff", num("distanceCutoff", { unset: UNSET, min: 0, hint: unsetHint })),
          row("Cone (inside / outside angle)", num("coneInside", { unset: UNSET, min: 0, max: 360, hint: unsetHint }), " / ", num("coneOutside", { unset: UNSET, min: 0, max: 360, hint: unsetHint })),
          row("Outside cone volume", num("coneOutsideVolume", { int: true, min: -1, max: 127 })),
        );
      }
      if (s.speakerUnitType || (s.dialogueTextKey ?? -1) >= 0 || s.facialAnimationLabel) {
        parts.push(
          h("h4", {}, "Dialogue"),
          row("Speaker unit type", text(s.speakerUnitType ?? "", (v) => set(() => { s.speakerUnitType = v.trim(); }), { maxLength: 4, size: 6 })),
          row("Text / speaker strings", h("span.muted", {}, `TRIGSTR_${s.dialogueTextKey} · TRIGSTR_${s.speakerNameKey} (edit in war3map.wts)`)),
          row("Facial animation", text(s.facialAnimationLabel ?? "", (v) => set(() => { s.facialAnimationLabel = v; })),
            text(s.facialAnimationGroupLabel ?? "", (v) => set(() => { s.facialAnimationGroupLabel = v; }), { placeholder: "group" })),
        );
      }
    }
    this.detail.replaceChildren(...parts);
  }
}
