# Problems

Extension `w3.problems`. Checks the open project like compiler errors: JASS errors, missing or off-disk files, textures of imported models, unknown placed types, imports without files.

## Data
Reads map/war3map.w3i.json, objects (w3u, w3d, ...), doodads, regions, sounds, imports, triggers (map/triggers/triggers.json) and campaign files; can delete invalid placed objects. Other extensions add checks (service w3.problems).

## Contributes
- Commands (7): w3.problems.run, w3.problems.checkTriggerTree, w3.problems.deleteInvalid, w3.problems.show, w3.problems.toggleIgnored, w3.problems.setMelee, w3.problems.open
- Views (1): w3.problems.list
- MCP tools (1): list_problems
- Services (1): w3.problems

Full list: `extension.json` in this folder.
