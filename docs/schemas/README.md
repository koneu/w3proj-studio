# JSON Schemas of the unpacked map files

Hand-written [JSON Schemas](https://json-schema.org/) (draft 2020-12) for the JSON files an unpacked project keeps:
the ten formats that have a format definition (`crates/w3proj/formats/`, see the README there), and the object data,
split terrain, pathing overrides and trigger folders, which are defined in code. They are written from our codecs
only: each one says what its definition or codec reads and writes.

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

The formats defined in code (no definition; each schema says what its codec in `crates/w3proj/src` reads):

| Schema | Project file | Codec |
|---|---|---|
| `objects.schema.json` | `map/*.w3u.json`, `.w3t`, `.w3b`, `.w3d`, `.w3a`, `.w3h`, `.w3q` (also `war3mapSkin.*`, `war3campaign.*`) | `objdata.rs`, tag `w3proj.objects/1` |
| `terrain.schema.json` | `map/terrain/terrain.json` | `terrain_layout.rs`, tag `w3proj.terrain/1` |
| `terrain-doodads.schema.json` | `map/terrain/<folder>/doodads.json` | `terrain_objects.rs` |
| `terrain-units.schema.json` | `map/terrain/<folder>/units.json` | `terrain_objects.rs` |
| `terrain-regions.schema.json` | `map/terrain/<folder>/regions.json` | `terrain_objects.rs` |
| `pathing.schema.json` | `.w3proj/pathing.json` | app `lib/terrain/resize.ts`, `terrain_pathing.rs`, tag `w3proj.pathing/1` |
| `triggers.schema.json` | `map/triggers/triggers.json` | `trigger_layout.rs`, tag `w3proj.triggers/1` |
| `trigger-category.schema.json` | `map/triggers/**/_category.json` | `trigger_layout.rs` |
| `trigger-gui.schema.json` | `map/triggers/**/*.gui.json` | `trigger_layout.rs`, ECAs `wtg.rs` |
| `trigger-comment.schema.json` | `map/triggers/**/*.comment.json` | `trigger_layout.rs` |
| `trigger-variable.schema.json` | one line of `map/triggers/**/variables.json` | `trigger_layout.rs` |
| `trigger-frontmatter.schema.json` | the JSON on the first line (`// @w3proj {…}`, `-- @w3proj {…}`) of `map/triggers/**/*.j`, `.vjass`, `.lua` | `trigger_layout.rs` |

The split terrain's files are described in `docs/terrain-subterrains-spec.md`, the trigger folders in
`docs/trigger-folders-spec.md`. The three per-subterrain object files refer to the flat files' schemas for their
entries (`doodads.schema.json#/properties/doodads/items`, …), and the comment and frontmatter schemas to
`trigger-gui.schema.json#/$defs/eca`, so keep `docs/schemas` together (editors resolve these references beside the
file).

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
- **The code-defined formats** follow the same rules, with these differences:
  - `terrain.json`, the per-subterrain files' top level and every trigger folder file **refuse unknown keys**
    (`additionalProperties: false`), because their codecs do. Object data, `pathing.json` and the counters in
    `triggers.json` allow them: the object data codec ignores them, the app keeps a `pathing.json`'s own keys (a split
    terrain refuses such a file, which the schema can't know).
  - The trigger files read a key holding `null` as missing; the schemas don't allow `null` (Studio never writes it).
  - A subterrain file's entries can't be checked for the keys a version needs: the version is in `terrain.json`
    (`dooHeader`, `objects.regions`), not in the file.
  - Object data: `level` and `data` are stored only in `.w3d`, `.w3a` and `.w3q` (one schema serves all seven
    extensions); a `value`'s type follows its change's `type` (if/then).
  - Ids and tile ids accept the forms the codecs write (`hfoo` or `0x…`; tile ids `Ldrt` or `hex:…`), as above.
- **Not expressible here, checked by the codecs**: in `terrain.json`, rectangles that overlap or reach past the
  canvas, names and folders used twice (folders ignoring case), device names (`CON`, `COM1`) as folders, id ranges
  that start after they end or overlap, a canvas too large; in a subterrain file, a creation number used twice; in
  the trigger folders, a variable defined twice differently, the zero character written as U+10FF00, a classic tree
  holding what it can't (nesting, comments, script items); in `pathing.json`, a cell outside the map, twice, or
  setting and clearing one bit.
- **Not covered**: `map/triggers/**/order.txt`, the script files' text, `terrain.txt`, `pathing.txt` and the other
  text formats (no JSON); `variables.json` and the frontmatter can't be checked by an editor through the mapping below
  (JSON Lines, a comment line), only by the test.

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
    { "fileMatch": ["**/map/war3map.w3l.json"], "url": "./docs/schemas/lights.schema.json" },
    { "fileMatch": ["**/map/*.w3u.json", "**/map/*.w3t.json", "**/map/*.w3b.json", "**/map/*.w3d.json", "**/map/*.w3a.json", "**/map/*.w3h.json", "**/map/*.w3q.json"], "url": "./docs/schemas/objects.schema.json" },
    { "fileMatch": ["**/map/terrain/terrain.json"], "url": "./docs/schemas/terrain.schema.json" },
    { "fileMatch": ["**/map/terrain/*/doodads.json"], "url": "./docs/schemas/terrain-doodads.schema.json" },
    { "fileMatch": ["**/map/terrain/*/units.json"], "url": "./docs/schemas/terrain-units.schema.json" },
    { "fileMatch": ["**/map/terrain/*/regions.json"], "url": "./docs/schemas/terrain-regions.schema.json" },
    { "fileMatch": ["**/.w3proj/pathing.json"], "url": "./docs/schemas/pathing.schema.json" },
    { "fileMatch": ["**/map/triggers/triggers.json"], "url": "./docs/schemas/triggers.schema.json" },
    { "fileMatch": ["**/map/triggers/**/_category.json"], "url": "./docs/schemas/trigger-category.schema.json" },
    { "fileMatch": ["**/map/triggers/**/*.gui.json"], "url": "./docs/schemas/trigger-gui.schema.json" },
    { "fileMatch": ["**/map/triggers/**/*.comment.json"], "url": "./docs/schemas/trigger-comment.schema.json" }
  ]
}
```

A `"$schema"` key inside one file works too where the codec allows unknown keys (it ignores it), but the app's next
save of that file drops it; in the files that refuse unknown keys (`terrain.json`, the trigger folders) it is an
error.

## The test that keeps them honest

`app/src/lib/formats/schemas.test.ts` (run with the TypeScript unit tests, so in the gate's commit tier), with
[Ajv](https://ajv.js.org/) (`ajv`, a pinned dev dependency of `app/`; `npm ci` installs it):

- one schema per definition and one per code-defined format, each a valid draft 2020-12 schema, the definitions'
  shared `$defs` the same in all ten (they are copied so each file stands alone for editors);
- each definition schema has its definition's fields (nothing more but older names), the same primitive types,
  fixed list lengths and always-written keys; a control proves this comparison catches a changed schema;
- each code-defined schema has the keys its codec reads, the keys it needs and refuses unknown keys exactly where
  the codec does, read from the codec's source (serde structs, the key lists the readers check against, `need_str`
  and "is missing"); a control proves it catches a changed schema;
- the fixtures' files (`tests/fixtures/mini-map`, `tests/fixtures/mini-campaign` with the campaign info,
  `tests/fixtures/trigger-folders`; a file for every definition schema), samples of what unpack and a terrain split
  wrote on real maps, and what the app writes to `pathing.json` pass; broken documents (a missing key, a byte past
  255, a version the codec refuses, a float past the 32-bit range, a version-dependent key left out, an unknown key
  where the codec refuses it, …) fail;
- in the corpus tier (`W3PROJ_REQUIRE_CORPUS=1`; skipped in the commit tier), every map and campaign of the corpus
  is unpacked with the release CLI into a temporary folder (with the game, so the triggers become folders), each map
  is split with `w3proj terrain split`, and every file above passes; every schema must meet at least one file there
  but `pathing.json` (only the app's Pathing tool writes it).

A change to a definition or to the keys a codec reads makes the comparison fail until the schema follows it.
