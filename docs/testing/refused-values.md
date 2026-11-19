# Refused values: the terrain viewer and its AI tools

Part of the [testing guide](../../TESTING.md); index in [README](README.md).

Decision 2026-11-15: a value past what its stored field holds is refused with a message and the map left as it was, never
wrapped, clamped without a word, truncated or overflowed. "Measured, kept": the World Editor does that too and a
we-compare spec or we-drive record relies on it, so Studio does it as well (the user decides those, see the last rows).
Tests: `values.test.ts`, `aitools.test.ts`, `lib/terrain/w3e.test.ts`, `unitprops.test.ts`, `lib/terrain/cameras.test.ts`,
`lib/terrain/regions.test.ts`, Rust `camera_and_region_values_past_their_fields_are_refused` and
`refused_camera_and_region_values_leave_the_files_unchanged`, `map_properties_numbers_past_their_fields_are_refused`,
app-smoke `mcpLimits`; the Map Properties, Map Size and trigger rows: `numbers.test.ts`, `techtree.test.ts`,
`atmosphere.test.ts`, `resize.test.ts`, `literals.test.ts`, `triggerinfo.test.ts`, `wtg.test.ts`.

| Field | Bound | Checked in | Behaviour |
|---|---|---|---|
| w3e corner fields on save | height word -32768..32767, water word 0..0xffff, texture 0..15 (v11) / 63 (v12), variation 0..31, cliff variation 0..7, cliff texture and layer 0..15, whole numbers; tile ids 4 characters | `w3e.ts` `w3eWriteProblem` (writeW3e) | refused: the save fails, nothing cut to its bits |
| water level (14 bits) | 0..0x3fff, whole | `w3e.ts` `setWaterLevel` | refused (was `& 0x3fff`, a wrap); callers pass levels already in range |
| water from brushes and `set_water` | 0..0x3fff | `limits.ts` `waterLimitHits`, `toollimits.ts` | Enforce Water Height Limits on: refused, "Not done: the water at N corners..."; off: cut at the end, the user's choice by the switch |
| ground height from AI tools (`sculpt_terrain`, roughen, `paint_path` flatten, `set_water` ford/lake) | -10240..6143.75 (without cliff level) | `aitools.ts` `refuseGroundPast`, `limits.ts` `groundLimitText` | refused whole: "Not done: the ground at N corners would go past..." |
| ground height from brushes, Reset Height Field Random | the same | `setGroundHeight`, terrain-painter `setRaw` | measured, kept: stops at the end (we-compare height-random-stops); NaN refused |
| cliff level, AI tools | 0..15 | `aitools.ts` `setCliffs`, `setWater` | refused; `set_cliff_level` level/by whole numbers |
| cliff level, Increase brush | 0..15 | terrain-painter `tools.ts` `strokeLayer`, `topRefusal` | refused with a toast: Enforce Terrain Limits on, above 14 (the editor: nothing, silently); off, above 15 (the editor wraps it round: we-compare cliff-slope-wrap, a known difference) |
| Adjust Cliff Levels | whole number; up to cliffShiftRange max | `wholemap.ts` `adjustCliffLevels` | refused: a water word (wet or dry) past its 14 bits (the editor wraps it: cliff-adjust-dry, known differences), a raise past +10 or past level 14 (the editor cuts it); measured, kept: down stops at level 0 |
| ground tiles | 16 slots, a known 4-character tile | `aitools.ts` `groundSlot`, `paint_*` tools | refused |
| ground variation | 0..17 written by Studio (5 bits) | `randomVariation`; text form `w3etext.ts` | only Studio writes it; the text form refuses past 31 |
| map size | 32..480 per side, multiples of 4 | `resize.ts` `resizeProblem`, `coordProblem` | refused, growth past ±32256 too (the editor moves the playable edge instead; map-size-limits asks Studio for the editor's result directly) |
| new map | sizes 32..480 by 32, cliff level 0..14 | `newmap.ts` `mapChoices`, the dialog's lists | refused |
| camera target typed | camera bounds | terrain-cameras `typeValue` | measured, kept: with Enforce Camera Bounds on put on the bound (camera-bounds) |
| camera values typed (all 13 fields of the Cameras tab) | a 32-bit float; an empty field or text is no value; and what the World Editor's Camera Properties would move (`CAMERA_RANGES`: distance 0.5 to 100000, rotation, angle of attack and roll 0 to 360, field of view 5 to 120, Z offset ±4096, near 0 to 9500, far 101 to 100000, far at least 1 above near, DoF Distance 0 to 10000, DoF Scale 0 to 1000, Pos Absolute Z ±4096; recorded in `tests/fixtures/we-specs/camera-region-limits-we.json`, we-drive 2026-11-16 and 2026-11-18) | `cameras.ts` `typedCameraValue` | refused: "Not changed: Distance to the target must be a number from -3.4e38 to 3.4e38" (app-smoke `cameraEditing`) |
| Sound Editor numbers typed | the field's stored type; and what the World Editor's Sound Properties would move (`SOUND_LIMITS`: volume 0 to 127, fade rates 1 to 127 (sounds; music's dialog unmeasured), pitch 0.1 to 2, distances 0 to 100000; recorded in `tests/fixtures/we-specs/sound-limits-we.json`, we-drive 2026-11-18). The editor's dialog has no cone fields: the cone angles keep 0 to 360 | `sound-editor/numbers.ts` | refused with why, the box shows the value kept (app-smoke `soundNumbersRefused`) |
| region edges typed, `add_region` | a 32-bit float, put on the 32 grid first (`regionEdgeOnGrid`); left below right, bottom below top; inside the map (the editor makes no region outside it) | `regions.ts` `typedRegionEdge`, `regionBoxProblem` | refused, the field marked and a toast (app-smoke `atmosphereTools`) |
| new region's number (drawn, `add_region`) | up to 2^32-1 | `regions.ts` `nextRegionIndex` | refused, not wrapped to 0 |
| any f32 field of a codec-backed file on write (w3c, w3r, doo, w3i, …) | the f32 range | format engine `write_prim` | refused: the save or canonicalize fails, nothing written (was stored as infinity); integer fields were already refused past their width |
| object position typed (Selection panel, Edit all x/y), `move_object` | inside the map's corners; a 32-bit float | `values.ts` `placedValueProblem` | refused: "Not changed: x ... is off the map"; `place_objects` skips one off the map with that reason, also with ignoreRoom |
| object nudge and drag | the object's limit | `limits.ts` `scaledNudge`, `moveedit.ts` | measured: a nudge step past it is refused (edge-last-step), a drag stops at the last motion that fits (we-drive, see "edge" above), kept |
| z, facing | finite 32-bit float | `placedValueProblem` | refused; any finite facing is stored as given (a turn more is the same facing) |
| scale | 0 and up, finite | `placedValueProblem` | refused below 0; measured, kept: with Fix Doodads on Load a doodad's scale is held to its type's range, 0 a random size in it (`doodadrules.ts` savedScale) |
| variation of a placed object | 0..numVar-1, whole | `placedValueProblem`, `aitools.ts` `dress` | refused (was clamped in `place_objects` and Edit all) |
| owner | player 1..28 | `placedValueProblem`, `place_objects` | refused (was clamped in Edit all) |
| hit points %, mana, gold, acquisition, hero level, attributes, skills, slots, colour, life, skin, item ids, drop chance, random level/class/table | `unitprops.ts` limits (hp 1..100, mana 1..1000000, gold 0..1000000, acquire above 0..5000, level 1..max, attributes 1..100000, colour 0..23, life 0..100, chance 0..100 each) | `unitprops.ts` `checkChange` | refused, "Nothing was changed: ..."; a drop set's total past 100 is let through on purpose (shown red) |
| item table, waygate region, random group and position numbers | 0..2^31-1, whole | `unitprops.ts` `storedIndex` | refused, also when the map's lists can't be read |
| `place_objects` unit choices | acquireRange above 0..5000, gold 0..1000000, drop level 0..8 | `aitools.ts` `setUnitChoices` | refused |
| tool settings | `edge` 0..1, `width` above 0, `density` 0.05..1, `limit` 1 up, `jitter` 0 up, `count` 1..30 | `values.ts` `givenNumber` | refused (were held to the nearest end or replaced by the default) |
| Reset Height Field Random | variation 0..20, smoothing 0..8, whole | `wholemap.ts` `randomizeHeightField` | refused |
| Map Properties number fields (loading screen, crest race, game data set/version, camera zoom, fog, terrain fog, water rendering, colour alphas, a player's start x/y) | the field's type in `w3i.json` (i32, u32, u8, f32) | map-info `numbers.ts` `setInfoNumber` (`numbers.test.ts` holds the types against `w3i.json`) | refused with a toast, the box shows the value kept, no undo step (the alphas were clamped to 0..255; app-smoke `typedFieldSave`) |
| upgrade level, random group / item table chance (Map Properties) | level 1..2^32 (stored from 0 in a u32), chance 0..100 | map-info `techtree.ts` `techNumber` | refused, the field marked |
| `set_sky` fogStart, fogEnd, fogDensity, overSky | f32, i32 | `atmosphere.ts` `applySky` | refused with why, no edit (app-smoke `atmosphereTools`) |
| Map Size sides and borders typed | whole numbers, borders 0 up | `resize.ts` `sidesProblem` | refused, the problem shown and Apply off (were rounded and clamped to 0; app-smoke `resizeUndo`) |
| trigger parameter Value (integer, real) | an integer -2^31..2^31-1 in decimal or 0x hex; a real in the f32 range without an exponent (the script takes the text as it is) | `lib/triggers/literals.ts` `literalProblem` | refused in the dialog with why |
| variable initial value (Variables table, `add_trigger_variable`), array size from `add_trigger_variable` | as above (a real is kept with 2 decimals, never with an exponent); size 1..32768 | `literals.ts` `typedInitialValue`, `triggerinfo.ts` `variableArgs` | refused with a toast / error, no edit (app-smoke `typedFieldSave`) |
| any u32/i32 of war3map.wtg written by the app | its width | `wtg.ts` Writer | refused, nothing written (was `>>> 0`, a wrap) |
