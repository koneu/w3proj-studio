# AI Editor

Extension `w3.aiEditor`. Edits AI definitions (.wai files): race and options, workers, heroes and skills, build/harvest/target priorities, attack groups and waves, test configuration.

## Data
Test AI (testrun.ts, lib/ai/testmap.ts) makes a copy of the Test Configuration's melee map with its players and AIs in a temp folder and starts it as Test Map does. Reads and writes .wai files of the project; exports a script, can add the AI to the map's imports (map/war3map.imp.json, map/war3map.imp), imports and exports custom AI data.

## Contributes
- Commands (6): w3.ai.open, w3.ai.new, w3.ai.exportScript, w3.ai.addToMap, w3.ai.importCustomData, w3.ai.exportCustomData
- Views (1): w3.ai.files
- Editors (1): w3.aiEditor
- MCP tools (2): set_ai, get_ai

Full list: `extension.json` in this folder.
