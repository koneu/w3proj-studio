# Subterrains

Extension `w3.terrainLayout`. Splits the terrain and placed objects into subterrains (one folder per rectangle under map/terrain/) so several people can edit a large map and merge in git; merges them back.

## Data
Reads and writes map/terrain/ (terrain.json per subterrain) and the single files war3map.w3e, war3mapUnits.doo, war3map.doo, war3map.w3r; offers a git merge hook.

## Contributes
- Commands (14): w3.terrainLayout.split, w3.terrainLayout.merge, w3.terrainLayout.installMergeHook, w3.terrainLayout.removeMergeHook, w3.terrainLayout.checkIds, w3.terrainLayout.fixIds, w3.terrainLayout.checkSeams, w3.terrainLayout.openSubterrains, and 6 more
- Views (1): w3.terrainLayout.subterrains
- Editors (1): w3.terrainLayout.editor
- MCP tools (4): check_terrain_seams, change_subterrains, get_subterrains, fix_creation_ids

Full list: `extension.json` in this folder.
