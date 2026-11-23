# vJASS (JassHelper)

Extension `w3.vjass`. Compiles vJASS in trigger texts (libraries, scopes, structs, Zinc, //! directives) into the map's JASS by calling the JassHelper that ships with the game; a script language (service w3.scriptLanguages).

## Data
Reads the map script and the game's common.j and Blizzard.j; writes input.j, output.j and logs (logs/currentmapscript.j, logs/compileerrors.txt) in a work folder. Does not copy JassHelper.

## Contributes
- Commands (1): w3.vjass.check
- Editors (1): w3.textEditor
- Settings (4): vjass.jassHelper, vjass.debug, vjass.optimize, vjass.timeout
- Needs: w3.mapScript

Full list: `extension.json` in this folder.
