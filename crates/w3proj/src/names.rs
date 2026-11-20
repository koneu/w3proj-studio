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

pub const META_FILES: &[&str] = &["(listfile)", "(attributes)", "(signature)", "(weak signature)"];

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
    "toc", "j", "lua", "ai", "pld", "imp", "w3x", "w3m", "ttf",
];

/// The name in a model's MODL chunk (MDX: "MDLX", then chunks of a tag, a u32 size and the data; MODL starts with
/// an 80-byte name). Imported models are often stored under it: 2 of The Chosen Ones campaign's otherwise unnamed
/// models (war3campImported\Tower01.mdx, Felsen1.mdx) are named only by their own MODL name.
fn mdx_model_name(bytes: &[u8]) -> Option<&str> {
    if !bytes.starts_with(b"MDLX") {
        return None;
    }
    let mut p = 4usize;
    while p.checked_add(8)? <= bytes.len() {
        let tag = &bytes[p..p + 4];
        let size = u32::from_le_bytes(bytes[p + 4..p + 8].try_into().ok()?) as usize;
        let data = p + 8;
        if tag == b"MODL" {
            let name = bytes.get(data..data.checked_add(80)?)?;
            let end = name.iter().position(|&b| b == 0).unwrap_or(name.len());
            return std::str::from_utf8(&name[..end]).ok().map(str::trim).filter(|s| !s.is_empty());
        }
        p = data.checked_add(size)?;
    }
    None
}

fn is_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'\\' | b'/' | b'.' | b'-' | b' ' | b'(' | b')' | b'!' | b'#' | b'&' | b'\'' | b'+' | b',' | b'[' | b']')
}

/// Finds things that look like file paths inside arbitrary bytes, and adds
/// common variants (model ↔ portrait, .mdl ↔ .mdx).
pub fn scan_candidates(bytes: &[u8], out: &mut BTreeSet<String>) {
    if let Some(name) = mdx_model_name(bytes) {
        if name.bytes().all(is_path_byte) {
            scan_token(&format!("{name}.mdx"), out);
        }
    }
    for token in bytes.split(|&b| !is_path_byte(b)) {
        if token.len() < 3 || token.len() > 260 {
            continue;
        }
        let Ok(s) = std::str::from_utf8(token) else {
            continue;
        };
        scan_token(s, out);
        // A script's string literal doubles its backslashes (JASS and Lua: "war3mapImported\\X.blp"): the path is
        // the one with single ones (44 imports of The Chosen Ones campaign are named only this way).
        if s.contains(r"\\") {
            scan_token(&s.replace(r"\\", r"\"), out);
        }
    }
}

fn scan_token(s: &str, out: &mut BTreeSet<String>) {
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
        // Imports may sit in the import folder of a map or a campaign: a chapter's script names a campaign import as
        // war3mapImported\X as often as war3campImported\X. And an import keeps only its file name when a model names
        // it with folders (Textures\Zap1b.blp stored as war3campImported\Zap1b.blp or Zap1b.blp). The Chosen Ones
        // campaign: 108 more of its 494 unnamed files found by these, 2026-11-20.
        for f in forms {
            let lower = f.to_ascii_lowercase();
            let rest = ["war3mapimported\\", "war3campimported\\"].iter().find_map(|p| lower.starts_with(p).then(|| &f[p.len()..]));
            let file = f.rsplit('\\').next().unwrap_or(&f);
            for base in [rest.unwrap_or(&f), file] {
                out.insert(format!("war3mapImported\\{base}"));
                out.insert(format!("war3campImported\\{base}"));
                out.insert(base.to_string());
            }
            out.insert(f);
        }
    }
}
