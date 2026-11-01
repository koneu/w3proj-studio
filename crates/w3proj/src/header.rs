//! The 512-byte `HM3W` header in front of a map's MPQ archive.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MapHeader {
    pub name: String,
    pub flags: u32,
    pub max_players: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unknown: u32,
}

fn is_zero(v: &u32) -> bool {
    *v == 0
}

impl MapHeader {
    /// Parses a header. Returns `None` if the prefix is not a plain HM3W
    /// header (the caller then keeps the raw bytes).
    pub fn parse(prefix: &[u8]) -> Option<MapHeader> {
        if prefix.len() < 16 || &prefix[..4] != b"HM3W" {
            return None;
        }
        let u32_at = |o: usize| prefix.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
        let unknown = u32_at(4)?;
        let rest = &prefix[8..];
        let n = rest.iter().position(|&b| b == 0)?;
        let name = String::from_utf8(rest[..n].to_vec()).ok()?;
        let flags = u32_at(8 + n + 1)?;
        let max_players = u32_at(8 + n + 5)?;
        Some(MapHeader {
            name,
            flags,
            max_players,
            unknown,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(512);
        out.extend_from_slice(b"HM3W");
        out.extend(self.unknown.to_le_bytes());
        out.extend(self.name.as_bytes());
        out.push(0);
        out.extend(self.flags.to_le_bytes());
        out.extend(self.max_players.to_le_bytes());
        out.resize(out.len().div_ceil(512).max(1) * 512, 0);
        out
    }
}
