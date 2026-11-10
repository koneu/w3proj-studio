// Key bindings, as VS Code has them: every command may have keys, from its manifest (the defaults) or from the user's
// keybindings.json in the settings folder, which the Keyboard Shortcuts editor writes and which can be edited by hand.
//
// A binding is a key (one chord, or a sequence of two: "ctrl+k ctrl+s"), a command and an optional `when`: a condition
// on the context the key is pressed in ("terrainFocus", "project && !inputFocus"). The user's rules come after the
// defaults, and of the bindings for a key whose `when` holds, the last one wins. A user rule whose command starts with
// "-" takes a default away ("-w3.terrain.toggleBlight" with key "h": H no longer toggles blight).
//
// A view that handles keys of its own (the terrain view: arrows, selection keys, the World Editor's View keys) gives
// the element with the keyboard a context key in `data-key-context` ("terrainFocus"). Bindings whose `when` names one
// of those are the view's: the workbench leaves the key to the view, which asks `commandsFor` what the key is bound to
// and keeps its own order (H mirrors the selection when there is one, else toggles blight).
//
// The pure functions are tested on their own (keybindings.test.ts); KeybindingService adds the file (read and written
// through what the workbench passes) and the commands.

import type { CommandContribution, Disposable } from "../extensions/api";
import { keyOf } from "./keys";

// ---- keys --------------------------------------------------------------------------------------------------------

const NAMED = /^(?:f(?:[1-9]|1[0-9]|2[0-4])|numpad[0-9]|up|down|left|right|space|enter|escape|tab|backspace|delete|insert|home|end|pageup|pagedown|pause|capslock|contextmenu)$/;
const ALIAS: Record<string, string> = {
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", esc: "escape", del: "delete", return: "enter",
  spacebar: "space", " ": "space", pgup: "pageup", pgdown: "pagedown", page_up: "pageup", page_down: "pagedown",
  plus: "+", numpad_add: "+", numpad_subtract: "-", numpad_multiply: "*", numpad_divide: "/", numpad_decimal: ".",
};
const MODS: Record<string, "ctrl" | "alt" | "shift"> = { ctrl: "ctrl", control: "ctrl", cmd: "ctrl", meta: "ctrl", win: "ctrl", alt: "alt", option: "alt", shift: "shift" };

/** A key as bindings write it: a named key ("pageup", "numpad8", "f1"), a letter or digit, or one other character.
 *  Shift isn't part of a chord with such a character: it went into making it ("+" is Shift and = on a US keyboard,
 *  and "/" Shift and 7 on a German one). */
const isChar = (k: string) => k.length === 1 && !/[a-z0-9]/.test(k);

function chordOf(mods: { ctrl: boolean; alt: boolean; shift: boolean }, key: string): string {
  const parts: string[] = [];
  if (mods.ctrl) parts.push("ctrl");
  if (mods.alt) parts.push("alt");
  if (mods.shift && !isChar(key)) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** One chord as bindings write it ("ctrl+shift+p", "ctrl+alt++", "Shift+PageUp"), in its one written form: modifiers
 *  in the order ctrl, alt, shift, lower case, names as above. Null when it isn't one. */
export function normalizeChord(spec: string): string | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  let key: string, mods: string[];
  if (s === "+") { key = "+"; mods = []; }
  else if (s.endsWith("++")) { key = "+"; mods = s.slice(0, -2).split("+"); }
  else { const parts = s.split("+"); key = parts.pop()!.trim(); mods = parts; }
  key = ALIAS[key] ?? key;
  if (!(key.length === 1 || NAMED.test(key))) return null;
  const on = { ctrl: false, alt: false, shift: false };
  for (const m of mods) {
    const mod = MODS[m.trim()];
    if (!mod) return null;
    on[mod] = true;
  }
  return chordOf(on, key);
}

/** A key, one chord or two separated by a space ("ctrl+k ctrl+s"), in its one written form; null when it isn't one. */
export function normalizeKey(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  const chords = spec.trim().split(/\s+/).filter(Boolean);
  if (!chords.length || chords.length > 2) return null;
  const out = chords.map(normalizeChord);
  return out.every((c) => c !== null) ? out.join(" ") : null;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "Hyper", "Super"]);

/** The chord of a key event, as bindings write it; null for a modifier alone. The number pad's digits are "numpad8"
 *  (with Num Lock on; off, the webview names the arrow), its operators the characters. Cmd counts as Ctrl. */
export function eventChord(e: { key: string; code?: string; ctrlKey: boolean; metaKey?: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const k = keyOf(e);
  if (MODIFIER_KEYS.has(k) || !k) return null;
  const pad = /^Numpad([0-9])$/.exec(e.code ?? "");
  let key = pad && /^[0-9]$/.test(k) ? `numpad${pad[1]}` : k.toLowerCase();
  key = ALIAS[key] ?? key;
  return chordOf({ ctrl: e.ctrlKey || !!e.metaKey, alt: e.altKey, shift: e.shiftKey }, key);
}

const LABEL: Record<string, string> = { pageup: "Page Up", pagedown: "Page Down", capslock: "Caps Lock", contextmenu: "Menu", backspace: "Backspace", space: "Space" };

/** "ctrl+k ctrl+s" as people write it: Ctrl+K Ctrl+S; "numpad8" NumPad 8, "pageup" Page Up. */
export function keyLabel(key: string): string {
  return key.split(" ").map((chord) => {
    const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+").filter(Boolean), "+"] : chord === "+" ? ["+"] : chord.split("+");
    return parts.map((p) => {
      if (LABEL[p]) return LABEL[p];
      const pad = /^numpad([0-9])$/.exec(p);
      if (pad) return `NumPad ${pad[1]}`;
      if (p.length === 1 || /^f\d+$/.test(p)) return p.toUpperCase();
      return p[0].toUpperCase() + p.slice(1);
    }).join("+");
  }).join(" ");
}

// ---- when ----------------------------------------------------------------------------------------------------------

/** A parsed `when`. */
export type When =
  | { t: "key"; name: string }
  | { t: "eq"; name: string; value: string; not: boolean }
  | { t: "not"; e: When }
  | { t: "and" | "or"; a: When; b: When };

/** The context a key is pressed in: a key's value (true, a string, a number). Missing keys are false. */
export type KeyContext = Readonly<Record<string, unknown>>;

/** Parses a `when` ("terrainFocus && !inputFocus", "activeEditor == 'w3.terrainViewer'"); throws on a mistake. */
export function parseWhen(text: string): When {
  const tokens = text.match(/\s*(&&|\|\||==|!=|!|\(|\)|'[^']*'|"[^"]*"|[A-Za-z0-9_.:-]+|\S)/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const ident = (t: string | undefined) => !!t && /^[A-Za-z_][\w.:-]*$/.test(t);
  const or = (): When => { let a = and(); while (peek() === "||") { i++; a = { t: "or", a, b: and() }; } return a; };
  const and = (): When => { let a = unary(); while (peek() === "&&") { i++; a = { t: "and", a, b: unary() }; } return a; };
  const unary = (): When => {
    if (peek() === "!") { i++; return { t: "not", e: unary() }; }
    if (peek() === "(") {
      i++;
      const e = or();
      if (tokens[i++] !== ")") throw new Error(`a "(" isn't closed in "${text}"`);
      return e;
    }
    const name = tokens[i++];
    if (!ident(name)) throw new Error(`"${name ?? ""}" isn't a context key in "${text}"`);
    if (peek() === "==" || peek() === "!=") {
      const not = tokens[i++] === "!=";
      const v = tokens[i++];
      if (v === undefined || ["&&", "||", "(", ")", "!", "==", "!="].includes(v)) throw new Error(`a value is missing after ${not ? "!=" : "=="} in "${text}"`);
      return { t: "eq", name: name!, value: /^['"]/.test(v) ? v.slice(1, -1) : v, not };
    }
    return { t: "key", name: name! };
  };
  if (!tokens.length) throw new Error("the when is empty");
  const e = or();
  if (i < tokens.length) throw new Error(`"${tokens[i]}" doesn't belong in "${text}"`);
  return e;
}

export function evalWhen(e: When, ctx: KeyContext): boolean {
  switch (e.t) {
    case "key": return !!ctx[e.name];
    case "eq": return (String(ctx[e.name] ?? "") === e.value) !== e.not;
    case "not": return !evalWhen(e.e, ctx);
    case "and": return evalWhen(e.a, ctx) && evalWhen(e.b, ctx);
    case "or": return evalWhen(e.a, ctx) || evalWhen(e.b, ctx);
  }
}

/** The context keys a `when` names. */
export function whenKeys(e: When): string[] {
  switch (e.t) {
    case "key": case "eq": return [e.name];
    case "not": return whenKeys(e.e);
    default: return [...whenKeys(e.a), ...whenKeys(e.b)];
  }
}

const whenCache = new Map<string, When | Error>();
/** The parsed `when`, kept; an Error for one that can't be parsed (such a binding never applies). */
export function compiledWhen(text: string): When | Error {
  let w = whenCache.get(text);
  if (!w) {
    try { w = parseWhen(text); } catch (e) { w = e instanceof Error ? e : new Error(String(e)); }
    if (whenCache.size > 2000) whenCache.clear();
    whenCache.set(text, w);
  }
  return w;
}

/** Whether a binding's `when` holds (none always does; one that can't be parsed never). */
export function whenHolds(when: string | undefined, ctx: KeyContext): boolean {
  if (when === undefined || !when.trim()) return true;
  const w = compiledWhen(when);
  return !(w instanceof Error) && evalWhen(w, ctx);
}

// ---- bindings ------------------------------------------------------------------------------------------------------

/** A rule as keybindings.json and manifests (`contributes.keybindings`) write it. */
export interface KeybindingRule { key: string; command: string; when?: string; args?: unknown }

/** A binding in effect: its key in its one written form, where it came from. */
export interface Binding {
  key: string;
  command: string;
  when?: string;
  source: "default" | "user";
  /** The extension that declared a default ("core" for the workbench's own). */
  extensionId?: string;
}

/** The defaults: each command's `keybinding`, in the order the commands came, then the manifests' keybindings. Keys
 *  that can't be read are left out. */
export function defaultBindings(commands: Iterable<CommandContribution & { extensionId?: string }>, contributed: readonly (KeybindingRule & { extensionId?: string })[]): Binding[] {
  const out: Binding[] = [];
  for (const c of commands) {
    const key = normalizeKey(c.keybinding);
    if (key) out.push({ key, command: c.id, source: "default", ...(c.extensionId ? { extensionId: c.extensionId } : {}) });
  }
  for (const r of contributed) {
    const key = normalizeKey(r.key);
    if (key && typeof r.command === "string" && r.command) out.push({ key, command: r.command, ...(r.when?.trim() ? { when: r.when.trim() } : {}), source: "default", ...(r.extensionId ? { extensionId: r.extensionId } : {}) });
  }
  return out;
}

/** What keybindings.json says: its rules that can be used, and why each other entry is left out. */
export interface UserRules { rules: KeybindingRule[]; ignored: string[] }

/** The user's rules out of keybindings.json's array (as parsed); entries that aren't rules are named, not used. */
export function userRules(raw: readonly unknown[]): UserRules {
  const rules: KeybindingRule[] = [], ignored: string[] = [];
  raw.forEach((r, i) => {
    const at = `entry ${i + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) { ignored.push(`${at} isn't an object`); return; }
    const { key, command, when } = r as Record<string, unknown>;
    if (typeof command !== "string" || !command || command === "-") { ignored.push(`${at} has no command`); return; }
    if (when !== undefined && typeof when !== "string") { ignored.push(`${at}: "when" isn't text`); return; }
    if (typeof when === "string" && when.trim() && compiledWhen(when) instanceof Error) { ignored.push(`${at}: ${(compiledWhen(when) as Error).message}`); return; }
    // A removal may leave the key out: then it takes the command's defaults away whatever their keys.
    const removal = command.startsWith("-");
    const k = key === undefined || key === "" ? (removal ? "" : null) : normalizeKey(key);
    if (k === null) { ignored.push(`${at}: "${String(key)}" isn't a key`); return; }
    rules.push({ key: k, command, ...(typeof when === "string" && when.trim() ? { when: when.trim() } : {}) });
  });
  return { rules, ignored };
}

const sameWhen = (a: string | undefined, b: string | undefined) => (a?.trim() || "") === (b?.trim() || "");

/** The bindings in effect: the defaults less what the user took away, then the user's own, in order. */
export function effectiveBindings(defaults: readonly Binding[], user: readonly KeybindingRule[]): Binding[] {
  const removals = user.filter((r) => r.command.startsWith("-"));
  const kept = defaults.filter((d) => !removals.some((r) => r.command.slice(1) === d.command && (!r.key || r.key === d.key) && (r.when === undefined || sameWhen(r.when, d.when))));
  const own: Binding[] = user.filter((r) => !r.command.startsWith("-")).map((r) => ({ key: r.key, command: r.command, ...(r.when ? { when: r.when } : {}), source: "user" }));
  return [...kept, ...own];
}

/** What a sequence of chords does: "pending" when it is the start of a longer key that applies (as in VS Code, that
 *  wins over a binding of the chord alone), else the binding (the last whose key it is and whose `when` holds), or
 *  nothing. */
export function resolve(bindings: readonly Binding[], chords: readonly string[], ctx: KeyContext): { binding: Binding } | { pending: true } | null {
  const key = chords.join(" ");
  const prefix = key + " ";
  if (bindings.some((b) => b.key.startsWith(prefix) && whenHolds(b.when, ctx))) return { pending: true };
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (b.key === key && whenHolds(b.when, ctx)) return { binding: b };
  }
  return null;
}

/** Whether a binding is the view's to handle: its `when` names a context key the element with the keyboard gives. */
export function isViewBinding(b: Pick<Binding, "when">, own: ReadonlySet<string>): boolean {
  if (!b.when || !own.size) return false;
  const w = compiledWhen(b.when);
  return !(w instanceof Error) && whenKeys(w).some((k) => own.has(k));
}

/** Every command a single chord is bound to where its `when` holds, the binding that wins first. */
export function commandsFor(bindings: readonly Binding[], chord: string, ctx: KeyContext): string[] {
  const out: string[] = [];
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (b.key === chord && whenHolds(b.when, ctx) && !out.includes(b.command)) out.push(b.command);
  }
  return out;
}

/** The other bindings with the same key: they compete when their `when`s hold together. */
export function conflictsOf(bindings: readonly Binding[], b: Pick<Binding, "key" | "command" | "when">): Binding[] {
  return bindings.filter((o) => o.key === b.key && !(o.command === b.command && sameWhen(o.when, b.when)));
}

/** The key a command's menu entry and palette line show: the user's own last binding, else its first default. */
export function primaryKey(bindings: readonly Binding[], command: string): string | undefined {
  const mine = bindings.filter((b) => b.command === command);
  return (mine.filter((b) => b.source === "user").pop() ?? mine[0])?.key;
}

type ElementLike = { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (s: string) => ElementLike | null; getAttribute?: (n: string) => string | null };
const TYPING_INPUTS = /^(?:text|search|email|url|password|number|tel|date|time|datetime-local|month|week)?$/;

/** What the element a key went to says about it: the context keys of its closest `data-key-context` (the view's own
 *  keys), whether it is a field one types into (context key `inputFocus`), and whether it takes every key itself
 *  (`data-all-keys`: a field recording a key, where Ctrl+S is the key wanted, not Save). */
export function targetContext(target: EventTarget | null): { own: Set<string>; inputFocus: boolean; allKeys: boolean } {
  const el = target as ElementLike | null;
  const own = new Set<string>();
  if (!el || typeof el.closest !== "function") return { own, inputFocus: false, allKeys: false };
  const holder = el.closest("[data-key-context]");
  for (const k of (holder?.getAttribute?.("data-key-context") ?? "").split(/\s+/)) if (k) own.add(k);
  const tag = (el.tagName ?? "").toUpperCase();
  const inputFocus = tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && TYPING_INPUTS.test((el.type ?? "").toLowerCase())) || !!el.isContentEditable || !!el.closest(".cm-editor");
  return { own, inputFocus, allKeys: !!el.closest("[data-all-keys]") };
}

// ---- edits of keybindings.json -----------------------------------------------------------------------------------------
// Each takes the file's array as it is and gives the new one: entries it doesn't touch, readable or not, stay as they are.

const ruleOf = (key: string, command: string, when?: string): KeybindingRule => ({ key, command, ...(when ? { when } : {}) });
const isRule = (r: unknown, key: string, command: string, when?: string) => {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return o.command === command && normalizeKey(o.key) === key && sameWhen(typeof o.when === "string" ? o.when : undefined, when);
};

/** A binding's key changed to `key`: a user's binding in place; a default is taken away and bound anew. */
export function changeKey(raw: readonly unknown[], b: Binding, key: string): unknown[] {
  if (b.source === "user") {
    const at = raw.findIndex((r) => isRule(r, b.key, b.command, b.when));
    if (at >= 0) return raw.map((r, i) => (i === at ? { ...(r as object), key } : r));
    return [...raw, ruleOf(key, b.command, b.when)];
  }
  return [...raw, ruleOf(b.key, `-${b.command}`, b.when), ruleOf(key, b.command, b.when)];
}

/** A binding's `when` changed (empty: everywhere): a user's in place; a default is taken away and bound anew. */
export function changeWhen(raw: readonly unknown[], b: Binding, when: string): unknown[] {
  const w = when.trim();
  if (b.source === "user") {
    const at = raw.findIndex((r) => isRule(r, b.key, b.command, b.when));
    if (at >= 0) return raw.map((r, i) => { if (i !== at) return r; const { when: _old, ...rest } = r as Record<string, unknown>; return w ? { ...rest, when: w } : rest; });
    return [...raw, ruleOf(b.key, b.command, w || undefined)];
  }
  return [...raw, ruleOf(b.key, `-${b.command}`, b.when), ruleOf(b.key, b.command, w || undefined)];
}

/** A new binding for a command (one that has none yet, or another key besides). */
export const addKey = (raw: readonly unknown[], command: string, key: string, when?: string): unknown[] => [...raw, ruleOf(key, command, when)];

/** A binding taken away: a user's out of the file, a default by a removal rule. */
export function removeBinding(raw: readonly unknown[], b: Binding): unknown[] {
  if (b.source === "user") {
    const at = raw.findIndex((r) => isRule(r, b.key, b.command, b.when));
    return at >= 0 ? raw.filter((_, i) => i !== at) : [...raw];
  }
  return [...raw, ruleOf(b.key, `-${b.command}`, b.when)];
}

/** A command back to its defaults: every rule of the user's for it, its own or a removal, out of the file. */
export function resetCommand(raw: readonly unknown[], command: string): unknown[] {
  return raw.filter((r) => {
    if (!r || typeof r !== "object") return true;
    const c = (r as Record<string, unknown>).command;
    return c !== command && c !== `-${command}`;
  });
}

/** Whether the user's file says anything about a command. */
export const userTouched = (user: readonly KeybindingRule[], command: string) => user.some((r) => r.command === command || r.command === `-${command}`);

/** keybindings.json's text read: the array, or why it can't be used. An empty file is no rules. */
export function parseKeybindingsFile(text: string): { raw: unknown[]; problem: string | null } {
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) return { raw: [], problem: null };
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { raw: [], problem: `it isn't valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!Array.isArray(v)) return { raw: [], problem: "it doesn't hold a JSON array" };
  return { raw: v, problem: null };
}

export const keybindingsText = (raw: readonly unknown[]) => JSON.stringify(raw, null, 2) + "\n";

// ---- the service ---------------------------------------------------------------------------------------------------

export interface KeybindingFiles {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
}

/** A command with what it's bound to, for the Keyboard Shortcuts editor. */
export interface KeybindingItem { command: string; title: string; category?: string; extensionId?: string; bindings: Binding[]; userTouched: boolean }

/** The defaults from the commands (and the manifests' keybindings), the user's file, and what a key does. */
export class KeybindingService {
  private contributedRules: (KeybindingRule & { extensionId?: string })[] = [];
  private user: UserRules = { rules: [], ignored: [] };
  private path = "";
  private problem: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private changed = {
    fire: () => { for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error(e); } } },
  };
  /** The last text read or written, to tell a file changed by hand from one that wasn't. */
  private lastText: string | null = null;
  warn: (message: string) => void = (m) => console.warn(m);

  constructor(private commands: { contributions(): Iterable<CommandContribution & { extensionId?: string }> }, private files: KeybindingFiles) {}

  onDidChange(l: () => void): Disposable {
    this.listeners.add(l);
    return { dispose: () => { this.listeners.delete(l); } };
  }

  contribute(extensionId: string, rules: readonly KeybindingRule[]) {
    for (const r of rules) this.contributedRules.push({ ...r, extensionId });
    this.changed.fire();
  }

  filePath() { return this.path; }
  /** Why keybindings.json isn't used and is left as it is; null when it's fine (or not there). */
  fileProblem() { return this.problem; }
  /** The entries of keybindings.json that are left out, and why. */
  ignored(): readonly string[] { return this.user.ignored; }
  userRules(): readonly KeybindingRule[] { return this.user.rules; }

  defaults(): Binding[] {
    return defaultBindings(this.commands.contributions(), this.contributedRules);
  }

  bindings(): Binding[] {
    return effectiveBindings(this.defaults(), this.user.rules);
  }

  private describe(why: string) {
    return `Your keybindings file (${this.path}) is there, but ${why}. Its keys aren't used, and it is left as it is: fix it with "Open Keyboard Shortcuts (JSON)".`;
  }

  private async read(path: string): Promise<{ raw: unknown[]; problem: string | null; text: string | null }> {
    let text: string;
    try {
      text = await this.files.readText(path);
    } catch (e) {
      // Absent and unreadable are told apart: only a file that is surely not there is "no keys of the user's yet".
      let there: boolean;
      try { there = await this.files.exists(path); } catch (e2) { return { raw: [], problem: `it can't be checked (${errText(e2)})`, text: null }; }
      return there ? { raw: [], problem: `it can't be read (${errText(e)})`, text: null } : { raw: [], problem: null, text: null };
    }
    return { ...parseKeybindingsFile(text), text };
  }

  private take(raw: unknown[], problem: string | null, text: string | null) {
    this.problem = problem;
    this.user = problem ? { rules: [], ignored: [] } : userRules(raw);
    this.lastText = text;
    this.changed.fire();
  }

  /** Reads, writes and reads again of the file go one after the other, so that what is in memory is what was last on
   *  disk: a read that started before a write can't land after it. */
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writing.catch(() => {}).then(job);
    this.writing = run.then(() => {}, () => {});
    return run;
  }

  /** Reads the user's file (at start, after it was saved in the app, when the window comes back). */
  load(path = this.path): Promise<void> {
    this.path = path;
    return this.queue(async () => {
      if (path !== this.path) return; // another file was asked for meanwhile
      const r = await this.read(path);
      if (path !== this.path) return;
      const was = this.problem;
      this.take(r.raw, r.problem, r.text);
      if (r.problem && r.problem !== was) this.warn(this.describe(r.problem));
    });
  }

  /** Reads the file again if it changed since (edited outside the app). */
  reloadIfChanged(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    return this.queue(async () => {
      const r = await this.read(path);
      if (path !== this.path || (r.text === this.lastText && r.problem === this.problem)) return;
      const was = this.problem;
      this.take(r.raw, r.problem, r.text);
      if (r.problem && r.problem !== was) this.warn(this.describe(r.problem));
    });
  }

  /** Changes the user's file: `edit` gets its array as it is on disk now and gives the new one. A file that is there but
   *  can't be used is never written over (its keys would be lost): the change is refused, with why. */
  update(edit: (raw: readonly unknown[]) => unknown[]): Promise<void> {
    const path = this.path;
    if (!path) return Promise.reject(new Error("The settings folder isn't known yet."));
    return this.queue(async () => {
      if (path !== this.path) throw new Error("The keybindings file moved meanwhile; nothing was changed.");
      const now = await this.read(path);
      if (now.problem) {
        this.take(now.raw, now.problem, now.text);
        throw new Error(this.describe(now.problem));
      }
      const raw = edit(now.raw);
      const text = keybindingsText(raw);
      await this.files.writeText(path, text);
      this.take(raw, null, text);
    });
  }

  /** Every command, hidden ones too, with its bindings; and keys bound to commands no extension declares. */
  items(): KeybindingItem[] {
    const bindings = this.bindings();
    const byCommand = new Map<string, Binding[]>();
    for (const b of bindings) byCommand.set(b.command, [...(byCommand.get(b.command) ?? []), b]);
    const out: KeybindingItem[] = [];
    const seen = new Set<string>();
    for (const c of this.commands.contributions()) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ command: c.id, title: c.title, ...(c.category ? { category: c.category } : {}), ...(c.extensionId ? { extensionId: c.extensionId } : {}), bindings: byCommand.get(c.id) ?? [], userTouched: userTouched(this.user.rules, c.id) });
    }
    for (const [command, list] of byCommand) if (!seen.has(command)) out.push({ command, title: command, bindings: list, userTouched: userTouched(this.user.rules, command) });
    return out;
  }

  commandsFor(chord: string, ctx: KeyContext): string[] {
    return commandsFor(this.bindings(), chord, ctx);
  }

  resolve(chords: readonly string[], ctx: KeyContext) {
    return resolve(this.bindings(), chords, ctx);
  }

  primaryKey(command: string): string | undefined {
    return primaryKey(this.bindings(), command);
  }

  async changeKey(b: Binding, key: string) { const k = keyOrThrow(key); await this.update((raw) => changeKey(raw, b, k)); }
  async addKey(command: string, key: string, when?: string) {
    const k = keyOrThrow(key);
    const w = when?.trim() ? compiledWhen(when) : null;
    if (w instanceof Error) throw w;
    await this.update((raw) => addKey(raw, command, k, when?.trim() || undefined));
  }
  async changeWhen(b: Binding, when: string) {
    const w = when.trim() ? compiledWhen(when) : null;
    if (w instanceof Error) throw w;
    await this.update((raw) => changeWhen(raw, b, when));
  }
  remove(b: Binding) { return this.update((raw) => removeBinding(raw, b)); }
  reset(command: string) { return this.update((raw) => resetCommand(raw, command)); }
}

function keyOrThrow(key: string): string {
  const k = normalizeKey(key);
  if (!k) throw new Error(`"${key}" isn't a key.`);
  return k;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
