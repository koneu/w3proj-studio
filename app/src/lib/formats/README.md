# lib/formats

Helpers for text and string-table files (SLK, INI, `war3map.wts`, lossless strings, archive paths). The
binary layouts of the map files are not here: the list of every format, its codecs in Rust and
TypeScript, its project form and its tests is in
[crates/w3proj/formats/README.md](../../../../crates/w3proj/formats/README.md).

`schemas.test.ts` here checks the JSON Schemas of the project's map JSON files
([docs/schemas](../../../../docs/schemas/README.md)) against the format definitions and the codecs' source, the
fixtures and the corpus.
