//! `war3map.wct` (custom script texts): the map's custom script header and each trigger's text,
//! `parse`d and `write`n for the folders of `map/triggers/` (`crate::trigger_layout`, a file per
//! text).
//!
//! A text whose stored length is 0 is "no text"; an empty text is stored as a lone zero byte. A text is
//! taken by its stored length, so zero bytes inside it (padding, as the Frostwolf Clan map has)
//! stay; only the last byte must be the terminating zero. Layouts:
//! Reforged: marker, version, comment, header, texts until the end (no count). Classic:
//! version (0/1), [comment, header,] count, texts.

use crate::{Error, Result};

const MARKER: u32 = 0x8000_0004;

/// A decoded `war3map.wct`. Strings are `crate::lossless` text: `lossless::encode` gives the
/// stored bytes back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wct {
    pub reforged: bool,
    pub version: u32,
    pub comment: String,
    /// Absent in classic version 0; `Some(None)`: the slot is there, with no text.
    pub header: Option<Option<String>>,
    /// One per trigger with a text slot (types 8 and 32 in war3map.wtg's order); `None`: no text.
    pub texts: Vec<Option<String>>,
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
        Ok(crate::lossless::decode(&rest[..n]))
    }
    /// Length-prefixed text; the length counts the terminating zero, which must be there. Zero
    /// bytes before it belong to the text.
    fn text(&mut self) -> Result<Option<String>> {
        let n = self.u32()? as usize;
        if n == 0 {
            return Ok(None);
        }
        let s = self.b.get(self.o..self.o.saturating_add(n)).ok_or_else(|| err("truncated text"))?;
        self.o += n;
        if s[n - 1] != 0 {
            return Err(err("text without its terminating zero"));
        }
        Ok(Some(crate::lossless::decode(&s[..n - 1])))
    }
    fn done(&self) -> bool {
        self.o >= self.b.len()
    }
}

/// Binary → structure.
pub fn parse(b: &[u8]) -> Result<Wct> {
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

/// Structure → binary.
pub fn write(w: &Wct) -> Vec<u8> {
    let mut out = Vec::new();
    let text = |out: &mut Vec<u8>, t: &Option<String>| match t {
        None => out.extend_from_slice(&0u32.to_le_bytes()),
        Some(s) => {
            let bytes = crate::lossless::encode(s);
            out.extend_from_slice(&(bytes.len() as u32 + 1).to_le_bytes());
            out.extend_from_slice(&bytes);
            out.push(0);
        }
    };
    if w.reforged {
        out.extend_from_slice(&MARKER.to_le_bytes());
    }
    out.extend_from_slice(&w.version.to_le_bytes());
    if w.reforged || w.version >= 1 {
        out.extend_from_slice(&crate::lossless::encode(&w.comment));
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
            assert_eq!(write(&parse(&b).unwrap()), b);
        }
    }

    /// Frostwolf Clan's texts end in padding zeros before the terminating one: the stored length
    /// says where a text ends, so they belong to it and come back.
    #[test]
    fn zero_bytes_inside_a_text_are_kept() {
        let mut b = Vec::new();
        b.extend_from_slice(&0x8000_0004u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(0); // comment
        b.extend_from_slice(&0u32.to_le_bytes()); // header: no text
        let text = b"endlibrary\0\0\0";
        b.extend_from_slice(&(text.len() as u32).to_le_bytes());
        b.extend_from_slice(text);
        let w = parse(&b).unwrap();
        assert_eq!(w.texts, vec![Some("endlibrary\0\0".to_string())]);
        assert_eq!(write(&w), b);
        // Control: the terminating zero itself is still required.
        let mut cut = b.clone();
        *cut.last_mut().unwrap() = b'x';
        assert!(parse(&cut).is_err());
    }

    #[test]
    fn code_pages_stay_in_the_texts() {
        // Comment, header and a trigger text with CP949 bytes.
        let mut b = Vec::new();
        b.extend_from_slice(&0x8000_0004u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(b"c \xC7\xD1\0");
        for text in [&b"// \xC7\xD1\xB1\xB9\0"[..], b"x\xFF\0"] {
            b.extend_from_slice(&(text.len() as u32).to_le_bytes());
            b.extend_from_slice(text);
        }
        let w = parse(&b).unwrap();
        assert!(w.texts.iter().flatten().all(|t| t.chars().any(|c| ('\u{10FF00}'..='\u{10FFFF}').contains(&c))), "{:?}", w.texts);
        assert_eq!(write(&w), b);
    }
}
