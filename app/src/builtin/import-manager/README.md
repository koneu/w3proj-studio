# Import Manager

Extension `w3.importManager`. The map's imported files: import from disk, change an import's path, export, open, remove, list unregistered files and clean up the list.

A version's graphics mode can be changed ("Move to"): the file moves to that mode's folder and the entry's flags get the bit the World Editor adds (`modeMove`, `lib/imports.ts`).

## Data
Reads and writes map/war3map.imp.json (campaigns: map/war3campaign.imp.json) and the imported files in the project folder; reads files from disk to import and writes exports to disk.

## Contributes
- Commands (6): w3.imports.open, w3.imports.replace, w3.imports.addVersion, w3.imports.addDeVersion, w3.imports.cleanUp, w3.imports.add
- Editors (1): w3.importManager

Full list: `extension.json` in this folder.
