//! `war3map.wct` (custom script texts) as one text file: the map's custom script header and
//! each trigger's text, separated by marker lines, so git diffs show the code itself.
//!
//! ```text
//! //== war3map.wct: version 1, reforged, comment "" ==
//! //== header ==
//! <custom script code>
//! //== trigger 0: Melee Initialization ==
//! <text of the first trigger with a text slot>
//! //== trigger 1 (no text): Another Trigger ==
//! ```
//!
//! Lines end with the texts' own line break (CRLF when any text uses it). A text whose
//! stored length is 0 is "(no text)"; an empty text is stored as a lone zero byte. Layouts:
//! Reforged: marker, version, comment, header, texts until the end (no count). Classic:
//! version (0/1), [comment, header,] count, texts. The trigger names come from war3map.wtg
//! (`with_names`, when it could be read); they are comments, ignored when packing.

use crate::{Error, Result};

const MARKER: u32 = 0x8000_0004;

struct Wct {
    reforged: bool,
    version: u32,
    comment: String,
    /// Absent in classic version 0.
    header: Option<Option<String>>,
    texts: Vec<Option<String>>,
}

fn err(m: impl Into<String>) -> Error {
    Error::Format(format!("war3map.wct: {}", m.into()))
}

struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Result<u32> {
        let s = self.b.get(self.o..self.o + 4).ok_or_else(|| err("truncated"))?;
        self.o += 4;
        Ok(u32::from_le_bytes(s.try_into().unwrap()))
    }
    fn cstr(&mut self) -> Result<String> {
        let rest = &self.b[self.o..];
        let n = rest.iter().position(|&c| c == 0).ok_or_else(|| err("unterminated string"))?;
        self.o += n + 1;
        String::from_utf8(rest[..n].to_vec()).map_err(|_| err("comment isn't UTF-8"))
    }
    /// Length-prefixed text; the length counts the terminating zero, which must be there.
    fn text(&mut self) -> Result<Option<String>> {
        let n = self.u32()? as usize;
        if n == 0 {
            return Ok(None);
        }
        let s = self.b.get(self.o..self.o + n).ok_or_else(|| err("truncated text"))?;
        self.o += n;
        if s[n - 1] != 0 || s[..n - 1].contains(&0) {
            return Err(err("text without its terminating zero"));
        }
        String::from_utf8(s[..n - 1].to_vec()).map(Some).map_err(|_| err("text isn't UTF-8"))
    }
    fn done(&self) -> bool {
        self.o >= self.b.len()
    }
}

fn parse(b: &[u8]) -> Result<Wct> {
    let mut r = Reader { b, o: 0 };
    let first = r.u32()?;
    let mut w = Wct { reforged: first == MARKER, version: first, comment: String::new(), header: None, texts: Vec::new() };
    if w.reforged {
        w.version = r.u32()?;
        w.comment = r.cstr()?;
        w.header = Some(r.text()?);
        while !r.done() {
            w.texts.push(r.text()?);
        }
    } else {
        if w.version > 1 {
            return Err(err(format!("unknown version {}", w.version)));
        }
        if w.version == 1 {
            w.comment = r.cstr()?;
            w.header = Some(r.text()?);
        }
        let n = r.u32()?;
        for _ in 0..n {
            w.texts.push(r.text()?);
        }
        if !r.done() {
            return Err(err("bytes after the texts"));
        }
    }
    Ok(w)
}

fn write(w: &Wct) -> Vec<u8> {
    let mut out = Vec::new();
    let text = |out: &mut Vec<u8>, t: &Option<String>| match t {
        None => out.extend_from_slice(&0u32.to_le_bytes()),
        Some(s) => {
            out.extend_from_slice(&(s.len() as u32 + 1).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
            out.push(0);
        }
    };
    if w.reforged {
        out.extend_from_slice(&MARKER.to_le_bytes());
    }
    out.extend_from_slice(&w.version.to_le_bytes());
    if w.reforged || w.version >= 1 {
        out.extend_from_slice(w.comment.as_bytes());
        out.push(0);
    }
    if let Some(h) = &w.header {
        text(&mut out, h);
    }
    if !w.reforged {
        out.extend_from_slice(&(w.texts.len() as u32).to_le_bytes());
    }
    for t in &w.texts {
        text(&mut out, t);
    }
    out
}

/// Binary → text form (sections numbered).
pub fn to_text(bytes: &[u8]) -> Result<Vec<u8>> {
    render(&parse(bytes)?, &[])
}

/// The text form with each trigger section named (`names`: the wtg's triggers with a text slot,
/// in order; line breaks in names become spaces).
pub fn with_names(text: &[u8], names: &[String]) -> Result<Vec<u8>> {
    render(&parse_text(text)?, names)
}

fn render(w: &Wct, names: &[String]) -> Result<Vec<u8>> {
    let mut all = w.header.iter().flatten().chain(w.texts.iter().flatten());
    let eol = if all.any(|t| t.contains("\r\n")) { "\r\n" } else { "\n" };
    let comment = serde_json::to_string(&w.comment).map_err(|e| err(e.to_string()))?;
    let mut s = format!("//== war3map.wct: version {}{}", w.version, if w.reforged { ", reforged" } else { "" });
    if w.reforged || w.version >= 1 {
        s += &format!(", comment {}", comment);
    }
    s += " ==";
    s += eol;
    let mut put = |name: String, t: &Option<String>, label: Option<&String>| {
        s += &format!("//== {name}{}", if t.is_none() { " (no text)" } else { "" });
        if let Some(l) = label.filter(|l| !l.is_empty()) {
            s += ": ";
            s += &l.replace(['\r', '\n'], " ");
        }
        s += " ==";
        s += eol;
        if let Some(t) = t {
            s += t;
            s += eol;
        }
    };
    if let Some(h) = &w.header {
        put("header".into(), h, None);
    }
    for (k, t) in w.texts.iter().enumerate() {
        put(format!("trigger {k}"), t, names.get(k));
    }
    Ok(s.into_bytes())
}

/// Text form → binary.
pub fn from_text(bytes: &[u8]) -> Result<Vec<u8>> {
    Ok(write(&parse_text(bytes)?))
}

fn parse_text(bytes: &[u8]) -> Result<Wct> {
    let s = std::str::from_utf8(bytes).map_err(|_| err("text form isn't UTF-8"))?;
    let first_end = s.find('\n').ok_or_else(|| err("no first line"))?;
    let eol = if s[..first_end].ends_with('\r') { "\r\n" } else { "\n" };
    let first = s[..first_end].trim_end_matches('\r');
    let head = first
        .strip_prefix("//== war3map.wct: version ")
        .and_then(|r| r.strip_suffix(" =="))
        .ok_or_else(|| err("first line isn't a war3map.wct line"))?;
    let (version, rest) = head.split_at(head.find(|c: char| !c.is_ascii_digit()).unwrap_or(head.len()));
    let mut w = Wct {
        reforged: rest.starts_with(", reforged"),
        version: version.parse().map_err(|_| err("bad version"))?,
        comment: String::new(),
        header: None,
        texts: Vec::new(),
    };
    if let Some(i) = rest.find(", comment ") {
        w.comment = serde_json::from_str(&rest[i + 10..]).map_err(|_| err("bad comment"))?;
    }

    // Sections: a marker line, then the text up to the line break before the next marker.
    let body = &s[first_end + 1..];
    let mut marks: Vec<(usize, usize, String, bool)> = Vec::new(); // (start, text start, name, has text)
    let mut at = 0;
    for line in body.split_inclusive('\n') {
        let l = line.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(m) = l.strip_prefix("//== ").and_then(|r| r.strip_suffix(" ==")) {
            // "header" or "trigger <n>", then " (no text)", then ": <trigger name>" (a comment).
            let (name, rest) = if let Some(r) = m.strip_prefix("header") {
                ("header".to_string(), r)
            } else if let Some(r) = m.strip_prefix("trigger ") {
                let digits = r.find(|c: char| !c.is_ascii_digit()).unwrap_or(r.len());
                (format!("trigger {}", &r[..digits]), if digits == 0 { "x" } else { &r[digits..] })
            } else {
                (String::new(), "x")
            };
            let (none, rest) = match rest.strip_prefix(" (no text)") {
                Some(r) => (true, r),
                None => (false, rest),
            };
            if rest.is_empty() || (rest.starts_with(": ") && name != "header") {
                marks.push((at, at + line.len(), name, !none));
            }
        }
        at += line.len();
    }
    for (k, (_, from, name, has)) in marks.iter().enumerate() {
        let to = marks.get(k + 1).map_or(body.len(), |m| m.0);
        let t = if *has {
            let chunk = &body[*from..to];
            Some(chunk.strip_suffix(eol).ok_or_else(|| err(format!("{name}: text doesn't end with a line break")))?.to_string())
        } else {
            if *from != to {
                return Err(err(format!("{name}: text after \"(no text)\"")));
            }
            None
        };
        if name == "header" {
            if k != 0 {
                return Err(err("header isn't first"));
            }
            w.header = Some(t);
        } else {
            if *name != format!("trigger {}", w.texts.len()) {
                return Err(err(format!("{name}: expected trigger {}", w.texts.len())));
            }
            w.texts.push(t);
        }
    }
    if marks.first().map_or(body.len(), |m| m.0) != 0 {
        return Err(err("text before the first section"));
    }
    if (w.reforged || w.version >= 1) != w.header.is_some() {
        return Err(err("header section doesn't match the version"));
    }
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bin(reforged: bool, version: u32, header: Option<Option<&str>>, texts: &[Option<&str>]) -> Vec<u8> {
        write(&Wct {
            reforged,
            version,
            comment: if reforged || version >= 1 { "c \"q\"".into() } else { String::new() },
            header: header.map(|h| h.map(String::from)),
            texts: texts.iter().map(|t| t.map(String::from)).collect(),
        })
    }

    #[test]
    fn round_trips() {
        let cases = [
            bin(true, 1, Some(Some("// header\r\nfunction A takes nothing returns nothing\r\nendfunction\r\n")), &[None, Some(""), Some("x\r\n\r\n"), Some("//== trigger 9 ==x")]),
            bin(true, 1, Some(None), &[]),
            bin(false, 1, Some(Some("h\n")), &[Some("a"), None]),
            bin(false, 0, None, &[Some("only\n"), Some("")]),
        ];
        for b in cases {
            let t = to_text(&b).unwrap();
            assert_eq!(from_text(&t).unwrap(), b, "{}", String::from_utf8_lossy(&t));
        }
    }

    #[test]
    fn readable() {
        let t = to_text(&bin(true, 1, Some(Some("h\r\n")), &[None, Some("a\r\nb")])).unwrap();
        assert_eq!(
            String::from_utf8(t).unwrap(),
            "//== war3map.wct: version 1, reforged, comment \"c \\\"q\\\"\" ==\r\n//== header ==\r\nh\r\n\r\n//== trigger 0 (no text) ==\r\n//== trigger 1 ==\r\na\r\nb\r\n"
        );
    }

    #[test]
    fn names_are_comments() {
        let b = bin(true, 1, Some(Some("h")), &[Some("a"), None]);
        let named = with_names(&to_text(&b).unwrap(), &["Melee Init".into(), "Two\nLines".into()]).unwrap();
        let t = String::from_utf8(named.clone()).unwrap();
        assert!(t.contains("//== trigger 0: Melee Init ==\n") && t.contains("//== trigger 1 (no text): Two Lines ==\n"), "{t}");
        assert_eq!(from_text(&named).unwrap(), b);
    }

    #[test]
    fn ambiguous_text_is_rejected_by_the_round_trip() {
        // A text containing a marker line can't be told apart: the codec check then keeps the file raw.
        let b = bin(true, 1, Some(Some("")), &[Some("a\n//== trigger 1 ==\nb")]);
        assert!(from_text(&to_text(&b).unwrap()).map_or(true, |x| x != b));
    }
}
