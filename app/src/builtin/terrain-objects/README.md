# Object Placer

Extension `w3.terrainObjects`. Object Placer of the terrain editor: units, items, doodads and destructables, single, scattered or packed into forests (the World Editor's multiple placement), optionally respecting pathing.

The toolbar's Recent list takes up one of the last five objects placed again (kept per user). The owner, Scatter and its size, like the random options, are settings and stay as left; Place… opens on the tab, search and filters it was left with. In it doodads and destructables name their tilesets (an Archway per tileset). With `terrain.placement.preview3d` on (off by default) it shows a turning 3D preview of the highlighted object.

## Data
Reads and writes placed objects in map/war3mapUnits.doo.json and map/war3map.doo.json; reads map/war3map.w3i.json. Settings control placement defaults.

## Contributes
- Commands (1): w3.terrainObjects.toggleAutoCycleRandomGroups
- MCP tools (1): list_placed
- Settings (8): terrain.placement.respectPathing, terrain.placement.randomVariation, terrain.placement.randomRotation, terrain.placement.randomScale, terrain.placement.autoCycleRandomGroups, terrain.placement.scatterDensity, terrain.placement.scatterPattern, terrain.placement.forestSize
- Needs: w3.terrainViewer, w3.objectEditor

Full list: `extension.json` in this folder.
