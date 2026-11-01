//! Reads every locally stored file and reports failures: `cargo run --release -p casc --example readall`.
use std::collections::BTreeMap;
fn main() {
    let g = casc::GameData::open(std::path::Path::new(r"C:\Program Files (x86)\Warcraft III")).unwrap();
    let t = std::time::Instant::now();
    let (mut ok, mut bytes) = (0usize, 0u64);
    let mut errs: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut exts: BTreeMap<String, usize> = BTreeMap::new();
    for p in g.local_paths().map(str::to_string).collect::<Vec<_>>() {
        match g.read_exact(&p) {
            Ok(d) => { ok += 1; bytes += d.len() as u64; *exts.entry(p.rsplit('.').next().unwrap_or("").to_lowercase()).or_default() += 1; }
            Err(e) => { let k = e.to_string(); let k = k.split(':').next().unwrap().to_string(); errs.entry(k).or_insert((0, p.clone())).0 += 1; }
        }
    }
    println!("{ok} ok, {:.1} GB in {:?}", bytes as f64 / 1e9, t.elapsed());
    for (k, (n, ex)) in errs { println!("ERR x{n}: {k}  e.g. {ex}"); }
    let mut e: Vec<_> = exts.into_iter().collect(); e.sort_by(|a, b| b.1.cmp(&a.1));
    println!("{}", e.iter().take(20).map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(" "));
}
