//! The agent file (`AGENTS.md`) in a project's root: what an AI agent (or a new team member) needs to know before it
//! edits the project's files. One template, here, for every writer: a new map or campaign (`project::create`) and an
//! unpack that makes a project (`project::write_files`, the top project only; a chapter map is no project of its own).
//!
//! It is written only when absent: a file the user edited or deleted-and-replaced is never touched, and sync, rebuild
//! and pack never rewrite it. It is an ordinary tracked file of the project's root (not ignored). Pack reads only
//! `map/` (and `maps/<chapter>/map/`), so it never goes into the map.
//!
//! Every command named in the text exists in the CLI (`crates/cli/tests/agent_file.rs` checks the text against
//! `w3proj --help`).

use std::path::Path;

use crate::project::{there, write_atomic};
use crate::Result;

/// The file's name. `AGENTS.md` is the cross-tool convention; no `CLAUDE.md` is written next to it.
pub const FILE: &str = "AGENTS.md";

/// Which folder layout the text describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A map project, terrain in `map/war3map.w3e.txt`.
    Flat,
    /// A map project whose terrain is split into subterrains (`map/terrain/`).
    Split,
    /// A campaign: chapter maps as projects under `maps/`.
    Campaign,
}

impl Kind {
    /// The kind of an existing project folder (what the layout is now).
    pub fn of(project: &Path) -> Result<Kind> {
        if crate::project::is_campaign_project(project)? {
            Ok(Kind::Campaign)
        } else if crate::terrain_layout::is_split_on_disk(&project.join(crate::project::MAP_DIR))? {
            Ok(Kind::Split)
        } else {
            Ok(Kind::Flat)
        }
    }
}

const HEAD: &str = "# Agent notes for this W3Proj Studio project

This folder is a Warcraft III project of W3Proj Studio, unpacked into files that Git can version. Edit the files here,
then `w3proj pack` builds the map. Do not edit a packed `.w3x` / `.w3m` / `.w3n`; edit the project.

";

const MAP_LAYOUT: &str = "## Layout

- `w3proj.toml`: the project's settings (pack output, raw files, checks). `header.bin` (if there): the map file's header.
- `map/`: the map's files; this is all that goes into the packed map.
  - `war3map.w3i.json`: map info (name, players, forces, flags). Other `*.json` / `*.txt` files are the readable form of
    the map's binary files (`war3map.doo.json` doodads, `war3mapUnits.doo.json` units and items, `war3map.w3r.json`
    regions, `war3map.w3c.json` cameras, `war3map.w3s.json` sounds, `war3map.imp.json` import list).
  - `objects/`: the object data (units, items, destructables, doodads, abilities, buffs, upgrades), one file per object:
    `objects/<kind>/custom/<id>.json` the objects made in the map, `objects/<kind>/original/<id>.json` the changed
    standard ones. `data` is the object's entry in `war3map.w3u` (and the other kinds' files), `skin` its entry in
    `war3mapSkin.w3u`; both are packed. An upper-case letter in the id is marked in the file name (`H000~8.json`: `~` and
    a hex digit, 8 the first letter, 4 the second, 2 the third, 1 the fourth); the id inside the file is what counts.
    `objects/objects.json` lists the packed files and their versions, `order.txt` the order where it isn't by id.
  - `war3map.wts`: the map's string table. Other files refer to its entries as `TRIGSTR_<number>`.
";

const TERRAIN_FLAT: &str = "  - `war3map.w3e.txt`: the terrain (a grid of corners; row 0 is the south row).
";

const TERRAIN_SPLIT: &str = "  - `terrain/`: the terrain in subterrains (rectangles). `terrain/terrain.json` has the canvas and the rectangles,
    `terrain/<folder>/terrain.txt` one subterrain's corners, `doodads.json`, `units.json` and `regions.json` the objects
    placed in it. Split and merge with `w3proj terrain split` and `w3proj terrain merge`.
";

const MAP_LAYOUT_2: &str = "  - `triggers/`: the triggers, one file per trigger (`.gui.json` GUI, `.j` / `.lua` / `.vjass` custom text, `.comment.json`),
    in folders; `triggers/triggers.json` is the root (script language and mode), `order.txt` the order in a folder.
  - `war3map.j` / `war3map.lua` is the map script. With `\"script\": \"generated\"` in `triggers/triggers.json` it is made
    from the triggers and lives in `build/derived/`, not in `map/`.
- `.w3proj/`: the project's tool settings, kept in Git.
- `build/`: pack output, derived files and other local files, ignored by Git.

";

const CAMPAIGN_LAYOUT: &str = "## Layout

- `w3proj.toml`: the project's settings (pack output, raw files, checks).
- `map/`: the campaign's own files: `war3campaign.w3f.json` (campaign info, the chapters' order and names),
  `war3campaign.imp.json` (imports) and the campaign's object data (`objects/`, one file per object, as in a map
  project; it packs into `war3campaign.w3u`, ...).
- `maps/<chapter>/`: each chapter map, a project of its own (`maps/<chapter>/map/` has the map's files as in a map
  project: `war3map.w3i.json`, `war3map.wts`, `triggers/`, terrain, ...). Edit a chapter by editing its folder.
- `.w3proj/`: the project's tool settings, kept in Git. `build/`: pack output and local files, ignored by Git.

";

const DERIVED: &str = "## Derived files: do not edit by hand

- `war3map.wpm` (pathing), `war3map.shd` (shadows) and `war3mapMap.blp` (the minimap) are made from the terrain and
  the doodads. After you change `war3map.w3e*`, `terrain/`, or the doodads, make them again with `w3proj rebuild`.
- A generated `war3map.j` / `war3map.lua` is made from the triggers (`w3proj rebuild --only script`); change the
  triggers, never the generated script. A script kept in `map/` (`\"script\": \"kept\"`) is yours to edit.
  To replace a script that isn't Studio's with the generated one, use `w3proj rebuild --replace-script` (the old
  script is first copied to `build/replaced-scripts/`).
- Everything in `build/derived/` and `build/derived-from.json`.
";

const RULES: &str = "
## Rules

- `war3map.wts`: never change the numbers (`TRIGSTR_<n>`) by hand, other files point at them. Change a string's text
  only; a new string takes the next free number.
- Keep every file's `format` tag (`\"w3proj.<name>/<n>\"`) and the JSON's structure; a file that doesn't parse or
  doesn't follow its schema is refused when packing.
- Keep objects' creation numbers (`gg_unit_..._0012`) unique: `w3proj terrain check` lists duplicates and
  `w3proj terrain fix-ids` repairs them.

## After every edit

1. `w3proj rebuild <project>` makes the derived files again.
2. `w3proj check <project>` runs the Problems checks (and the melee checks); fix errors before you pack.
3. `w3proj pack <project>` builds the map (`build/` by default, `-o` names another file).

`w3proj --help` lists everything; `w3proj <command> --help` the flags. A running W3Proj Studio also serves the same
project to AI clients over MCP (`w3proj mcp`); its `read_guide` tool has guides for terrain, melee maps, spells and
more. That is for live work in the app: with only files, use the commands above.

## Where the formats are

In the W3Proj Studio repository: `docs/schemas/README.md` (a JSON Schema for each project file),
`crates/w3proj/formats/README.md` (the binary formats), `docs/terrain-subterrains-spec.md` (the split terrain) and
`docs/trigger-folders-spec.md` (the trigger folders).
";

/// The text for a project of this kind.
pub fn text(kind: Kind) -> String {
    let mut out = String::from(HEAD);
    match kind {
        Kind::Campaign => out.push_str(CAMPAIGN_LAYOUT),
        Kind::Flat | Kind::Split => {
            out.push_str(MAP_LAYOUT);
            out.push_str(if kind == Kind::Split { TERRAIN_SPLIT } else { TERRAIN_FLAT });
            out.push_str(MAP_LAYOUT_2);
        }
    }
    out.push_str(DERIVED);
    out.push_str(RULES);
    out
}

/// Writes `AGENTS.md` into the project folder unless there is a file (or anything) of that name. Whether it wrote.
pub fn ensure(project: &Path, kind: Kind) -> Result<bool> {
    let path = project.join(FILE);
    if there(&path)? {
        return Ok(false);
    }
    write_atomic(&path, text(kind).as_bytes())?;
    Ok(true)
}
