# Map Text Encoding

Extension `w3.textEncoding`. The code page an old map's texts are in (GBK, CP949 or Big5), for the open project: the
editors show texts that aren't UTF-8 readable in it and write edited texts in it. A text nobody edits keeps its bytes;
nothing is converted on open, save or pack (`lib/formats/codepage.ts`).

## Data
Writes the project setting `map.textEncoding` (`.w3proj/settings.json`). Reads no map files itself: the editors (Map
Properties, Object Editor, Trigger Editor, Sound Editor, Campaign Editor, the text editor's string tables and map script, and the
Source Control diff, which only shows) read the choice through
`textCodec` when they open, and this extension opens them again when the choice changes.

## Contributes
- Commands (1): w3.textEncoding.change
- Settings (1): map.textEncoding
- Status bar: the open project's text encoding (click to change it)

Full list: `extension.json` in this folder.
