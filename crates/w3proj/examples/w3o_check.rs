//! Reads each given `.w3o` (what the World Editor's File > Export All Object Data writes) with `w3proj::w3o::unpack`,
//! prints the kinds it holds with the number of objects, and checks that `pack` gives the same bytes back.
//! `cargo run --release -p w3proj --example w3o_check -- <file.w3o>...`
//! Exit 1 when a file can't be read or doesn't come back byte for byte.
fn main() {
    let mut bad = 0;
    for f in std::env::args().skip(1) {
        let bytes = std::fs::read(&f).unwrap_or_else(|e| panic!("{f}: {e}"));
        match w3proj::w3o::unpack(&bytes) {
            Ok(parts) => {
                let kinds: Vec<String> = parts
                    .iter()
                    .map(|(k, file)| {
                        let opt = w3proj::objdata::kind(k).unwrap_or(false);
                        let n = w3proj::objdata::decode(file, opt).map(|t| format!("{t:?}").len()).unwrap_or(0);
                        format!("{k}({} bytes, debug {n})", file.len())
                    })
                    .collect();
                let again = w3proj::w3o::pack(&parts);
                let same = again.as_ref().is_ok_and(|b| *b == bytes);
                println!("{} {f}: {} bytes, version {}, kinds {}", if same { "SAME" } else { "DIFFERS" }, bytes.len(), u32::from_le_bytes(bytes[..4].try_into().unwrap()), kinds.join(" "));
                if !same {
                    bad += 1;
                }
            }
            Err(e) => {
                println!("ERROR {f}: {e}");
                bad += 1;
            }
        }
    }
    std::process::exit(if bad == 0 { 0 } else { 1 });
}
