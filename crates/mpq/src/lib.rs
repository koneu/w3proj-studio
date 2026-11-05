//! Minimal, dependency-light MPQ v1 reader/writer for Warcraft III maps.

mod adpcm;
pub mod crypto;
mod huffman;
mod huffman_tables;
mod read;
mod write;

pub use read::{Archive, BlockEntry, HashEntry, Header, Slot};
pub use write::{ArchiveBuilder, WriteOptions};

pub mod flags {
    pub const IMPLODE: u32 = 0x0000_0100;
    pub const COMPRESS: u32 = 0x0000_0200;
    pub const ENCRYPTED: u32 = 0x0001_0000;
    pub const FIX_KEY: u32 = 0x0002_0000;
    pub const SINGLE_UNIT: u32 = 0x0100_0000;
    pub const DELETE_MARKER: u32 = 0x0200_0000;
    pub const SECTOR_CRC: u32 = 0x0400_0000;
    pub const EXISTS: u32 = 0x8000_0000;
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("no MPQ header found")]
    NotAnArchive,
    #[error("file not found in archive: {0}")]
    FileNotFound(String),
    #[error("encrypted file needs its name to be decrypted")]
    NeedsName,
    #[error("corrupt archive: {0}")]
    Corrupt(&'static str),
    #[error("{0} decompression failed")]
    Decompress(&'static str),
    #[error("unsupported compression mask 0x{0:02x}")]
    UnsupportedCompression(u8),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Sector size for the header's shift. Protected maps write nonsense there, so it's capped: the
/// game reads such maps, and reader and writer have to agree.
pub(crate) fn sector_size(shift: u16) -> usize {
    512usize << shift.min(20)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read() {
        let mut b = ArchiveBuilder::new(WriteOptions::default());
        let big: Vec<u8> = (0..20_000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        b.add("war3map.j", b"function main takes nothing returns nothing\nendfunction".to_vec());
        b.add("war3mapImported/model.mdx", big.clone());
        b.add("empty.txt", Vec::new());
        let bytes = b.write(b"HM3W").unwrap();
        assert_eq!(&bytes[512..516], b"MPQ\x1A");

        let a = Archive::from_bytes(bytes).unwrap();
        assert_eq!(a.prefix().len(), 512);
        assert_eq!(&a.prefix()[..4], b"HM3W");
        assert!(a.read("WAR3MAP.J").unwrap().starts_with(b"function main"));
        assert_eq!(a.read("war3mapImported\\model.mdx").unwrap(), big);
        assert_eq!(a.read("empty.txt").unwrap(), b"");
        let list = String::from_utf8(a.read("(listfile)").unwrap()).unwrap();
        assert!(list.contains("war3mapImported\\model.mdx"));
    }

    #[test]
    fn a_nonsense_sector_size_still_round_trips() {
        let mut b = ArchiveBuilder::new(WriteOptions { sector_size_shift: 0xffff, ..WriteOptions::default() });
        b.add("war3map.j", vec![7; 5000]);
        let a = Archive::from_bytes(b.write(b"HM3W").unwrap()).unwrap();
        assert_eq!(a.header().sector_size_shift, 0xffff);
        assert_eq!(a.read("war3map.j").unwrap(), vec![7; 5000]);
    }

    #[test]
    fn deterministic() {
        let make = || {
            let mut b = ArchiveBuilder::new(WriteOptions::default());
            b.add("b.txt", vec![1; 9000]);
            b.add("a.txt", vec![2; 100]);
            b.write(&[]).unwrap()
        };
        assert_eq!(make(), make());
    }
}
