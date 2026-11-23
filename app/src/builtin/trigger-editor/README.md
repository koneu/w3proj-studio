# Trigger Editor

Extension `w3.triggerEditor`. GUI triggers and custom script: the tree of categories, triggers and variables, names, flags, comments, undo and saving; trigger contents come from other extensions (service w3.triggers).

## Data
Reads and writes map/triggers/<category>/<name>.gui.json and .j files (map/triggers/triggers.json); can export and import a raw war3map.wtg/.wct; reads map/war3map.w3i.json and map/war3map.wts.

## Contributes
- Commands (18): w3.triggers.export, w3.triggers.import, w3.triggers.reset, w3.triggers.adjustStringIds, w3.triggers.open, w3.triggers.variables, w3.triggers.convertToCustomText, w3.triggers.copyAsText, and 10 more
- Views (1): w3.triggers.overview
- Editors (1): w3.triggerEditor
- MCP tools (9): add_trigger_variable, remove_trigger_variable, set_script_header, remove_trigger, set_trigger_enabled, set_trigger_script, create_script_trigger, list_triggers, and 1 more
- Services (1): w3.triggers

Full list: `extension.json` in this folder.
