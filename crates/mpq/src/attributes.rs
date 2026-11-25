//! The archive's `(attributes)` file: a value per block of the block table.
//!
//! Layout, as read from the maps of smoketest_maps (2026-11-25; `crates/w3proj/formats/README.md`):
//! `u32 version` (100 in every map), `u32 flags`, then one array per flag bit set, each with one entry per
//! block-table entry, in block order: bit 0x1 `u32` CRC32 (zlib's, of the file's bytes as read, decompressed),
//! bit 0x2 `u64` time stamp, bit 0x4 16 bytes. The World Editor writes flags 0x1 only (8 + 4 × blocks bytes); its
//! own block, the last, has CRC 0. Other bits than these three are kept in `flags` and not read.

use crate::{Error, Result};

pub const NAME: &str = "(attributes)";
pub const VERSION: u32 = 100;
pub const CRC32: u32 = 0x1;
pub const TIME: u32 = 0x2;
pub const HASH16: u32 = 0x4;

/// CRC32 as `(attributes)` holds it for a file's (decompressed) bytes.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = flate2::Crc::new();
    c.update(data);
    c.sum()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attributes {
    pub version: u32,
    pub flags: u32,
    /// Empty unless `flags` has `CRC32`.
    pub crc32: Vec<u32>,
    /// Empty unless `flags` has `TIME`.
    pub time: Vec<u64>,
    /// Empty unless `flags` has `HASH16`.
    pub hash16: Vec<[u8; 16]>,
}

impl Attributes {
    /// Reads `(attributes)` for an archive of `blocks` block-table entries. An array cut short is an error;
    /// bytes after the arrays are ignored.
    pub fn parse(data: &[u8], blocks: usize) -> Result<Attributes> {
        let word = |at: usize| -> Option<u32> { Some(u32::from_le_bytes(data.get(at..at.checked_add(4)?)?.try_into().ok()?)) };
        let (Some(version), Some(flags)) = (word(0), word(4)) else {
            return Err(Error::Corrupt("(attributes) shorter than its header"));
        };
        let mut at = 8usize;
        let mut take = |size: usize, bit: u32| -> Result<&[u8]> {
            if flags & bit == 0 {
                return Ok(&[]);
            }
            let len = blocks.checked_mul(size).ok_or(Error::Corrupt("(attributes) block count too large"))?;
            let end = at.checked_add(len).filter(|&e| e <= data.len()).ok_or(Error::Corrupt("(attributes) cut short"))?;
            let part = &data[at..end];
            at = end;
            Ok(part)
        };
        let crc32 = take(4, CRC32)?.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let time = take(8, TIME)?.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
        let hash16 = take(16, HASH16)?.chunks_exact(16).map(|c| c.try_into().unwrap()).collect();
        Ok(Attributes { version, flags, crc32, time, hash16 })
    }

    /// The arrays `flags` names, in its order (the other bits write nothing).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.crc32.len() * 4 + self.time.len() * 8 + self.hash16.len() * 16);
        out.extend_from_slice(&self.version.to_le_bytes());
        out.extend_from_slice(&self.flags.to_le_bytes());
        if self.flags & CRC32 != 0 {
            self.crc32.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
        }
        if self.flags & TIME != 0 {
            self.time.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
        }
        if self.flags & HASH16 != 0 {
            self.hash16.iter().for_each(|v| out.extend_from_slice(v));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_only_layout() {
        let a = Attributes { version: VERSION, flags: CRC32, crc32: vec![0x11223344, 0], time: vec![], hash16: vec![] };
        let b = a.to_bytes();
        assert_eq!(b, [100, 0, 0, 0, 1, 0, 0, 0, 0x44, 0x33, 0x22, 0x11, 0, 0, 0, 0]);
        assert_eq!(Attributes::parse(&b, 2).unwrap(), a);
    }

    #[test]
    fn all_three_arrays_in_order() {
        let a = Attributes { version: VERSION, flags: 7, crc32: vec![1, 2], time: vec![3, 4], hash16: vec![[5; 16], [6; 16]] };
        let b = a.to_bytes();
        assert_eq!(b.len(), 8 + 2 * 28);
        assert_eq!(Attributes::parse(&b, 2).unwrap(), a);
        // Fewer blocks than the arrays hold: the rest is trailing bytes, read wrongly but without harm.
        assert!(Attributes::parse(&b, 1).is_ok());
    }

    #[test]
    fn short_or_absurd_input_is_an_error() {
        assert!(Attributes::parse(&[], 0).is_err());
        assert!(Attributes::parse(&[100, 0, 0, 0, 1, 0, 0], 0).is_err());
        let head = [100, 0, 0, 0, 7, 0, 0, 0];
        assert!(Attributes::parse(&head, 1).is_err());
        assert!(Attributes::parse(&head, usize::MAX).is_err());
        assert!(Attributes::parse(&head, usize::MAX / 4 + 1).is_err());
        // No bit set: nothing to read whatever the count.
        assert!(Attributes::parse(&[100, 0, 0, 0, 0, 0, 0, 0], usize::MAX).is_ok());
    }

    /// The value zlib's CRC32 gives for this text; (attributes) of real maps agree with it (cli/tests/attributes.rs).
    #[test]
    fn crc32_is_zlibs() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }
}
