//! Mapping between archive names (`war3mapImported\x.mdx`) and project
//! paths (`war3mapImported/x.mdx`) that are safe on every file system.
//!
//! Each path component is escaped with `%XX` for characters Windows rejects,
//! `%` itself, trailing dots/spaces and reserved device names, so any archive
//! name survives a round trip through the file system.

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn must_escape(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '%' | '/' | '\\') || (c as u32) < 0x20
}

fn push_escaped(out: &mut String, c: char) {
    let mut buf = [0u8; 4];
    for b in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{b:02X}"));
    }
}

fn escape_component(comp: &str) -> String {
    let mut out = String::with_capacity(comp.len());
    let stem = comp.split('.').next().unwrap_or("");
    let reserved = RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem));
    let n = comp.chars().count();
    for (i, c) in comp.chars().enumerate() {
        let trailing = i + 1 == n && (c == '.' || c == ' ');
        if must_escape(c) || trailing || (reserved && i == 0) {
            push_escaped(&mut out, c);
        } else {
            out.push(c);
        }
    }
    out
}

/// Archive name → relative project path (always `/`-separated).
pub fn to_project_path(archive_name: &str) -> String {
    // Separators that would produce empty components are kept literally.
    let chars: Vec<char> = archive_name.chars().collect();
    let mut comps: Vec<String> = vec![String::new()];
    for (i, &c) in chars.iter().enumerate() {
        let empty_side = i == 0 || i + 1 == chars.len() || chars[i - 1] == '\\';
        if c == '\\' && !empty_side {
            comps.push(String::new());
        } else {
            // A `\` kept inside a component is escaped by escape_component.
            comps.last_mut().unwrap().push(c);
        }
    }
    comps
        .iter()
        .map(|c| escape_component(c))
        .collect::<Vec<_>>()
        .join("/")
}

/// A `/`-separated relative path (as project files are named) under `base`, joined one component at a time: the result
/// has the platform's separator throughout (a `/` left inside would be mixed with `\` on Windows).
pub fn join_rel(base: &std::path::Path, rel: &str) -> std::path::PathBuf {
    rel.split('/').filter(|c| !c.is_empty()).fold(base.to_path_buf(), |p, c| p.join(c))
}

/// Relative project path → archive name.
pub fn to_archive_name(project_path: &str) -> String {
    project_path
        .split('/')
        .map(percent_decode)
        .collect::<Vec<_>>()
        .join("\\")
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // `get` below also stops at the end, so `<=` here would change nothing (cargo-mutants' one survivor).
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(name: &str) -> String {
        let p = to_project_path(name);
        assert_eq!(to_archive_name(&p), name, "via {p}");
        p
    }

    #[test]
    fn plain() {
        assert_eq!(rt("war3map.j"), "war3map.j");
        assert_eq!(rt("war3mapImported\\a b.mdx"), "war3mapImported/a b.mdx");
    }

    #[test]
    fn awkward() {
        assert_eq!(rt("con.txt"), "%63on.txt");
        assert_eq!(rt("a:b?.txt"), "a%3Ab%3F.txt");
        assert_eq!(rt("100%.blp"), "100%25.blp");
        assert_eq!(rt("trailing."), "trailing%2E");
        assert_eq!(rt("a/b"), "a%2Fb");
        rt("\\lead");
        rt("double\\\\sep");
        rt("end\\");
    }

    /// A separator that would leave an empty component stays in its component, escaped: a file
    /// system drops empty components (`a//b` is `a/b`, and `join_rel` skips them), so such a name
    /// would come back without its `\`. A round trip alone doesn't show this: `a//b` turns back
    /// into `a\\b` as text.
    #[test]
    fn no_component_is_ever_empty() {
        assert_eq!(rt("\\lead"), "%5Clead");
        assert_eq!(rt("end\\"), "end%5C");
        assert_eq!(rt("double\\\\sep"), "double/%5Csep");
        assert_eq!(rt("a\\\\\\b"), "a/%5C%5Cb");
        assert_eq!(rt("\\"), "%5C");
        assert_eq!(rt("x\\y\\"), "x/y%5C");
        assert_eq!(rt(""), "");
        for name in ["\\lead", "end\\", "double\\\\sep", "a\\\\\\b", "x\\y\\", "\\\\"] {
            let p = to_project_path(name);
            assert!(!p.split('/').any(str::is_empty), "{name:?} gave {p:?}");
            // Through the file system: the path joined and read back component by component.
            let joined = join_rel(std::path::Path::new("root"), &p);
            let back: Vec<String> = joined.iter().skip(1).map(|c| c.to_string_lossy().into_owned()).collect();
            assert_eq!(to_archive_name(&back.join("/")), name);
        }
    }

    #[test]
    fn percent_decoding_takes_only_two_hex_digits() {
        assert_eq!(to_archive_name("%41%4a"), "AJ");
        // Too short or not hex at the end of a component: kept as typed.
        assert_eq!(to_archive_name("100%"), "100%");
        assert_eq!(to_archive_name("a%4"), "a%4");
        assert_eq!(to_archive_name("a%4/b"), "a%4\\b");
        assert_eq!(to_archive_name("%zz%"), "%zz%");
        // A multi-byte character right after a % isn't cut in half.
        assert_eq!(to_archive_name("%é1"), "%é1");
        // Bytes that aren't UTF-8 together: replaced, never a panic.
        assert_eq!(to_archive_name("%FF"), "\u{FFFD}");
    }

    #[test]
    fn reserved_names_are_escaped_whatever_their_case_or_extension() {
        assert_eq!(rt("LPT9"), "%4CPT9");
        assert_eq!(rt("aux.tar.gz"), "%61ux.tar.gz");
        assert_eq!(rt("Nul"), "%4Eul");
        // Only the whole stem: these are ordinary names.
        assert_eq!(rt("console.txt"), "console.txt");
        assert_eq!(rt("COM10"), "COM10");
        assert_eq!(rt("x.con"), "x.con");
        // A control character, a trailing space, and a non-ASCII character escaped by its UTF-8 bytes.
        assert_eq!(rt("a\tb "), "a%09b%20");
        assert_eq!(rt("é."), "é%2E");
    }

    #[test]
    fn join_rel_uses_one_separator_and_skips_empty_parts() {
        let base = std::path::Path::new("base");
        assert_eq!(join_rel(base, "a/b/c.txt"), base.join("a").join("b").join("c.txt"));
        assert_eq!(join_rel(base, "/a//b/"), base.join("a").join("b"));
        assert_eq!(join_rel(base, ""), base.to_path_buf());
    }

    /// The pairs the app's TypeScript side checks too (`app/src/lib/formats/archivepath.test.ts`):
    /// both sides name every file the same way, a U+FEFF at the start of a name included.
    #[test]
    fn the_names_the_app_uses() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/archive-names.json");
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let pairs = |key: &str| -> Vec<(String, String)> {
            fixture[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| (c["path"].as_str().unwrap().to_string(), c["archive"].as_str().unwrap().to_string()))
                .collect()
        };
        let both = pairs("roundTrip");
        // Control: the cases this is about are there.
        assert!(both.iter().filter(|(p, _)| p.contains('\u{feff}')).count() >= 4);
        for (path, archive) in &both {
            assert_eq!(&to_archive_name(path), archive, "{path:?}");
            assert_eq!(&to_project_path(archive), path, "{archive:?}");
        }
        let one_way = pairs("toArchive");
        assert!(one_way.len() >= 2);
        for (path, archive) in &one_way {
            assert_eq!(&to_archive_name(path), archive, "{path:?}");
        }
    }
}
