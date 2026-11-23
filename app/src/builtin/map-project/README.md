# Map Project

Extension `w3.mapProject`. Imports, syncs and packs .w3x maps into projects; round-trips with the game.

## Data
Reads a .w3x/.w3m or folder and unpacks it into the project (map/...); packs the project into a map file (build/ or the game's maps folder) and starts the test run. Settings control the test run.

## Contributes
- Commands (12): w3.project.open, w3.project.importMap, w3.project.importMapFolder, w3.project.syncFromMap, w3.project.pack, w3.project.packToGame, w3.project.packAs, w3.project.openInWorldEditor, and 4 more
- Settings (7): testMap.difficulty, testMap.profile, testMap.windowMode, testMap.assetMode, testMap.teenData, testMap.fixedSeed, and 1 more

Full list: `extension.json` in this folder.
