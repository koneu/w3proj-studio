# Camera Editor

Extension `w3.terrainCameras`. Camera Editor inside the terrain editor: create from the view (normal or free camera), preview, move, aim and edit cameras. A free camera (war3map.w3c camera type 1) is kept by where it stands (lib/terrain/cameras.ts); View looks through it, where the World Editor's View Selected Camera looks straight down under it.

## Data
Reads and writes map/war3map.w3c.json (cameras); reads map/war3map.w3i.json.

## Contributes
- MCP tools (1): list_cameras
- Needs: w3.terrainViewer

Full list: `extension.json` in this folder.
