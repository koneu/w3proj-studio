//! Packs a project's files as they are, without what `w3proj pack` works out on the way (the World
//! Editor's ally priorities in war3map.w3i, `allies::pack_w3i`). A test tool, for inputs that have
//! to keep what another tool wrote: e.g. all-zero ally masks (`tests/fixtures/we-specs/make-studio-paths.mjs`).
//! `cargo run --release -p w3proj --example pack_as_is -- <project> <output.w3x>`
use std::path::Path;

use w3proj::project::{build_archive, encode_files, read_project};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [project, output] = args.as_slice() else {
        eprintln!("usage: pack_as_is <project> <output.w3x>");
        std::process::exit(2);
    };
    let project = Path::new(project);
    let run = || -> w3proj::Result<()> {
        let codecs = w3proj::Registry::for_project(project, &[])?;
        let (manifest, prefix, files) = read_project(project)?;
        let encoded = encode_files(&files, &manifest.pack.raw, &codecs)?;
        std::fs::write(output, build_archive(&manifest, &prefix, encoded)?)?;
        Ok(())
    };
    if let Err(e) = run() {
        eprintln!("pack_as_is: {e}");
        std::process::exit(1);
    }
}
