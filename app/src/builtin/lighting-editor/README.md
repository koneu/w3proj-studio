# Lighting Editor

Extension `w3.lightingEditor`. The map's own day/night lighting: copy the game's terrain or unit lighting into the map, edit intensities, colours over the day and the direction (as a sun angle: direction and height in degrees, sunangle.ts; or the stored rotation), and export the light as .mdx or .mdl (the World Editor's Export Current Values). Editing in the side bar (session.ts) saves each change as it is made and shows it in the terrain view at a chosen time of day (service w3.lightPreview); the tab editor of a lighting model has the same form (form.ts).

## Data
Reads and writes map/war3map.w3l; also touches map/war3map.imp (import list) and map/war3map.w3i (reads the lighting setting).

## Contributes
- Commands (1): w3.lighting.show
- Views (1): w3.lighting.overview
- Editors (1): w3.lightingEditor

Full list: `extension.json` in this folder.
