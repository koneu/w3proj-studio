# Terrain Painter

Extension `w3.terrainPainter`. Terrain tools (raise, lower, plateau, smooth, textures, cliffs, water, blight, ramps) and the Tileset / Terrain Settings tab.

A cliff or water tool can paint the chosen tile too ("Paint texture too", the World Editor's Apply Texture beside Apply Cliff): each stamp paints, then moves the ground, in one undo step; where the cliff brush can do nothing the tile is painted all the same.

## Data
Reads and writes the terrain (map/war3map.w3e through the terrain viewer's document); tool brushes are described in brush.ts, file.ts.

## Contributes
- Commands (1): w3.terrain.settings
- Editors (1): w3.terrainSettings
- Needs: w3.terrainViewer

Full list: `extension.json` in this folder.
