# Map Script

Extension `w3.mapScript`. Generates the map script (war3map.j, or war3map.lua for Lua maps) from the map's data on save and on command.

## Data
Reads triggers, variables, regions (map/war3map.w3r.json), cameras, sounds (map/war3map.w3s.json), placed units/doodads (map/war3mapUnits.doo.json, map/war3map.doo.json), item tables and players (map/war3map.w3i.json), and objects; writes map/war3map.j or map/war3map.lua.

## Contributes
- Commands (3): w3.script.generate, w3.script.regenerate, w3.script.export
- Editors (1): w3.scriptDiff
- MCP tools (2): build_script, search_script_api
- Services (1): w3.scriptLanguages
- Settings (1): script.generateOnSave

Full list: `extension.json` in this folder.
