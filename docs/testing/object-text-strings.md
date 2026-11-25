# Object texts as strings of war3map.wts

What the World Editor does with the object data's texts when it saves a map, and why Studio keeps them literal (branch
research/trigstr-object-texts, 2026-11-25, SD, slot 0, software renderer). Earlier rounds that found the field list,
the triggers' and the languages' tables are summed up at the top of `app/src/lib/formats/movetexts.ts` (moveto-fields,
movetexts-triggers, movetexts-locales, 2026-11-10 to 13).

## Evidence

- **Open and save, nothing edited.** Inputs `object-texts-a.w3x` and `-b.w3x` by
  `tests/fixtures/we-specs/make-object-texts.mjs` (flat.w3x with object files and a war3map.wts of its own; what each
  probes is at its top), each through `we-drive --map <in> --wait-ready --save <out> --close`, the save unpacked. The
  same inputs on cliff.w3m gave the same war3map.wts and object files; the editor's save of its own save of input a
  was checked on those.
- **Corpus** (`node scripts/object-text-census.mjs <maps>` in `app/`): the moved fields' values in each map's main and
  Skin object files.

| Map | refs | literal | empty | Skin files | editor's object comments in wts |
|---|---|---|---|---|---|
| FiresOverEversong 3.0.0 | 12335 | 0 | 521 | 7 | yes |
| wowr4.6 | 20996 | 0 | 743 | 7 | yes |
| OriginZ 1.04h | 3098 | 0 | 895 | 7 | yes |
| Frostwolf Clan 1.0 | 914 | 0 | 56 | 6 | yes |
| Firebrand Exarchate Race | 556 | 0 | 8 | 5 | yes |
| Invictus 1.03 | 268 | 0 | 141 | 5 | yes |
| Deadlock LV, Avalanche LV (W3C) | 1 each | 0 | 0 | 2 | yes |
| CrazyHeroSiegeAI 2.0 | 0 | 9090 | 0 | 0 | no |
| MatrixPCDefense 4.3 | 0 | 1579 | 0 | 0 | no |

The 18 other maps of smoketest_maps (28 in all) have no moved field. Every map with Skin files (a save by the current editor) holds
no literal object text; the two literal maps have no Skin files and no object comments: saves by an older editor or
another tool, and both are played maps, so the game shows literal object texts.

## What the editor's save does

| Field kind | Saved as |
|---|---|
| The Text fields of each kind (names, editor suffixes, tooltips, extended tooltips, descriptions, proper names, revive, awaken, learn and turn-off tips, hotkeys, caster upgrade names and tips) and the upgrades' class and effects: MOVED_FIELDS in movetexts.ts | a TRIGSTR_nnn of war3map.wts, in the **Skin file** of the kind (war3mapSkin.w3u and so on); the main file loses the field |
| Ability order strings, uepa, icons, models, sounds, art, tech lists, data | literal, as they were |
| An empty text (`aub1` = "") | literal "" in the Skin file, no string |
| A text holding a reference ("See TRIGSTR_007 here") | moved like any literal: a new string with that text |
| A reference whose string the table lacks (`ides` = TRIGSTR_050) | gone: the field is dropped from both files |
| The same field in the main and the Skin file (h003 unam "Main Name" and "Skin Name") | the Skin file's text only; the main one is lost |

- **Unchanged texts are converted too**: the inputs were opened and saved without an edit.
- **Strings are claimed by text, not by number.** Every field's text is looked up in the strings the map loaded with;
  an unclaimed string with the same text is reused (its number stays), else a new number. Each loaded string is
  claimed once, the lowest number first: three "Twice" fields with strings 8 and 15 holding "Twice" took 8, 15, then
  a new one. A literal equal to a loaded string's text takes it (h002's utip "Same As Literal" took 20, which nothing
  referred to). A reference is no claim: h006's literal "Existing Tip" took 7 and h007, which referred to 7, got a new
  string with the same text. A string two fields referred to (12) stays with the first; the second gets a copy.
  Strings the players' names claim (1, "Player 1") aren't taken by an object with that text.
- **New strings are never shared**: h000's and h001's name, h000's tip and I000's name, all "Dup Text", took four
  numbers; an ability's three levels with the same tip three.
- **Numbering order**: after the highest loaded number (21 after 20, the unused 9 dropped), triggers first, then
  players and forces, then kind by kind (units, items, destructables, doodads, abilities, buffs, upgrades), the game's
  objects before the map's own, objects in **file order** (h005 before h004 got 16, 17), each object's main-file
  fields in their order, then its Skin-file fields.
- **Comments**: every object string, a reused one too, gets the editor's comment (`// Units: h001 (Dup Text), Tip
  (Tooltip - Basic)`); a comment of the map's own on a reused string (7's "my own comment") is replaced.
- **Strings nothing refers to afterwards** leave the table (9 "Orphan").
- **Deterministic**: the editor's save of its own save of input a is the same in every file but the two exported .mdl
  files' time stamp lines (cliff.w3m's imports).

## Studio's Move Texts against it

`moveTexts` on the same input (input a's project): the same fields and order, new numbers after the highest, the
comments. It differs in five things: (1) it never reuses a loaded string by text (h002's tip got 23, string 20 was
dropped); (2) a reference stays the number it was, also where two fields share it (h001's ides stays 12); (3) it keeps
a reused string's own comment; (4) fields stay in the file they were in (no move into the Skin files), and h003's main
"Main Name" becomes a string of its own; (5) a reference the table lacks stays. None of these shows in the game: every
field resolves to the same text.

## Plain or TRIGSTR: what the difference is

- **Game display**: none found. The game resolves a reference at load; a literal is shown as is (the two literal corpus
  maps are played). Not checked in the game here.
- **Localization**: the only difference. A map's `_Locales\xxXX.w3mod\war3map.wts` replaces strings by number, so
  only referenced texts can be translated.
- **The editor's re-open**: none. It opens literal texts as texts (its comments named the literal names: "h000 (Dup
  Text)") and converts them on its next save.
- **Git**: literal texts keep a field's change in one file; the editor's form spreads each change over the object file
  and war3map.wts, and its numbers move with every literal added before them.

## Decision

Studio keeps literal texts by default; Move Texts to String Table gives the referenced form on demand. A pack option
that does the move on a copy was not built: the move is TypeScript (`lib/formats/movetexts.ts`, with `wts.ts`,
`localewts.ts` and the triggers' StringExt types from TriggerData.txt) and packing is Rust (`pack_bytes_with` reads the
project folder; no way to hand it changed files). Either a Rust port of the move (a second copy to keep in step, as
`crates/w3proj/src/wts.rs` is for pruning) or a headless task plus packing from a temporary copy (which breaks
`is_chapter_project`, copies the imports, and needs Node and the game at pack time) would be needed, and neither gives
the editor's bytes, as the five differences above show.
