# Checkpoints

Extension `w3.checkpoints`. Packs the project into build/checkpoints now and then, so a slip costs minutes at most; a checkpoint can be restored.

## Data
Reads the whole project when packing; writes packed maps under build/checkpoints (recovered ones to recovered/). Restoring replaces project files from the pack. Settings control the interval, count and size.

## Contributes
- Commands (3): w3.checkpoints.create, w3.checkpoints.restore, w3.checkpoints.newest
- MCP tools (3): list_checkpoints, create_checkpoint, restore_checkpoint
- Settings (4): checkpoints.enabled, checkpoints.intervalMinutes, checkpoints.keep, checkpoints.maxMegabytes
- Needs: w3.mapProject

Full list: `extension.json` in this folder.
