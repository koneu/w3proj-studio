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
    // Campaigns (.w3n): campaign info, object data, strings, imports. Chapter maps are named
    // in war3campaign.w3f (found by scanning it).
    "war3campaign.w3f",
    "war3campaign.w3u",
    "war3campaign.w3t",
    "war3campaign.w3b",
    "war3campaign.w3d",
    "war3campaign.w3a",
    "war3campaign.w3h",
    "war3campaign.w3q",
    "war3campaign.wts",
    "war3campaign.imp",
    "war3campaignSkin.w3u",
    "war3campaignSkin.w3t",
    "war3campaignSkin.w3b",
    "war3campaignSkin.w3d",
    "war3campaignSkin.w3a",
    "war3campaignSkin.w3h",
    "war3campaignSkin.w3q",
    "war3campaignSkin.txt",
    "war3campaignMisc.txt",
    "war3campaignExtra.txt",
    "war3campImported\\ui.toc",
];

pub const META_FILES: &[&str] = &["(listfile)", "(attributes)", "(signature)"];

/// Archive names for the game's stored paths ("War3.w3mod:_HD.w3mod:Units/X.mdx"): the path
/// a map would use to replace the file, for each art set ("Units\\X.mdx", "_HD.w3mod\\Units\\X.mdx").
pub fn from_game_paths<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out = BTreeSet::new();
    for p in paths {
        let path = p.rsplit(':').next().unwrap_or(p).replace('/', "\\");
        if p.to_ascii_lowercase().contains("_hd.w3mod:") {
            out.insert(format!("_HD.w3mod\\{path}"));
        }
        out.insert(path);
    }
    out.into_iter().collect()
}

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

/// `war3map.imp` / `war3campaign.imp`: u32 version, u32 count, {u8 flag, cstring path}[count].
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
            out.push(format!("war3campImported\\{s}"));
        }
        p += n + 1;
    }
    out
}

const EXTS: &[&str] = &[
    "mdx", "mdl", "blp", "tga", "dds", "png", "wav", "mp3", "flac", "ogg", "txt", "slk", "fdf",
    "toc", "j", "lua", "ai", "pld", "imp", "w3x", "w3m",
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
            let mut forms = vec![cand.replace('/', "\\")];
            if ext == "mdl" || ext == "mdx" {
                let stem = stem.replace('/', "\\");
                forms.extend([format!("{stem}.mdx"), format!("{stem}_portrait.mdx"), format!("{stem}_Portrait.mdx")]);
            }
            let lower = forms[0].to_ascii_lowercase();
            // Command button icons come with a disabled variant the game derives the name of.
            if let Some(i) = lower.find("commandbuttons\\") {
                let file = &forms[0][i + "commandbuttons\\".len()..];
                if !file.contains('\\') && !lower.contains("commandbuttonsdisabled") {
                    out.insert(format!("ReplaceableTextures\\CommandButtonsDisabled\\DIS{file}"));
                }
            }
            // Imports may sit in the import folder of a map or a campaign.
            let imported = lower.starts_with("war3mapimported\\") || lower.starts_with("war3campimported\\");
            for f in forms {
                if !imported {
                    out.insert(format!("war3mapImported\\{f}"));
                    out.insert(format!("war3campImported\\{f}"));
                }
                out.insert(f);
            }
        }
    }
}
