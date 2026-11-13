//! Strings nothing refers to leave war3map.wts when a project is packed, as the World Editor drops
//! them on every save. The same rules as the app's packing (TypeScript: `app/src/lib/formats/wts.ts`
//! `pruneStrings`, `app/src/lib/formats/mapdoc.ts` `stringRefsInMap`, `app/src/lib/formats/prunedstrings.ts`):
//!
//! - referenced is every `TRIGSTR_<digits>` anywhere in the map's text files (`.json .j .lua .txt
//!   .fdf .toc .ai .slk .ini`) and its own raw files (`war3map*`, `war3campaign*`), string tables
//!   left out, and the sounds' dialogue keys (`dialogueTextKey`, `speakerNameKey`: numbers in
//!   war3map.w3s, read through its codec when it is kept raw);
//! - strings that stay keep their numbers, comments, order and bytes; a dropped block goes from its
//!   `STRING` header up to the next header;
//! - recorded strings an earlier drop took (`.w3proj/pruned-strings.json`) that are referenced
//!   again and missing come back first, at the end, with their old numbers and texts;
//! - nothing is dropped when anything can't be read (a sounds file, the record, a table that isn't
//!   UTF-8): the strings just stay.
//!
//! Numbers are compared as JavaScript's `Number()` reads the digits (an `f64`), so both sides agree
//! on any input. The parser reads strangers' files: it never panics, and a run of `//` lines is
//! read once however many headers start in it, so no input makes it slow.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use serde::Serialize;
use serde_json::Value;

use crate::codec::Registry;

/// Where the app records dropped strings, from the project's root.
pub const PRUNED_STRINGS_FILE: &str = ".w3proj/pruned-strings.json";
const PRUNED_FORMAT: &str = "w3proj.prunedStrings/1";
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A string number as JavaScript reads it: the bits of a non-negative `f64`, whose order as
/// integers is their order as numbers.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StringNum(u64);

impl StringNum {
    fn from_digits(digits: &str) -> StringNum {
        // ASCII digits only: always a number (very long ones round, or become infinity, as in JS).
        StringNum(digits.parse::<f64>().unwrap_or(f64::INFINITY).to_bits())
    }
    pub fn from_u64(n: u64) -> StringNum {
        StringNum((n as f64).to_bits())
    }
    pub fn value(self) -> f64 {
        f64::from_bits(self.0)
    }
}

impl fmt::Display for StringNum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.value())
    }
}

impl fmt::Debug for StringNum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.value())
    }
}

impl Serialize for StringNum {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_f64(self.value())
    }
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn skip_space(text: &str, mut at: usize) -> usize {
    while let Some(c) = text[at..].chars().next() {
        if !js_space(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}

/// The parser's searches over one text, with what it learnt about runs of `//` lines.
struct Reader<'a> {
    text: &'a str,
    /// Start of a `//` line (as the header's comment group meets it) → where the run of them ends.
    runs: HashMap<usize, usize>,
}

/// A header `STRING <digits> [// …\n]* {` + `\r?\n`: where it starts, its number, where its text starts.
struct Header {
    at: usize,
    num: StringNum,
    end: usize,
}

impl<'a> Reader<'a> {
    fn new(text: &'a str) -> Self {
        Reader { text, runs: HashMap::new() }
    }

    /// `(?:\/\/[^\n]*\n\s*)*` from `at`: where it ends.
    fn comments(&mut self, at: usize) -> usize {
        let b = self.text.as_bytes();
        let mut seen = Vec::new();
        let mut p = at;
        let end = loop {
            if let Some(&e) = self.runs.get(&p) {
                break e;
            }
            if !(b.get(p) == Some(&b'/') && b.get(p + 1) == Some(&b'/')) {
                break p;
            }
            let Some(nl) = b[p + 2..].iter().position(|&c| c == b'\n') else { break p };
            seen.push(p);
            p = skip_space(self.text, p + 2 + nl + 1);
        };
        for s in seen {
            self.runs.insert(s, end);
        }
        end
    }

    /// The header pattern anchored at `at`.
    fn header_at(&mut self, at: usize) -> Option<Header> {
        let b = self.text.as_bytes();
        if !b[at..].starts_with(b"STRING") {
            return None;
        }
        let p = at + 6;
        let q = skip_space(self.text, p);
        if q == p {
            return None;
        }
        let digits = b[q..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let num = StringNum::from_digits(&self.text[q..q + digits]);
        let p = skip_space(self.text, q + digits);
        let p = self.comments(p);
        if b.get(p) != Some(&b'{') {
            return None;
        }
        let p = p + 1;
        let end = if b.get(p) == Some(&b'\r') && b.get(p + 1) == Some(&b'\n') {
            p + 2
        } else if b.get(p) == Some(&b'\n') {
            p + 1
        } else {
            return None;
        };
        Some(Header { at, num, end })
    }

    /// The first header from `from` (HEADER.exec).
    fn find_header(&mut self, from: usize) -> Option<Header> {
        let mut at = from;
        while let Some(i) = find(self.text.as_bytes(), b"STRING", at) {
            if let Some(h) = self.header_at(i) {
                return Some(h);
            }
            at = i + 1;
        }
        None
    }

    /// The first `\r?\n}` from `from`: (index, length).
    fn find_close(&self, from: usize) -> Option<(usize, usize)> {
        let b = self.text.as_bytes();
        let i = find(b, b"\n}", from)?;
        Some(if i > from && b[i - 1] == b'\r' { (i - 1, 3) } else { (i, 2) })
    }

    /// The first `}` from `from` with `\r?\n`, blank lines and a header right after it (UNCLOSED).
    fn find_unclosed(&mut self, from: usize) -> Option<usize> {
        let b = self.text.as_bytes();
        let mut at = from;
        while let Some(i) = b[at..].iter().position(|&c| c == b'}').map(|k| at + k) {
            let mut p = i + 1;
            if b.get(p) == Some(&b'\r') {
                p += 1;
            }
            if b.get(p) == Some(&b'\n') {
                p += 1;
                // (?:[ \t]*\r?\n)*
                loop {
                    let mut q = p;
                    while matches!(b.get(q), Some(b' ' | b'\t')) {
                        q += 1;
                    }
                    if b.get(q) == Some(&b'\r') {
                        q += 1;
                    }
                    if b.get(q) == Some(&b'\n') {
                        p = q + 1;
                    } else {
                        break;
                    }
                }
                if self.header_at(p).is_some() {
                    return Some(i);
                }
            }
            at = i + 1;
        }
        None
    }
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| from + i)
}

/// One block: `text[from..to]` is its text, `text[to..end]` what closes it; `header` where its
/// `STRING` starts.
struct Block {
    header: usize,
    num: StringNum,
    from: usize,
    to: usize,
    end: usize,
}

enum Search<T> {
    NotYet,
    None,
    At(T),
}

/// The blocks of a file, as the app's parser reads them (wts.ts `scan`).
fn scan(text: &str) -> Vec<Block> {
    let mut r = Reader::new(text);
    let mut blocks = Vec::new();
    let mut pos = 0;
    let mut c: Search<(usize, usize)> = Search::NotYet;
    let mut u: Search<usize> = Search::NotYet;
    loop {
        let Some(h) = r.find_header(pos) else { return blocks };
        let from = h.end;
        if matches!(c, Search::NotYet) || matches!(c, Search::At((i, _)) if i < from) {
            c = r.find_close(from).map_or(Search::None, Search::At);
        }
        if matches!(u, Search::NotYet) || matches!(u, Search::At(i) if i < from) {
            u = r.find_unclosed(from).map_or(Search::None, Search::At);
        }
        match (&u, &c) {
            (Search::At(ui), close) if !matches!(close, Search::At((ci, _)) if *ci <= *ui) => {
                blocks.push(Block { header: h.at, num: h.num, from, to: *ui, end: ui + 1 });
                pos = ui + 1;
            }
            (_, Search::At((ci, len))) => {
                blocks.push(Block { header: h.at, num: h.num, from, to: *ci, end: ci + len });
                pos = ci + len;
            }
            _ => return blocks,
        }
    }
}

/// The strings of a file by number (a number given twice: the last).
pub fn strings(text: &str) -> BTreeMap<StringNum, String> {
    scan(text).into_iter().map(|b| (b.num, text[b.from..b.to].to_string())).collect()
}

fn remove_strings(text: &str, nums: &BTreeSet<StringNum>) -> String {
    let mut r = Reader::new(text);
    let mut out = String::new();
    let mut at = 0;
    for b in scan(text) {
        if !nums.contains(&b.num) {
            continue;
        }
        let next = r.find_header(b.end).map_or(text.len(), |h| h.at);
        out.push_str(&text[at..b.header]);
        at = next;
    }
    out.push_str(&text[at..]);
    out
}

/// war3map.wts without the strings `referenced` doesn't name, and the numbers that went,
/// ascending. Errs rather than give a table in which a kept string doesn't read back as it was.
pub fn prune_strings(text: &str, referenced: &BTreeSet<StringNum>) -> std::result::Result<(String, Vec<StringNum>), String> {
    let dropped: BTreeSet<StringNum> = scan(text).iter().map(|b| b.num).filter(|n| !referenced.contains(n)).collect();
    if dropped.is_empty() {
        return Ok((text.to_string(), Vec::new()));
    }
    let out = remove_strings(text, &dropped);
    let (before, back) = (strings(text), strings(&out));
    for (n, v) in &before {
        if referenced.contains(n) && back.get(n) != Some(v) {
            return Err(format!("string {n} wouldn't stay as it is; no strings were dropped."));
        }
    }
    if let Some(n) = dropped.iter().find(|n| back.contains_key(n)) {
        return Err(format!("string {n} wouldn't go; no strings were dropped."));
    }
    Ok((out, dropped.into_iter().collect()))
}

/// `text` with `blocks` added at the end as the World Editor writes them (wts.ts `appendStrings`).
fn append_strings(text: &str, blocks: &[(StringNum, String)], eol: &str) -> String {
    let mut out = text.to_string();
    if blocks.is_empty() {
        return out;
    }
    if !out.strip_prefix('\u{feff}').unwrap_or(&out).trim_matches(js_space).is_empty() {
        if !out.ends_with('\n') {
            out.push_str(eol);
        }
        // /\n[ \t]*\r?\n$/
        let t = &out[..out.len() - 1];
        let t = t.strip_suffix('\r').unwrap_or(t);
        if !t.trim_end_matches([' ', '\t']).ends_with('\n') {
            out.push_str(eol);
        }
    }
    for (n, v) in blocks {
        out.push_str(&format!("STRING {n}{eol}{{{eol}{}{eol}}}{eol}{eol}", v.replace('\n', eol)));
    }
    out
}

/// `text` with the recorded strings `referenced` names and the table lacks put back at the end,
/// with their old numbers and texts; and their numbers, ascending.
pub fn restore_pruned(text: &str, record: &BTreeMap<StringNum, String>, referenced: &BTreeSet<StringNum>)
    -> std::result::Result<(String, Vec<StringNum>), String> {
    let table = strings(text);
    let restored: Vec<StringNum> = record.keys().copied().filter(|n| referenced.contains(n) && !table.contains_key(n)).collect();
    if restored.is_empty() {
        return Ok((text.to_string(), restored));
    }
    let eol = if text.contains("\r\n") || !text.contains('\n') { "\r\n" } else { "\n" };
    let blocks: Vec<(StringNum, String)> = restored.iter().map(|n| (*n, record[n].replace("\r\n", "\n"))).collect();
    let out = append_strings(text, &blocks, eol);
    let back = strings(&out);
    for (n, v) in &blocks {
        if back.get(n).map(|b| b.replace("\r\n", "\n")).as_ref() != Some(v) {
            return Err(format!("pruned string {n} wouldn't read back as it was; nothing was restored."));
        }
    }
    for (n, v) in &table {
        if back.get(n) != Some(v) {
            return Err(format!("string {n} wouldn't stay as it is; nothing was restored."));
        }
    }
    Ok((out, restored))
}

/// The record of dropped strings in its file's text; errs when it isn't one.
pub fn parse_pruned_record(text: &str) -> std::result::Result<BTreeMap<StringNum, String>, String> {
    let doc: Value = serde_json::from_str(text).map_err(|_| format!("{PRUNED_STRINGS_FILE} isn't valid JSON."))?;
    let strings = match (doc.get("format").and_then(Value::as_str), doc.get("strings")) {
        (Some(PRUNED_FORMAT), Some(Value::Object(m))) => m,
        _ => return Err(format!("{PRUNED_STRINGS_FILE} isn't a record of pruned strings ({PRUNED_FORMAT}).")),
    };
    let mut out = BTreeMap::new();
    for (k, v) in strings {
        let num = (!k.is_empty() && k.bytes().all(|c| c.is_ascii_digit())).then(|| StringNum::from_digits(k));
        match (num, v.as_str()) {
            (Some(n), Some(v)) if n.value() <= MAX_SAFE => {
                out.insert(n, v.to_string());
            }
            _ => return Err(format!("{PRUNED_STRINGS_FILE} has an entry that isn't a string number with its text ({k:?}).")),
        }
    }
    Ok(out)
}

/// Every `TRIGSTR_<digits>` in `bytes`.
pub fn refs_in(bytes: &[u8], into: &mut BTreeSet<StringNum>) {
    let mut at = 0;
    while let Some(i) = find(bytes, b"TRIGSTR_", at) {
        let start = i + 8;
        let digits = bytes[start..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 {
            // ASCII digits are UTF-8.
            into.insert(StringNum::from_digits(std::str::from_utf8(&bytes[start..start + digits]).unwrap_or("0")));
        }
        at = start + digits;
    }
}

/// The dialogue keys a sounds document (w3proj.sounds JSON) names.
fn sound_keys_in(doc: &Value, into: &mut BTreeSet<StringNum>) {
    let Some(sounds) = doc.get("sounds").and_then(Value::as_array) else { return };
    for s in sounds {
        for key in ["dialogueTextKey", "speakerNameKey"] {
            if let Some(k) = s.get(key).and_then(Value::as_f64) {
                if k.is_finite() && k.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&k) {
                    into.insert(StringNum((k + 0.0).to_bits()));
                }
            }
        }
    }
}

const TEXT_EXTENSIONS: [&str; 9] = [".json", ".j", ".lua", ".txt", ".fdf", ".toc", ".ai", ".slk", ".ini"];

/// Every string number the map's files refer to (`files`: paths relative to `map/`, `/` between
/// folders). Errs when the sounds' keys can't be read.
pub fn map_string_refs(files: &BTreeMap<String, Vec<u8>>, codecs: &Registry) -> std::result::Result<BTreeSet<StringNum>, String> {
    let mut refs = BTreeSet::new();
    for (path, bytes) in files {
        let lower = path.replace('\\', "/").to_ascii_lowercase();
        if lower.ends_with(".wts") {
            continue;
        }
        let text_file = TEXT_EXTENSIONS.iter().any(|e| lower.ends_with(e));
        let raw_file = (lower.starts_with("war3map") || lower.starts_with("war3campaign")) && !lower.contains('/');
        if !text_file && !raw_file {
            continue;
        }
        refs_in(bytes, &mut refs);
        if lower == "war3map.w3s.json" {
            let doc: Value = serde_json::from_str(&String::from_utf8_lossy(bytes))
                .map_err(|_| format!("map/{path} is there but can't be read, so the strings its dialogue sounds use can't be told."))?;
            sound_keys_in(&doc, &mut refs);
        } else if lower == "war3map.w3s" {
            let doc = codecs
                .for_archive_name("war3map.w3s")
                .find_map(|c| c.decode("war3map.w3s", bytes).ok())
                .and_then(|json| serde_json::from_slice::<Value>(&json).ok())
                .ok_or_else(|| format!("map/{path} is kept raw and can't be read, so the strings its dialogue sounds use can't be told."))?;
            sound_keys_in(&doc, &mut refs);
        }
    }
    Ok(refs)
}

/// What pruning a project's strings did: `dropped` and `restored` numbers, or why nothing was
/// looked at (`kept`).
#[derive(Debug, Default, Serialize)]
pub struct PruneOutcome {
    pub dropped: Vec<StringNum>,
    pub restored: Vec<StringNum>,
    pub kept: Option<String>,
}

/// Prunes `files`' war3map.wts in place (`files`: the project's `map/` files; `record`: the text of
/// `.w3proj/pruned-strings.json`, `Ok(None)` when it isn't there, `Err` when it can't be read).
/// The project on disk isn't touched. Anything unreadable leaves the table as it is.
pub fn prune_files(files: &mut BTreeMap<String, Vec<u8>>, record: std::result::Result<Option<String>, String>, codecs: &Registry) -> PruneOutcome {
    let kept = |why: String| PruneOutcome { kept: Some(why), ..PruneOutcome::default() };
    let Some(name) = files.keys().find(|k| k.eq_ignore_ascii_case("war3map.wts")).cloned() else {
        return PruneOutcome::default();
    };
    let Ok(wts) = std::str::from_utf8(&files[&name]) else {
        return kept("war3map.wts isn't UTF-8 text".into());
    };
    let record = match record {
        Ok(None) => BTreeMap::new(),
        Ok(Some(text)) => match parse_pruned_record(&text) {
            Ok(r) => r,
            Err(e) => return kept(e),
        },
        Err(e) => return kept(e),
    };
    let refs = match map_string_refs(files, codecs) {
        Ok(r) => r,
        Err(e) => return kept(e),
    };
    let (text, restored) = match restore_pruned(wts, &record, &refs) {
        Ok(r) => r,
        Err(e) => return kept(e),
    };
    let (text, dropped) = match prune_strings(&text, &refs) {
        Ok(r) => r,
        Err(e) => return kept(e),
    };
    if text.as_bytes() != &files[&name][..] {
        files.insert(name, text.into_bytes());
    }
    PruneOutcome { dropped, restored, kept: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(n: u32, text: &str) -> String {
        format!("STRING {n}\r\n{{\r\n{text}\r\n}}\r\n\r\n")
    }
    fn nums(v: &[u64]) -> BTreeSet<StringNum> {
        v.iter().map(|&n| StringNum::from_u64(n)).collect()
    }
    fn list(v: &[StringNum]) -> Vec<f64> {
        v.iter().map(|n| n.value()).collect()
    }

    #[test]
    fn unreferenced_strings_go_the_rest_byte_for_byte() {
        let wts = format!("\u{feff}{}{}{}{}{}", block(1, "Player 1"), block(3, "orphan"), block(2, "Force 1"), block(40, "forty"), block(7, "Seven"));
        let (out, dropped) = prune_strings(&wts, &nums(&[1, 2, 7, 99])).unwrap();
        assert_eq!(list(&dropped), [3.0, 40.0]);
        assert_eq!(out, format!("\u{feff}{}{}{}", block(1, "Player 1"), block(2, "Force 1"), block(7, "Seven")));
        // Nothing to drop: the text itself.
        assert_eq!(prune_strings(&out, &nums(&[1, 2, 7])).unwrap(), (out.clone(), vec![]));
    }

    #[test]
    fn comments_lf_repeated_numbers_and_unclosed_blocks() {
        let wts = "STRING 5\n// a comment\n{\nline one\nline two\n}\nSTRING 6\n{\ngone\n}\nSTRING 5\n{\nagain\n}";
        let (out, dropped) = prune_strings(wts, &nums(&[5])).unwrap();
        assert_eq!(list(&dropped), [6.0]);
        assert_eq!(out, "STRING 5\n// a comment\n{\nline one\nline two\n}\nSTRING 5\n{\nagain\n}");
        // A `}` ending a text line right before the next header ends the block there.
        let unclosed = "STRING 1\n{\nfirst}\nSTRING 2\n{\nsecond\n}\n";
        assert_eq!(strings(unclosed).get(&StringNum::from_u64(1)).map(String::as_str), Some("first"));
        let (out, _) = prune_strings(unclosed, &nums(&[2])).unwrap();
        assert_eq!(out, "STRING 2\n{\nsecond\n}\n");
        // A last block with no end stays.
        let open = format!("{}STRING 2\r\n{{\r\nno end", block(1, "orphan"));
        assert_eq!(prune_strings(&open, &nums(&[])).unwrap().0, "STRING 2\r\n{\r\nno end");
    }

    #[test]
    fn numbers_as_javascript_reads_them() {
        let wts = format!("{}{}", block(7, "seven"), block(8, "eight"));
        let mut refs = BTreeSet::new();
        refs_in(b"call X(\"TRIGSTR_0007\") TRIGSTR_ TRIGSTR_x", &mut refs);
        assert_eq!(list(&refs.iter().copied().collect::<Vec<_>>()), [7.0]);
        assert_eq!(list(&prune_strings(&wts, &refs).unwrap().1), [8.0]);
    }

    #[test]
    fn recorded_strings_come_back_when_referenced_and_missing() {
        let wts = format!("\u{feff}{}{}", block(1, "one"), block(2, "two"));
        let record = parse_pruned_record(r#"{"format":"w3proj.prunedStrings/1","strings":{"2":"old two","5":"five\nsecond","7":"seven"}}"#).unwrap();
        let (out, restored) = restore_pruned(&wts, &record, &nums(&[1, 2, 5])).unwrap();
        assert_eq!(list(&restored), [5.0]);
        assert_eq!(out, format!("{wts}STRING 5\r\n{{\r\nfive\r\nsecond\r\n}}\r\n\r\n"));
        for bad in ["", "[]", "{}", r#"{"format":"x","strings":{}}"#, r#"{"format":"w3proj.prunedStrings/1","strings":{"-1":"a"}}"#,
            r#"{"format":"w3proj.prunedStrings/1","strings":{"1":2}}"#, r#"{"format":"w3proj.prunedStrings/1","strings":{"99999999999999999999":"a"}}"#] {
            assert!(parse_pruned_record(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn anything_unreadable_keeps_the_table() {
        let codecs = Registry::default();
        let wts = format!("{}{}", block(1, "one"), block(2, "orphan"));
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        files.insert("war3map.wts".into(), wts.clone().into_bytes());
        files.insert("war3map.w3i.json".into(), br#"{"name":"TRIGSTR_001"}"#.to_vec());
        // The control: everything readable, 2 goes.
        let mut ok = files.clone();
        let r = prune_files(&mut ok, Ok(None), &codecs);
        assert_eq!((list(&r.dropped), r.kept), (vec![2.0], None));
        assert_eq!(ok["war3map.wts"], block(1, "one").into_bytes());
        for (what, record, extra) in [
            ("record", Ok(Some("{ not json".to_string())), None),
            ("record read", Err("can't read".to_string()), None),
            ("sounds", Ok(None), Some(("war3map.w3s.json", b"{ not json".to_vec()))),
            ("raw sounds", Ok(None), Some(("war3map.w3s", b"garbage".to_vec()))),
        ] {
            let mut f = files.clone();
            if let Some((p, b)) = extra {
                f.insert(p.into(), b);
            }
            let r = prune_files(&mut f, record, &codecs);
            assert!(r.kept.is_some() && r.dropped.is_empty(), "{what}");
            assert_eq!(f["war3map.wts"], wts.as_bytes(), "{what}");
        }
        let mut f = files.clone();
        f.insert("war3map.wts".into(), vec![0xff, 0xfe, b'S']);
        assert!(prune_files(&mut f, Ok(None), &codecs).kept.is_some());
    }

    #[test]
    fn dialogue_keys_count() {
        let codecs = Registry::default();
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        files.insert("war3map.wts".into(), format!("{}{}{}", block(6, "text"), block(7, "speaker"), block(8, "orphan")).into_bytes());
        files.insert("war3map.w3s.json".into(), br#"{"sounds":[{"dialogueTextKey":6,"speakerNameKey":7.0},{"dialogueTextKey":-1}]}"#.to_vec());
        assert_eq!(list(&prune_files(&mut files, Ok(None), &codecs).dropped), [8.0]);
    }

    #[test]
    fn stray_carriage_returns_stay_where_they_are() {
        // The fixture the app's TypeScript reads too (wts.test.ts, "stray carriage returns"): `\r\r\n` and `\r\r`
        // inside texts, after a comment, before and after a `}` line, after a header. They read as part of the text;
        // a drop keeps every other byte.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/wts-crcrlf/war3map.wts");
        let text = std::fs::read_to_string(path).unwrap();
        assert_eq!(text.matches("\r\r\n").count(), 6);
        let table = strings(&text);
        let read: Vec<(f64, &str)> = table.iter().map(|(n, v)| (n.value(), v.as_str())).collect();
        assert_eq!(read, [
            (1.0, "The bounces does half the \r\r\ndamage of the original explosion."),
            (2.0, "To edit"),
            (3.0, "for the first time in years. \r\rIn the quiet calm of..."),
            (4.0, "ends in one\r"),
            (5.0, "after a header"),
            (6.0, "last"),
        ]);
        let cut = |s: &str, a: &str, b: &str| format!("{}{}", &s[..s.find(a).unwrap()], &s[s.find(b).unwrap()..]);
        let (out, dropped) = prune_strings(&text, &nums(&[1, 3, 5, 6])).unwrap();
        assert_eq!(list(&dropped), [2.0, 4.0]);
        assert_eq!(out, cut(&cut(&text, "STRING 2", "STRING 3"), "STRING 4", "STRING 5"));
        // Nothing to drop: the file's own bytes.
        assert_eq!(prune_strings(&text, &nums(&[1, 2, 3, 4, 5, 6])).unwrap().0, text);
    }

    #[test]
    fn a_long_run_of_comment_lines_is_read_once() {
        // Every comment line starts a header search; the run is read once, not once per line.
        let mut wts = String::from("STRING 1\n");
        for _ in 0..200_000 {
            wts.push_str("// STRING 2 \n");
        }
        let started = std::time::Instant::now();
        assert!(strings(&wts).is_empty());
        assert!(started.elapsed().as_secs() < 10, "took {:?}", started.elapsed());
    }
}
