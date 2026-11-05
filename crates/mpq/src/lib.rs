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

    /// An uncompressed archive of one file, encrypted afterwards as protected maps have it (the
    /// writer never encrypts). Every sector has its own key.
    fn encrypted_archive(name: &str, data: &[u8], fix_key: bool) -> Vec<u8> {
        let options = WriteOptions { compress: false, listfile: false, ..WriteOptions::default() };
        let sector = 512 << options.sector_size_shift;
        let mut b = ArchiveBuilder::new(options);
        b.add(name, data.to_vec());
        let mut bytes = b.write(b"HM3W").unwrap();

        let u32_at = |b: &[u8], at: usize| u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
        let block_table = 512 + u32_at(&bytes, 512 + 20) as usize;
        let table_key = crypto::hash_string("(block table)", crypto::HASH_FILE_KEY);
        let mut block: Vec<u32> = (0..4).map(|i| u32_at(&bytes, block_table + i * 4)).collect();
        crypto::decrypt(&mut block, table_key);
        let (pos, size) = (block[0], block[2]);
        block[3] |= flags::ENCRYPTED | if fix_key { flags::FIX_KEY } else { 0 };
        crypto::encrypt(&mut block, table_key);
        for (i, w) in block.iter().enumerate() {
            bytes[block_table + i * 4..block_table + i * 4 + 4].copy_from_slice(&w.to_le_bytes());
        }

        let key = crypto::file_key(name, pos, size, fix_key);
        let body = 512 + pos as usize;
        for (i, chunk) in bytes[body..body + data.len()].chunks_mut(sector).enumerate() {
            let mut words: Vec<u32> = chunk.chunks_exact(4).map(|w| u32::from_le_bytes(w.try_into().unwrap())).collect();
            crypto::encrypt(&mut words, key.wrapping_add(i as u32));
            for (at, w) in words.iter().enumerate() {
                chunk[at * 4..at * 4 + 4].copy_from_slice(&w.to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn encrypted_files_are_read_back() {
        // Two and a bit sectors, so that the per-sector key and the tail both matter.
        let data: Vec<u8> = (0..8195u32).map(|i| (i % 251) as u8).collect();
        for fix_key in [false, true] {
            let a = Archive::from_bytes(encrypted_archive(r"scripts\war3map.j", &data, fix_key)).unwrap();
            assert_eq!(a.read(r"scripts\war3map.j").unwrap(), data, "fix_key {fix_key}");
        }
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
