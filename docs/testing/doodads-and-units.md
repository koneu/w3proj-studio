# Doodads, units and items

Placing, moving, picking, rules on load, pathing footprints, fences, camps and unit properties, measured against the editor. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

- **Dragging**: `--drag X,Y:X,Y[@MS]` presses the left button, moves in 20 steps over MS (400) and lets go; `--drag-mod alt` holds a key during the next drag. Measured (TerenasStand_LV, doodad layer `--key d`, a tree clicked, 800 ms): a plain drag of the selected tree changes nothing in war3map.doo (it is a box select), Alt+drag moves it (editor id 1224, (320, -576) to (576, -768)), the only change in 1680 doodads.

- **Moving objects at the edges** (branch we-drag-checks, 2026-11-13, SD, copies of the empty 64x64 map: camera bounds
  right at 2816, playable part 3328, map 4096; scripts and saves in `target/evidence/we-drag-checks/` of the main
  checkout). A plain drag that starts on a selected object moves it (a doodad by `--key d`, a unit by `--key u`; the
  first click must hit the model: a footman's feet miss, 10 px higher hits); Alt+drag moves a unit's centre to the
  pointer. The nudge is Edit > Nudge Selection: the number pad (`--numlock on`, then `--key KP_6`; without Num
  Lock the keys arrive as arrows and do nothing; a blind `--key Num_Lock` toggles whatever the spec before left, since the X server keeps the lock while an editor is connected), 64 a step for a tree, 8 for a doodad without pathing and a footman.
  Measured again in nudge-turn-we (target/evidence/nudge-turn-we): the nudge is 64 for a tree (LTlt) and a farm (hhou), 8
  for a doodad without pathing (LPcr) and a footman; the diagonals KP_7 9 1 3 move both axes the whole step (a tree:
  -64/+64, +64/+64, -64/-64, +64/-64); KP_Divide turns a selection 5 degrees left, KP_Multiply 5 right. Studio:
  selectionkeys.ts (NUDGE 8, TURN 5), doodadedit.ts GRID_NUDGE_STEPS.
  The editor takes the drag's second-to-last motion step (a footman dragged 576 in 20 steps moved 547). Found: with
  Enforce Camera Bounds on (and off alike) drags and nudges go past the camera bounds; a unit stops with its collision
  size or half its footprint inside the playable part (footman, collision 31: 3296; farm, 4x4 cells: 3264); a doodad
  goes past the playable part and stops with its centre strictly inside the map (tree and a 12x12 LZth 4032 on 64
  steps, a pathless LPcr 4088 on 8 steps). A step that would pass the limit is refused, the object stays at the last step that
  fits (spec edge-last-step: footman 3296, farm 3264, tree 4032, LPcr 4088; selected one at a time here, groups below; a box select of the lower objects needs a box 200 px wide). The camera too scrolls past the camera bounds with the switch on. Studio:
  limits.ts `insetBy`, terrain-viewer `moveBounds`; app-smoke heightsLimits.
  Groups and diagonals at the edge (branch edge-group-nudge-we, 2026-11-14; spec edge-group-nudge, whose first spec
  switches Num Lock on for the file, so run it whole): the editor's d mode selects only doodads and u only units, so a
  doodad and a unit are never one group. A group nudges all by the longest step (tree + pathless LPcr: both 64, a
  footman + farm: both 64) and is refused whole when any member's step would pass its limit (tree 4032 with LPcr 4032;
  footman 3264 with the farm 3200, not 3296 and 3264). In about 3 of 12 first runs of an editor a group stepped 8
  instead (the tree stayed, LPcr went to 4088): the box missed the tree, as the editor reads the pointer once a frame
  (branch we-timed-specs in branch-rounds.md; we-drive's drags now hold still at both ends). A diagonal (KP_9) at the east edge moves nothing, the
  free axis too, for one object and for a group. A tree dragged past the edge stops on the grid inside it (4032, 3968
  or 3904 in different runs: the last motion that fits varies), never on 4096; the unit and group drags didn't press
  reliably, so no drag spec. Studio: limits.ts `scaledNudge`, moveedit.ts `refuseShift` with `settle`.

- **Picking a doodad** (branch doodad-pick-we, 2026-11-16, SD; spec `doodad-pick-we`, input and steps by
  `tests/fixtures/we-compare/make-doodad-pick-input.mjs`, whose `project` is the formula above): a click on bare flat
  ground, then Delete, on a tree LTlt, a rock LRrk (4x4 pathing) and a rune XOmr (2x2), 0 and 30, 45, 60, 80, 100, 130
  units from the centre towards E, W, N, S, from a view of 2000 (the editor snaps what it opens: 64, the rune 32 further,
  so the input stands on those). The editor picks where the model is on the screen, not by the footprint: tree hit to 60
  all round (W80 too, E80 no), rock to 80 all round, rune 30 (45 on one side); north (above the foot, the model's height)
  tree and rock 130, rune 100, none of them south or beside at 100. Studio's footprint cylinder (radius 32, 64, 32) missed
  the rock at E80 and W80, the tree at W80 and picked the rune at S30. Now (`renderer.ts` pickObject, `meshpick.ts`): the
  model's triangles inside its bounding sphere and box, and the cylinder besides. Studio's table with the clicks put where
  Studio's own camera shows the ground (`clickGround`: its 3D view isn't the editor's) agrees on 69 of 75 (before 66):
  tree S60, S80, rock S60, rune S30, E45, N80 differ (the rock's and the tree's S60 also under the old rule: a click
  there misses in Studio's frame; the rune is a thin model). Only mesh (no cylinder): rune 20 of 25, tree and rock 24.

- **Floating doodads** (branch doodad-nudge-z, 2026-11-16, SD; spec `tests/we-compare/doodad-water-z.json`, input by `tests/fixtures/we-specs/make-doodad-water-z.mjs`): the 298 doodads at z 294.4 after studio-paths-terrain-save were all of types with Doodads.slk `floats` 1 (lily pads, seaweed, bubbles), not a bounds clamp. The editor puts such a doodad without flag 4 on the water level of the corner nearest to it (halves round up on both axes) when that corner has the water flag and its level is above its ground (cliff level counted), else on the ground, and works this out again on every save (opened and saved, stored heights don't count; non-floating plain doodads go back to the ground the same way). EchoIsles' 3522 doodads fit it, as the original and as the editor saved them. Studio: w3e.ts `floatingLevelAt`, objheights.ts `doodadGround`, used where a move lands (nudge, drag, turns). On opening (branch doodad-open-rules): the same for every doodad and destructable without flag 4 (a tree LTlt too), with its life (doodads 255, destructables at most 100) and scale rules (four appended cases in the input); Studio's Fix Doodads on Load does it as the terrain view opens (doodadedit.ts `restAsOpened`, kept within 0.01), and `doodad-water-z-open` matches. Without the terrain view opened Studio writes the stored values. A fixed doodad (flags 6) moved by the nudge goes to its ground with flags 2 when the editor's Reset Fixed Z When Moving Objects is on, and keeps its height and flags with it off (`doodad-water-z-nudge`, `-keep`; 2026-11-17, branch fix-we-studio: the spec had failed because we-drive pins the switch off and Studio's default is on).

- **Heights on load: ramps and sample radius** (branch doodad-open-z-we, 2026-11-16, SD; specs `tests/we-compare/doodad-open-z.json` (input `make-doodad-open-z.mjs`, `wide` for the unknown ones) and `doodad-open-z-real.json` (smoketest_maps Hammerfall, AutumnLeaves, SnowareBay, Firebrand, and `-tweak` copies by `make-doodad-open-z-real.mjs` into `target/doodad-open-z/`)): the editor keeps every stored height of those maps on open and save (all 20 128 doodads), and puts copies raised by 37.5 back on them: the stored heights are its ground, not stale. Studio's Fix Doodads on Load had rewritten 100 of them (13, 25, 43, 19); the causes: (1) ramps: a ramp's middle corner is half a level up only where it climbs along one axis beside a straight tile (w3e.ts `rampLift`; the inside of a bend and a climb without a straight tile stay down), 196 doodads on ramp tiles fit; (2) destructables with an Elevation Sample Radius (DestructableData `radius`, `brad`) from 1 to 100 stand on the mean of the ground at (x ± 64, y ± 64) (objheights.ts `doodadGround`): walls, gates, icy rocks (50), the bridge YT00 (100), original-table changes to 1, 25, 64, 100; radius 0 and every custom type (whatever its radius) on the point (objects.ts `Skin.elevRadius`); radius 128, 150 and 200 (YT04) sample wider in a way not found (no square or ring of 4 to 25 points fits): Studio keeps their stored height on open (`ELEVATION_RADIUS_UNKNOWN`); (3) floating goes by the skin the doo names (SnowareBay's LWw0 drawn as NWfp floats). With them Fix Doodads on Load leaves 80 955 of the 80 956 plain doodads of smoketest_maps' 24 maps as stored; the one left: AutumnLeaves' seaweed 2213 on a cliff tile whose nearest corner is wet (419.15 over ground 252.75) next to a dry level-6 corner, which the editor keeps on the ground (the 1986 other floating ones fit `floatingLevelAt`). The editor also snaps YT04 to another grid point than Studio (32 west and south).

- **Copy and paste of objects** (branch paste-anchor-we, 2026-11-12, SD, a flat 64x64 map): `--key d` (doodads layer),
  `--click` on a doodad or `--drag` a box round several, `--key ctrl+c`, `--key ctrl+v`, `--move` to a spot, `--click`
  there, `--key Escape`; the clipboard stays for another `ctrl+v`. The status bar's "Point: (x, y, z)" at the pointer
  (the bottom left of `--shot-window`) gives its world position; at the opening camera the ground maps to the display
  by a plane homography (fitted from six such readings to the pixel). The editor moves each doodad onto its own grid
  when the map loads (a barrel to 64n + 32, a crate to 64n), so the copied positions are read from its save.
  Which grid (branch paste-centre-we, 2026-11-15, SD; spec `paste-centre`, input `make-paste-centre-input.mjs`; the
  pointer read from a lone pathless LPcr pasted at the same pixel first): a group with something on a grid (a doodad or
  destructable with a pathing texture, a building) moves by whole 64s: its centre, the mean of the positions with each
  on its own grid (a farm saved at 290 counts at 320), and the pointer both go to the 64 grid, then each object onto its
  own grid; a group with nothing on a grid (pathless doodads, footmen, items) puts its mean exactly at the pointer.
  Studio: placement.ts `copyCentre`, `pasteCentreAt`. A box select whose corner is near the view's top edge scrolls the
  view, and a drag that starts on a still-selected doodad's model moves it: keep boxes well inside, click bare ground first.

- **Gold mines and start locations** (branch mine-start-grid, 2026-11-13, SD; spec tests/we-compare/mine-start-grid.json):
  both stand on the 64 grid when placed, nudged, dragged or Alt-moved (a mine by its 16×16 texture, a start location as
  a 4×4 building); loading and saving leaves off-grid ones where they are. Nudged, a start location stops 64 inside the
  whole map (4032 of 4096), past the playable part. The palette's Start Location (`--key u`, `--click 1510,403`) makes
  Player 1's start a new object (editor id last, hit points and mana 0); Neutral Passive is `--click 1435,80`, `--click
  1405,424`, its first building (`--click 1383,365`, 3 s later) the Gold Mine. A click on a start location selected it
  (its circle moved with the keys) but the save kept it where it was; a box select (`--drag` from bare ground) works.
  we-compare refuses `--look`: the spec's input has the camera objects, picked as --look does (`--key m`, `--click
  1396,177` for the first row, 13 px a row, `--click 1476,119`). Placing a unit without a texture (Phoenix Egg) is free:
  it stood at -1899.459, 500.253 where -1900, 500 was aimed through `proj.py`'s projection.

- **Doodad rules while editing** (branch doodad-rules-edit, 2026-11-13, HD, empty_map_on_newest_world_editor.w3m with a
  barrel LTbr at 32, 32 scale 1.2, a log AOlg (12x6 texture) at 1056, 0 facing 0, wheat LPwh (no texture); saved after
  each step): an 8 px drag of the barrel (about 20 units at the opening camera) didn't move it, an 18 px one put it at
  96, 32: dragged doodads stay on their grid (whether it jumps during the drag or at the release a picture can't tell
  with one `--drag`). `+` (`KP_Add`) ten times then `-` three times took the barrel's 1.2 to 1.35, not 1.55: the scale
  is held to the type's range (1.1 to 1.5) at once. The numpad `/` turned the barrel and the wheat freely (by 5° to 15°
  per press, depending on how long it was held) but the log a quarter per press (three: 0° to 270°, its place on the
  grid of 270°). Ctrl+arrows moved nothing, wheat included, and `]` turned nothing: not the editor's keys in this
  build. A `--click` on the wheat or the log may miss; a `--drag` box from bare ground round it selects it (a box
  starting on a doodad drags it). doodadedit.ts follows this.

- **Doodad facings and turned ranges on load** (branch verify3-p6-diffs, 2026-11-13, SD, the 212-doodad map of
  verification round 3 package 6 with 26 more, opened and saved): a destructable's fixed rotation is enforced (LTlt
  fixedRot 270 at 30, -90, 400 saved 270; LTt0 0 and ATt0 90 likewise, before the quarter turn of their 24×12
  texture), a doodad's isn't (YZef 270 at 30 stays 30); every other angle comes into 0..360 by whole turns in single
  precision, doodads and destructables, with or without a texture (1080 and 720 to 360, -720 to 0); a range the wrong
  way round saves every scale at its least (the map's LTex 1.5 to 1.1, LPfp 1.4 to 0.9); the tree bridges' doubled
  minScale/maxScale lines count by their first. doodadgrid.test.ts and doodadrules.test.ts hold the cases.

- **Unit Properties**: `--key u` (units layer), `--click` on the unit, `--key Return` opens the dialog (two clicks are too
  slow for a double click). Its tab strip moves two tabs per click or arrow key in this display: `--click` on General,
  `--key Right`, `--key Left` lands on Abilities. The Skin button on General opens "Choose Skin", which does draw (a list
  of the kind's types, filter All/Standard/Custom and a search box); a random unit's second tab is Random Unit (Random
  Unit Type: Any Neutral Hostile Unit, From Random Group, Use Custom Table with New/Delete/Edit Unit). Found so on copies
  of cliff.w3m (branch unit-props-2, 2026-11-10): the editor draws a placed unit's skin and its Custom Color only where
  the type allows a custom team colour (`utcc`, not "is a waygate"), and its script switches a custom ability on by
  its base's order.
  Placed destructables and doodads (branch skin-row-dest, 2026-11-13, empty 64x64 map, doodad layer `--key d`, click, Return):
  Doodad Properties has a Skin button at the end for both (a destructable's General tab: Variation, Z, Scale, Life, Skin;
  a plain doodad's: Rotation, Roll, Pitch, Scale, Skin); Choose Skin lists the kind's types (destructables for a tree).
  Choosing LTe1 for an LTlt and saving wrote skinId LTe1 in a version-13 doo, id and life unchanged.

- **Random groups** (branch scatter-we, 2026-11-14, SD, `tests/fixtures/we-compare/random-group.w3m`: group 0 with lines
  footman, knight, rifleman and one placed unit of it; spec `random-group-scatter`): the editor has no scatter brush for
  units and no palette entry for a group (Neutral Hostile's palette has one Random Unit, by level, the red "?" at
  1478,333); several group units at once come from a paste. Its save numbers every pasted object on (a two-unit paste:
  editor ids 3 and 4), uDNR with random type 1, group, position. A placed group unit is drawn as one of its group's lines
  under a "?" from the start (which one differs per start). Advanced (260,41) has Cycle Random Groups - Next / Previous
  (Ctrl+= / Ctrl+-; `--key ctrl+equal` did nothing, the menu item 320,334 works) and Auto Cycle Random Groups (Ctrl+G,
  on): with it on the drawn line changes by itself every 3 s (measured 2026-11-20: 3.03 s on average over 380 pictures; it was 2 to 5 s in Studio before) with no input at all, both ways round the lines (15
  pictures 2.3 s apart: F F R K R R R F R F K K F F F), and stays after Ctrl+G turns it off (10 pictures alike). It is
  not tied to placing: pastes changed the line or not as the timer had it.
  Studio: randomplace.ts `startAutoCycle` (a tick every 3 s, `AUTO_CYCLE_MS`; uniform random line), the line starts random per open; app-smoke placerAndCampaign.

Diagonal fences and angles (branch rotated-footprint-we, 2026-11-15; `tests/we-compare/fence-wpm.json`, inputs from `make-fence.mjs`, `angles`, `ints`): a diagonal pathing texture (Fence45, Fence135, ShortFence135) turns by quarters cell for cell as `pathing.ts` stamps it, the scale doesn't count, and example map 22's played Fence 1 gets the editor's own war3map.wpm. Opening a map, the editor reads a stored angle that is a whole number as degrees (2.0 is 2 degrees: a rectangle turns to 0), any doodad (doodadgrid.ts `openedAngle`).

Angles the editor reads on opening (branch snap-angle-we, 2026-11-15; specs `fence-neg`, `fence-dest` in `fence-wpm.json`, `neutral-facing.json`; inputs `make-fence.mjs neg|dest`, `make-neutral-facing.mjs [neg]`): every whole number is degrees, negative and above 360 too (-2 is 358, 361 is 1), and -1 is 135 (every copy, every type: a rectangle's quarter turn of it is 180, the old "-1 came back as 180"); -0.5 and -3.14159 stay radians. Destructables without a fixed rotation (LTbr, YTpl, LTcr, OTsp) read them as doodads do. Game doodads stored with flags 0 and 1 snap as with 2 and are saved with the solid flag. Units of every kind (gold mines, taverns, goblin merchants, barracks, footmen) keep their facing, drawn turned in the editor's view as in Studio's (no fixed facing for neutral buildings), but read a whole number as degrees, -1 as 135, and come into 0..360 by whole turns (-0.5 to 5.78, 400 to 40 degrees, 360 stays 360): doodadgrid.ts `openedUnitAngle`, applied on open with Snap Doodads on Load. The editor has no switch for its snap on load (no such string in WorldEditStrings.txt): the setting off is Studio's own. A water click under Enforce Water Height Limits (`water-floor-e-*` in `water-limit-low.json`, `low-ground-e.w3x`: level-1 ground at -2176, the clicked corner at -2048) lifts every corner of the map below -2048 to it, not only round the brush; the open alone doesn't (`low-ground-e-open`). The editor reads the ground word in its low 14 bits: stored -8400 (word -208) opens as 7984 (`low-ground-d-open`).

Doodad grid spec `doodad-snap-grid` (branch doodad-onepixel-grid, 2026-11-14; input from `make-doodad-snap.mjs grid`): all-magenta custom pictures 1 to 8 pixels, each placed at 16 offsets at 0 and 90 degrees; per axis a picture n pixels long stands on 64n + floor(n/2)*32 (1 on 64n, 2 and 3 on 64n+32, 4 and 8 on 64n), halves going up.

Doodad turn keys and `_` destructables (branch doodad-turn-we, 2026-11-14; spec `doodad-turn-we`, input `make-doodad-snap.mjs turn`; box select, Num_Lock first for the number pad's digits): the number pad `/` turns a doodad with a mixed square picture a whole quarter per press (4x4 ring 270 to 0 in one, 2x2 diagonal 270 to 90 in two), a one-colour square one by 5 degrees (270 to 275). Number pad 6 nudges a destructable without a pathing texture by 8 and leaves its angle (a fixed rotation 90 stays at 22.9), one with a 2x2 texture to the next grid point (64) at its fixed 90. A destructable with a fixed rotation but no texture, placed from the Doodad palette (rows at 1410,184 + 13 per row), gets a random angle and stays where it was clicked; with a texture it faces its fixed rotation on its grid. Studio: doodadedit.ts `doodadTurn` (mixed) and `objects.type` (no fixedRot once the texture is read, `ready`).

Replace, square brush, margin (branch we-specs-d2, 2026-11-15; specs `replace-units`, `brush-square`, `enforce-limits-margin`, input `make-replace-input.mjs`): the Advanced menu (260,41) holds Replace Tiles 288,223, Replace Cliff Type 288,240, Replace Doodads 288,257 and Replace Units 288,274 (the Edit menu has no Replace). Replace Units ("Replace Units", 460x480 at 450,258): Old Unit Type's palette on the left (Human's Peasant 471,365, Footman 503,365), New Unit Type's race 733,290 (Neutral 705,361, then a filter box at 795,339: `--type "Gold Mine"` leaves one icon at 701,422), Swap Both Unit Types 461,711, Selected Units Only 461,728, OK 791,725; every footman became a Player 1 gold mine on the 64 grid nearest it, halves going up (Studio's replace_objects). The Shape buttons (Circle 1392,624, Square 1424,624) on Grass and on Level, Increase One and Decrease One give the square of half side size - 1, and the cliff brushes type the square one corner wider (Studio's `cliffTypeStencil` square). Enforce Terrain Limits changes nothing for a texture stroke, a placed tree or a paste in the margin past the playable part (the editor paints to the map's last corner; a footman's paste there is refused either way). A pasted pathless doodad (LPcr) lands at the pointer, inside the playable part too (`limits-*-paste-margin`; Studio matches since branch paste-centre-we). Replace Doodads ("Replace Doodads", 460x377 at 450,310; spec `replace-doodad-grid`): Old Doodad's category box 563,363 and New Doodad's 793,363 drop down Bridges/Ramps, Cinematic, Environment, Pathing Blockers, Props, Structures, Trees/Destructibles (y 459), Water at 13 px steps from 381; the lists start at 408, 13 px a row, in their own order (Trees/Destructibles: LTlt, LTbs, LTbr, LTbx, LTex, LTba, LOcg, LTcr), no filter box; Swap Both Doodad Types 461,643, Selected Doodads Only 461,660, Reset Variations 461,677, OK 791,674. A barrel (2x2) replaced by crates (4x4) goes to the 4x4 grid, halves going up; one whose crate would overlap a tree's pathing stays a barrel. A Ctrl+V paste places once: a second click without another Ctrl+V places nothing. Leaving a menu open by `--key Escape` keeps the menu bar's focus, and `--close` then times out: click the menu's title again to close it.

Camps, Replace Doodads on a real map, TurtleRock (branch we-package-specials-camps, 2026-11-16, SD):
**camp grouping** (`tests/fixtures/we-specs/make-camps.mjs`: camps.w3x, camps-b.w3x, `far D1,D2,D3,D4` for camps-far-*.w3x; no
spec file, we-compare has no picture specs): the editor shows a camp only as an icon on its minimap, "Show Creep Camp
Icon" (22,225 under the minimap; the editor keeps it ticked or not in its preferences, `[Minimap] Show Creep Camps`, which
we-drive unticks before each start since branch we-drive-fixes: the "first click doesn't take" was the box left ticked by the
run before, six runs in a row alternated; one click after `--wait-ready` ticks it, check it in a `--shot-screen`; the minimap crop (10,75)-(152,200) zoomed 5x
reads well, 1 px about 11 units), a grey dot per creep, a coloured icon on one creep of each camp: green below 10 (a lone nmrl,
a lone ogre lord 7), orange at 10 (a Green Dragon) and for 7+7+1=15, red at 20 (two Green Dragons): the levels added up,
Studio's bands. **Grouping**: pairs of murlocs 400, 450, 500, 600, 650, 700, 750, 800, 816, 824, 828 apart each show one icon and
one dot, 832, 1000, 1200 and 1500 apart two icons: the limit is 832 = 26 cells of 32 (CreepCampPathingCellDistance=26), not
Studio's 450 (meleecheck.ts `SAME_CAMP`, dropsview.ts). Not transitive: a creep joins a camp by its distance to the camp's
icon creep (five murlocs at -1500, -900, -416, 416, 1200: icons on the 1st, 3rd and 4th; a chain of three 400 apart: one icon,
on the middle one: see below, that was a neighbour camp's doing). Diagonals (branch camp-icon-we, 2026-11-16; maps camps-c/d/e/f.w3x from `make-camps.mjs c|d|e|f`, icons read by `read-camp-icons.py` from a `--shot-screen` and the generator's `.layout.json`, results in `camps-icons-we.json`, unit test clusters.test.ts): the distance is the straight one, whatever the direction: 588 on both axes (831.6) one icon, 589 (832.97), 600, 700 two; 820x100, 700x440, 440x700, 826x50, 831x40 (831.96) one, 831x45 (832.2), 100x832 two. The icon is on the first creep of each camp in the order of the map's units (chains of three 400 apart in all six orders, a chain 0/300/700 either way, vertical chains, a chain of four 300 apart: icons on the 1st and the 4th), so the "middle creep" above was camps-b's lone murloc and ogre lord 800 from the chain's ends taking them in. Studio's `campGroups` matched already; only its comment changed. The first click on "Show Creep Camp Icon" failed in 4 of 8 runs (the box kept from the run before, see above; fixed); a run without a tick shows grey dots only, so read-camp-icons.py prints empty icon lists then.
**Replace Doodads on HillsbradCreek** (spec `replace-doodads-hillsbrad`, Advanced > Replace Doodads: old tileset box
663,341, "Herbstliches Lordaeron" 513,515, [FTtw] first row 520,408; new LTcr kept from the earlier run): of 2786 FTtw the editor
replaced 2692 and says "94 doodads could not be replaced in their current locations" in the view; Studio replaces 2701
(85 left): nine crates the editor refuses, in rows of FTtw/LTcr 128 apart, e.g. (7616,3648), (7168,5568): they touch only the rounded no-build (blue) 2x2 corner of a large rock (BRrs, 12x12), and the editor counts other objects' blue cells as room taken (Studio's roomShape, branch replace-doodads-we: matches, 94 refused). The new variation: 0 and 1 stay, 2 to 9 become 0 or 1 at random (Studio's `variationAfter`), so the spec ignores variation.
**TurtleRock v2.0** opens in the editor with no dialog and no message (the unused cliff type CLno), `--map` then `--wait-ready`.
**Specials** YCr3, LCc0, YCx7 (AutumnLeaves_S2, tiles (16,37), (108,55), (13,24)): not measured; the editor's picture of them
(cliff models, flat shot from `--look`) can't be told from Studio's by eye for facing or height, and nothing in the editor reads them out.

Replace Units and room (branch replace-units-overlap, 2026-11-15; spec `replace-units-overlap`, input `make-replace-units-overlap-input.mjs`): the dialog keeps the last race of New Unit Type, so a spec sets it first (race box 733,290, Human 705,309; Human's filter box is 795,315 and typed German names found nothing: click the icon, Buildings row 1: Farm 797,525, Altar 829,525, Barracks 861,525; the header `Units: [hhou] Hof` names the pick). A footman that would become a building whose footprint covers another object stays a footman, as for Replace Doodads; the footprint takes in the texture's no-build (blue) part, so a barracks (8x8 no-walk in 12x12) or gold mine (8x8 in 16x16) is stopped by a tree its red part misses, and a farm by a barracks' ring. The editor has no Replace for a selection (Edit menu, Unit Properties).

- **Keys Y and Z** (Tools menu: Reset Random Brush Z, Set Uniform Doodad Heights Y; both greyed with nothing selected under the Doodads Selection brush; `we-drive --keyboard de`, setxkbmap before the editor starts, `--key` then names keysyms): under the German layout the key named `y` (the physical key US keyboards call Z) ran Set Uniform Doodad Heights on `uniform-heights.w3x` (five carts to 71.9, flags 6, as with the US layout), the key named `z` (the physical Y position) did nothing: the editor's accelerators are the letters, not the physical keys; Studio's `keyOf` reads `e.key` first, so Y is the letter there too. Z (Reset Random Brush) shows nothing in the saved file: eight LTlt placed with the palette's random rotation and variation, four, Z, four: the variations and scales of the second four don't repeat the first (4, 3, 6, 4 against 5, 9, 0, 8), so it isn't a seed reset; no Studio equivalent (its draws are made at the placement).

**Units' heights** (branch terrain-extras, 2026-11-09, HD, copies of map 03 with units added by the release CLI): the
editor draws every unit at its flying height (UnitData `moveHeight`, object data `umvh`) over the ground under it, and
ignores the height the placement file holds: footmen stored at 0, 256 and 600 on ground 256 stand on it alike, gryphons
(240) stored at those heights fly at the same height, a footman and a banshee given 300 and a gryphon given 600 in the
map's object data fly that high. Over the lake a flyer is over the bed (heightAt), not the surface; at the lake's cliff
edge it follows the ground as drawn (within the camera's few pixels). Ships stay on the surface. The selection circle of
a flyer lies on the ground under it. Studio's pictures at the same looks put the units within 5–15 px of the editor's
(their stand animations differ); app-smoke `flyingHeights` reads the drawn heights (`drawnUnits` of the view's handle).

**Fire and particle colours in HD** (branch render-fixes-4, 2026-11-09, a test map with AObr, ZObz, LObr, OOgr, ZZdt,
AOob and AOnt in a row, the editor in SD and HD): the particle colours are read right (red, green, blue): the
editor's classic view shows the same yellow-green fire on ZObz and the same faint green-yellow haze over the grate
OOgr as Studio's stand-ins. The HD editor draws the Reforged PopcornFX effects instead (orange glows), which Studio
can't; its stand-ins are the classic emitters, additive, so orange over the bright HD grass turns lime and blue
turns cyan. Particles don't go through the HD tone curve. What was wrong and is fixed: HD emissive textures (layer
slot 3: AOob's red runes were black, AOnt's lamp unlit), Reforged models whose classic emitters are empty
placeholders (LObr: no fire at all), the HD City cliffs' placeholder textures (`ReplaceableTextures\Cliff\Cliff1_…`,
drawn white on OrcX02_03) and Cityscape's HD water colour (blue).
