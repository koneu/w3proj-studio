# Cameras and views

Camera bounds, the default camera, camera objects, zoom and the View menu. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

- **Enforce Camera Bounds** (Advanced menu, Ctrl+Shift+B: `--click 260,41`, `--click 310,411`; branch camera-bounds-we,
  2026-11-14, SD, `tests/fixtures/we-compare/camera-bounds.w3m`: the empty 64x64 map, camera bounds x ±2816, y -3328..2816,
  playable part to 3328, map to 4096; scripts, pictures and saves in `target/evidence/camera-bounds-we/` of that
  worktree). The switch is about camera objects only: with it on, the camera palette's Create Camera and Set Camera To
  Current View refuse a view whose target is outside the camera bounds with an "Error" box, "The current camera position
  is outside of the world camera bounds." (refused at 3000, 0; 2820, 0; 4096, 0; 0, 2900 with the eye inside; made at
  2816, 0; 2700, 0; 0, -3000 with the eye south of the map); off, all are made (specs `camera-bounds-create`,
  `camera-bounds-create-off`). Camera Properties puts a Target X typed past the bound on it without a word (3100 became
  2816; off it stayed 3100: spec `camera-bounds-typed`), and a camera dragged by its model (View > Camera Objects on, a
  click on bare ground first) from 2700 to 3117.1 with the switch off stopped at 2805.0 with it on, the last step short
  of the bound (2784.3 in a quicker drag: no spec, the steps the editor sees vary).
  Everything else is the same on and off: a paste past the bounds is placed (a footman at
  3070.8, 0, an LPcr at 3072.2, -510.5; spec `camera-bounds-paste`), objects already past them stay through a save, a
  unit pasted or nudged past the playable part is refused either way (footman stays at 3296), and the view: the arrow
  keys stop with the camera target on the map's edge (4096.0 right, 4096.0 up; after V for game view too, its state not read back), a right-button drag
  pans past the bounds (the middle button pans nothing), and a minimap click, View Entire Map and 20 wheel notches out
  give the same pictures (mean difference at most 0.06). Unit and Doodad Properties have no X or Y to type. The camera
  palette (`--key m`): Create Camera 1476,80, Create Free Camera 1476,100, View Selected Camera 1476,119, Set Camera To
  Current View 1476,139, rows from 1396,177 (13 px each); a button wants a click on the palette first (a row), and the
  arrow keys want the pointer over the view (`--move`). The status bar's Point reads the ground under the pointer; with
  the opening camera's angles at distance 3000 the pointer at 748,404 is the camera target, 300,404 is 1153.1 west of
  it, 748,750 is 927.8 south (how the target was read where the bar is empty off the map). Camera Properties (a row,
  Return) has Target X at 709,328 and OK at 684,727 of the display. A run that closed the editor with a module window
  open (the Sound Editor) leaves it over the next run's view in the shared farm; `--wait-ready` closes it (below, "A module window the editor reopens"). Studio: lib/terrain/cameras.ts `viewInCameraBounds`, `targetInCameraBounds`, wheelzoom.ts `heldPan`;
  app-smoke heightsLimits.

- **Projection for clicks**: with `--look X,Y,D` (angle 304, fov 70, rotation 90) a ground point maps to the display
  through TESTING's Studio-equivalent camera (target y - 0.0993 D, distance 0.9127 D, pitch 57.2, vertical fov 41.06,
  the view at 156,79): the status bar read (3713.9, 515.4) where (3712, 512) was aimed (`proj.py` in that folder).

- **The default camera when a map opens** is deterministic: the camera object with target = the terrain's centre
  (`offset + (corners - 1) * 64`), distance 3000, angle of attack 304, field of view 70, rotation 90 gives the same
  picture (mean difference under 1/255). It doesn't depend on the start locations, the camera bounds or the map size
  (eight test maps). In Studio's terms, at the view's 1184:844, fitted from a 256 grid of marked ground corners
  (0.5 px rms): `node scripts/app-drive.mjs … --terrain --camera "x=CX,y=CY-298,distance=2738,pitch=57.2,yaw=-90,fov=41.06"`
  (CX, CY the map's centre); Studio's picture with that camera fits back to the same numbers. For another camera of
  angle 304 and field of view 70 the numbers scale with its distance d (target `y - 0.0993 d`, distance `0.9127 d`).
  The editor puts the target above the middle of the view (an off-centre projection, at 0.385 of the height), which
  a centred camera matches only at this aspect.

- **A new camera's clipping** (branch camera-farz-we, 2026-11-15, SD; specs `tests/we-compare/camera-farz.json`, input
  `camera-farz.w3m`: eight cameras at 0, 0 from 500 to 5000, every second with far 9000 / near 50): Create Camera, Create
  Free Camera and Set Camera To Current View give the camera the view's far and near clipping, never one from the
  distance. The view has far 50000, near 16 when a map opens (the empty map and 4v4_MountHyjal); View Selected Camera
  gives it that camera's, which stay through wheel zoom (x1.1 a notch) and arrow-key panning. Studio:
  lib/terrain/cameras.ts `ViewClipping`, set by the Cameras tab's View button.

- **Applying a camera object**: `--key m` (camera layer), `--click 1396,177` (the first camera in the palette's list,
  13 px per row), `--click 1476,119` (View Selected Camera). Three runs gave the same picture. `--look` does this:
  its cameras go into we-drive's copy of the map before the start (unpacked with the release CLI, war3map.w3c.json,
  packed again), one row each, then two parking cameras at the terrain's corners; after View Selected Camera the
  parking camera farther away is selected, which takes the selected camera's green circle out of the picture
  without moving the view. `--look center` on cliff.w3m (SD) gives the opening picture exactly (difference 0).

- **The Camera Objects layer** (`--view "Camera Objects=on"`, Ctrl+M; branch camera-layer, 2026-11-13, a copy of
  cliff.w3m with flat cameras of distance 500, 1000 and 2000, and 12b_RoC_Orc04Interlude's 28): one blue model per
  camera, a small movie camera with an arrow whose tip is the target, pointing along the camera's view and scaled by
  its distance (the camera's back 0.365 of it from the target; world-sized, so it grows as the view comes closer). No
  footprint or field of view on the ground. Lit by the map's light (blue under 12b's, light cyan on cliff.w3m's day).
  Studio's lib/terrain/cameras.ts `cameraMarkers` lines up within 2 px at the opening view. The colour (branch
  camera-tab-markers) fits one colour lit by the units' light as the lighting model gives it, without HD's response
  to it (renderer `setShapes`); with that response no one colour fits both maps. The camera layer (`m`) shows no
  models by itself (View > Camera Objects does), but a selected camera (its palette row) gets a pure green circle
  round its target on the ground (following hills), radius 0.096 of its distance; on cliff.w3m's bright grass it is
  hard to see by eye (find it by difference).

- **Wheel zoom** (branch wheel-zoom-pivot, 2026-11-13, cliff.w3m, SD): each notch changes the camera distance by 1.1
  and keeps the camera target fixed, the eye sliding along the ray to it, wherever the pointer is: three notches in
  with the pointer at the view's middle, top left and bottom right all expand about (593, 325.5) of the 1184x844
  view, the target's place in the off-centre projection (focus of expansion of matched patches, residual 1.5 px).
  Studio zooms about the same point (wheelzoom.ts `zoomStep`).

- **Keyboard zoom and the zoom's row** (branch key-zoom, 2026-11-13, cliff.w3m, SD; numbers and the patch matcher in
  `target/evidence/key-zoom/` of that worktree): Ctrl+Up and Ctrl+Down are a wheel notch exactly (Ctrl+Up then a notch
  out gives the opening picture back to the pixel, a notch in after Ctrl+Up's undo the Ctrl+Up picture), wherever the
  pointer is. Held, they step once per key repeat (400 ms: one step; 1500 ms: 22, the display's repeat starting after
  660 ms at 25 a second). Page Up and Down, the number pad's + and -, and Ctrl+Page Up don't zoom. `--screen` gave
  other view sizes (moving the window by X doesn't: the editor doesn't lay it out again): the zoom keeps the middle
  column's point at row 325.0 of an 844 high view, 222.6 of 592, 220.2 of 585 and 211.7 of 565, whatever the width:
  0.4057 h - 17.4 (within 0.3 px), not a share of the height (325.5 / 844 misses the small views by 6). Studio uses
  that row for wheel and keys (wheelzoom.ts `zoomPivotRow`).

- **The View menu** (`--view-menu`): Foliage, Doodads, Units, Water, Blight, Shadows, Lighting (L), Weather and
  Info Display are checked by default; Sky, Fog Effects, Light Ranges, Bloom, Ambient Occlusion, Grid, Camera Bounds,
  pathing, Regions and Camera Objects aren't. With game view on, these items are greyed and read as unchecked.
  G goes round the grids: none, large (yellow every 512), medium (white tiles, yellow every 4), small, none; the
  Grid item reads unchecked whatever is shown. B draws a thin light-blue line on the ground at the camera bounds
  (HillsbradCreek's west edge, mostly hidden behind trees). `--move` to the view's edge didn't scroll it in this
  display (checked 2026-11-10, SD).
