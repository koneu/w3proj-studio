# Object Editor

Extension `w3.objectEditor`. Table editor for unit, item, ability, buff, doodad, destructable and upgrade data.

## Data
Reads and writes map/war3map.w3u.json, w3t, w3a, w3b, w3d, w3h, w3q (as .json) and the war3mapSkin.* variants; texts go through map/war3map.wts. Exports and imports all objects.

## Contributes
- Commands (6): w3.objects.exportAll, w3.objects.importAll, w3.objectEditor.open, w3.objectEditor.resetAllStandard, w3.objectEditor.objectAction, w3.objectEditor.openInCampaign
- Views (1): w3.objects.kinds
- Editors (1): w3.objectEditor
- MCP tools (5): set_object_fields, create_object, delete_object, list_objects, get_object
- Services (1): w3.objects
- Settings (1): objectEditor.allowNegativeReals

Full list: `extension.json` in this folder.
