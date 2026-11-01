//! Recovering file names. MPQ archives store only name hashes; names come
//! from `(listfile)`, a list of well-known map files, `war3map.imp`, and
//! paths mentioned inside other files (scripts, models, object data).

use std::collections::BTreeSet;

pub const KNOWN: &[&str] = &[
    "war3map.j",
    "scripts\\war3map.j",
    "war3map.lua",
    "war3map.w3i",
    "war3map.w3e",
    "war3map.wpm",
    "war3map.doo",
    "war3mapUnits.doo",
    "war3map.w3r",
    "war3map.w3c",
    "war3map.w3s",
    "war3map.wtg",
    "war3map.wct",
    "war3map.wts",
    "war3map.shd",
    "war3map.mmp",
    "war3map.imp",
    "war3map.w3u",
    "war3map.w3t",
    "war3map.w3b",
    "war3map.w3d",
    "war3map.w3a",
    "war3map.w3h",
    "war3map.w3q",
    "war3mapSkin.w3u",
    "war3mapSkin.w3t",
    "war3mapSkin.w3b",
    "war3mapSkin.w3d",
    "war3mapSkin.w3a",
    "war3mapSkin.w3h",
    "war3mapSkin.w3q",
    "war3mapSkin.txt",
    "war3mapMisc.txt",
    "war3mapExtra.txt",
    "war3mapMap.blp",
    "war3mapMap.tga",
    "war3mapMap.b00",
    "war3mapPreview.tga",
    "war3mapPath.tga",
    "war3map.wai",
    "conversation.json",
    "Scripts\\common.j",
    "Scripts\\Blizzard.j",
    "Units\\UnitData.slk",
    "Units\\UnitBalance.slk",
    "Units\\UnitUI.slk",
    "Units\\UnitWeapons.slk",
    "Units\\UnitAbilities.slk",
    "Units\\AbilityData.slk",
    "Units\\ItemData.slk",
    "Units\\UpgradeData.slk",
    "Units\\DestructableData.slk",
    "Units\\CommonAbilityStrings.txt",
    "Units\\CommonAbilityFunc.txt",
    "Units\\HumanUnitFunc.txt",
    "Units\\OrcUnitFunc.txt",
    "Units\\UndeadUnitFunc.txt",
    "Units\\NightElfUnitFunc.txt",
    "Units\\NeutralUnitFunc.txt",
    "Units\\ItemFunc.txt",
    "Units\\ItemStrings.txt",
    "Units\\MiscData.txt",
    "Units\\MiscGame.txt",
    "UI\\MiscData.txt",
    "UI\\SkinMetaData.slk",
    "UI\\war3skins.txt",
    "UI\\TriggerData.txt",
    "UI\\TriggerStrings.txt",
    "UI\\WorldEditData.txt",
    "UI\\WorldEditStrings.txt",
    "UI\\FrameDef\\FrameDef.toc",
    "war3mapImported\\ui.toc",
];

pub const META_FILES: &[&str] = &["(listfile)", "(attributes)", "(signature)"];

pub fn is_meta(name: &str) -> bool {
    META_FILES.iter().any(|m| m.eq_ignore_ascii_case(name))
}

pub fn parse_listfile(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split(['\r', '\n', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// `war3map.imp`: u32 version, u32 count, {u8 flag, cstring path}[count].
pub fn parse_imp(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    if bytes.len() < 8 {
        return out;
    }
    let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let mut p = 8;
    for _ in 0..count {
        if p >= bytes.len() {
            break;
        }
        p += 1; // flag
        let Some(n) = bytes[p..].iter().position(|&b| b == 0) else {
            break;
        };
        if let Ok(s) = std::str::from_utf8(&bytes[p..p + n]) {
            out.push(s.to_string());
            out.push(format!("war3mapImported\\{s}"));
        }
        p += n + 1;
    }
    out
}

const EXTS: &[&str] = &[
    "mdx", "mdl", "blp", "tga", "dds", "png", "wav", "mp3", "flac", "ogg", "txt", "slk", "fdf",
    "toc", "j", "lua", "ai", "pld", "imp",
];

fn is_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'\\' | b'/' | b'.' | b'-' | b' ' | b'(' | b')' | b'!' | b'#' | b'&' | b'\'' | b'+' | b',' | b'[' | b']')
}

/// Finds things that look like file paths inside arbitrary bytes, and adds
/// common variants (model ↔ portrait, .mdl ↔ .mdx).
pub fn scan_candidates(bytes: &[u8], out: &mut BTreeSet<String>) {
    for token in bytes.split(|&b| !is_path_byte(b)) {
        if token.len() < 3 || token.len() > 260 {
            continue;
        }
        let Ok(s) = std::str::from_utf8(token) else {
            continue;
        };
        // A token may hold several space-separated words; try every suffix
        // that starts at a word boundary.
        let starts = std::iter::once(0).chain(s.match_indices(' ').map(|(i, _)| i + 1));
        for st in starts {
            let cand = s[st..].trim();
            let Some((stem, ext)) = cand.rsplit_once('.') else {
                continue;
            };
            let ext = ext.to_ascii_lowercase();
            if stem.is_empty() || !EXTS.contains(&ext.as_str()) {
                continue;
            }
            let cand = cand.replace('/', "\\");
            out.insert(cand.clone());
            if ext == "mdl" || ext == "mdx" {
                out.insert(format!("{stem}.mdx").replace('/', "\\"));
                out.insert(format!("{stem}_portrait.mdx").replace('/', "\\"));
                out.insert(format!("{stem}_Portrait.mdx").replace('/', "\\"));
            }
            if !cand.to_ascii_lowercase().starts_with("war3mapimported\\") {
                out.insert(format!("war3mapImported\\{cand}"));
            }
        }
    }
}
