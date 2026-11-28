# Testing notes

The short guide is [TESTING.md](../../TESTING.md): the layers, how to run the gate, the tools, the process and the rules
for writing tests. This folder holds what was measured: per-branch logs against the real World Editor, the details
behind the tools, and the table of refused values. Numbers here are findings, not instructions; a newer round replaces
an older one only where it says so ("earlier: ...").

| File | What it holds |
|---|---|
| [gate-and-smoke.md](gate-and-smoke.md) | How the gate schedules its steps, the queue between gates, the real-app smoke test's parts, page-call limits, logs, coverage folders, the hostile-input watchdog |
| [refused-values.md](refused-values.md) | The decision on values past their stored field, and the table of every field, bound and test |
| [numeric-limits-measured.md](numeric-limits-measured.md) | What the World Editor keeps for typed numbers in Map Properties (fog, zoom, water), random groups, item tables and the Trigger Editor's limited Value dialogs |
| [editor-tooling.md](editor-tooling.md) | we-drive: setup, sandbox, layout, timings, hygiene, waiting; slots, editor CPU, frame cap and renderer choice |
| [verification-rounds.md](verification-rounds.md) | One build per round (verify-build), we-compare specs, one editor per mode, state between specs |
| [pictures.md](pictures.md) | Comparing the editor's and Studio's pictures: method and the picture-parity measurements |
| [cameras-and-views.md](cameras-and-views.md) | Camera bounds, the default camera, projection for clicks, camera objects, zoom, the View menu |
| [terrain-and-water.md](terrain-and-water.md) | Ramps, cliffs, brushes, map size, water (classic and HD), the border, noise, regions |
| [minimaps.md](minimaps.md) | Export Minimap and the saved minimap |
| [lighting-and-shadows.md](lighting-and-shadows.md) | Time of day, light ranges, Calculate Shadows, HD shadows, the game view's light |
| [doodads-and-units.md](doodads-and-units.md) | Dragging, picking, pasting, rules on load, fences and footprints, camps, unit properties |
| [saved-data-rules.md](saved-data-rules.md) | What w3i, w3e, wpm, doo, wts and the object files store, map preferences, saving |
| [object-text-strings.md](object-text-strings.md) | Which object texts the World Editor's save turns into war3map.wts strings, how it numbers and reuses them, the corpus count, and why Studio keeps them literal |
| [editors-and-ui.md](editors-and-ui.md) | Trigger, Object, Sound and AI editors against the World Editor |
| [branch-rounds.md](branch-rounds.md) | Rounds that measured several unrelated things (we-compare-N, we-misc-N), kept whole |
