//! Checks a format definition against sample files: byte-exact round trip
//! per file, grouped by header (magic/version), plus the engine's notes.
//! `cargo run --release -p w3proj --example format_check -- <format> <archive name> <dir>... [--defs <dir>]`
//! e.g. `format_check w3i war3map.w3i samples/w3i`
use std::collections::BTreeMap;
use std::path::PathBuf;

use w3proj::codec::Codec;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut defs = Vec::new();
    if let Some(i) = args.iter().position(|a| a == "--defs") {
        defs.push(PathBuf::from(args.remove(i + 1)));
        args.remove(i);
    }
    let (format, archive_name, dirs) = (&args[0], &args[1], &args[2..]);
    let registry = w3proj::Registry::with_formats(&defs).expect("definitions load");
    let codec = registry.formats().into_iter().find(|f| &f.def.name == format).expect("format definition");
    let mut stats: BTreeMap<String, usize> = BTreeMap::new();
    let mut notes: BTreeMap<String, usize> = BTreeMap::new();
    let mut shown = 0;
    for dir in dirs {
        for entry in std::fs::read_dir(dir).expect("readable folder") {
            let path = entry.unwrap().path();
            let bytes = std::fs::read(&path).unwrap();
            if bytes.len() < 12 {
                continue;
            }
            // Header for grouping: printable magic (if any) and the first version-like u32s.
            let u = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
            let header = if bytes[..4].iter().all(|b| b.is_ascii_graphic()) {
                format!("{} v{} sub{}", String::from_utf8_lossy(&bytes[..4]), u(4), u(8))
            } else {
                format!("v{}", u(0))
            };
            let result = match codec.decode_with_notes(archive_name, &bytes) {
                Ok((json, n)) => {
                    for note in n {
                        let key: String = note.chars().filter(|c| !c.is_ascii_digit()).collect();
                        *notes.entry(format!("{header}: {key}")).or_default() += 1;
                    }
                    match codec.encode(archive_name, &json) {
                        Ok(back) if back != bytes => "round trip differs".to_string(),
                        Err(e) => format!("encode: {e}"),
                        Ok(_) => "ok".to_string(),
                    }
                }
                Err(e) => format!("decode: {e}"),
            };
            if result != "ok" && shown < 6 {
                shown += 1;
                println!("{} [{header}]: {result}", path.display());
            }
            let group: String = result.chars().take_while(|c| !c.is_ascii_digit()).collect();
            *stats.entry(format!("{header}  {}", group.trim_end())).or_default() += 1;
        }
    }
    for (k, n) in stats {
        println!("{n:>5}  {k}");
    }
    for (k, n) in notes {
        println!("{n:>5}  note: {k}");
    }
}
