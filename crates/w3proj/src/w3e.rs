//! `war3map.w3e` (terrain) as text: one grid per field, so a git diff shows which rows of
//! which field changed. Same text as `app/src/lib/terrain/w3etext.ts`.
//!
//! ```text
//! W3E version 12
//! tileset L
//! custom-tilesets 1
//! ground Ldrt Ldro Lgrs
//! cliffs CLdi CLgr
//! corners 97 97
//! offset -6272 -6272
//!
//! [height]
//! 0*40 12 16 16 0*55
//! …
//! [layer] all 2
//! ```
//!
//! Every grid has one line per row of corners, from north (top) to south, so it reads like
//! the map. Numbers (`height`, `water`) are separated by spaces, with `value*count` for runs
//! of three or more; the other fields are one character per corner (0–9, a–z, A–Z, `+`, `/`
//! for 0–63). A grid whose corners all hold the same value is written as `[name] all value`.
//!
//! Fields: `height` ground height (stored value − 0x2000, quarter world units), `water`
//! water level (bits 0–13 − 0x2000), `water-bits` (bits 14–15 of the water word, meaning
//! unknown), `texture`, `variation`, `cliff-variation`, `cliff-texture`, `layer`, `flags`
//! (1 ramp, 2 blight, 4 water, 8 boundary), and for version 12 `texture-bits` (bits 10–15
//! of the texture word) when any is set. Bytes after the corners go into `[trailer]` as hex.
//! Tile ids that aren't printable ASCII are written as `hex:XXXXXXXX` (their 4 bytes).

use crate::{Error, Result};

const DIGITS: &[u8; 64] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";

fn err(m: impl Into<String>) -> Error {
    Error::Format(format!("war3map.w3e: {}", m.into()))
}

#[derive(Default, Clone, Copy)]
struct Corner {
    height: i16,
    water: u16,
    texture: u8,
    flags: u8,
    texture_bits: u8,
    variation: u8,
    cliff_variation: u8,
    cliff_texture: u8,
    layer: u8,
}

struct Terrain {
    version: u32,
    tileset: u8,
    custom_tilesets: u32,
    ground: Vec<[u8; 4]>,
    cliffs: Vec<[u8; 4]>,
    width: usize,
    height: usize,
    offset: [f32; 2],
    corners: Vec<Corner>,
    trailer: Vec<u8>,
}

fn parse(b: &[u8]) -> Result<Terrain> {
    let u32_at = |o: usize| -> Result<u32> {
        b.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())).ok_or_else(|| err("truncated"))
    };
    if b.get(0..4) != Some(b"W3E!") {
        return Err(err("missing W3E! header"));
    }
    let version = u32_at(4)?;
    if version != 11 && version != 12 {
        return Err(err(format!("unsupported version {version}")));
    }
    let tileset = *b.get(8).ok_or_else(|| err("truncated"))?;
    let custom_tilesets = u32_at(9)?;
    let mut p = 13;
    let list = |p: &mut usize| -> Result<Vec<[u8; 4]>> {
        let n = u32_at(*p)? as usize;
        *p += 4;
        let s = b.get(*p..*p + n * 4).ok_or_else(|| err("truncated tile list"))?;
        *p += n * 4;
        Ok(s.chunks(4).map(|c| c.try_into().unwrap()).collect())
    };
    let ground = list(&mut p)?;
    let cliffs = list(&mut p)?;
    let width = u32_at(p)? as usize;
    let height = u32_at(p + 4)? as usize;
    let offset = [f32::from_bits(u32_at(p + 8)?), f32::from_bits(u32_at(p + 12)?)];
    p += 16;
    let per = if version == 12 { 8 } else { 7 };
    let n = width.checked_mul(height).ok_or_else(|| err("size overflow"))?;
    let end = n.checked_mul(per).and_then(|size| size.checked_add(p)).ok_or_else(|| err("size overflow"))?;
    let body = b.get(p..end).ok_or_else(|| err(format!("truncated: {width}×{height} corners")))?;
    let corners = body
        .chunks(per)
        .map(|c| {
            let (texture, flags, texture_bits) = if version == 12 {
                let t = u16::from_le_bytes([c[4], c[5]]);
                ((t & 0x3f) as u8, ((t >> 6) & 0xf) as u8, (t >> 10) as u8)
            } else {
                (c[4] & 0xf, c[4] >> 4, 0)
            };
            Corner {
                height: i16::from_le_bytes([c[0], c[1]]),
                water: u16::from_le_bytes([c[2], c[3]]),
                texture,
                flags,
                texture_bits,
                variation: c[per - 2] & 0x1f,
                cliff_variation: c[per - 2] >> 5,
                cliff_texture: c[per - 1] >> 4,
                layer: c[per - 1] & 0xf,
            }
        })
        .collect();
    Ok(Terrain {
        version,
        tileset,
        custom_tilesets,
        ground,
        cliffs,
        width,
        height,
        offset,
        corners,
        trailer: b[p + n * per..].to_vec(),
    })
}

fn write(t: &Terrain) -> Vec<u8> {
    let per = if t.version == 12 { 8 } else { 7 };
    let mut out = Vec::with_capacity(13 + 8 + (t.ground.len() + t.cliffs.len()) * 4 + 16 + t.corners.len() * per);
    out.extend_from_slice(b"W3E!");
    out.extend_from_slice(&t.version.to_le_bytes());
    out.push(t.tileset);
    out.extend_from_slice(&t.custom_tilesets.to_le_bytes());
    for list in [&t.ground, &t.cliffs] {
        out.extend_from_slice(&(list.len() as u32).to_le_bytes());
        list.iter().for_each(|id| out.extend_from_slice(id));
    }
    out.extend_from_slice(&(t.width as u32).to_le_bytes());
    out.extend_from_slice(&(t.height as u32).to_le_bytes());
    out.extend_from_slice(&t.offset[0].to_le_bytes());
    out.extend_from_slice(&t.offset[1].to_le_bytes());
    for c in &t.corners {
        out.extend_from_slice(&c.height.to_le_bytes());
        out.extend_from_slice(&c.water.to_le_bytes());
        if t.version == 12 {
            let w = c.texture as u16 | (c.flags as u16) << 6 | (c.texture_bits as u16) << 10;
            out.extend_from_slice(&w.to_le_bytes());
        } else {
            out.push(c.texture | c.flags << 4);
        }
        out.push(c.variation | c.cliff_variation << 5);
        out.push(c.cliff_texture << 4 | c.layer);
    }
    out.extend_from_slice(&t.trailer);
    out
}

/// A grid field: how it's read from and written to a corner, and whether it's a number grid.
struct Field {
    name: &'static str,
    numbers: bool,
    /// Largest value of a character grid.
    max: u8,
    get: fn(&Corner) -> i32,
    set: fn(&mut Corner, i32),
}

const FIELDS: &[Field] = &[
    Field { name: "height", numbers: true, max: 0, get: |c| c.height as i32 - 0x2000, set: |c, v| c.height = (v + 0x2000) as i16 },
    Field { name: "water", numbers: true, max: 0, get: |c| (c.water & 0x3fff) as i32 - 0x2000, set: |c, v| c.water = c.water & 0xc000 | (v + 0x2000) as u16 },
    Field { name: "water-bits", numbers: false, max: 3, get: |c| (c.water >> 14) as i32, set: |c, v| c.water = c.water & 0x3fff | (v as u16) << 14 },
    Field { name: "texture", numbers: false, max: 63, get: |c| c.texture as i32, set: |c, v| c.texture = v as u8 },
    Field { name: "variation", numbers: false, max: 31, get: |c| c.variation as i32, set: |c, v| c.variation = v as u8 },
    Field { name: "cliff-variation", numbers: false, max: 7, get: |c| c.cliff_variation as i32, set: |c, v| c.cliff_variation = v as u8 },
    Field { name: "cliff-texture", numbers: false, max: 15, get: |c| c.cliff_texture as i32, set: |c, v| c.cliff_texture = v as u8 },
    Field { name: "layer", numbers: false, max: 15, get: |c| c.layer as i32, set: |c, v| c.layer = v as u8 },
    Field { name: "flags", numbers: false, max: 15, get: |c| c.flags as i32, set: |c, v| c.flags = v as u8 },
    Field { name: "texture-bits", numbers: false, max: 63, get: |c| c.texture_bits as i32, set: |c, v| c.texture_bits = v as u8 },
];

/// Number ranges of the number grids (stored value minus the 0x2000 offset).
fn number_range(name: &str) -> (i32, i32) {
    if name == "height" {
        (-0x8000 - 0x2000, 0x7fff - 0x2000)
    } else {
        (-0x2000, 0x3fff - 0x2000)
    }
}

/// Unprintable ids (e.g. four zero bytes in (10)DustwallowKeys) as `hex:XXXXXXXX`: always 12
/// characters, so never mistaken for a 4-character id.
fn id_text(id: &[u8; 4]) -> Result<String> {
    if id.iter().all(|c| c.is_ascii_graphic()) {
        Ok(String::from_utf8(id.to_vec()).unwrap())
    } else {
        Ok(format!("hex:{}", id.iter().map(|b| format!("{b:02x}")).collect::<String>()))
    }
}

fn id_parse(id: &str) -> Result<[u8; 4]> {
    if let Ok(b) = id.as_bytes().try_into() {
        return Ok(b);
    }
    let bad = || err(format!("tile id \"{id}\" isn't 4 characters or hex:XXXXXXXX"));
    let hex = id.strip_prefix("hex:").filter(|h| h.len() == 8).ok_or_else(bad)?;
    let mut out = [0u8; 4];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| bad())?;
    }
    Ok(out)
}

/// Offsets are written as integers when they are whole numbers, otherwise as their bits.
fn float_text(v: f32) -> String {
    if v.fract() == 0.0 && v.abs() < 1e7 && !(v == 0.0 && v.is_sign_negative()) {
        format!("{}", v as i64)
    } else {
        format!("bits:{:08x}", v.to_bits())
    }
}

fn parse_float(s: &str) -> Result<f32> {
    match s.strip_prefix("bits:") {
        Some(h) => u32::from_str_radix(h, 16).map(f32::from_bits).map_err(|_| err(format!("bad offset {s}"))),
        None => s.parse::<i64>().map(|v| v as f32).map_err(|_| err(format!("bad offset {s}"))),
    }
}

pub fn to_text(bytes: &[u8]) -> Result<Vec<u8>> {
    let t = parse(bytes)?;
    if !t.tileset.is_ascii_graphic() {
        return Err(err("tileset isn't a printable character"));
    }
    let ids = |l: &[[u8; 4]]| l.iter().map(id_text).collect::<Result<Vec<_>>>().map(|v| v.join(" "));
    let mut s = format!(
        "W3E version {}\ntileset {}\ncustom-tilesets {}\nground {}\ncliffs {}\ncorners {} {}\noffset {} {}\n",
        t.version,
        t.tileset as char,
        t.custom_tilesets,
        ids(&t.ground)?,
        ids(&t.cliffs)?,
        t.width,
        t.height,
        float_text(t.offset[0]),
        float_text(t.offset[1]),
    );
    for f in FIELDS {
        let values: Vec<i32> = t.corners.iter().map(f.get).collect();
        if f.name == "texture-bits" && (t.version != 12 || values.iter().all(|&v| v == 0)) {
            continue;
        }
        s.push('\n');
        if let Some(&first) = values.first().filter(|&&v| values.iter().all(|&x| x == v)) {
            let v = if f.numbers { first.to_string() } else { (DIGITS[first as usize] as char).to_string() };
            s.push_str(&format!("[{}] all {v}\n", f.name));
            continue;
        }
        s.push_str(&format!("[{}]\n", f.name));
        for row in values.chunks(t.width.max(1)).rev() {
            if f.numbers {
                let mut tokens = Vec::new();
                let mut i = 0;
                while i < row.len() {
                    let run = row[i..].iter().take_while(|&&v| v == row[i]).count();
                    if run >= 3 {
                        tokens.push(format!("{}*{run}", row[i]));
                    } else {
                        tokens.extend(std::iter::repeat_n(row[i].to_string(), run));
                    }
                    i += run;
                }
                s.push_str(&tokens.join(" "));
            } else {
                s.extend(row.iter().map(|&v| DIGITS[v as usize] as char));
            }
            s.push('\n');
        }
    }
    if !t.trailer.is_empty() {
        s.push_str("\n[trailer]\n");
        s.extend(t.trailer.iter().map(|b| format!("{b:02x}")));
        s.push('\n');
    }
    Ok(s.into_bytes())
}

fn digit(c: char, max: u8) -> Result<i32> {
    match DIGITS.iter().position(|&d| d as char == c) {
        Some(v) if v <= max as usize => Ok(v as i32),
        _ => Err(err(format!("'{c}' isn't a value from 0 to {max}"))),
    }
}

pub fn from_text(bytes: &[u8]) -> Result<Vec<u8>> {
    let text = std::str::from_utf8(bytes).map_err(|_| err("not UTF-8"))?;
    // Header keys, then sections; blank lines and `#` comments anywhere.
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.trim().is_empty() && !l.starts_with('#')).peekable();
    let mut head = std::collections::HashMap::new();
    while let Some(l) = lines.next_if(|l| !l.starts_with('[')) {
        let (k, v) = l.split_once(' ').unwrap_or((l, ""));
        head.insert(k.to_string(), v.trim().to_string());
    }
    let key = |k: &str| head.get(k).map(String::as_str).ok_or_else(|| err(format!("missing \"{k}\"")));
    let version = key("W3E")?.strip_prefix("version ").and_then(|v| v.trim().parse::<u32>().ok()).ok_or_else(|| err("bad \"W3E version\" line"))?;
    if version != 11 && version != 12 {
        return Err(err(format!("unsupported version {version}")));
    }
    let tileset = match key("tileset")?.as_bytes() {
        [c] => *c,
        _ => return Err(err("tileset must be one character")),
    };
    let custom_tilesets = key("custom-tilesets")?.parse().map_err(|_| err("bad custom-tilesets"))?;
    let ids = |k: &str| -> Result<Vec<[u8; 4]>> {
        key(k)?
            .split_whitespace()
            .map(id_parse)
            .collect()
    };
    let (ground, cliffs) = (ids("ground")?, ids("cliffs")?);
    let nums: Vec<&str> = key("corners")?.split_whitespace().collect();
    let [w, h] = nums[..] else { return Err(err("\"corners\" needs width and height")) };
    let width: usize = w.parse().map_err(|_| err("bad width"))?;
    let height: usize = h.parse().map_err(|_| err("bad height"))?;
    let off: Vec<&str> = key("offset")?.split_whitespace().collect();
    let [ox, oy] = off[..] else { return Err(err("\"offset\" needs x and y")) };
    let offset = [parse_float(ox)?, parse_float(oy)?];

    let n = width.checked_mul(height).filter(|&n| n <= 1 << 24).ok_or_else(|| err("map too large"))?;
    let mut corners = vec![Corner::default(); n];
    let mut seen = std::collections::HashSet::new();
    let mut trailer = Vec::new();
    while let Some(l) = lines.next() {
        let (name, rest) = l
            .strip_prefix('[')
            .and_then(|s| s.split_once(']'))
            .ok_or_else(|| err(format!("expected a [section], found \"{l}\"")))?;
        if !seen.insert(name.to_string()) {
            return Err(err(format!("[{name}] appears twice")));
        }
        if name == "trailer" {
            let hex: String = lines.next_if(|l| !l.starts_with('[')).unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
            trailer = (0..hex.len())
                .step_by(2)
                .map(|i| hex.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok()).ok_or_else(|| err("bad trailer hex")))
                .collect::<Result<_>>()?;
            continue;
        }
        let f = FIELDS.iter().find(|f| f.name == name).ok_or_else(|| err(format!("unknown section [{name}]")))?;
        let value = |s: &str| -> Result<i32> {
            if f.numbers {
                let (lo, hi) = number_range(f.name);
                s.parse::<i32>().ok().filter(|v| (lo..=hi).contains(v)).ok_or_else(|| err(format!("[{name}]: bad value \"{s}\"")))
            } else {
                let mut cs = s.chars();
                match (cs.next(), cs.next()) {
                    (Some(c), None) => digit(c, f.max),
                    _ => Err(err(format!("[{name}]: bad value \"{s}\""))),
                }
            }
        };
        if let Some(all) = rest.trim().strip_prefix("all ") {
            let v = value(all.trim())?;
            corners.iter_mut().for_each(|c| (f.set)(c, v));
            continue;
        }
        for y in (0..height).rev() {
            let row = lines.next_if(|l| !l.starts_with('[')).ok_or_else(|| err(format!("[{name}] has fewer than {height} rows")))?;
            let mut values = Vec::with_capacity(width);
            if f.numbers {
                for tok in row.split_whitespace() {
                    let (v, count) = match tok.split_once('*') {
                        Some((v, c)) => (v, c.parse::<usize>().ok().filter(|&c| c >= 1 && c <= width).ok_or_else(|| err(format!("[{name}]: bad run \"{tok}\"")))?),
                        None => (tok, 1),
                    };
                    let v = value(v)?;
                    values.extend(std::iter::repeat_n(v, count));
                }
            } else {
                for c in row.trim().chars() {
                    values.push(digit(c, f.max)?);
                }
            }
            if values.len() != width {
                return Err(err(format!("[{name}] row {} has {} values, expected {width}", height - y, values.len())));
            }
            for (x, v) in values.into_iter().enumerate() {
                (f.set)(&mut corners[y * width + x], v);
            }
        }
    }
    for f in FIELDS {
        if !seen.contains(f.name) && f.name != "texture-bits" {
            return Err(err(format!("missing [{}]", f.name)));
        }
    }
    if version == 11 && seen.contains("texture-bits") {
        return Err(err("[texture-bits] needs version 12"));
    }
    if version == 11 && corners.iter().any(|c| c.texture > 15) {
        return Err(err("version 11 holds textures 0–15 only"));
    }
    Ok(write(&Terrain { version, tileset, custom_tilesets, ground, cliffs, width, height, offset, corners, trailer }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(version: u32, trailer: &[u8]) -> Vec<u8> {
        let (width, height) = (5, 3);
        let corners = (0..width * height)
            .map(|i| Corner {
                height: 0x2000 + if i % 7 == 0 { -12 } else { 0 },
                water: 0x2000 + 100 + if i == 3 { 0x4000 } else { 0 },
                texture: (i % 3) as u8,
                flags: if i == 4 { 5 } else { 0 },
                texture_bits: 0,
                variation: (i * 5 % 32) as u8,
                cliff_variation: 0,
                cliff_texture: 15,
                layer: 2,
            })
            .collect();
        write(&Terrain {
            version,
            tileset: b'L',
            custom_tilesets: 1,
            ground: vec![*b"Ldrt", *b"Lgrs", *b"Lrok"],
            cliffs: vec![*b"CLdi"],
            width,
            height,
            offset: [-320.0, 0.5],
            corners,
            trailer: trailer.to_vec(),
        })
    }

    #[test]
    fn round_trips() {
        for b in [sample(12, &[]), sample(11, &[]), sample(12, &[1, 2, 0xff])] {
            let t = to_text(&b).unwrap();
            assert_eq!(from_text(&t).unwrap(), b, "{}", String::from_utf8_lossy(&t));
            let crlf = String::from_utf8(t).unwrap().replace('\n', "\r\n");
            assert_eq!(from_text(crlf.as_bytes()).unwrap(), b);
        }
    }

    #[test]
    fn unprintable_tile_ids_as_hex() {
        let mut b = sample(12, &[]);
        b[13 + 4 + 4..13 + 4 + 8].copy_from_slice(&[0, 0, 0, 0]);
        let t = String::from_utf8(to_text(&b).unwrap()).unwrap();
        assert!(t.contains("ground Ldrt hex:00000000 Lrok\n"), "{t}");
        assert_eq!(from_text(t.as_bytes()).unwrap(), b);
        assert!(from_text(t.replace("hex:00000000", "hex:0000000g").as_bytes()).is_err());
    }

    #[test]
    fn readable() {
        let t = String::from_utf8(to_text(&sample(12, &[])).unwrap()).unwrap();
        assert_eq!(
            t,
            "W3E version 12\ntileset L\ncustom-tilesets 1\nground Ldrt Lgrs Lrok\ncliffs CLdi\ncorners 5 3\noffset -320 bits:3f000000\n\
             \n[height]\n0*4 -12\n0 0 -12 0 0\n-12 0*4\n\
             \n[water] all 100\n\
             \n[water-bits]\n00000\n00000\n00010\n\
             \n[texture]\n12012\n20120\n01201\n\
             \n[variation]\nins16\npu38d\n05afk\n\
             \n[cliff-variation] all 0\n\
             \n[cliff-texture] all f\n\
             \n[layer] all 2\n\
             \n[flags]\n00000\n00000\n00005\n"
        );
    }

    #[test]
    fn a_size_too_large_to_multiply_is_an_error() {
        let mut b = sample(12, &[]);
        let at = b.len() - 3 * 5 * 8 - 16;
        b[at..at + 8].copy_from_slice(&[0, 0, 0, 0x40, 0, 0, 0, 0x40]);
        assert!(to_text(&b).is_err());
    }

    #[test]
    fn rejects_bad_text() {
        let t = String::from_utf8(to_text(&sample(12, &[])).unwrap()).unwrap();
        assert!(from_text(t.replace("20120\n01201", "2012\n01201").as_bytes()).is_err());
        assert!(from_text(t.replace("[layer] all 2", "[layer] all g").as_bytes()).is_err());
        assert!(from_text(t.replace("\n[flags]", "\n[flag]").as_bytes()).is_err());
    }
}
