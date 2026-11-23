# Map Properties

Extension `w3.mapInfo`. Map Properties: description, loading screen, prologue, options, environment, players, forces, techtree, random groups, item tables; also string export/import.

## Data
Reads and writes map/war3map.w3i.json and the string table map/war3map.wts; reads objects (map/war3map.w3u.json) and placed units (map/war3mapUnits.doo.json) for item tables and checks. Exports strings to a text file chosen on disk.

## Contributes
- Commands (6): w3.strings.export, w3.strings.import, w3.strings.moveToTable, w3.mapInfo.open, w3.mapInfo.itemTables, w3.mapInfo.createItemTable
- Views (1): w3.scenario.sections
- Editors (1): w3.mapInfo
- MCP tools (3): set_map_text, set_sky, map_info
- Services (1): w3.mapInfo
- Needs: w3.objectEditor

Full list: `extension.json` in this folder.
