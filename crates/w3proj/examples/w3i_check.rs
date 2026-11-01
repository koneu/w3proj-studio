//! Round-trips every `.w3i` in the given folders through JSON:
//! `cargo run --release -p w3proj --example w3i_check -- <dir>...`
use std::collections::BTreeMap;

fn main() {
    let mut stats: BTreeMap<String, usize> = BTreeMap::new();
    for dir in std::env::args().skip(1) {
        for entry in std::fs::read_dir(&dir).expect("readable folder") {
            let path = entry.unwrap().path();
            let bytes = std::fs::read(&path).unwrap();
            if bytes.len() < 4 {
                continue;
            }
            let version = u32::from_le_bytes(bytes[..4].try_into().unwrap());
            let result = match w3proj::mapinfo::to_json(&bytes) {
                Ok(json) => match w3proj::mapinfo::from_json(&json) {
                    Ok(back) if back == bytes => "ok".to_string(),
                    Ok(_) => "round trip differs".to_string(),
                    Err(e) => format!("encode: {e}"),
                },
                Err(e) => format!("decode: {e}"),
            };
            if result != "ok" {
                println!("{} v{version}: {result}", path.display());
            }
            *stats.entry(format!("v{version} {result}")).or_default() += 1;
        }
    }
    for (k, n) in stats {
        println!("{n:>5}  {k}");
    }
}
