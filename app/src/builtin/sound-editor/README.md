# Sound Editor

Extension `w3.soundEditor`. The map's sounds and music: browse and play game and imported sounds, add them, edit effect, channel, volume, pitch, distances and cones.

## Data
Reads and writes map/war3map.w3s (as .json); reads the game's sound table, map/war3map.imp.json, the script (map/war3map.j or .lua) to find usages, and the string table.

## Contributes
- Commands (14): w3.sounds.open, w3.sounds.export, w3.sounds.replace, w3.sounds.findUsages, w3.sounds.removeUnused, w3.sounds.moveUp, w3.sounds.moveDown, w3.sounds.sort, and 6 more
- Editors (1): w3.soundEditor
- Services (1): w3.sounds

Full list: `extension.json` in this folder.
