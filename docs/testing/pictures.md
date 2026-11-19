# Comparing pictures with Studio

How to put the editor's and Studio's pictures side by side, and the picture-parity measurements. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

- **Looks against Studio, branch we-compare-5** (2026-11-18; pictures, no spec; the maps were made from
  edge-last-step.w3m with the release CLI, unpack, JSON, pack). **Building ground marks**: farm (HSMA), town hall (HTOW),
  barracks (HMED), orc barracks (OMED) on flat ground, SD, `--view Shadows=off`, `--look x,y,1200`, each picture against
  one of the same map without the buildings (changed pixels over 30): the marks' widths and south edges in the editor and
  in Studio (`app-drive --set 'game.graphicsMode="sd"' --set terrain.shadows.visible=false --compare-ready lit`) within
  1 to 12 px (town hall 385-776 against 388-783, barracks 440-749 both, south edges within 2 px): UberSplatData's Scale is
  half the square's side (splats.ts). A placed building's own scale (war3mapUnits.doo, 0.2) changes neither model nor mark
  in either. **Fog from the eye** (map 02c, linear 500 to 2200, `--compare-ready`, `--look 0,0,D`): the editor's game view
  closes the fog in as the camera goes out, as Studio's (`--compare-ready game`): mean difference over the view's top
  half 11.7 / 12.0 / 9.3 / 1.6 / 1.6 at D 800 / 1200 / 1650 / 2500 / 3500, all fog colour from 3500 on; at 5000 the
  editor's ground ends a third down the view (black above, the sky's edge drawn), Studio's is fog. **Rain** (a region
  over the map with RLhr, angx and angy 10): the editor's streaks are vertical in the world (from a camera 15 degrees down
  they spread out from the middle; near it upright), Studio's all lean about 14 degrees one way (weather.ts tiltOf); the
  editor's are thin and bright, Studio's wider and fainter; with the camera at 3000 instead of 1650 the editor shows a
  fifth of the streak pixels (233 against 1090), Studio as many (its box grows with the view, weather.ts viewBox).
  Ember rain (VWeo, angx -50) and wind (WOcw, WNcw) didn't show a direction in stills. **View Selection keys** (Edit >
  View Selection with a unit selected): Cycle Main View Next ~, Previous Shift+~, View In Object Manager F1 (opens the
  Object Manager on Units, the type's row opened down to the object), View In Object Editor Ctrl+F1 (opens the Object
  Editor), Select In Tool Palette Ctrl+P (the palette's type becomes the unit's, "Brush: Units - Farm", nothing
  selected). Studio binds the three in the terrain view (extension.json; commands.test.ts, app-smoke newMaps' view
  commands). **Camera objects** (View > Camera Objects on, a camera seen from another): the editor draws a camera model,
  a line from it to the target and a small box at the target, no field-of-view cone; Studio's marker
  (cameras.ts cameraMarkers: arrowhead on the target, shaft, camera) has the same parts. **Unit looks** (HD, game view):
  a footman placed with the knight's skin is a knight in both; a footman with a stored colour 5 is in the owner's red in
  both; a custom footman with Allow Custom Team Color (utcc 1) and colour 5 is orange in both; a custom footman with
  Tinting Color 255, 40, 40 (uclr, uclg, uclb) is all red in the editor and untinted in Studio (no object tint is drawn).

Both sides at the same size, camera and lighting, then `pic-compare.mjs`:

```sh
node scripts/we-drive.mjs --map M --compare-ready --look center --shot we.png --close        # game view
node scripts/app-drive.mjs --map M --terrain --view-size 1184x844 --camera we --compare-ready game --shot st.png
node scripts/pic-compare.mjs we.png st.png --sample --diff d.png
```

| World Editor (we-drive) | Studio (app-drive) |
|---|---|
| `--compare-ready`: game view on, the day fixed (06:00) | `--compare-ready game`: Studio's game view (`terrain.gameView`, V), lighting on at hour 6: no start locations, regions, cameras, pathing, grids or light ranges, as the editor's |
| (game view off, the editor's marks drawn, lit) | `--compare-ready lit`: `terrain.lighting.enabled` on, `terrain.lighting.hour` 6, game view off (the pair used before Studio had a game view: start locations still drawn) |
| `--compare-ready-unlit`: game view off, View > Lighting off | `--compare-ready unlit`: `terrain.lighting.enabled` off (Studio's even light), game view off |

**What the editor's game view leaves out** (we-drive on a copy of map 03 with two regions, a camera, three lit
doodads, and Regions, Camera Objects, Pathing - Ground, Camera Bounds, Light Ranges and a grid all on, 2026-11-09):
all of those, and the start location with its start building; units, doodads, water and the lighting stay. Every View
item is greyed while it's on, and comes back as it was after. Studio's game view (viewmodes.ts `shownView`) does the
same, and its badge "Game View" stands where the editor's "Game View Settings" note would. With those items on in
both and the same camera (`--look center,2200`), the editor's game view against Studio's `--compare-ready game` was a
mean absolute difference of 6.7, against `--compare-ready lit` (the regions, pathing, grid and start location drawn)
24.1. Studio's toggles and keys are checked by app-smoke (`viewModes`).
| `--look x,y[,distance[,aoa[,fov[,rotation]]]]` | `--camera "we:x,y[,distance…]"` (only angle 304 and field of view 70 are fitted) |

Studio's defaults are lighting on at hour 12 (`terrain.lighting.*` in the terrain viewer's extension.json). On map
03 at the opening view (HD, both pairs), the mean absolute difference was 17.5 (lit) and 16.5 (unlit) before the
editor's picture tone went into Studio (`lib/model/tone.ts`, branch render-fixes-2), and is 7.7 and 6.9 after; on
cliff.w3m 42.8 and 14.1 before, 26.8 and 7.1 after. What is left on map 03 is the lake's shore and the start
location, which the editor hides in game view. The editor's HD game view draws no shoreline waves (its classic game
view and its unlit view do: white crests at the water's edge, where Studio's foam sits about a tile farther up the
shore); Studio leaves them out in HD with the lighting on (renderer.ts `groupShown`). On
cliff.w3m lit, its own lighting (sun 1.95, shadow intensity 5.85) came out brighter in the editor (grass green 248
against 218) until branch render-fixes-4 (below): 245 now, the opening view's mean difference 28.3 → 19.9; light_map.w3m
(the same lighting) 19.9 → 9.1 at its centre and 33.3 → 25.2 close up; map 03 7.0 → 7.2.

The camera lines up on raised ground too: on map 03 (ground 256 high at the centre) the start location's ring is
within 1 px of the editor's and the two footmen within 3–5 px. The lake's edge differs by how each fades the water
in from the shore (in SD within 3–14 px, in HD 10–30 px), not by the camera. The editor fades each corner by its own
stored water level, flagged or not: map 03's shore corners are stored far below (-346 under the bank), so its lake's
edge follows the wet corners tile by tile; the same map with them stored at the lake's level shows a smooth oval
(we-drive, both, 2026-11-08). Its HD lake is opaque sooner from the shore than the classic ramp (about 0.37 at depth
11, 0.59 at 22, 0.85 at 71). Both are in renderer.ts (`waterTile`, the HD branch of the water shader).

**Click helpers, scale ranges, ZZdt, submerged models and trees** (branch render-fixes-6, 2026-11-09, copies of map 03
with doodads, custom doodad types and units added by the release CLI, the editor in SD and HD):

- Every `useClickHelper` doodad (Doodads.slk) gets the editor's click helper beside its model, outside game view only:
  WorldEditData.txt's `ClickHelper` (InvalidObject.mdx, a 128 cube whose white squares its geoset colours magenta) at
  `ClickHelperScale` 0.4 of the doodad as drawn, `ClickHelperColor`'s alpha 96 (objects.ts CLICK_HELPER). A dust type
  given scales 0.5–3 and placed at 1, 2 and 3 showed cubes 46, 80 and 126 px wide; turned doodads turn it. Studio's cube
  lands on the editor's to the pixel; its colour is the classic view's (the HD view blends it in linear light: brighter
  magenta, lighter black squares).

- A doodad or destructable stored outside its type's minScale..maxScale is drawn at the nearest end, per axis (ZZdt 1–1
  at 4, the armor rack LOam 0.8–2 at 3, the hay cart LOch 0.8–1.2 at 2, 1, 1, Lordaeron's tree LTlt 0.8–1.2 at 0.4 and
  3); the stored scale stays (objects.ts scaleRange).

- ZZdt (DemonFootPrint): the classic view does draw the footprint and its flame, small and under its click helper
  (seen through the cube at distance 900; a custom hay-cart type with the same model shows them plainly at 1000–2200).
  The HD view draws the Reforged model, which has no geometry and only a PopcornFX effect (CORN, visibility 1 in its
  Stand) that shows nothing; Studio stands in the classic model's emitters for PopcornFX models (the fires need them),
  so it draws a flame there. No table field or model value tells ZZdt from the fires (scanned: the 62 doodads whose HD
  model is PopcornFX and whose classic model has emitters).

- HD water over a model under its surface goes by the water in front of the point seen, not the bed's depth (the
  editor shows a swimming naga's tail): renderer.ts drawWaterDepth, viewdepth.ts. On the copy of map 03 with two naga
  myrmidons and a siren in its round lake the tails now show; the region's mean difference hardly moves (lit 14.2 →
  14.3, unlit 13.1 → 12.8: the swimming poses differ). The editor's tails look clearer still.

- TwistedMeadows' trees are darker than the editor's also with View > Lighting off (green 61 against 85), so not by the
  sun or the fill: the alpha test at 0.5 or 0.3 instead of 0.75 gives 63 and 64, an even light on the models of 1.0,
  1.2 and 1.43 gives 68, 75 and 82, where 1.2 matches the rocks there (87 against 87) but makes map 03's racks too red
  (38 against 28). Other HD models are darker too (TwistedMeadows' rocks 75 against 87, the roof 79 against 89, unlit),
  each by its own amount: the editor's HD shading of the materials (normal and ORM maps, which Studio's model shader
  doesn't use for light) is the likelier cause.

- **Special doodads** (branch special-doodads-we, 2026-11-13, AutumnLeaves_S2, look -6208,-5376,1200; we-drive SD and HD
  give the same picture): to see which patches of Studio's picture are the specials, rewrite war3map.doo.json with
  `specials: []` (app-drive `--eval` with `w3.workspace.writeText`) and `pic-compare` the two shots. At the first YCl2 the
  editor draws a cliff hollow exactly there, so the position fits; Studio's model shows as a hard-edged flat grass
  square with tan rock on it (lowprio-bugs). Not compared: facing and height of other types. The editor's picture is
  dark on its left half there (outside the camera bounds), Studio's isn't.

- **Specials, Classic conversions, portal, bounds line, variable values** (branch we-misc-3, 2026-11-17, we-drive
  `--mode hd` (its default) and `sd` against app-drive with `--set game.graphicsMode='"sd"'` (Studio's default is HD);
  `--camera we:` and `--look` with the same x,y,distance; pic-compare):
  (1) *Variable initial values* (`tests/we-compare/var-initial-values.json`, Studio's `add_trigger_variable` into a
  new map, the editor opens and saves it): real 1.5, 2.345, -0.1, 7 (the editor's script and wtg: 1.50, 2.35, -0.10,
  7.00), integer 0x1F, 0xff, 42, -5, unitcode hfoo (`'hfoo'` in the script), string: war3map.wtg and the `udg_` lines
  MATCH. (An integer variable can't hold `'hfoo'`: Studio refuses it, only the object-code types take 4 letters.)
  (2) *Specials* (input `tests/fixtures/we-specs/make-specials-look.mjs`: plateau.w3x with 25 specials, flat-ground
  rows of YCd1-4, YCl2, YCc1-4, LCc0, LCc2, YCg1, YCp2, YCu2, YCr2 and caves and collapses on all four faces of the
  two-layer plateau; looks 0,-2560 / 0,-1792 / 0,1536 / 0,-128 at 2600): the editor draws every one, the city types
  YCd/YCc too (on a Lordaeron Summer map). Same places and shapes as Studio's. Left: (a) on **flat ground** (corner
  cliff texture 15, the "none" of the w3e) the editor's cliff part is a flat quad with an unresolved texture, **white
  (255, 255, 255) in SD and blue (40, 66, 78) in HD**, tile-aligned at the footprint's edge; Studio's tile of the first cliff type is
  tan like the ground and shows nothing; (b) the dark inside of a cave or collapse is the editor's black all through
  the hollow, Studio's shows a ground-coloured polygon (AutumnLeaves' LCc0 at (5632,-1152), HD: the same, so not the
  plateau's doing; back faces were not the cause: switching culling off for the models changed only a small piece);
  (c) **fixed**: on a plateau's face the editor gives the special the cliff type of the tile it is placed by
  (`sp.x, sp.y`, the footprint's bottom left), Studio took the tile under the model's middle, often off the cliff, so
  its tops were tan where the editor's are green (`specialTileCliffType`; region 0,0,1184,640 of the plateau view
  mean absolute difference 21.1 to 15.9; plain ground alone is 7.7, the camera fit's offset). The camera fit
  moves a real map's picture by about 30 px at 1300 away (AutumnLeaves), so only shapes can be told there.
  (3) *Classic conversions* (`openpoints/example-maps/14c_GraphicsModes_Classic_and_HD.w3x`, SD, look 0,1800,3600): the
  editor draws all eight Studio-converted models (Iron Gate, Capital Tower, Palace Walls, Pillars, Wall Endcap) with
  the same shapes and textures as Studio, so the game's not drawing them (user.md 14c) isn't the model data the
  editor reads; the tower is 11 darker in mean colour in Studio (lighting; a native Classic model was not compared).
  (4) *Map 16's outer columns* (`16_Particles_Doodads.w3x`, HD, looks -2000,1600 and 2000,1600 at 3000, -2000,2400
  at 900): ShimmeringPortal's disc has the editor's hue (r:g:b 0.83:0.57:1 against 0.87:0.62:1) and is 12 darker; its
  rim is pinker in Studio (b/r 1.13 against the editor's 1.37, bluish white); the centre glow is a moving shape in
  both (magenta flower in the editor, a white slit in Studio at that moment). The Ruin Fountain is 125 px across in
  the editor and 80 in Studio at the same camera (the other doodads' sizes and places match): not looked into. Rising
  Water is more opaque and bluer in the editor.
  (5) *Camera bounds line* (`camera-bounds.w3m`, SD unlit, look 2816,0,1500 and 2816,2816,1500): the editor draws a
  one-pixel line of exactly (128, 128, 255) at the bound, Studio's was (150, 200, 255) drawn over two pixels at half
  strength: the colour is now the editor's (`CAMERA_BOUNDS_RGB`); the line is still antialiased over two pixels.
  The line is on by default in Studio's terrain view and off in the editor's.

- **Picture parity 4** (branch we-look-4, 2026-11-17; we-drive and app-drive as in the bullet above, inputs
  `make-specials-look.mjs`, `make-geoset-color.mjs`, `openpoints/example-maps/16_Particles_Doodads.w3x`):
  (1) *Camera bounds line*: now one pixel wide, every pixel exactly (128, 128, 255): `crispline.ts` steps the projected line
  pixel by pixel (Bresenham) and the renderer draws each pixel as a GL point of size 1 at its centre (the canvas is
  multisampled, a GL line came out over two pixels at half strength); camera-bounds.w3m, SD unlit, `--camera we:2816,0,1500`:
  844 pixels of exactly that colour in one column; at rotation 60 a one-pixel staircase of 1050. The editor's picture
  has no line (off by default there); Studio keeps it on by default (a UX choice, nothing in the editor's view mode needs it).
  (2) *Export Minimap in HD*: the editor draws the grey 183 dot for a doodad whose model is stored only below `_DE.w3mod`
  (EOcr, LCpa, LRsr, UO*, YO*); Studio's minimap reads the game without that layer (`minimapgen.ts` `withoutDeLayer`, the
  map's own import of the file still counts; the model view keeps the fallback). `mmsave-dots-models-hd` (new, same map as
  the SD spec) MATCH, `-sd` still MATCH. *A material never seen* (branch we-compare-3, 2026-11-18, HD Export Minimap of
  flat.w3x with five ASpr): the HD pier's three materials are its diffuse, a glow (alpha track) and the diffuse again at
  static alpha 0 (the walk plane); the editor's dot core is about 182, 152, 95, the mean of the first two (179.5, 149.5,
  94.5), not of all three (154, 125, 82). `minimapgen.ts` `shownTextureMean` leaves out a material whose first layer has
  alpha 0 and no alpha track; on minimap-dots-models only ASpr's dot changes (and USba's by 5, whose editor dot is the
  grey 183 one while Studio's is 104, 94, 108: not looked into).
  (3) *Geoset animation colours*: AzsharaStatue's geoset 2 (RedRock texture) holds only the static colour (0.31, 0.78, 0.86) and
  the editor draws it **gold**: the static colour is stored blue, green, red like the colour track's keys (Studio read it red,
  green, blue, grey stone); `renderer.ts` turns both now (`modeldraw.test.ts`; the statue is gold in Studio's picture).
  (Corrected by Picture parity 5: only the keys are turned; the gold is the statue's texture, its static-coloured pedestal is teal.)
  This makes ShimmeringPortal's static glow colour (0.467, 0, 0.992) pink-red where it was violet, and the portal rim of map 16
  was already pinker than the editor's: the rim's cause is not the static colour (the glow's alpha track, key times 3333
  and 10333, lies outside its Stand 14967-15300).
  **Left, with what was found**: (a) AzsharaStatue's pedestal is a teal hex column in the editor and a red-brown pyramid in Studio,
  and ShroomsBlue is the 27-vertex cap (geoset 1) alone in the editor where Studio draws the 110-vertex mushroom (geoset 0)
  and hides geoset 1. Both models' geoset alpha / colour tracks have **no key inside the Stand interval except one at its
  first frame** (Azshara Stand 167-1167: g1 alpha keys 167 = 0, 1333 = 1, g0 colour 167, 1333, 2667 with the last (0.53, 0.6,
  0.38); Shrooms stand 167-1167: g0 alpha keys 1833 = 1, 3233 = 0, g1 167 = 0, 1300 = 0, 2000 = 1, 6667 = 1). What the editor
  draws is each track's **last key** (g1 shown, g0 hidden, the teal from Azshara's last colour key turned blue, green, red),
  not the key at Stand's start that Studio takes. Not changed: as a general rule ("a track with no key after the sequence's
  first frame holds its last key") it would also reach every model whose Stand begins on a key, and no second model was measured.
  (b) Specials on flat ground: with replaceable 11 left unresolved on those (path empty: texture null, drawn white) the cave
  and collapse walls turned white too, where the editor keeps their rock texture and only the flat quad at the footprint's
  edge is white (SD) or blue (HD): the quad is not "texture 11 missing", so it was not changed (a tile of cliff texture 15 still
  takes the first type); the HD cave interior is black in the editor's pictures where Studio shows its ground through the
  hollow (HD CityCliffDoodadCave1: geoset 0 the cliff placeholders, opaque; geoset 1 the diffuse with blend, 285 triangles each,
  the diffuse 2048 x 2048 with 20 % of its pixels alpha 0 and a mean colour of 40, 33, 27): not settled.
  (c) Map 16 (HD, `--look` at 700): the editor's picture is about 1.4 times larger than Studio's at the same x, y, distance for
  everything (grass blades, the fountain 520 px against 360 px across; at 3000 it was 125 against 80 for the fountain alone),
  so the camera fit at short range is what differs, not the Ruins Fountain's scale (ZOfo, scale 1). Rising Water (IZrw,
  `RisingWaterDoodad.mdx`: one blend layer with the 24 `ReplaceableTextures\Water\WaterNN` frames, alpha track key 3567 = 1
  inside its Stand 3500-8500) is bluer and more opaque in the editor than Studio's green, light water; not looked into further.

- **Picture parity 5** (branch we-specials-5, 2026-11-18; we-drive `--compare-ready` / `--compare-ready-unlit` against
  app-drive `--compare-ready game|unlit` and `--camera we:`, pic-compare; test models made with lib/model/classic.ts
  `toClassicMdx` or by rewriting an MDX's texture entries, imported into copies of flat.w3x / specials-look.w3x under the
  game model's path, which the editor draws in SD and HD alike):
  (1) *Specials on flat ground*: the white (SD) / blue (HD) quads are **holes in the ground**, not the model. The YCc3 model
  with layer 0's texture made solid red and YCc2's layer 1 solid blue: every model triangle took the colour, the quads stayed
  white or black; a low side view shows them flat on the ground, white as the SD game view's background above the horizon.
  The editor leaves every tile of a special's footprint without ground, flat tiles too (cliffs.ts `planCliffs` hiddenTiles);
  where the model doesn't cover its tiles one sees what is behind the ground (SD game view white, without game view black;
  HD (42, 69, 82) under a skybox, Studio black). The black inside of HD caves is the same hole. specials-look, SD game view,
  `192,-1600,900`, region 330,400,240,140: mean absolute difference 97.7 to 0.1 (HD 52 to 54: the hole's colour); the plateau
  view and AutumnLeaves' LCc0 (HD) show the same shapes. In HD the cave's placeholder geoset (material 0) with its diffuse
  made red showed no red at all: the editor seems not to draw it (not followed up).
  (2) *Geoset colours*: copies of one mushroom (SD and HD): a colour track's key (1, 0, 0) is blue, (0, 0, 1) red; a static
  colour (1, 0, 0) red, a static (0, 0, 1) under a key (0, 1, 0) green: only keys are blue, green, red (renderer.ts;
  modeldraw.test.ts). AzsharaStatue's pedestal (static (0.31, 0.78, 0.86)) is teal, the statue gold by its texture.
  ShimmeringPortal's rim (static (0.47, 0, 0.99)) is violet again: map 16 `-2000,1600,3000`, region 500,0,180,110 mean
  difference (17, -4, -23) to (-7, -4, 2).
  (3) *Geoset tracks without a key in Stand*: not reproduced. ShroomsBlue's own two alpha tracks on copies of its mushroom,
  and tracks with keys only before, after or at the start of Stand (all sequences NonLooping, and Stand looping): the editor
  (SD) shows and hides exactly as Studio (static alpha where Stand has no key, a key at Stand's start held); the real
  ShroomsBlue shows its mushroom in both. Earlier pictures of the cap alone were not SD's.
  (4) *Rising Water* (HD model: one blend layer, alpha 0.5, ORM roughness 33, metallic 0, EnvironmentMap slot): with the
  layer's alpha set to 1 in a copy the editor's water is much more opaque, so the alpha is used; on a dirt map red and green
  match Studio's within 5 and the editor's blue is 31-43 higher, the same at the top and bottom of the view (not a Fresnel
  term): the HD material shading (environment light) Studio's model shader doesn't have, not this model's data.
  The Ruins Fountain (ZOfo) has `defScale:hd=1.45` in DoodadSkins.txt (125 against 80 px at 3000 in (c) above): not tested.
