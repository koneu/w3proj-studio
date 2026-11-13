// A dialogue sound's text and speaker name: strings of war3map.wts that the sound names by number (dialogueTextKey,
// speakerNameKey; the w3s file's own dialogueText / speakerName stay as they are). The Sound Editor edits them here and
// writes them on save the way the other editors write their TRIGSTR texts (Map Properties, Game Settings): only the
// strings it changed, merged onto the file as it is on disk then, so strings other editors saved meanwhile stay; for a
// string both changed, the last save wins.
//
// A sound that has no key yet gets both when its text or speaker name is first typed, as the game's campaign maps have
// them (3,207 of 3,519 dialogue sounds with both keys: speaker name n, text n + 1; no map has a sound with only one):
// the next free numbers after the highest string of the table, the highest key of the map's sounds and the highest
// TRIGSTR reference in the map's other files, and every number of the languages' tables (`_Locales\xxXX.w3mod\war3map.wts`).
// A save adds its new strings to those tables too, with the same text, as Move Texts does (lib/formats/localewts); a
// text changed later changes war3map.wts only (the languages' copies are theirs to translate).

import { appendStrings, StringTable, WtsCutError, wtsCuts, wtsSafeText, type NewString, type WtsCut } from "../../lib/formats/wts";
import type { Sound } from "./sounds";

const norm = (s: string | null | undefined) => s?.replace(/\r\n/g, "\n");

/** The Sound Editor's view of war3map.wts: the file as read or last saved here, and the strings set here. */
export class DialogueStrings {
  private base: StringTable | null;
  private baseText: string | null;
  /** The texts set here by string number (what undo takes and puts back). */
  private texts = new Map<number, string>();
  /** A string's text before it was first set here (null: it wasn't in the table). Undo past the first change gives it
   *  back, also after a save. */
  private orig = new Map<number, string | null>();

  /** `text`: war3map.wts, null when the map has none. */
  constructor(text: string | null) {
    this.baseText = text;
    this.base = text === null ? null : new StringTable(text);
  }

  /** The text of string `n` as shown here; "" for no key or a string the table lacks. */
  text(n: number | undefined): string {
    if (n === undefined || n < 0) return "";
    if (this.texts.has(n)) return this.texts.get(n)!;
    if (this.orig.has(n)) return this.orig.get(n) ?? "";
    return this.base?.get(n) ?? "";
  }

  /** Whether the table has string `n` (as read or saved here, or set here). */
  has(n: number | undefined): boolean {
    return n !== undefined && n >= 0 && (this.texts.has(n) || !!this.base?.has(n));
  }

  /** Sets string `n` (a new one when the table lacks it). */
  set(n: number, value: string) {
    if (!this.orig.has(n)) this.orig.set(n, this.base?.has(n) ? this.base.get(n)! : null);
    this.texts.set(n, value);
  }

  /** The strings set here, for the editor's history. */
  state(): [number, string][] {
    return [...this.texts].sort((a, b) => a[0] - b[0]);
  }
  restore(state: [number, string][]) {
    this.texts = new Map(state);
  }

  /** What a save writes: each string whose text here differs from the file as read or last saved here. */
  pending(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [n, was] of this.orig) {
      const v = this.texts.has(n) ? this.texts.get(n)! : was;
      // A new string taken back by undo: nothing to write (one saved meanwhile stays, unused).
      if (v === null) continue;
      if (norm(v) !== norm(this.base?.get(n)) || !this.base?.has(n)) out.set(n, v);
    }
    return out;
  }

  /** The strings a save adds (pending, and not in the table as read or last saved here), by number: what the languages'
   *  tables get too (lib/formats/localewts addLocaleStrings). */
  added(): NewString[] {
    return [...this.pending()].filter(([n]) => !this.base?.has(n)).map(([num, v]) => ({ num, text: norm(v)! })).sort((a, b) => a.num - b.num);
  }

  /** The strings to write that the game would cut (a line starting with "}"). */
  cuts(): WtsCut[] {
    return wtsCuts(this.pending());
  }
  /** Changes the texts of `cuts()` so they read back whole (wtsSafeText); false when there were none. */
  fixCuts(): boolean {
    const cuts = this.cuts();
    for (const c of cuts) this.set(c.num, wtsSafeText(this.pending().get(c.num)!));
    return cuts.length > 0;
  }

  /** The number for a new string: after the highest of the table, of the strings set here, of the sounds' keys and of
   *  `otherRefs` (the TRIGSTR numbers the map's other files refer to and the languages' tables have: lib/formats/mapdoc
   *  stringNumbersTaken, as Move Texts numbers), so a reference to a string the table lacks doesn't come to show a dialogue text. */
  nextKey(sounds: readonly Sound[], otherRefs: Iterable<number>): number {
    let max = 0;
    for (const n of otherRefs) max = Math.max(max, n);
    for (const [n] of this.base?.entries() ?? []) max = Math.max(max, n);
    for (const n of this.orig.keys()) max = Math.max(max, n);
    for (const s of sounds) max = Math.max(max, s.dialogueTextKey ?? -1, s.speakerNameKey ?? -1);
    return max + 1;
  }

  /** The file to write onto `current` (war3map.wts on disk now, null when it isn't there), or null when there's
   *  nothing to write. Throws rather than write: a string the game would cut (WtsCutError), a file that was there when
   *  read and is gone now, a new string whose number another tool used meanwhile for another text. */
  merge(current: string | null): string | null {
    const pending = this.pending();
    if (!pending.size) return null;
    const cuts = wtsCuts(pending);
    if (cuts.length) throw new WtsCutError(cuts);
    if (current === null && this.baseText !== null) {
      throw new Error("Not saved: war3map.wts was there when the Sound Editor read it and is gone now, so the dialogue texts weren't written. "
        + "Restore it (a checkpoint or the packed map has it) and save again.");
    }
    let out = current ?? "﻿";
    const eol = current === null || current.includes("\r\n") || !current.includes("\n") ? "\r\n" : "\n";
    // Strings the table had: only those changed here, onto the file as it is now.
    const edits = [...pending].filter(([n]) => this.base?.has(n));
    if (edits.length && this.baseText !== null) {
      const edited = new StringTable(this.baseText);
      for (const [n, v] of edits) edited.set(n, v);
      out = StringTable.merge(this.baseText, edited, out);
    }
    // New strings at the end.
    const disk = new StringTable(out);
    const blocks: NewString[] = [];
    for (const [n, v] of pending) {
      if (this.base?.has(n)) continue;
      if (disk.has(n)) {
        if (norm(disk.get(n)) === norm(v)) continue;
        throw new Error(`Not saved: string ${n}, new here for a dialogue, was added to war3map.wts by something else meanwhile with another text. `
          + "Close the Sound Editor without saving and type the text again.");
      }
      blocks.push({ num: n, text: norm(v)! });
    }
    blocks.sort((a, b) => a.num - b.num);
    out = appendStrings(out, blocks, eol);
    // Read back: the new strings whole, every other string as it was.
    const back = new StringTable(out);
    for (const b of blocks) {
      if (norm(back.get(b.num)) !== b.text) throw new Error(`Not saved: string ${b.num} wouldn't read back as typed.`);
    }
    for (const [n, v] of disk.entries()) {
      if (back.get(n) !== v) throw new Error(`Not saved: string ${n} of war3map.wts wouldn't stay as it is.`);
    }
    return out;
  }

  /** `merged` was written: it is the file now. The strings set here stay (undo can still take them back). */
  saved(merged: string) {
    this.baseText = merged;
    this.base = new StringTable(merged);
  }
}

/** Sets a sound's dialogue text or speaker name. A sound without the keys gets them first (speaker name, then text, the
 *  next free numbers), both strings made. False when nothing changed (the same text, or "" for a sound without a key). */
export function setDialogueString(s: Sound, which: "text" | "speaker", value: string, strings: DialogueStrings, sounds: readonly Sound[],
  otherRefs: Iterable<number>): boolean {
  const key = which === "text" ? s.dialogueTextKey : s.speakerNameKey;
  if (norm(strings.text(key)) === norm(value)) return false;
  if (key === undefined || key < 0) {
    let next = strings.nextKey(sounds, otherRefs);
    if ((s.speakerNameKey ?? -1) < 0) { s.speakerNameKey = next++; strings.set(s.speakerNameKey, ""); }
    if ((s.dialogueTextKey ?? -1) < 0) { s.dialogueTextKey = next++; strings.set(s.dialogueTextKey, ""); }
  }
  strings.set(which === "text" ? s.dialogueTextKey! : s.speakerNameKey!, value);
  return true;
}
