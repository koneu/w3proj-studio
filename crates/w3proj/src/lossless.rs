//! Strings of map files as text, for any bytes. Old maps hold Chinese, Korean or other text in
//! their own code pages, which isn't UTF-8 and can't be told apart reliably. Bytes that aren't
//! valid UTF-8 become private-use characters (U+10FF00 + byte) and turn back into the same bytes,
//! so such a string survives JSON and text forms without a guess at its encoding.
//!
//! app/src/lib/formats/lossless.ts is the same thing for the editors.

/// `FIRST + 0x100` is one past the last character there is and FIRST's low byte is 0, so mutation testing's
/// `FIRST * 0x100` (the same range of real characters) and `v + FIRST` as u8 (the same low byte) survive: they are
/// equivalent, not untested.
const FIRST: u32 = 0x10_FF00;

fn escape(b: u8) -> char {
    char::from_u32(FIRST + u32::from(b)).expect("the private use plane is valid")
}

fn push_valid(out: &mut String, s: &str) {
    for c in s.chars() {
        if (FIRST..FIRST + 0x100).contains(&(c as u32)) {
            // The real character (next to no file has it): as its bytes, or it would come back as one.
            let mut buf = [0; 4];
            for &b in c.encode_utf8(&mut buf).as_bytes() {
                out.push(escape(b));
            }
        } else {
            out.push(c);
        }
    }
}

/// Text for any bytes; `encode` gives exactly these bytes back.
pub fn decode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                push_valid(&mut out, s);
                return out;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                push_valid(&mut out, std::str::from_utf8(good).expect("checked by valid_up_to"));
                let n = e.error_len().unwrap_or(bad.len());
                for &b in &bad[..n] {
                    out.push(escape(b));
                }
                rest = &bad[n..];
            }
        }
    }
}

/// The bytes of a string from `decode` (or typed text, which is plain UTF-8).
pub fn encode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.chars() {
        let v = c as u32;
        if (FIRST..FIRST + 0x100).contains(&v) {
            out.push((v - FIRST) as u8);
        } else {
            let mut buf = [0; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_stays_as_it_is() {
        for s in ["", "plain", "Größe", "한국어", "中文", "😀"] {
            assert_eq!(decode(s.as_bytes()), s);
            assert_eq!(encode(s), s.as_bytes());
        }
    }

    #[test]
    fn code_pages_come_back_byte_for_byte() {
        // "한국" in CP949, "中文" in GBK, a broken sequence, one cut off at the end.
        for b in [&[0xC7, 0xD1, 0xB1, 0xB9][..], &[0xD6, 0xD0, 0xCE, 0xC4], b"a\xFFb", b"a\xE4\xB8"] {
            let s = decode(b);
            assert!(std::str::from_utf8(b).is_err());
            assert_eq!(encode(&s), b);
        }
        assert_eq!(decode(b"a\xFF"), "a\u{10FFFF}");
    }

    /// tests/fixtures/codepage-samples.json: GBK, CP949 and Big5 texts, sequences those can't read among them, as
    /// app/src/lib/formats/codepage.ts shows and stores them. Both sides read them alike, and the text the editor stores
    /// for a typed one is written as the code page's bytes.
    #[test]
    fn code_page_samples_agree_with_the_editor() {
        let samples: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/codepage-samples.json")).unwrap();
        let read = samples["read"].as_array().unwrap();
        let typed = samples["typed"].as_array().unwrap();
        assert!(read.len() >= 6 && typed.len() >= 3, "control: the samples are there");
        for s in read {
            let bytes = unhex(s["bytes"].as_str().unwrap());
            assert!(std::str::from_utf8(&bytes).is_err(), "control: {s} isn't UTF-8");
            assert_eq!(decode(&bytes), s["lossless"].as_str().unwrap(), "{s}");
            assert_eq!(encode(&decode(&bytes)), bytes, "{s}");
        }
        for s in typed {
            assert_eq!(encode(s["stored"].as_str().unwrap()), unhex(s["bytes"].as_str().unwrap()), "{s}");
        }
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn the_escapes_themselves_survive() {
        let real = "\u{10FF80}x\u{10FFFF}";
        assert_eq!(encode(&decode(real.as_bytes())), real.as_bytes());
    }

    #[test]
    fn any_bytes_at_all() {
        let mut x = 0x2545_F491u32;
        for len in 0..400 {
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    // Often the lead and continuation bytes UTF-8 is made of.
                    if x & 1 == 0 { 0xF4 - (x >> 8 & 0x3F) as u8 } else { (x >> 8) as u8 }
                })
                .collect();
            assert_eq!(encode(&decode(&bytes)), bytes);
        }
    }
}
