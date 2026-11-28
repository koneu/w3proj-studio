# Terrain Viewer

Extension `w3.terrainViewer`. 3D view of the map's terrain: ground textures, heights, water, cliffs, placed doodads and units, shadows, minimap export; hosts the terrain tools of other extensions (service w3.terrain).

## Data
Reads and writes map/war3map.w3e (as .w3e.txt/.json), map/war3mapUnits.doo.json, map/war3map.doo.json, map/war3map.w3i.json, map/war3map.wpm, map/war3map.shd, map/war3map.mmp.json; reads regions (w3r). Many settings under terrain.*.

## Contributes
- Commands (118): w3.terrain.itemDrops, w3.terrain.open, w3.map.new, w3.terrain.exportMinimap, w3.terrain.resetVariations, w3.terrain.resetHeightField, w3.terrain.adjustCliffLevels, w3.terrain.removeUnusedTiles, and 110 more
- Views (1): w3.terrain.overview
- Editors (2): w3.terrainViewer, w3.itemDrops
- MCP tools (34): replace_objects, find_pockets, check_route, fill_rows, reserve_area, release_area, list_reserved_areas, list_ground_tiles, and 26 more
- Services (1): w3.terrain
- Settings (30): terrain.sky, terrain.fog, terrain.grid.default, terrain.gameView, terrain.preserveCopiedHeight, terrain.resetFixedHeights, and 24 more
- Needs: w3.objectEditor

Full list: `extension.json` in this folder.
