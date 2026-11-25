# lib/formats

Helpers for text and string-table files (SLK, INI, `war3map.wts`, lossless strings, archive paths). The
binary layouts of the map files are not here: the list of every format, its codecs in Rust and
TypeScript, its project form and its tests is in
[crates/w3proj/formats/README.md](../../../../crates/w3proj/formats/README.md).

String tables (`war3map.wts`, `war3campaign.wts`, the languages' copies) are read with `wts.ts` `readWts` and
written with `writeWts`, not as UTF-8 text: their bytes go through `lossless.ts`, so a table in an old map's code
page shows its strings (what isn't UTF-8 as private-use characters, as in other lossless text) and an edit keeps
every other byte. `readTextFile`/`writeTextFile` do the same for code that handles any text file (the MCP edit log).

`schemas.test.ts` here checks the JSON Schemas of the project's map JSON files
([docs/schemas](../../../../docs/schemas/README.md)) against the format definitions and the codecs' source, the
fixtures and the corpus.
