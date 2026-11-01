//! MPQ (v1, as used by Warcraft III maps) reader.
//!
//! The reader is deliberately tolerant: "protected" maps often carry bogus
//! header sizes, oversized tables or garbage hash entries, so table bounds are
//! clamped to the file and broken entries are skipped instead of failing the
//! whole archive.

use std::io::Read;
use std::path::Path;

use crate::crypto::{self, HASH_FILE_KEY, HASH_NAME_A, HASH_NAME_B, HASH_TABLE_OFFSET};
use crate::{flags, Error, Result};

pub const HASH_EMPTY: u32 = 0xFFFF_FFFF;
pub const HASH_DELETED: u32 = 0xFFFF_FFFE;

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub header_size: u32,
    pub archive_size: u32,
    pub format_version: u16,
    pub sector_size_shift: u16,
    pub hash_table_pos: u32,
    pub block_table_pos: u32,
    pub hash_table_entries: u32,
    pub block_table_entries: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct HashEntry {
    pub hash_a: u32,
    pub hash_b: u32,
    pub locale: u16,
    pub platform: u16,
    pub block_index: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct BlockEntry {
    pub file_pos: u32,
    pub compressed_size: u32,
    pub file_size: u32,
    pub flags: u32,
}

/// A live file slot in the hash table.
#[derive(Debug, Clone, Copy)]
pub struct Slot {
    pub slot: usize,
    pub hash: HashEntry,
    pub block: BlockEntry,
}

pub struct Archive {
    data: Vec<u8>,
    offset: usize,
    header: Header,
    hash_table: Vec<HashEntry>,
    block_table: Vec<BlockEntry>,
}

fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

/// Reads `count` encrypted u32 records of `words` each, clamped to the data.
fn read_table(data: &[u8], pos: usize, count: usize, words: usize, key: u32) -> Vec<u32> {
    let avail = data.len().saturating_sub(pos) / (words * 4);
    let n = count.min(avail) * words;
    let mut table: Vec<u32> = (0..n).map(|i| u32_at(data, pos + i * 4)).collect();
    crypto::decrypt(&mut table, key);
    table
}

impl Archive {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_bytes(std::fs::read(path)?)
    }

    pub fn from_bytes(data: Vec<u8>) -> Result<Self> {
        // The MPQ header lives on a 512-byte boundary; WC3 maps prefix it
        // with a 512-byte HM3W header.
        let offset = (0..data.len().saturating_sub(32))
            .step_by(512)
            .find(|&o| &data[o..o + 4] == b"MPQ\x1A")
            .ok_or(Error::NotAnArchive)?;

        let h = &data[offset..];
        let header = Header {
            header_size: u32_at(h, 4),
            archive_size: u32_at(h, 8),
            format_version: u16_at(h, 12),
            sector_size_shift: u16_at(h, 14),
            hash_table_pos: u32_at(h, 16),
            block_table_pos: u32_at(h, 20),
            hash_table_entries: u32_at(h, 24),
            block_table_entries: u32_at(h, 28),
        };

        let hash_key = crypto::hash_string("(hash table)", HASH_FILE_KEY);
        let raw = read_table(
            &data,
            offset + header.hash_table_pos as usize,
            header.hash_table_entries as usize,
            4,
            hash_key,
        );
        let hash_table = raw
            .chunks_exact(4)
            .map(|c| HashEntry {
                hash_a: c[0],
                hash_b: c[1],
                locale: (c[2] & 0xFFFF) as u16,
                platform: (c[2] >> 16) as u16,
                block_index: c[3],
            })
            .collect();

        let block_key = crypto::hash_string("(block table)", HASH_FILE_KEY);
        let raw = read_table(
            &data,
            offset + header.block_table_pos as usize,
            header.block_table_entries as usize,
            4,
            block_key,
        );
        let block_table = raw
            .chunks_exact(4)
            .map(|c| BlockEntry {
                file_pos: c[0],
                compressed_size: c[1],
                file_size: c[2],
                flags: c[3],
            })
            .collect();

        Ok(Archive {
            data,
            offset,
            header,
            hash_table,
            block_table,
        })
    }

    /// Everything before the MPQ header (the HM3W map header for WC3 maps).
    pub fn prefix(&self) -> &[u8] {
        &self.data[..self.offset]
    }

    /// Bytes after the archive, e.g. a map signature footer.
    pub fn suffix(&self) -> &[u8] {
        let end = self.offset + self.header.archive_size as usize;
        self.data.get(end..).unwrap_or(&[])
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn sector_size(&self) -> usize {
        512usize << self.header.sector_size_shift.min(20)
    }

    /// All live slots: hash entries pointing at an existing block.
    pub fn slots(&self) -> Vec<Slot> {
        self.hash_table
            .iter()
            .enumerate()
            .filter(|(_, h)| h.block_index != HASH_EMPTY && h.block_index != HASH_DELETED)
            .filter_map(|(slot, h)| {
                let block = *self.block_table.get(h.block_index as usize)?;
                if block.flags & flags::EXISTS == 0 || block.flags & flags::DELETE_MARKER != 0 {
                    return None;
                }
                Some(Slot {
                    slot,
                    hash: *h,
                    block,
                })
            })
            .collect()
    }

    /// Looks a file up by name. Prefers the neutral locale.
    pub fn find(&self, name: &str) -> Option<Slot> {
        let size = self.hash_table.len();
        if size == 0 {
            return None;
        }
        let a = crypto::hash_string(name, HASH_NAME_A);
        let b = crypto::hash_string(name, HASH_NAME_B);
        let start = crypto::hash_string(name, HASH_TABLE_OFFSET) as usize % size;
        let mut found: Option<Slot> = None;
        for i in 0..size {
            let slot = (start + i) % size;
            let h = self.hash_table[slot];
            if h.block_index == HASH_EMPTY {
                break;
            }
            if h.hash_a == a && h.hash_b == b && h.block_index != HASH_DELETED {
                if let Some(&block) = self.block_table.get(h.block_index as usize) {
                    if block.flags & flags::EXISTS == 0 {
                        continue;
                    }
                    let s = Slot {
                        slot,
                        hash: h,
                        block,
                    };
                    if h.locale == 0 {
                        return Some(s);
                    }
                    found.get_or_insert(s);
                }
            }
        }
        found
    }

    pub fn contains(&self, name: &str) -> bool {
        self.find(name).is_some()
    }

    pub fn read(&self, name: &str) -> Result<Vec<u8>> {
        let slot = self
            .find(name)
            .ok_or_else(|| Error::FileNotFound(name.to_string()))?;
        self.read_block(&slot.block, Some(name))
    }

    /// Reads a block. `name` is required to decrypt encrypted files.
    pub fn read_block(&self, b: &BlockEntry, name: Option<&str>) -> Result<Vec<u8>> {
        let start = self.offset + b.file_pos as usize;
        let end = start + b.compressed_size as usize;
        let raw = self
            .data
            .get(start..end)
            .ok_or(Error::Corrupt("block extends past end of file"))?;
        let file_size = b.file_size as usize;
        if file_size == 0 {
            return Ok(Vec::new());
        }

        let key = if b.flags & flags::ENCRYPTED != 0 {
            let name = name.ok_or(Error::NeedsName)?;
            Some(crypto::file_key(
                name,
                b.file_pos,
                b.file_size,
                b.flags & flags::FIX_KEY != 0,
            ))
        } else {
            None
        };
        let compressed = b.flags & (flags::COMPRESS | flags::IMPLODE) != 0;

        if b.flags & flags::SINGLE_UNIT != 0 {
            let mut buf = raw.to_vec();
            if let Some(k) = key {
                crypto::decrypt_bytes(&mut buf, k);
            }
            if compressed && buf.len() < file_size {
                return decompress(&buf, file_size, b.flags);
            }
            buf.truncate(file_size);
            return Ok(buf);
        }

        let sector = self.sector_size();
        let n = file_size.div_ceil(sector);

        if !compressed {
            let mut buf = raw.get(..file_size).ok_or(Error::Corrupt("short file"))?.to_vec();
            if let Some(k) = key {
                for (i, chunk) in buf.chunks_mut(sector).enumerate() {
                    crypto::decrypt_bytes(chunk, k.wrapping_add(i as u32));
                }
            }
            return Ok(buf);
        }

        let entries = n + 1 + usize::from(b.flags & flags::SECTOR_CRC != 0);
        if raw.len() < entries * 4 {
            return Err(Error::Corrupt("sector table truncated"));
        }
        let mut table: Vec<u32> = (0..entries).map(|i| u32_at(raw, i * 4)).collect();
        if let Some(k) = key {
            crypto::decrypt(&mut table, k.wrapping_sub(1));
        }

        let mut out = Vec::with_capacity(file_size);
        for i in 0..n {
            let (s, e) = (table[i] as usize, table[i + 1] as usize);
            let mut sect = raw
                .get(s..e)
                .ok_or(Error::Corrupt("sector out of bounds"))?
                .to_vec();
            if let Some(k) = key {
                crypto::decrypt_bytes(&mut sect, k.wrapping_add(i as u32));
            }
            let expected = sector.min(file_size - i * sector);
            if sect.len() < expected {
                out.extend(decompress(&sect, expected, b.flags)?);
            } else {
                out.extend_from_slice(&sect[..expected]);
            }
        }
        Ok(out)
    }
}

fn decompress(buf: &[u8], expected: usize, block_flags: u32) -> Result<Vec<u8>> {
    if block_flags & flags::IMPLODE != 0 {
        return explode::explode(buf).map_err(|_| Error::Decompress("pkware"));
    }
    let (&mask, data) = buf.split_first().ok_or(Error::Corrupt("empty sector"))?;
    if mask & !(0x10 | 0x08 | 0x02) != 0 {
        return Err(Error::UnsupportedCompression(mask));
    }
    // Decompression runs in the reverse order of Storm's compression order.
    let mut cur = data.to_vec();
    if mask & 0x10 != 0 {
        let mut out = Vec::with_capacity(expected);
        bzip2::read::BzDecoder::new(&cur[..])
            .read_to_end(&mut out)
            .map_err(|_| Error::Decompress("bzip2"))?;
        cur = out;
    }
    if mask & 0x08 != 0 {
        cur = explode::explode(&cur).map_err(|_| Error::Decompress("pkware"))?;
    }
    if mask & 0x02 != 0 {
        let mut out = Vec::with_capacity(expected);
        flate2::read::ZlibDecoder::new(&cur[..])
            .read_to_end(&mut out)
            .map_err(|_| Error::Decompress("zlib"))?;
        cur = out;
    }
    Ok(cur)
}
