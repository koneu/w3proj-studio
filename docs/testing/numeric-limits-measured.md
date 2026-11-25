# Numeric field limits measured in the World Editor

Part of the [testing guide](../../TESTING.md); index in [README](README.md).

Branch test/we-numeric-limits, 2026-11-25, SD, we-drive slot 0. Each value was typed into the box (End, Shift+Home,
Delete, then the text), the box left with Tab and photographed (`--shot-screen`), the dialog closed with OK, the map
saved (`--save`) and the saved file read back with `w3proj unpack`. "Box" is what the box showed after Tab, "saved" what
the file held. Inputs: `tests/fixtures/we-specs/flat.w3x` (Map Properties), `tests/fixtures/we-compare/random-group.w3m`
(random groups and item tables), `tests/fixtures/we-specs/trigger-limits.w3x` from `make-trigger-limits.mjs` (Trigger
Editor). Earlier measurements of the same dialogs (verify round 3, ya.md 2026-11-22) are in `map-info/numbers.ts` and
`lib/triggers/literals.ts`; nothing here contradicts them unless it says so.

## Map Properties: Options tab, terrain fog

Scenario > Map Options (166,41 then 202,78), Use Terrain Fog ticked (444,396). The Style list holds Linear, Exponential 1,
Exponential 2, Height, New Exponential 1, New Exponential 2 (`fog.style` 0 to 5: Height saved 3, Exponential 1 saved 1).
Which boxes are enabled depends on the style: Linear: Z Start, Z End, Max Opacity; Exponential 1 and 2: Density, Max
Opacity; New Exponential 1: Z Start, Z End, Density, Max Opacity; Height: Z Start, Z End, Height Start, Height End,
Linear Start, Linear End, Max Opacity and Draw Fog Over Sky.

| Field | Typed | Box | Saved |
|---|---|---|---|
| Z Start | abc | 0.00 | 0.0 |
| Z End | (empty) | 0.00 | 0.0 |
| Density | 1e3 | 13.00 | 13.0 (letters are dropped as typed) |
| Density | -2 | 0.00 | |
| Max Opacity | 0.123 | 0.12 | 0.12 |
| Max Opacity | -1 / 5 | 0.00 / 1.00 | 0.0 / 1.0 |
| Linear Start | -5 / abc | 0.00 / 0.00 | 0.0 |
| Linear End | +7.5 | 0.00 | 0.0 |
| Linear End | 1e3 | 13.00 | 13.0 |
| Height Start | -200000 | -100000.00 (Height End pulled to it) | |
| Height End | -300000 | -100000.00 | |
| Height Start | 100000.5 | 100000.00 | 100000.0 |
| Height End | -100000.555 | -100000.00 | -100000.0 |
| Height Start | -5 | -5.00 (negatives kept) | |
| Height Start | 123.456 | 123.46 | 123.456 (the box rounds, the file keeps what was typed) |
| Height Start | 1.5e2 | 1.52 | 1.52 |
| Height Start | abc / (empty) / +5 | 0.00 | |

**Height Start and End are kept with Start at or above End**, the other way round from Z and Linear: Height Start typed
below Height End pulls End down to it (-5 with End 0: both -5; 0 with End 777: both 0), Height End typed above Start
pushes Start up (777 with Start -5: both 777); End 50 below Start 123.456 stays. Range -100000 to 100000 for both.

**Where they are saved**: the six words of the v39 terrain fog struct are Height Start (f32), Height End (f32), Linear
Start, Linear End, Max Opacity, Draw Fog Over Sky (i32, 1 when ticked). w3i.json named them `style` (i32), `overSky`
(i32), `linearStart`, `linearEnd`, `maxOpacity`, `height` (f32): Height Start 100000 was read as `style` 1203982336,
Draw Fog Over Sky ticked as `height` 1e-45. The editor's own war3map.j writes `SetTerrainFogExV( 3, 3000.0, 5000.0,
0.500, 123.5, 50.0, 0.0, 13.0, 0.000, 0.000, 0.000 )` for Height Start 123.456 and End 50 (`fog.style`, Z Start, Z End,
Density, Height Start, Height End, Linear Start, Linear End, colour), `BlzSetTerrainFogMaxLinearDensity` from the fifth
word and `BlzSetTerrainFogDrawOverSky( true )` from the sixth. Confirmed by a save of a made-up map with a distinct
value in each word (250, -125, 1500, 6000, 0.75, 1: `SetTerrainFogExV( 3, 3000.0, 5000.0, 0.500, 250.0, -125.0, 1500.0,
6000.0, ... )`, `BlzSetTerrainFogMaxLinearDensity( 0.8 )`, `BlzSetTerrainFogDrawOverSky( true )`; we-compare
`terrain-fog.json`). Fixed: the words are now `heightStart`, `heightEnd`, ..., `drawOverSky` (older JSON's names read
with their bits: `was`, `wasType`), and Map Properties and the script use them.

## Map Properties: camera zoom

The three Force ... camera zoom boxes (ticks 444,746 / 444,770 / 444,794). With all three unticked the save wrote 1250
into all three (the map held 0).

| Typed (in this order) | Min / Default / Max after |
|---|---|
| Min 2000, Max 2500, Default 1500 | 2000 / 2000 / 2500: **a default below Min is Min, Min stays** (Studio pulled Min down: fixed) |
| Min 1500, Max 2000, Default 2800 | 1500 / 2000 / 2000 |
| Default 1800, then Min 1900 | 1900 / 1900 / 2000 |
| Max abc | 1250 / 1250 / 1250 (the box takes digits only: empty, 0, pulled to 1250, the others follow) |
| Max (empty) | 1250 |
| Min 1e3 | 1250 ("13") |

## Map Properties: Water tab

Scenario > Map Water (202,95); boxes at Min Opacity 617,289, Max Opacity 617,313, Emissivity 617,337, Reflectivity
823,289, Edge Softness 823,313, Envmap Reflectivity 823,337, Waves Vertex Displacement 687,361, Waves Normal Map
Strength 687,385.

| Typed | Box / saved |
|---|---|
| Max 50, then Min 80 | Min 80, **Max 80** (Studio left Max alone: fixed) |
| Min 60, then Max 30 | Min 30, Max 30 |
| Reflectivity abc | 0 |
| Edge Softness (empty) | 0 |
| Envmap Reflectivity 1e2 | 12 |
| Emissivity -30 | 30 |
| Waves Normal Map Strength 12.7 | 100 ("127") |

So the water and zoom boxes take digits only and an empty box is 0 (then the range). Studio now does the same
(`numbers.ts` `filterInfoTyping`, `setInfoNumber`). The fog boxes differ: they keep `-` and `.` and drop letters
("1e3" is 13), an empty box or text is 0, and "+5" or "+7.5" gave 0.00; Studio's fog boxes are number boxes that refuse
text, an empty box and an exponent (not changed).

## Random groups and item tables (Advanced menu)

Advanced (260,41) > Random Groups... (300,77): random-group.w3m's group Three (Footman 34, Knight 33, Rifleman 33); a set's
row (528,455 + 14 per row), Edit Set (630,593), the Random Group Set dialog's Chance box (575,375), its OK (734,622), the
group dialog's OK (883,593).

| Typed into a set's Chance | Box | Saved chances (set 1, 2, 3) |
|---|---|---|
| set 1: 150 | 100 | 100, 0, 0 (the others scaled down to the rest) |
| set 2: -5 | 5 | 95, 5, 0 |
| set 3: abc | 0 | 95, 5, 0 |
| set 1: (empty) | 0 | 0, 5, 0 (lowering one raises nothing) |
| set 2: 12.5 | 100 ("125") | 0, 100, 0 |
| set 3: 1e2 | 12 | 0, 88, 12 |
| set 1: 0, set 2: 100, set 3: +7 | 0 / 100 / 7 | 0, 93, 7 |
| from 34, 33, 33: set 1: 50 | 50 | 50, 25, 25 |
| then set 3: 40 | 40 | 40, 20, 40 |

Advanced > Item Tables... (300,95): Add Table (477,607), New Set (885,430), New Item (885,480) opens Choose Item, whose
Chance box (1000,265) starts at 100; OK 1067,736. Six items typed into one set in this order:

| Typed | Box |
|---|---|
| 150 | 100 |
| -5 | 5 |
| abc | 1 |
| (empty) | 1 |
| 12.5 | 100 ("125") |
| 1e1 | 11 |

Saved: 0, 0, 0, 0, 89, 11 (each new item's chance scales the set's others down to the rest of 100). So both boxes take
digits only and go to 100 at most; the group box's least is 0, the item box's 1; a chance that takes the total past 100
scales the other lines (sets, items) down in proportion so the total is 100, and a lower chance leaves them. Studio
(`map-info/techtree.ts` `techNumber`) still refuses a typed chance past 0..100 (an item's below 1, `TECH_LIMITS.itemChance`)
rather than dropping letters; the scaling it now does as the editor (below).

### Rounding of the scaling

Branch feat/chance-scaling, 2026-11-25, SD, we-drive slot 0. Input: random-group.w3m with groups C00.. whose lines hold
the chances below and two item tables (made with `w3proj unpack`/`pack`); in the Random Groups dialog each group's row
(428,424 + 13 per row), the set's row, Edit Set, the value typed into Chance, OK; in Item Tables (Advanced > Item
Tables...) an item's row (700,445 + 16 per row), Edit Item (884,520) or New Item (884,480), Chance (1000,265), OK; the
map saved and read back. "Line" counts from 1.

| Chances before | Line set | Typed | Saved |
|---|---|---|---|
| 17, 17, 16, 17, 17, 16 | 1 | 25 | 25, 15, 15, 15, 15, 15 |
| 30, 14, 14, 14, 14, 14 | 1 | 33 | 33, 13, 13, 13, 14, 14 |
| 30, 14, 14, 14, 14, 14 | 6 | 20 | 28, 13, 13, 13, 13, 20 |
| 100, 0, 0 | 2 | 40 | 60, 40, 0 |
| 10, 20, 30, 40 | 1 | 25 | 25, 17, 25, 33 |
| 10, 20, 30, 40 | 4 | 50 | 8, 17, 25, 50 |
| 1, 1, 1, 97 | 4 | 99 | 0, 0, 1, 99 |
| 1, 1, 1, 97 | 1 | 50 | 50, 1, 1, 48 |
| 33, 33, 34 | 1 | 50 | 50, 25, 25 |
| 5, 5, 5, 5, 80 | 5 | 90 | 3, 3, 2, 2, 90 |
| 25, 25, 25, 25 | 2 | 26 | 25, 26, 25, 24 |
| 17, 17, 16, 17, 17, 16 | 1 | 10 | 10, 17, 16, 17, 17, 16 |
| 100, 0, 0, 0, 0, 0 | 1 | 40 | 40, 0, 0, 0, 0, 0 |
| 18, 18, 49, 15 | 3 | 96 | 1, 1, 96, 2 |
| 22, 50, 2, 2, 13, 11 | 1 | 48 | 48, 33, 1, 2, 9, 7 |
| 19, 70, 1, 10 | 4 | 84 | 3, 12, 1, 84 |
| 71, 17, 12, 0 | 4 | 22 | 55, 13, 10, 22 |
| 36, 28, 8, 28 | 1 | 51 | 51, 21, 7, 21 |
| 27, 6, 65, 0, 1, 1 | 1 | 94 | 94, 0, 5, 0, 0, 1 |
| 65, 0, 15, 6, 14 | 3 | 37 | 48, 1, 37, 4, 10 |
| 40, 30, 20, 10 | 3 | 90 | 5, 4, 90, 1 |
| 7, 11, 13, 17, 19, 33 | 6 | 50 | 5, 8, 10, 13, 14, 50 |
| 89, 7, 1, 3 | 4 | 69 | 28, 2, 1, 69 |
| 53, 0, 28, 10, 5, 4 | 4 | 74 | 15, 1, 8, 74, 1, 1 |
| 18, 26, 0, 31, 19, 6 | 4 | 51 | 13, 18, 1, 51, 13, 4 |
| item set 17, 17, 16, 17, 17, 16 | 1 | 25 | 25, 15, 15, 15, 15, 15 |
| item set 1, 1, 1, 97 | 4 | 99 | 0, 0, 1, 99 |
| item set 0, 0, 1, 99 | New Item | 50 | 0, 0, 1, 49, 50 |

**The rule** (all 28 cases, and the AI Editor's hero chances of bugs.md, 2026-11-20): the other lines get
`100 - typed` in proportion to what they held, each rounded half up; what that leaves over is taken one at a time from
the largest line, what it leaves short given one at a time to the smallest, the later line first on a tie (a line at 0
can get one). Rounding by remainders (largest remainder, ties to the earlier line: the AI Editor's rule before) gives 13
of these cases otherwise (e.g. 18, 18, 49, 15 → 96: 2, 1, 96, 1). The hero chances use the same rounding but keep the total at 100 both ways, and a box set while the other
five are 0 goes back to 100. Studio: `lib/chances.ts` `scaleChances` (cases in `chances.test.ts`), used by Map
Properties' chance boxes (`map-info/techtree.ts`) and the AI Editor (`ai-editor/numbers.ts`).

## Trigger Editor: the Value dialog of a limited parameter

The game's TriggerData.txt has 234 `_<Function>_Limits` lines (a minimum and maximum per argument, `_` open). The Value dialog is the Integer or Real one in every case (no other number dialogs: other types with an
integer or real base are presets, variables or object pickers); it names the bounds under the box ("Minimum: 0.00",
"Minimum: 0, Maximum: 100"). trigger-limits.w3x's trigger Limits (F4, about 60 s to paint; the trigger's row 145,204):
each action line double-clicked (400,458 + 16 per line), the number's link in Configure Action clicked (y 491), the text
typed over the selected box, Tab, Shift+Tab, Return (the Integer dialog's OK sits 25 px higher than the Real one's), then
Configure Action's OK (900,588); three saves, war3map.wtg and war3map.j read back.

| Action (argument, limits) | Typed | Saved |
|---|---|---|
| Wait (real, 0 up) | -5 / abc / (empty) | 0.00 / 0.00 / 0.00 |
| Wait | 2000000000 / 12.345 / 1e3 | 1000000000.00 / 12.35 / 13.00 |
| Set HD water min opacity (integer, 0..100) | 150 / -5 / 12.5 | 100 / 0 / 100 |
| Set ally color filter state (integer, 0..2) | 5 / -1 / abc | 2 / 0 / 0 |
| Limit heroes for a player (integer, -1 up) | -5 / 3000000000 / -1 | -1 / -1 / -1 |
| Set handicap (real, 1..10000) | 0 / 20000 / 0.5 | 1.00 / 10000.00 / 1.00 |

So a value past the bounds is pulled to the nearer bound, after the box's own rules (`-` kept, letters dropped,
3000000000 wrapped to -1294967296 and limited to -1000000000 before the bound -1), and an empty box is 0. Studio refused
such a value in its dialog ("The lowest value is 0.") and refused an empty box; it now keeps what the editor keeps
(`literals.ts` `limitTriggerNumber`, `trigger-gui/dialogs.ts`; app-smoke `triggerValueLimits`). The Variables dialog's
initial value is another box (an empty one there means no initial value) and was not measured again.
