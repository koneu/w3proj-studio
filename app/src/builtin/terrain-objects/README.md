# Object Placer

Extension `w3.terrainObjects`. Object Placer of the terrain editor: units, items, doodads and destructables, single or scattered, optionally respecting pathing.

## Data
Reads and writes placed objects in map/war3mapUnits.doo.json and map/war3map.doo.json; reads map/war3map.w3i.json. Settings control placement defaults.

## Contributes
- Commands (1): w3.terrainObjects.toggleAutoCycleRandomGroups
- MCP tools (1): list_placed
- Settings (6): terrain.placement.respectPathing, terrain.placement.randomVariation, terrain.placement.randomRotation, terrain.placement.randomScale, terrain.placement.autoCycleRandomGroups, terrain.placement.scatterDensity
- Needs: w3.terrainViewer, w3.objectEditor

Full list: `extension.json` in this folder.
