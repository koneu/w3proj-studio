# JSON Schemas of the unpacked map files

Hand-written [JSON Schemas](https://json-schema.org/) (draft 2020-12) for the JSON files an unpacked project keeps
for the ten formats that have a format definition (`crates/w3proj/formats/`, see the README there). They are
written from our codecs only: each one says what its definition reads and writes.

| Schema | Project file | `format` tag |
|---|---|---|
| `w3i.schema.json` | `map/war3map.w3i.json` | `w3proj.mapinfo/1` |
| `doodads.schema.json` | `map/war3map.doo.json` | `w3proj.doodads/1` |
| `units.schema.json` | `map/war3mapUnits.doo.json` | `w3proj.units/1` |
| `regions.schema.json` | `map/war3map.w3r.json` | `w3proj.regions/1` |
| `cameras.schema.json` | `map/war3map.w3c.json` | `w3proj.cameras/1` |
| `sounds.schema.json` | `map/war3map.w3s.json` | `w3proj.sounds/1` |
| `imports.schema.json` | `map/war3map.imp.json`, `map/war3campaign.imp.json` | `w3proj.imports/1` |
| `campaign.schema.json` | `map/war3campaign.w3f.json` | `w3proj.campaign/1` |
| `minimap.schema.json` | `map/war3map.mmp.json` | `w3proj.minimap/1` |
| `lights.schema.json` | `map/war3map.w3l.json` | `w3proj.lights/1` |

A campaign's chapter maps have the same files under `maps/<chapter>/map/`.

## What they say, and what not

- **Fields, types and required keys** are the definition's. A field with an `if` in the definition is required
  under the same condition (`if`/`then` on `version`, `subversion`, `randomType`, a variant). A field with a
  `default`, an older name (`was`) or a variant may be left out, as the codec fills it in.
- **Unknown keys are allowed** (no `additionalProperties: false`). The codec ignores keys its definition doesn't
  know instead of refusing them; older JSON keeps values under older names (cameras' `unknown` before
  `dofDistance`, `dofScale`, `posAbsoluteZ`). Such keys don't reach the packed map, and the app drops them when it
  saves the file again (it writes the codec's own form).
- **Value forms**: integers in the range of their byte width; a float as a number within the 32-bit range, or
  `"f32:0x"` and 8 hex digits (how NaN and infinities keep their bits); an id as four printable ASCII characters or
  `"0x"` and 8 hex digits (the codec also takes any other 4-byte string, but writes only these forms); strings
  without the zero character.
- **Not expressible here, checked by the codec**: an integer written with a decimal point (`5.0`; JSON Schema calls
  it an integer, the codec refuses it), list lengths tied to another list (w3i's `unitTables[].lines[].ids` has one
  id per entry of `positions`), and the definition's plausibility `check`s (they only choose between readings).
- **Not covered**: the split terrain's per-subterrain `doodads.json`, `units.json`, `regions.json` (same tags,
  another shape), object data (`w3proj.objects/1`), triggers, terrain and the other code-defined formats.

## Using them in VS Code

VS Code validates a JSON file and completes its keys once a schema is mapped to it. Put the mapping into the
project's `.vscode/settings.json` (paths are relative to the workspace folder; for a project outside this
repository give each `url` as an absolute path or a `file:///` URL to this folder):

```json
{
  "json.schemas": [
    { "fileMatch": ["**/map/war3map.w3i.json"], "url": "./docs/schemas/w3i.schema.json" },
    { "fileMatch": ["**/map/war3map.doo.json"], "url": "./docs/schemas/doodads.schema.json" },
    { "fileMatch": ["**/map/war3mapUnits.doo.json"], "url": "./docs/schemas/units.schema.json" },
    { "fileMatch": ["**/map/war3map.w3r.json"], "url": "./docs/schemas/regions.schema.json" },
    { "fileMatch": ["**/map/war3map.w3c.json"], "url": "./docs/schemas/cameras.schema.json" },
    { "fileMatch": ["**/map/war3map.w3s.json"], "url": "./docs/schemas/sounds.schema.json" },
    { "fileMatch": ["**/map/war3map.imp.json", "**/map/war3campaign.imp.json"], "url": "./docs/schemas/imports.schema.json" },
    { "fileMatch": ["**/map/war3campaign.w3f.json"], "url": "./docs/schemas/campaign.schema.json" },
    { "fileMatch": ["**/map/war3map.mmp.json"], "url": "./docs/schemas/minimap.schema.json" },
    { "fileMatch": ["**/map/war3map.w3l.json"], "url": "./docs/schemas/lights.schema.json" }
  ]
}
```

A `"$schema"` key inside one file works too (the codec ignores it), but the app's next save of that file drops it.

## The test that keeps them honest

`app/src/lib/formats/schemas.test.ts` (run with the TypeScript unit tests, so in the gate's commit tier), with
[Ajv](https://ajv.js.org/) (`ajv`, a pinned dev dependency of `app/`; `npm ci` installs it):

- one schema per definition, each a valid draft 2020-12 schema, the shared `$defs` the same in all ten (they are
  copied so each file stands alone for editors);
- each schema has its definition's fields (nothing more but older names), the same primitive types, fixed list
  lengths and always-written keys; a control proves this comparison catches a changed schema;
- the files of the mini-map (`tests/fixtures/mini-map`) and the mini-campaign (`tests/fixtures/mini-campaign`, the
  campaign info) pass, with a file for every schema, and so do samples of what unpack wrote on real maps;
  broken documents (a missing key, a byte past 255, a version the definition refuses, a float past the 32-bit
  range, a version-dependent key left out, …) fail;
- in the corpus tier (`W3PROJ_REQUIRE_CORPUS=1`; skipped in the commit tier), every map and campaign of the corpus
  is unpacked with the release CLI into a temporary folder and every file above passes; every schema must meet at
  least one file there.

A change to a definition makes the comparison fail until the schema follows it.
