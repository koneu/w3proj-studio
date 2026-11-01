//! Warcraft III's view of the storage: the text root (`mod:path|ckey|…`)
//! and the mod layering the game uses to resolve a plain path like
//! `Units\UnitMetaData.slk`.

use std::collections::HashMap;
use std::path::Path;

use crate::storage::{parse_hex, CKey, Storage};
use crate::{Error, Result};

/// Which art set to resolve against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Classic graphics.
    Sd,
    /// Reforged graphics.
    Hd,
    /// The 3.0 art layer (`_de.w3mod`).
    De,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s.to_ascii_lowercase().as_str() {
            "sd" => Some(Mode::Sd),
            "hd" => Some(Mode::Hd),
            "de" => Some(Mode::De),
            _ => None,
        }
    }
}

pub struct RootEntry {
    /// As written in the root, e.g. `War3.w3mod:_HD.w3mod:Units/Human/Footman/Footman.mdx`.
    pub path: String,
    pub ckey: CKey,
}

pub struct GameData {
    pub storage: Storage,
    entries: Vec<RootEntry>,
    /// Lower-cased full path (with `/`) → index into `entries`.
    by_path: HashMap<String, usize>,
    /// Locale whose files are installed, e.g. "dede".
    pub locale: String,
    /// `FileAliases.json`: normalised src → normalised dest.
    aliases: HashMap<String, String>,
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/").to_ascii_lowercase()
}

/// Extracts `"src": "…", "dest": "…"` pairs. The file is a flat array of
/// small objects, so a scan is enough and avoids a JSON dependency.
fn parse_aliases(json: &str) -> HashMap<String, String> {
    let field = |obj: &str, name: &str| -> Option<String> {
        let rest = &obj[obj.find(&format!("\"{name}\""))? + name.len() + 2..];
        let rest = &rest[rest.find('"')? + 1..];
        Some(rest[..rest.find('"')?].to_string())
    };
    json.split('{')
        .filter_map(|obj| Some((normalize(&field(obj, "src")?), normalize(&field(obj, "dest")?))))
        .collect()
}

impl GameData {
    pub fn open(install: &Path) -> Result<GameData> {
        let storage = Storage::open(install, "w3")?;
        let root_ckey = storage
            .config_key(0, "root")
            .ok_or_else(|| Error::Storage("build config has no root".into()))?;
        let root = storage.read_ckey(&root_ckey)?;
        let text = String::from_utf8_lossy(&root);
        let mut entries = Vec::new();
        let mut by_path = HashMap::new();
        for line in text.lines() {
            let mut f = line.split('|');
            // path | content key | locale or platform | install path
            let (Some(path), Some(key)) = (f.next(), f.next()) else { continue };
            // Rows with an install path are client binaries, not game data.
            if f.nth(1).is_some_and(|install| !install.is_empty()) {
                continue;
            }
            let Some(ckey) = parse_hex::<16>(key) else { continue };
            by_path.insert(normalize(path), entries.len());
            entries.push(RootEntry { path: path.to_string(), ckey });
        }

        // The installed locale is the one whose files are actually stored.
        let mut counts: HashMap<String, usize> = HashMap::new();
        for e in &entries {
            let lower = e.path.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("war3.w3mod:_locales/") {
                if let Some((loc, _)) = rest.split_once(".w3mod:") {
                    if storage.ekey_for(&e.ckey).is_some_and(|k| storage.has_ekey(&k)) {
                        *counts.entry(loc.to_string()).or_default() += 1;
                    }
                }
            }
        }
        let locale = counts
            .into_iter()
            .max_by_key(|(_, n)| *n)
            .map(|(l, _)| l)
            .unwrap_or_else(|| "enus".into());

        let mut data = GameData {
            storage,
            entries,
            by_path,
            locale,
            aliases: HashMap::new(),
        };
        if let Ok(json) = data.read_exact("war3.w3mod:fileAliases.json") {
            data.aliases = parse_aliases(&String::from_utf8_lossy(&json));
        }
        Ok(data)
    }

    /// Mod prefixes searched for a plain path, most specific first.
    pub fn layers(&self, mode: Mode, tileset: Option<char>) -> Vec<String> {
        let loc = &self.locale;
        let mut out = Vec::new();
        let mut art = |base: &str| {
            if let Some(t) = tileset {
                out.push(format!("{base}_tilesets/{}.w3mod:", t.to_ascii_lowercase()));
            }
            out.push(format!("{base}_locales/{loc}.w3mod:"));
            out.push(base.to_string());
        };
        match mode {
            Mode::De => art("war3.w3mod:_de.w3mod:"),
            Mode::Hd => art("war3.w3mod:_hd.w3mod:"),
            Mode::Sd => {}
        }
        art("war3.w3mod:");
        out.push("war3.w3mod:_deprecated.w3mod:".into());
        out
    }

    /// Resolves a plain game path through the layers. Returns the full root
    /// path of the first layer that has the file stored locally.
    ///
    /// Like the game, it follows `FileAliases.json` and falls back from
    /// `.blp` to `.dds` (Reforged ships DDS but data still names BLP) and
    /// from `.mdl` to `.mdx`.
    pub fn resolve(&self, path: &str, mode: Mode, tileset: Option<char>) -> Option<&str> {
        let p = normalize(path);
        let mut candidates = vec![p.clone()];
        if let Some(dest) = self.aliases.get(&p) {
            candidates.push(dest.clone());
        }
        for c in candidates.clone() {
            if let Some(stem) = c.strip_suffix(".blp") {
                candidates.push(format!("{stem}.dds"));
            } else if let Some(stem) = c.strip_suffix(".mdl") {
                candidates.push(format!("{stem}.mdx"));
            }
        }
        let layers = self.layers(mode, tileset);
        candidates.iter().find_map(|c| {
            layers.iter().find_map(|layer| {
                let i = *self.by_path.get(&format!("{layer}{c}"))?;
                self.is_local(i).then(|| self.entries[i].path.as_str())
            })
        })
    }

    pub fn read(&self, path: &str, mode: Mode, tileset: Option<char>) -> Result<(String, Vec<u8>)> {
        let full = self
            .resolve(path, mode, tileset)
            .ok_or_else(|| Error::NotFound(path.to_string()))?
            .to_string();
        let data = self.read_exact(&full)?;
        Ok((full, data))
    }

    /// Reads a full root path (`War3.w3mod:…`), no layering.
    pub fn read_exact(&self, full_path: &str) -> Result<Vec<u8>> {
        let i = *self
            .by_path
            .get(&normalize(full_path))
            .ok_or_else(|| Error::NotFound(full_path.to_string()))?;
        self.storage.read_ckey(&self.entries[i].ckey)
    }

    fn is_local(&self, i: usize) -> bool {
        self.storage
            .ekey_for(&self.entries[i].ckey)
            .is_some_and(|k| self.storage.has_ekey(&k))
    }

    /// All root entries that are stored locally (readable).
    pub fn local_paths(&self) -> impl Iterator<Item = &str> {
        self.entries
            .iter()
            .enumerate()
            .filter(|(i, _)| self.is_local(*i))
            .map(|(_, e)| e.path.as_str())
    }

    pub fn total_entries(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases() {
        let a = parse_aliases(
            r#"[ {"src":"SharedModels/Dust3.blp", "dest":"Textures/Dust3.blp", "assetType": "Texture"},
                 {"src":"A\B.mdx", "dest":"C/D.mdx"} ]"#,
        );
        assert_eq!(a.get("sharedmodels/dust3.blp").unwrap(), "textures/dust3.blp");
        assert_eq!(a.get("a/b.mdx").unwrap(), "c/d.mdx");
    }
}
