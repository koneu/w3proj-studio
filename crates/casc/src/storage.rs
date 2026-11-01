//! Local CASC storage: build info, index files, data archives, BLTE and the
//! encoding table. Everything here is product-independent; the namespace
//! (paths → content keys) lives in `tvfs`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{Error, Result};

pub type CKey = [u8; 16];
pub type EKey = [u8; 16];

pub fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.trim();
    if s.len() < N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One row of `.build.info`.
#[derive(Debug, Clone)]
pub struct BuildInfo {
    pub product: String,
    pub version: String,
    pub build_key: String,
    pub active: bool,
}

pub fn read_build_info(install: &Path) -> Result<Vec<BuildInfo>> {
    let text = std::fs::read_to_string(install.join(".build.info"))
        .map_err(|e| Error::Storage(format!(".build.info: {e}")))?;
    let mut lines = text.lines();
    let header: Vec<String> = lines
        .next()
        .unwrap_or_default()
        .split('|')
        .map(|h| h.split('!').next().unwrap_or("").to_string())
        .collect();
    let col = |name: &str| header.iter().position(|h| h == name);
    let (p, v, b, a) = (col("Product"), col("Version"), col("Build Key"), col("Active"));
    Ok(lines
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split('|').collect();
            let get = |i: Option<usize>| i.and_then(|i| f.get(i)).unwrap_or(&"").to_string();
            BuildInfo {
                product: get(p),
                version: get(v),
                build_key: get(b),
                active: get(a) == "1",
            }
        })
        .collect())
}

/// `key = value [value…]` config files under `Data/config/xx/yy/<hash>`.
pub fn read_config(data_dir: &Path, key: &str) -> Result<HashMap<String, Vec<String>>> {
    let path = data_dir.join("config").join(&key[0..2]).join(&key[2..4]).join(key);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| Error::Storage(format!("config {key}: {e}")))?;
    Ok(text
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let (k, v) = l.split_once(" = ")?;
            Some((k.trim().to_string(), v.split_whitespace().map(str::to_string).collect()))
        })
        .collect())
}

#[derive(Clone, Copy, Debug)]
struct Location {
    archive: u16,
    offset: u32,
    size: u32,
}

pub struct Storage {
    data_dir: PathBuf,
    /// First 9 bytes of an encoding key → location in `data.NNN`.
    index: HashMap<[u8; 9], Location>,
    /// Content key → encoding key.
    encoding: HashMap<CKey, EKey>,
    archives: Mutex<HashMap<u16, File>>,
    pub build_config: HashMap<String, Vec<String>>,
    pub build: BuildInfo,
}

impl Storage {
    /// Opens the storage of `product` (e.g. "w3") in a game install folder.
    pub fn open(install: &Path, product: &str) -> Result<Storage> {
        let build = read_build_info(install)?
            .into_iter()
            .find(|b| b.product == product && b.active)
            .ok_or_else(|| Error::Storage(format!("product {product} not found in .build.info")))?;
        let data_dir = install.join("Data");
        let build_config = read_config(&data_dir, &build.build_key)?;
        let index = read_indices(&data_dir.join("data"))?;
        let mut s = Storage {
            data_dir,
            index,
            encoding: HashMap::new(),
            archives: Mutex::new(HashMap::new()),
            build_config,
            build,
        };
        let enc_ekey = s
            .config_key(1, "encoding")
            .ok_or_else(|| Error::Storage("build config has no encoding key".into()))?;
        let enc = s.read_ekey(&enc_ekey)?;
        s.encoding = parse_encoding(&enc)?;
        Ok(s)
    }

    /// The `n`th hash of a build config entry (0 = content key, 1 = encoding key).
    pub fn config_key(&self, n: usize, name: &str) -> Option<[u8; 16]> {
        parse_hex(self.build_config.get(name)?.get(n)?)
    }

    pub fn ekey_for(&self, ckey: &CKey) -> Option<EKey> {
        self.encoding.get(ckey).copied()
    }

    pub fn has_ekey(&self, ekey: &EKey) -> bool {
        let short: [u8; 9] = ekey[..9].try_into().unwrap();
        self.index.contains_key(&short)
    }

    pub fn read_ckey(&self, ckey: &CKey) -> Result<Vec<u8>> {
        let ekey = self
            .ekey_for(ckey)
            .ok_or_else(|| Error::NotFound(format!("content key {}", hex(ckey))))?;
        self.read_ekey(&ekey)
    }

    pub fn read_ekey(&self, ekey: &[u8]) -> Result<Vec<u8>> {
        let short: [u8; 9] = ekey[..9].try_into().unwrap();
        let loc = *self
            .index
            .get(&short)
            .ok_or_else(|| Error::NotFound(format!("encoding key {} is not stored locally", hex(ekey))))?;
        let raw = {
            let mut files = self.archives.lock().unwrap();
            let file = match files.get_mut(&loc.archive) {
                Some(f) => f,
                None => {
                    let path = self.data_dir.join("data").join(format!("data.{:03}", loc.archive));
                    let f = File::open(&path).map_err(|e| Error::Storage(format!("{}: {e}", path.display())))?;
                    files.entry(loc.archive).or_insert(f)
                }
            };
            let mut buf = vec![0u8; loc.size as usize];
            file.seek(SeekFrom::Start(loc.offset as u64))?;
            file.read_exact(&mut buf)?;
            buf
        };
        // 30-byte local header: reversed ekey hash, size, flags, checksums.
        if raw.len() < 30 {
            return Err(Error::Corrupt("archive entry too short"));
        }
        blte_decode(&raw[30..])
    }
}

fn read_indices(dir: &Path) -> Result<HashMap<[u8; 9], Location>> {
    // One index per bucket; the highest version is current.
    let mut latest: HashMap<u8, (u32, PathBuf)> = HashMap::new();
    for e in std::fs::read_dir(dir).map_err(|e| Error::Storage(format!("{}: {e}", dir.display())))? {
        let path = e?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let Some(stem) = name.strip_suffix(".idx") else { continue };
        if stem.len() != 10 {
            continue;
        }
        let (Ok(bucket), Ok(version)) = (u8::from_str_radix(&stem[..2], 16), u32::from_str_radix(&stem[2..], 16)) else {
            continue;
        };
        if latest.get(&bucket).is_none_or(|(v, _)| version > *v) {
            latest.insert(bucket, (version, path));
        }
    }
    if latest.is_empty() {
        return Err(Error::Storage(format!("no .idx files in {}", dir.display())));
    }
    let mut index = HashMap::new();
    for (_, path) in latest.values() {
        let d = std::fs::read(path)?;
        let u32le = |o: usize| u32::from_le_bytes(d[o..o + 4].try_into().unwrap());
        let header_len = u32le(0) as usize;
        let h = 8;
        if d.len() < h + header_len || u16::from_le_bytes([d[h], d[h + 1]]) != 7 {
            return Err(Error::Storage(format!("{}: unsupported index version", path.display())));
        }
        let (size_len, offset_len, key_len, offset_bits) = (d[h + 4] as usize, d[h + 5] as usize, d[h + 6] as usize, d[h + 7] as u32);
        if key_len != 9 || size_len != 4 || offset_len != 5 {
            return Err(Error::Storage(format!("{}: unexpected index layout", path.display())));
        }
        let entries_at = (h + header_len).div_ceil(16) * 16;
        let entries_len = u32le(entries_at) as usize;
        let start = entries_at + 8;
        let entry = key_len + offset_len + size_len;
        for e in d[start..(start + entries_len).min(d.len())].chunks_exact(entry) {
            let key: [u8; 9] = e[..9].try_into().unwrap();
            let packed = e[9..14].iter().fold(0u64, |a, &b| (a << 8) | b as u64);
            let loc = Location {
                archive: (packed >> offset_bits) as u16,
                offset: (packed & ((1u64 << offset_bits) - 1)) as u32,
                size: u32::from_le_bytes(e[14..18].try_into().unwrap()),
            };
            index.entry(key).or_insert(loc);
        }
    }
    Ok(index)
}

/// Decodes a BLTE stream (raw, zlib and nested frames).
pub fn blte_decode(d: &[u8]) -> Result<Vec<u8>> {
    if d.len() < 8 || &d[..4] != b"BLTE" {
        return Err(Error::Corrupt("missing BLTE signature"));
    }
    let header_size = u32::from_be_bytes(d[4..8].try_into().unwrap()) as usize;
    let mut out = Vec::new();
    if header_size == 0 {
        decode_chunk(&d[8..], &mut out)?;
        return Ok(out);
    }
    if d.len() < 12 {
        return Err(Error::Corrupt("BLTE header truncated"));
    }
    let count = u32::from_be_bytes([0, d[9], d[10], d[11]]) as usize;
    let mut p = header_size;
    for i in 0..count {
        let info = 12 + i * 24;
        let comp = u32::from_be_bytes(d[info..info + 4].try_into().unwrap()) as usize;
        let chunk = d.get(p..p + comp).ok_or(Error::Corrupt("BLTE chunk out of range"))?;
        decode_chunk(chunk, &mut out)?;
        p += comp;
    }
    Ok(out)
}

fn decode_chunk(c: &[u8], out: &mut Vec<u8>) -> Result<()> {
    let (&mode, body) = c.split_first().ok_or(Error::Corrupt("empty BLTE chunk"))?;
    match mode {
        b'N' => out.extend_from_slice(body),
        b'Z' => {
            flate2::read::ZlibDecoder::new(body)
                .read_to_end(out)
                .map_err(|_| Error::Corrupt("zlib chunk"))?;
        }
        b'F' => out.extend(blte_decode(body)?),
        b'E' => return Err(Error::Encrypted),
        m => return Err(Error::Storage(format!("unsupported BLTE chunk mode {:?}", m as char))),
    }
    Ok(())
}

/// The encoding file maps content keys to encoding keys.
fn parse_encoding(d: &[u8]) -> Result<HashMap<CKey, EKey>> {
    if d.len() < 22 || &d[..2] != b"EN" {
        return Err(Error::Corrupt("bad encoding file"));
    }
    let (ckey_len, ekey_len) = (d[3] as usize, d[4] as usize);
    if ckey_len != 16 || ekey_len != 16 {
        return Err(Error::Corrupt("unexpected key sizes in encoding file"));
    }
    let page_size = u16::from_be_bytes([d[5], d[6]]) as usize * 1024;
    let page_count = u32::from_be_bytes(d[9..13].try_into().unwrap()) as usize;
    let espec_size = u32::from_be_bytes(d[18..22].try_into().unwrap()) as usize;
    let pages_at = 22 + espec_size + page_count * 32;
    let mut map = HashMap::with_capacity(page_count * 64);
    for page in 0..page_count {
        let base = pages_at + page * page_size;
        let Some(p) = d.get(base..base + page_size) else { break };
        let mut o = 0;
        while o + 22 <= p.len() {
            let keys = p[o] as usize;
            if keys == 0 {
                break;
            }
            let ckey: CKey = p[o + 6..o + 22].try_into().unwrap();
            if let Some(ek) = p.get(o + 22..o + 38) {
                map.insert(ckey, ek.try_into().unwrap());
            }
            o += 22 + keys * 16;
        }
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn blte_single_chunk() {
        let mut d = b"BLTE\0\0\0\0N".to_vec();
        d.extend_from_slice(b"hello");
        assert_eq!(blte_decode(&d).unwrap(), b"hello");
    }

    #[test]
    fn blte_multi_chunk() {
        let chunks: Vec<Vec<u8>> = vec![[b"N".as_slice(), b"abc"].concat(), [b"Z".as_slice(), &zlib(b"defdefdef")].concat()];
        let header_size = 12 + 24 * chunks.len();
        let mut d = b"BLTE".to_vec();
        d.extend((header_size as u32).to_be_bytes());
        d.extend([0x0F, 0, 0, chunks.len() as u8]);
        for c in &chunks {
            d.extend((c.len() as u32).to_be_bytes());
            d.extend(0u32.to_be_bytes()); // decompressed size (unused)
            d.extend([0u8; 16]); // checksum (unused)
        }
        for c in &chunks {
            d.extend(c);
        }
        assert_eq!(blte_decode(&d).unwrap(), b"abcdefdefdef");
    }

    #[test]
    fn blte_rejects_encrypted() {
        assert!(matches!(blte_decode(b"BLTE\0\0\0\0Exyz"), Err(Error::Encrypted)));
    }

    #[test]
    fn hex_roundtrip() {
        let k: [u8; 4] = parse_hex("deadBEEF").unwrap();
        assert_eq!(hex(&k), "deadbeef");
    }
}
