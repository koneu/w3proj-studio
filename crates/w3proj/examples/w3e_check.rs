//! Checks the terrain text form against every `war3map.w3e` under the given folders:
//! byte-exact round trip and sizes.
//! `cargo run --release -p w3proj --example w3e_check -- <dir>... [--out <dir>]`
//! `--out` also writes each text (numbered) for comparing with the TypeScript side.
use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("war3map.w3e")) {
            out.push(p);
        }
    }
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let out_dir = args.iter().position(|a| a == "--out").map(|i| {
        args.remove(i);
        PathBuf::from(args.remove(i))
    });
    let mut files = Vec::new();
    args.iter().for_each(|d| walk(Path::new(d), &mut files));
    let (mut ok, mut bin_total, mut text_total) = (0, 0, 0);
    for (i, f) in files.iter().enumerate() {
        let bytes = std::fs::read(f).unwrap();
        match w3proj::w3e::to_text(&bytes).and_then(|t| w3proj::w3e::from_text(&t).map(|b| (t, b))) {
            Ok((t, b)) if b == bytes => {
                ok += 1;
                bin_total += bytes.len();
                text_total += t.len();
                if let Some(d) = &out_dir {
                    std::fs::write(d.join(format!("{i}.txt")), &t).unwrap();
                }
            }
            Ok(_) => println!("DIFFERS {}", f.display()),
            Err(e) => println!("ERROR {}: {e}", f.display()),
        }
    }
    println!("{ok}/{} round-trip; binary {} KB, text {} KB", files.len(), bin_total / 1024, text_total / 1024);
}
