# Lighting and shadows

Time of day, light ranges, Calculate Shadows, HD shadows and the light in the game view. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

- **Light Ranges** (branch light-radius, 2026-11-13, HD, `--look X,Y,3000,270,70,90` straight down, copies of the
  empty map with imported copies of the Ruins Brazier's HD model, one light value changed each; numbers in
  `target/evidence/light-radius/` of the main checkout): one ring per light on the ground under it, in the light's
  colour, its radius set by the brightness alone (intensity times the colour's length; not the attenuation, not the
  object's scale), animated with the intensity track. Studio's fit: viewmodes.ts `lightRangeRadius`. In SD no rings
  were drawn. Closing the editor with Light Ranges on ended in its crash dialog each time (`--close` times out).

- **Time and lighting**: with the day fixed (we-drive's default) the status bar says "Time: 06:00". Measured
  2026-11-08 at the opening view (pic-compare, whole picture), the editor's three states hardly differ: on cliff.w3m
  game view off with View > Lighting on, with it off, and game view on are within a mean absolute difference of
  0.7 and 1.3; on map 03 (Water Ford Lake Boats) 2.5 and 3.0. In SD that holds for any light (the classic picture
  clamps the light to 1); in HD it holds for map 03, but cliff.w3m's own strong lighting makes its game view much
  brighter than the editor's light (green about 233 against 123). The rest of the colour difference to Studio was
  the HD picture's tone (`lib/model/tone.ts`).

- **Calculate Shadows and what the editor leaves out** (branch we-terrain-2, 2026-11-17; File menu (19,41) > Calculate Shadows and Save Map (105,155), the save asks "Warning", `--save-accept Warning`; plain Save keeps the stored war3map.shd byte for byte: HillsbradCreek and LastRefuge saved without a change, so the sample maps' shadows are the old calculation's: Studio's against the stored LastRefuge 5446 cells, against a fresh calculation 3853 of 147456 (editor 10556 shaded, Studio 11611); (2)LastRefuge unpacked, doodads emptied or split by Doodads.slk's DoodadSkins `shadow`). **shadow=0 doodads cast nothing**: the 335 doodads of LastRefuge's 24 shadow=0 types (ZPsh, ZWsw, LPwh, LPfp, LPrs, ...) alone give the terrain-only shadow (8177 cells) exactly, 0 cells added or taken away; the other 2118 add 2379 cells (Studio `bakesShadow`: right). The 91 cells that still disagree are the same cell-edge disagreement as everywhere else: **terrain only** (cliffs; Studio's 225/30 heightfield cast) 7117 cells shared, 1736 Studio-only on the south-west rims, 1060 editor-only on the north-east ones; a fit of azimuth, elevation, sample offset and start height (nearest, bilinear, tile-maximum and minimum ground) found nothing better than 2244 cells off; **doodads on flat ground** (HD): the editor 2346 cells beyond the terrain, Studio 2704, 1954 shared, rocks LRrk (177 of the 2118) most of the difference; twenty rocks one by one on a flat map (10 variations at angle 0, one variation at 10 angles): the editor 259 cells, Studio 285, 172 shared; the editor's blob reaches one cell further west and south, Studio's north-east. The calculation follows the editor's graphics mode: the same rocks 259 cells in HD and 870 in SD (Studio's 285 and 590; 518 shared in SD); letting every geoset filter mode cast changed nothing. Not found: the rule that decides the edge cells (found for the terrain: next item).

- **Calculate Shadows: the terrain's rule** (branch we-shadow-3, 2026-11-17; `we-drive --save-shadows FILE`, we-compare `"we": { "save": "shadows" }`; maps from `tests/fixtures/we-specs/make-shadow-probes.mjs`: `shadow-terrain` (a 128 bank, cliffs one and two levels up, single corners raised 128, 256 and 512, two ridges, a 64 bank) and `shadow-rocks` (LRrk, ten variations, eight turns); spec `tests/we-compare/shadow-terrain.json` with plateau.w3x: both MATCH). The terrain's shadows are the same in SD and HD. **Heights per cell**: one per shd cell at its centre; ground tiles over their two triangles split from the top-left to the bottom-right corner (a raised corner's shadow is fatter along that diagonal than bilinear's); **cliff tiles** from a cliff model, but not the drawn one: the editor names it after the corners read from the top-left (top-left, top-right, bottom-right, bottom-left) and reads it a quarter turn round (the tile's (u, v) at the model's (1 - v, u)), the highest surface there, over the tile's lowest layer plus the ground's own height (of the eight name orders against the eight turns only this pair fits: the one-level cliff's shadow reaches a cell further in one row of four along an east face; the drawn model left 129 cells off, corner heights alone more). **The walk**: from each cell 16 cells toward the sun, one cell diagonal a step (225°), dark when a cell on the way is higher than the cell itself plus 32√2 · tan 30° per step (strictly; a 1-unit start offset adds an error, 2 and more many); the cells 17 steps off a 512 high corner stay lit. Fitted alternatives that lost: the old ray (bilinear ground, 16-unit steps from the centre, +1 start; 786 of 2618 cells off on the probe map), steps of 16 or 32 units (47 off), exact ray-triangle cliffs (64 off on the east face), cliff models cast like doodads (hundreds). Studio: shadows.ts `shadowCellHeights`, `shadowCliffName`, `cliffCellHeights`, `SHADOW_WALK_STEPS`; the probe map and plateau.w3x 0 cells off (were 786 and 286). **Real maps** (HD, the editor's fresh calculation; LastRefuge, TurtleRock and HillsbradCreek with their doodads emptied, LastRefuge whole): a variation the shadow's name lacks is counted round its variations (`shadowCliffVariation`; the drawn model's fall-back to the highest left 674, 840, 1646 cells off, this 367, 576, 1009), the ground under a cliff model is bilinear (330, 534, 859); before the branch 2950, 4222, 7405 of 8704, 11045, 18219 shaded cells, LastRefuge whole 3995 → 1438 of 11050. Left: mostly cells under water that Studio shades and the editor doesn't, at the north-east edges of shadows over a bumpy sea bed (TurtleRock 381 of its 534; a start offset of 0.5 halves them and adds others, the water level as the height takes thousands away: not found), and ramps. **Doodads**: SD casts alpha-tested geosets whole (the rocks: 983 of 984 cells and 5 more; with the alpha test 659 and 3 more; shadowmap.ts); HD rocks (opaque) 337 of the editor's 341 and 49 more, the extra cells at the rocks' middles, under the highest part (the model is a single cap covering each point once; neither faces toward or away from the sun, nor a height walk over the doodads (269 off), nor the surface's facing explain the editor's holes): not found.

- **Calculate Shadows: the walk's rise and length, water, ramps, cliff variations, doodads** (branch we-shadow-4, 2026-11-17, HD; `we-drive --save-shadows`; maps from `make-shadow-probes.mjs`: `shadow-slopes` (planes facing away from the sun falling 26.56, 26.63, 26.69 and 26.75 a step of the walk, two of them under water, a corner raised 1000), `shadow-cliffvar` (cliff variation 3 on faces whose shadow models BAAB and BBAA have two), `shadow-ramps` (a ramp down each face of a plateau) and `shadow-boxes` (box models imported as custom doodads: closed, without bottom, triangles turned inward, sunk 32, floating 32, a lone top facing up and down, a tall post); specs `shadow-slopes` and `shadow-cliffvar` in `tests/we-compare/shadow-terrain.json`). **The rise**: a step of the walk rises 80/3 (the sun about 30.5° high, not tan 30° = 26.13): on the real maps the cells whose steepest rise toward the sun lies between 26.13 and 26.6 are lit, those over 26.7 dark; the probe's planes at 26.63 lit, at 26.69 dark, the 128 bank's cells exactly 80/3 up dark (a 1536 corner's four exactly 80/3 up, 36 steps off, were lit: not explained, the committed probe avoids them). **The length**: none; the 16 steps of we-shadow-3 were the old rise's fit (a 1000 corner casts 33 cells, HillsbradCreek's slopes 28: 307 cells off after 16 steps, 75 without a limit). **Water** plays no part: TurtleRock's cells under water were the rise (534 off, 24 now, none of them about water; the wet planes as the dry ones). **Ramps**: a ramp side (lib/terrain/cliffs.ts `rampSides`) reads the ramp model named from the top-left corner on, a quarter turn round, as cliff tiles do (`shadowRampName`, `rampCellHeights`; shadow-ramps 42 cells off with the side tiles' cliff models, 28 as ground, 20 with the drawn ramp model, 7 so; LastRefuge 114, 113, 103, 87). **A variation the name lacks** goes round: 3 on a name of two reads 1 (shadow-cliffvar: 0 cells off, 383 with 0). **Doodads** (HD and SD alike): a cell's line toward the sun from its own ground (the walk's heights) meets the model; the cell is dark only when all of the model's surfaces on that line lie above the ground there: a closed box on the ground leaves its footprint lit (its bottom is on the line, at the ground), the box without its bottom shades it, sunk lit, floating dark, the triangles' turn changes nothing (`castShadow`); of the boxes' 235 cells the 8 whose centres lie exactly on a projected triangle's edge are off (the editor leaves some of those out, not found), LRrk's probe 7 of 341 (53 before), in SD 3 of 984 (6 at tan 30°). Before and after the branch, the editor's fresh calculation against Studio: TurtleRock, LastRefuge, HillsbradCreek without doodads 534, 330, 857 → 24, 87, 75 cells off (of 11045, 8704, 18219); LastRefuge whole 1438 → 487 of 11050. Left: the ramps' 7 cells, LastRefuge's 2-level notch at tile (61, 86) (the editor leaves it lit under its walls), the edge cells, whether a texture hole of an alpha-tested face counts as a surface.

**HD shadows by hour and tileset, specials in Calculate Shadows** (branch we-shadows-1, 2026-11-18, HD). (1) **The light in
HD's real shadows**: `make-water-shadows.mjs --time 1|2|3 --tileset B` (Map Preferences' Time of Day in war3mapExtra.txt:
the status bar says 06:00, 12:00, 18:00; the editor's fixed day doesn't override it), one we-drive run with
`--looks-every-map` (every map gets the `--look` cameras), `--look 0,0,2400`, game view off, Shadows on and off; Studio
`--compare-ready lit` with `terrain.lighting.hour` 6, 12, 18. Taken back to linear light per pixel (the medians of the
darker half of each shadow), the ground keeps **0.36 to 0.39 of its light in the editor at every hour and on Lordaeron
Summer and Barrens alike** (dirt under the trees, footmen and a gryphon; 06:00 and 12:00 give the same picture there),
Studio 0.53 to 0.56. Misc checks 5's "0.08-0.10 lighter, blue up to 0.26" was this one factor seen through sRGB: the
dirt's blue is dark, so its ratio moves most. Map 03's footmen: the editor 0.375 (green; render-fixes-5's 0.50 was the
same shadow read through ACES's toe, which hdTone dropped on 2026-11-12, so Studio's shadows got lighter then). Studio
now leaves the ground GAME_SHADOW_FILL 0.31 of the lit light (tone.ts; the models keep GAME_LIGHT_FILL): 0.36 to 0.38 on
all of them, map 03 0.37; water under a footman 0.40/0.50 against the editor's 0.45/0.52 (red/green; before 0.56/0.60);
TwistedMeadows' opening view mixed (a house 0.49 against 0.52, rocks 0.38 and 0.51 against 0.44 and 0.45). cliff.w3m's own
lighting has no fill and is unchanged. (2) **Special doodads in Calculate Shadows** (`--save-shadows`; (2)LastRefuge with its
doodads emptied, with and without its one special, the cave YCr2 at tile 60, 85, footprint 12 x 12 cells): the cave
lights 26 cells of the notch it fills and darkens 2. Studio read the cliff models under it (26 + 2 off); the cave's own
model as it is drawn (origin in the footprint's middle, 270°, over the footprint's lowest layer), its highest surface on
all nine tiles, flat ones included, gives the editor's cells exactly (shadows.ts `specialCellHeights`); the tiles as
ground 44 off, the model on the cliff tiles only 6, turned 0/90/180 33 to 75, moved 16 units 6 to 14. The rest of the map
(59 cells) is the same with and without the special. (3) **Cells on a projected triangle's edge**
(make-shadow-probes.mjs shadow-boxes, saved again: the same 8 of 235 off): all eight lie on the boxes' diagonal x = y, the
sun's direction through the box: where the bottom's split edge and the west/south corner edge meet a cell's line. The
editor shades them for the box turned inward and leaves them lit for the closed, cap and floating boxes, so it is not a
plain inclusive or exclusive test (treating the edge as outside: 32 off, a tolerance of 1e-4: 41) nor a top-left rule;
probably the editor's floating-point rounding on lines exactly through an edge: not reproduced.

**Making the editor show a light**: `--look` maps are copies, so a variant of a map with a lighting model written
for the test (war3map.w3l naming two `<guid>.mdl` files, unpacked and packed with the release CLI) shows what the
editor does with one value at a time. That is how tone.ts was fitted: flat ground of cliff.w3m, the sun straight
down at intensity 0.5, 1 and 2, at 52° from the south, north, east and south-west, ambient alone, shadow intensity
0, 2 and 5.85; with no light at all the view is black and `--compare-ready` never sees it drawn.

Measured again on 2026-11-08 (branch render-fixes-3), with both of cliff.w3m's lighting files changed per variant:

- **The ground in game view follows the map's unit lighting model**, not the terrain one: changing only the terrain
  file (its shadow intensity, its sun's intensity) left the flat grass the same to the last digit; changing only the
  unit file changed it. (cliff.w3m's two files are the same and both name their model `DNCLordaeronTerrain`, so a
  cache by that name would look the same; a map with two different models would tell.)

- **The shadow intensity's lift is much stronger than shadeWrap's** at the cliff's sun (52° from straight up), and
  grows with the sun's intensity. k (the light on flat grass over the editor's own light, from the mean green by
  simulating the tone curve per pixel of the unlit picture, so values near white aren't underestimated): sun 1.95,
  ambient 0.2, shadow 0 / 1 / 2 / 3 / 5.85: 0.93 / 1.45 / 2.12 / 3.14 / 16.4 (Studio's hdLight and shadeWrap: 1.31
  / 1.81 / 2.32 / 2.83 / 4.28); shadow 5.85 with sun 0.5 / 1: 2.43 / 4.01; sun 1.95, shadow 5.85, ambient 0 / 1:
  13.4 / 32.7; shadow 0, ambient 0: sun 1.95 0.79.

Measured once more (branch render-fixes-4) with the cliff's south walls close up (`--look 0,600,1000`, the same twelve
variants and an unlit picture; walls told apart by their brown in the unlit picture, k per channel the same way):

- The sun is in the south-west (the unit shadows fall to the north-east), so those walls face it (cosine about 0.4),
  not away. Their green k for shadow 0 / 1 / 2 / 3 / 5.85: 0.71 / 1.22 / 1.67 / 2.14 / 3.81, about 0.5 more per unit,
  the same as the grass's while its green is below 200 (0.92 / 1.45 / 2.13): **the lift is the same on every
  surface**, 1.32 × (1 − 0.62) per unit for this sun, none with the sun straight down (`facing` in tone.ts). A lift by
  the surface's own (1 − cos), which shadeWrap was, whitened the walls (0.75 per unit).

- Beside a sun the ambient adds as it reads (walls 3.63 / 3.81 / 4.65 for ambient 0 / 0.2 / 1; 0.14–0.18 for 0.2 at
  shadow 0), not as the ambient-alone fit's 1.24 × colour^0.52 (hdLight).

- The large k above came from the tone curve, not the light: the walls' red (226) and the bright grass (238) need far
  more k under ACES than their green and the dim grass. With the light as above, ACES is 10.5 levels rms off over all
  36 means, ACES with a shoulder that reaches white from linear 0.69 on (`HD_SHOULDER`) 3.9.

- The ground doesn't follow the unit model after all, at least not the game's own: map 03 (no lighting of its own,
  so Lordaeron's terrain and unit models) with the ground under the unit light came out 18 levels darker than the
  editor's grass (106 against 125); under the terrain light it's within 0.1. The render-fixes-3 finding came from
  cliff.w3m, whose two files both name their model `DNCLordaeronTerrain`.

**Shadows** (branch view-shadows, 2026-11-09; we-drive `--game-view off` then `--view Shadows=off`, the luminance
ratio of the two pictures shows what View > Shadows draws): the classic (SD) view draws war3map.shd on the ground
(0.65 of the colour in a full cell, filtered between cells), the shadow images of buildings and destructables
(`ReplaceableTextures\Shadows`, a texel per 32-unit cell, the red texel on the object) and the units' Shadow.blp
textures; the HD view instead casts the models' own shadows (a footman's shape) and draws no war3map.shd at all.
How Studio follows that, and the numbers, are in `viewshadows.ts` (SHADOW_LOOK, shadowLookFor). A test map with
buildings, units, trees and a barrel on cliff.w3m's flat ground (made with the release CLI, unpack, JSON, pack) was
what told the parts apart.

**HD's real shadows** (branch hd-shadows, 2026-11-09; we-drive HD, Shadows on over off, `--game-view` on and off give
the same shadows): the models' own shapes from the sun, on the ground, on water and on the models; none from cliffs
or the ground (cliff.w3m: the same picture), and none at all with View > Lighting off. They fall from the units' sun
(map 03's footmen's to the north-east, as its unit light; the terrain light's is east). How light they are depends on
the lighting model, not a fixed darkness: the test map above (`lab.w3m`) with cliff.w3m's lighting files changed one
value at a time gave black shadows without ambient and shadow intensity, shadows as light as the lit ground at shadow
intensity 1, and lighter above (5.85: yellow on orange sand); the game's own HD lighting keeps about half the light
(map 03's footmen 0.68 of the colour). The fit is in tone.ts (SUN_SHADE, GAME_LIGHT_FILL, sunLight), the shadow map in
lib/model/sunshadow.ts. Against Studio's HD pictures (`--compare-ready lit`, the same looks, Shadows on over off), the
shadow's light over the lit ground (green) was 1.56 / 1.32 / 1.30 in the editor on the test map's three looks, 0.71 /
0.71 / 0.69 with the stand-ins before and 1.35 / 1.29 / 1.32 now; map 03's footmen 0.68, 0.62, 0.64; TwistedMeadows'
trees 0.73, none, 0.60. The overlap of the shadows (pixels that change with Shadows, both pictures; the editor's
include its animated models) went from 0.05–0.27 to 0.12–0.63 on the test map, 0.16–0.21 to 0.25 on map 03, 0.01 to
0.13 on TwistedMeadows; the whole picture's mean difference hardly moves (shadows are a small part of it: 10.9 → 10.5,
14.5 → 13.8, 13.7 → 11.8 on the test map, map 03 and TwistedMeadows within 0.2). The editor's gryphon flies, and its
shadow with it; Studio draws it so since branch terrain-extras (below). `app-drive --frame-cost` reports the last
frame's real shadows (`sunShadows`).

**Shadows, water and shore against the editor once more** (branch render-fixes-5, 2026-11-09; light ratios Shadows
on over off with the tone curve inverted per pixel, green, medians): the models never got the game lighting's fill
(the model shader's uniform list lacked it), so trees and units were near black in shadow and on their sides away
from the sun (TwistedMeadows' tree trunks 24, 11, 3 with Shadows off against the editor's 79, 52, 22; now 58, 29, 10).
Models now take it on every surface (tone.ts objectLight), the ground in shadow only. Ground in shadow: map 03's
footmen 0.50 (editor) / 0.54 → 0.56 (Studio before → after), TwistedMeadows' trees 0.54 / 0.51 → 0.56 and 0.60 /
0.52 → 0.59. HD water was the bigger part of TwistedMeadows' difference: its centre is water 38 deep over rock, which
the editor shows nearly as the rock; five pools of set depths (8–96) on flat grass gave the editor's opacity and a
lighter shallow colour (renderer.ts HD_WATER). TwistedMeadows' opening view against the editor's game view 16.8 →
10.4, unlit 19.1 → 11.2; the pools 11.4 → 10.0; a test lake on map 03 with a gryphon and two nagas 13.0 → 12.5 (lit),
15.6 → 14.0 (unlit); map 03 unchanged (6.9). The same pools put the editor's shore waves where the water is at least
24.5 deep and only on the shore's −X and −Y sides (shoreline.ts). Still different: the editor shows a swimming
naga's body through the water (its opacity seems to go by the water in front of what's behind, not by the bed's
depth), the lake's outline (an oval in the editor), and the trees' lit sides are darker than the editor's.

**Shadows on HD water, by depth** (branch fix-water-shadow-de, 2026-11-22; `app/scripts/water-shadows.mjs`, which makes
the maps, runs both programs and measures: `make-water-shadows.mjs --depth S --deep D --lake-trees --lake-tree-scale 2
--no-units` for 8:70, 12:80, 20:100, 30:130, 45:200, 60:300, we-drive HD gpu with game view off, a `--look` at each lake's
tree and four frames 0.7 s apart with View > Shadows on and four off at the same camera; Studio the same through `we:`
cameras; `shadow-keep.mjs`: per channel in linear light the sum over the core, the 9 x 9 blurred ratio under 0.8, of the
mean of the frames). Why the earlier rounds disagreed (45 deep green 0.68 on 2026-11-18, 0.60 in the verify round): one
frame on against one off, units animating beside the trees and unscaled trees whose shadow in deep water is a few hundred
pixels; one frame against one scatters the editor's blue by up to 0.25 in shallow water (the waves' reflection), the four
frames' means by 0.02. Editor, green / blue kept: 8 deep 0.447 / 0.442 (all three channels 0.44, the ground's shadow:
the editor's water shows nothing of its own there), 12 0.466 / 0.739, 20 0.501 / 0.829, 30 0.557 / 0.798, 45 0.621 /
0.865, 60 0.625 / 0.880, 70 0.593 / 0.826, 80 0.603 / 0.791, 100 0.635 / 0.787, 130 0.563 / 0.761, 200 0.576 / 0.777 (300:
no core, the tree's top too small above the water). The fit: Studio rendered with none of the water's own colour and sky
taken and with all of it taken (WATER_SHADE), over the second's core in both, gives per depth and channel kept = A + B ×
share; the share the editor's number needs falls from about 1 at 12 deep to green 0.55 to 0.64, blue 0.76 to 0.79 from
70 deep on. renderer.ts `waterShadowKeep`: nothing taken up to 12 deep, linearly to 0.585 / 0.78 at 70 and deeper (red
0.9, unreadable). Studio before / after, mean over 12 to 200 deep of |Studio − editor| in green and blue: 0.053 / 0.021
(before: 0.06 to 0.12 too light from 30 to 70 deep, 0.06 to 0.12 too dark from 100 on); after, 100 deep green is the
largest (0.573 against 0.635; that core is the smallest, 2778 pixels). Left: 8 deep blue (Studio 0.633: its water shows
its blue reflection there, the editor's doesn't), and the shadow's shape on deep water: the editor's is longer than
Studio's (80 deep, scale 1: from the tree's top 148 pixels along against Studio's 120, land shadows alike at 233), as if
the editor looked the shadow up below the surface.

**Calculate Shadows in DE** (branch fix-water-shadow-de, 2026-11-22; `de-ruins.w3x`, `make-shadow-probes.mjs de-ruins`,
we-drive `--mode de --save-shadows` against Studio with `game.graphicsMode` de): the editor's DE and HD shadow maps are the
same bytes; EW00, ET00, LRrk and the plateau match Studio's; EMt0 (ExteriorMainTower, at -3072, -1024, 270°) has 5 cells
more in Studio: row 95 (16 units south of the tower's centre), cells 24..26 and 38..39, the west and east rims of its
footprint, which the editor leaves lit. A footprint-edge case of the doodad rule like the boxes' 8 edge cells above:
not found.
