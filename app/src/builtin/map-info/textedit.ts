// A text of the map's properties changed (set_map_text) as the World Editor's Map Properties writes war3map.w3i when its
// OK closes the dialog (we-compare wts-missing, branch fix/wts-missing-we, 2026-11-23: Scenario > Map Description's name
// typed over and OK, on flat.w3x with and without its war3map.wts):
// - a TRIGSTR_ reference whose string the table lacks was read as no text and is written as "" (blankStringlessTexts);
// - the changed text goes where it is: into its string when it refers to one the table has, else into the file;
// - every plain text of the map (name, suggested players, description, author, the loading screen's three) becomes a
//   string numbered on from the highest number taken (mapTextsToStrings): 1 to 4 without a war3map.wts, which is made
//   then; 3 to 6 after the table's 1 and 2;
// - the loading screen's crest race becomes 128, a game data set of -1 0 (editorInfoDefaults), camera zooms of 0 1250
//   (resizedCameraZoom).
// The players' and forces' plain names become strings when the map is packed (map-project/namestrings.ts), after these.
// The editor's save counter (`saves`) isn't counted: Studio never counts it.

import { blankStringlessTexts, editorInfoDefaults, mapTextsToStrings, type InfoString } from "../../lib/formats/infostrings";
import { addLocaleStrings } from "../../lib/formats/localewts";
import { refsIn } from "../../lib/formats/movetexts";
import { StringTable } from "../../lib/formats/wts";
import { resizedCameraZoom } from "../../lib/terrain/resize";
import { setMapText } from "./summary";

/** What a new string must go after. `taken`: the numbers the map's files other than war3map.w3i and the map script refer
 *  to, an earlier drop recorded and the languages' tables have (mapdoc stringNumbersTaken over those files);
 *  `scriptRefs`: the numbers the map script (war3map.j / .lua) refers to. */
export interface TakenNumbers { taken: Iterable<number>; scriptRefs: Iterable<number> }

/** `doc` (war3map.w3i's JSON, changed in place) and `wts` (war3map.wts, null when there is none) after `field` is set to
 *  `text`, as the top says. Gives the string table to write (null: none, there was none and nothing went into one) and
 *  the strings added (for the languages' tables). The map script's references to the numbers the w3i's blanked texts had
 *  don't count as taken: the script is made from the w3i (the editor's save writes it anew), so they are those texts'
 *  (flat.w3x's script names its force TRIGSTR_002 in a comment). Throws for an unknown field, and for a table text
 *  with a `}` (WtsCutError: the game would cut it). */
export function mapTextEdit(doc: Record<string, unknown>, field: string, text: string, wts: string | null, numbers: TakenNumbers):
  { wts: string | null; added: InfoString[] } {
  const table = wts === null ? null : new StringTable(wts);
  const blanked = new Set(blankStringlessTexts(doc, (n) => table?.has(n) ?? false));
  setMapText(doc, field, text, table);
  const used = new Set<number>(numbers.taken);
  for (const [n] of table?.entries() ?? []) used.add(n);
  refsIn(JSON.stringify(doc), used);
  for (const n of numbers.scriptRefs) if (!blanked.has(n)) used.add(n);
  let max = 0;
  for (const n of used) max = Math.max(max, n);
  const added = mapTextsToStrings(doc, max + 1);
  editorInfoDefaults(doc);
  const zoom = resizedCameraZoom(doc.cameraZoom as Parameters<typeof resizedCameraZoom>[0]);
  if (zoom) doc.cameraZoom = zoom;
  const base = table ? table.serialize() : null;
  return { wts: added.length ? addLocaleStrings("war3map.wts", base ?? "﻿", added) : base, added };
}
