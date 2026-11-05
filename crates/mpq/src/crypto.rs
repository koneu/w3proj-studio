//! MPQ hashing and encryption (the "Storm" crypt table).

use std::sync::OnceLock;

pub const HASH_TABLE_OFFSET: u32 = 0;
pub const HASH_NAME_A: u32 = 1;
pub const HASH_NAME_B: u32 = 2;
pub const HASH_FILE_KEY: u32 = 3;

fn crypt_table() -> &'static [u32; 0x500] {
    static TABLE: OnceLock<[u32; 0x500]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 0x500];
        let mut seed: u32 = 0x0010_0001;
        for i in 0..0x100 {
            let mut idx = i;
            for _ in 0..5 {
                seed = (seed * 125 + 3) % 0x2A_AAAB;
                let hi = (seed & 0xFFFF) << 16;
                seed = (seed * 125 + 3) % 0x2A_AAAB;
                let lo = seed & 0xFFFF;
                table[idx] = hi | lo;
                idx += 0x100;
            }
        }
        table
    })
}

/// Normalises a byte the same way Storm does before hashing:
/// ASCII upper-case, and `/` treated as `\`.
fn normalize(b: u8) -> u8 {
    match b {
        b'/' => b'\\',
        b'a'..=b'z' => b - 32,
        _ => b,
    }
}

pub fn hash_string(name: &str, hash_type: u32) -> u32 {
    hash_bytes(name.as_bytes(), hash_type)
}

pub fn hash_bytes(name: &[u8], hash_type: u32) -> u32 {
    let table = crypt_table();
    let mut seed1: u32 = 0x7FED_7FED;
    let mut seed2: u32 = 0xEEEE_EEEE;
    for &b in name {
        let ch = normalize(b) as u32;
        seed1 = table[(hash_type * 0x100 + ch) as usize] ^ seed1.wrapping_add(seed2);
        seed2 = ch
            .wrapping_add(seed1)
            .wrapping_add(seed2)
            .wrapping_add(seed2 << 5)
            .wrapping_add(3);
    }
    seed1
}

pub fn decrypt(data: &mut [u32], mut key: u32) {
    let table = crypt_table();
    let mut seed: u32 = 0xEEEE_EEEE;
    for v in data.iter_mut() {
        seed = seed.wrapping_add(table[0x400 + (key & 0xFF) as usize]);
        let ch = *v ^ key.wrapping_add(seed);
        key = ((!key << 0x15).wrapping_add(0x1111_1111)) | (key >> 0x0B);
        seed = ch
            .wrapping_add(seed)
            .wrapping_add(seed << 5)
            .wrapping_add(3);
        *v = ch;
    }
}

pub fn encrypt(data: &mut [u32], mut key: u32) {
    let table = crypt_table();
    let mut seed: u32 = 0xEEEE_EEEE;
    for v in data.iter_mut() {
        seed = seed.wrapping_add(table[0x400 + (key & 0xFF) as usize]);
        let ch = *v;
        *v = ch ^ key.wrapping_add(seed);
        key = ((!key << 0x15).wrapping_add(0x1111_1111)) | (key >> 0x0B);
        seed = ch
            .wrapping_add(seed)
            .wrapping_add(seed << 5)
            .wrapping_add(3);
    }
}

/// Decrypts a byte buffer in place. Trailing bytes that do not fill a
/// whole u32 are left untouched (matching Storm).
pub fn decrypt_bytes(data: &mut [u8], key: u32) {
    let n = data.len() / 4;
    let mut words: Vec<u32> = (0..n)
        .map(|i| u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap()))
        .collect();
    decrypt(&mut words, key);
    for (i, w) in words.iter().enumerate() {
        data[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
}

/// The encryption key of a file, derived from its base name.
pub fn file_key(name: &str, block_pos: u32, file_size: u32, fix_key: bool) -> u32 {
    let base = name.rsplit(['\\', '/']).next().unwrap_or(name);
    let key = hash_string(base, HASH_FILE_KEY);
    if fix_key {
        key.wrapping_add(block_pos) ^ file_size
    } else {
        key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_hashes() {
        // Well-known table keys.
        assert_eq!(hash_string("(hash table)", HASH_FILE_KEY), 0xC3AF_3770);
        assert_eq!(hash_string("(block table)", HASH_FILE_KEY), 0xEC83_B3A3);
    }

    #[test]
    fn roundtrip() {
        let orig = vec![1u32, 2, 3, 0xDEAD_BEEF, 42];
        let mut d = orig.clone();
        encrypt(&mut d, 0x1234_5678);
        assert_ne!(d, orig);
        decrypt(&mut d, 0x1234_5678);
        assert_eq!(d, orig);
    }

    #[test]
    fn decrypt_bytes_decrypts_whole_words_and_keeps_the_tail() {
        let mut words = vec![0x0403_0201u32, 0x0807_0605];
        encrypt(&mut words, 77);
        let mut bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        bytes.extend_from_slice(&[9, 10, 11]);
        decrypt_bytes(&mut bytes, 77);
        assert_eq!(bytes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn a_file_key_comes_from_the_base_name() {
        let key = hash_string("war3map.j", HASH_FILE_KEY);
        assert_eq!(file_key("war3map.j", 0x100, 0x200, false), key);
        assert_eq!(file_key(r"scripts\war3map.j", 0x100, 0x200, false), key);
        assert_eq!(file_key("scripts/war3map.j", 0x100, 0x200, false), key);
    }

    #[test]
    fn a_fixed_file_key_also_uses_position_and_size() {
        let key = hash_string("war3map.j", HASH_FILE_KEY);
        assert_eq!(file_key("war3map.j", 0x100, 0x200, true), key.wrapping_add(0x100) ^ 0x200);
        assert_eq!(file_key("war3map.j", 0, u32::MAX, true), !key);
    }

    #[test]
    fn case_and_slash_insensitive() {
        assert_eq!(
            hash_string("war3map.j", HASH_NAME_A),
            hash_string("WAR3MAP.J", HASH_NAME_A)
        );
        assert_eq!(
            hash_string("a/b.mdx", HASH_NAME_B),
            hash_string("A\\B.MDX", HASH_NAME_B)
        );
    }
}
