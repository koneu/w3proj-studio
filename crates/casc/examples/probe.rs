//! Smoke test against a local install: `cargo run -p casc --example probe [install dir]`.

use casc::{GameData, Mode};
use std::path::PathBuf;

fn main() {
    let install = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)\Warcraft III"));
    let t = std::time::Instant::now();
    let g = GameData::open(&install).unwrap();
    println!(
        "opened in {:?}: {} entries, {} local, locale {}",
        t.elapsed(),
        g.total_entries(),
        g.local_paths().count(),
        g.locale
    );
    for (p, m) in [
        (r"Units\UnitMetaData.slk", Mode::Sd),
        (r"UI\WorldEditStrings.txt", Mode::Sd),
        (r"Units\HumanUnitStrings.txt", Mode::Sd),
        (r"Units\Human\Footman\Footman.mdx", Mode::Sd),
        (r"Units\Human\Footman\Footman.mdx", Mode::Hd),
        (r"Units\Human\Footman\Footman.mdx", Mode::De),
        (r"ReplaceableTextures\CommandButtons\BTNFootman.blp", Mode::Sd),
        (r"ReplaceableTextures\CommandButtons\BTNFootman.blp", Mode::Hd),
        (r"TerrainArt\LordaeronSummer\Lords_Dirt.blp", Mode::Sd),
        (r"Scripts\common.j", Mode::Sd),
    ] {
        let t = std::time::Instant::now();
        match g.read(p, m, None) {
            Ok((full, d)) => println!(
                "{m:?} {p} -> {full} ({} bytes, magic {:?}) {:?}",
                d.len(),
                String::from_utf8_lossy(&d[..4.min(d.len())]),
                t.elapsed()
            ),
            Err(e) => println!("{m:?} {p} -> ERR {e}"),
        }
    }
}
