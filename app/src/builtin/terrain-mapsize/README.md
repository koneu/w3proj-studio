# Map Size and Camera Bounds

Extension `w3.terrainMapSize`. Map Size and Camera Bounds in a tab of its own: grow or shrink per side and set the unplayable border, with a preview.

## Data
Reads and writes map/war3map.w3i.json (size, camera bounds) and the terrain, with the objects placed on it (units, doodads, regions).

## Contributes
- Commands (3): w3.terrainMapSize.edit, w3.terrainMapSize.undo, w3.terrainMapSize.redo
- Editors (1): w3.terrainMapSize
- Needs: w3.terrainViewer

Full list: `extension.json` in this folder.
