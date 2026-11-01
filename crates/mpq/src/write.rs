//! Deterministic MPQ v1 writer.
//!
//! Output depends only on the input files and options (sorted names, fixed
//! compression level, no timestamps), so packing the same project twice
//! yields byte-identical archives.

use std::io::Write;

use flate2::{write::ZlibEncoder, Compression};

use crate::crypto::{self, HASH_FILE_KEY, HASH_NAME_A, HASH_NAME_B, HASH_TABLE_OFFSET};
use crate::{flags, Error, Result};

#[derive(Debug, Clone)]
pub struct WriteOptions {
    /// Sector size is `512 << shift`. WC3's editor uses 3 (4 KiB).
    pub sector_size_shift: u16,
    /// Minimum hash table size; rounded up to a power of two that fits.
    pub min_hash_table_size: u32,
    pub compress: bool,
    pub listfile: bool,
}

impl Default for WriteOptions {
    fn default() -> Self {
        WriteOptions {
            sector_size_shift: 3,
            min_hash_table_size: 16,
            compress: true,
            listfile: true,
        }
    }
}

#[derive(Default)]
pub struct ArchiveBuilder {
    files: Vec<(String, Vec<u8>)>,
    pub options: WriteOptions,
}

impl ArchiveBuilder {
    pub fn new(options: WriteOptions) -> Self {
        ArchiveBuilder {
            files: Vec::new(),
            options,
        }
    }

    /// Adds a file. Names use `\` separators; `/` is normalised.
    pub fn add(&mut self, name: &str, data: Vec<u8>) {
        let name = name.replace('/', "\\");
        let key = name.to_ascii_uppercase();
        self.files.retain(|(n, _)| n.to_ascii_uppercase() != key);
        self.files.push((name, data));
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// Writes `prefix` (padded to 512 bytes) followed by the archive.
    pub fn write(mut self, prefix: &[u8]) -> Result<Vec<u8>> {
        self.files
            .sort_by_key(|(n, _)| n.to_ascii_uppercase());
        if self.options.listfile {
            let list = self
                .files
                .iter()
                .filter(|(n, _)| !n.starts_with('('))
                .map(|(n, _)| n.as_str())
                .collect::<Vec<_>>()
                .join("\r\n");
            self.files.retain(|(n, _)| !n.eq_ignore_ascii_case("(listfile)"));
            self.files.push(("(listfile)".into(), list.into_bytes()));
        }

        let mut out = prefix.to_vec();
        out.resize(prefix.len().div_ceil(512) * 512, 0);
        let base = out.len();
        out.extend_from_slice(&[0u8; 32]); // header, filled in at the end

        let sector = 512usize << self.options.sector_size_shift;
        let mut blocks: Vec<[u32; 4]> = Vec::with_capacity(self.files.len());
        for (_, data) in &self.files {
            let pos = (out.len() - base) as u32;
            let (bytes, fl) = encode_file(data, sector, self.options.compress)?;
            out.extend_from_slice(&bytes);
            blocks.push([pos, bytes.len() as u32, data.len() as u32, fl]);
        }

        let needed = (self.files.len() as u32 * 4).div_ceil(3).max(1);
        let size = needed
            .max(self.options.min_hash_table_size)
            .next_power_of_two();
        let mut hash = vec![[u32::MAX; 4]; size as usize];
        for (i, (name, _)) in self.files.iter().enumerate() {
            let mut slot = (crypto::hash_string(name, HASH_TABLE_OFFSET) & (size - 1)) as usize;
            while hash[slot][3] != u32::MAX {
                slot = (slot + 1) % size as usize;
            }
            hash[slot] = [
                crypto::hash_string(name, HASH_NAME_A),
                crypto::hash_string(name, HASH_NAME_B),
                0, // locale neutral, platform 0
                i as u32,
            ];
        }

        let hash_pos = (out.len() - base) as u32;
        write_table(&mut out, &hash, "(hash table)");
        let block_pos = (out.len() - base) as u32;
        write_table(&mut out, &blocks, "(block table)");
        let archive_size = (out.len() - base) as u32;

        let h = &mut out[base..base + 32];
        h[0..4].copy_from_slice(b"MPQ\x1A");
        h[4..8].copy_from_slice(&32u32.to_le_bytes());
        h[8..12].copy_from_slice(&archive_size.to_le_bytes());
        h[12..14].copy_from_slice(&0u16.to_le_bytes());
        h[14..16].copy_from_slice(&self.options.sector_size_shift.to_le_bytes());
        h[16..20].copy_from_slice(&hash_pos.to_le_bytes());
        h[20..24].copy_from_slice(&block_pos.to_le_bytes());
        h[24..28].copy_from_slice(&size.to_le_bytes());
        h[28..32].copy_from_slice(&(blocks.len() as u32).to_le_bytes());
        Ok(out)
    }
}

fn write_table(out: &mut Vec<u8>, rows: &[[u32; 4]], key_name: &str) {
    let mut words: Vec<u32> = rows.iter().flatten().copied().collect();
    crypto::encrypt(&mut words, crypto::hash_string(key_name, HASH_FILE_KEY));
    for w in words {
        out.extend_from_slice(&w.to_le_bytes());
    }
}

/// Encodes one file as a sectored block. Returns (bytes, flags).
fn encode_file(data: &[u8], sector: usize, compress: bool) -> Result<(Vec<u8>, u32)> {
    if data.is_empty() {
        return Ok((Vec::new(), flags::EXISTS));
    }
    if !compress {
        return Ok((data.to_vec(), flags::EXISTS));
    }
    let n = data.len().div_ceil(sector);
    let table_len = (n + 1) * 4;
    let mut offsets = Vec::with_capacity(n + 1);
    let mut body = Vec::new();
    for chunk in data.chunks(sector) {
        offsets.push((table_len + body.len()) as u32);
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(chunk)?;
        let z = enc.finish()?;
        if z.len() + 1 < chunk.len() {
            body.push(0x02);
            body.extend_from_slice(&z);
        } else {
            body.extend_from_slice(chunk);
        }
    }
    offsets.push((table_len + body.len()) as u32);
    if table_len + body.len() > u32::MAX as usize {
        return Err(Error::Corrupt("file too large for MPQ v1"));
    }
    let mut out = Vec::with_capacity(table_len + body.len());
    for o in offsets {
        out.extend_from_slice(&o.to_le_bytes());
    }
    out.extend_from_slice(&body);
    Ok((out, flags::EXISTS | flags::COMPRESS))
}
