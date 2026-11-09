//! Writing `w3proj.toml` without losing what the user put in it: the manifest on disk is edited in
//! place, and only the keys Studio owns (the fields of `project::Manifest`) are changed. Comments,
//! key order, formatting and keys Studio doesn't know stay as they are, and a manifest whose owned
//! values are already right is left byte for byte.

use toml_edit::{DocumentMut, Item, TableLike, Value};

/// The keys Studio owns: top-level keys, each a value (no fields) or a table with these fields.
/// Every key `Manifest` writes must be here (checked by a test), else it would never be updated.
pub(crate) const OWNED: &[(&str, &[&str])] = &[
    ("format", &[]),
    ("map", &["name", "flags", "max_players", "unknown"]),
    ("archive", &["sector_size_shift"]),
    ("pack", &["output", "raw"]),
];

/// The manifest text `old` with the owned keys set as in `new` (the manifest written from the
/// struct): a key `new` doesn't have is removed, one that differs is replaced (keeping the comment
/// after it), one that is the same is left alone. None when nothing changes. An error when either
/// text isn't TOML: then nothing may be written over the file.
pub(crate) fn merge(old: &str, new: &str) -> Result<Option<String>, String> {
    let mut doc: DocumentMut = old.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let fresh: DocumentMut = new.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let mut changed = false;
    for (key, fields) in OWNED {
        let want = fresh.get(key);
        if fields.is_empty() {
            changed |= set(doc.as_table_mut(), key, want);
            continue;
        }
        let table = doc.get_mut(key).and_then(Item::as_table_like_mut);
        match (table, want) {
            (Some(table), Some(want)) if want.is_table_like() => {
                let want = want.as_table_like().unwrap();
                for field in *fields {
                    changed |= set(table, field, want.get(field));
                }
            }
            (Some(table), None) => {
                for field in *fields {
                    changed |= set(table, field, None);
                }
                if table.is_empty() {
                    doc.remove(key);
                }
            }
            // Not there, or not a table (a manifest like that doesn't load): written as Studio has it.
            (_, want) => changed |= set(doc.as_table_mut(), key, want),
        }
    }
    Ok(changed.then(|| doc.to_string()))
}

/// Sets `key` in `table` to `want` (None: removes it). Whether anything changed.
fn set(table: &mut dyn TableLike, key: &str, want: Option<&Item>) -> bool {
    let Some(want) = want else {
        return table.remove(key).is_some();
    };
    match table.get_mut(key) {
        Some(Item::Value(old)) if want.as_value().is_some_and(|w| same(old, w)) => false,
        Some(Item::Value(old)) if want.is_value() => {
            let mut value = want.as_value().unwrap().clone();
            *value.decor_mut() = old.decor().clone();
            *old = value;
            true
        }
        Some(old) => {
            *old = placed(want);
            true
        }
        None => {
            table.insert(key, placed(want));
            true
        }
    }
}

/// An item of the fresh manifest, to go into the one on disk: a table goes after the ones there
/// (its place in the fresh text means nothing in the other).
fn placed(item: &Item) -> Item {
    let mut item = item.clone();
    if let Item::Table(t) = &mut item {
        t.set_position(None);
    }
    item
}

/// The same TOML value, however it is written.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => x.value() == y.value(),
        (Value::Integer(x), Value::Integer(y)) => x.value() == y.value(),
        (Value::Float(x), Value::Float(y)) => x.value().to_bits() == y.value().to_bits(),
        (Value::Boolean(x), Value::Boolean(y)) => x.value() == y.value(),
        (Value::Datetime(x), Value::Datetime(y)) => x.value() == y.value(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| same(a, b)),
        (Value::InlineTable(x), Value::InlineTable(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::MapHeader;
    use crate::project::{ArchiveSettings, Manifest, PackSettings};

    fn full() -> String {
        let m = Manifest {
            format: 1,
            map: Some(MapHeader { name: "n".into(), flags: 1, max_players: 2, unknown: 3 }),
            archive: ArchiveSettings { sector_size_shift: 3 },
            pack: PackSettings { output: Some("o.w3x".into()), raw: vec!["r".into()] },
        };
        toml::to_string_pretty(&m).unwrap()
    }

    /// A field added to the manifest must be added to OWNED too, else saves would never update it.
    #[test]
    fn every_key_the_manifest_writes_is_owned() {
        let doc: DocumentMut = full().parse().unwrap();
        for (key, item) in doc.iter() {
            let fields = OWNED.iter().find(|(k, _)| *k == key).unwrap_or_else(|| panic!("{key} isn't owned")).1;
            if let Some(t) = item.as_table_like() {
                for (field, _) in t.iter() {
                    assert!(fields.contains(&field), "{key}.{field} isn't owned");
                }
            } else {
                assert!(fields.is_empty(), "{key} is owned as a table");
            }
        }
    }

    #[test]
    fn the_same_values_written_differently_are_no_change() {
        let old = "format = 0x1 # hex\n[map]\nname = 'n'\nflags = 1\nmax_players = 2\nunknown = 3\n[archive]\nsector_size_shift = 3\n[pack]\noutput = \"o.w3x\"\nraw = [ 'r', ]\n";
        assert_eq!(merge(old, &full()).unwrap(), None);
    }

    #[test]
    fn a_table_studio_adds_goes_after_the_ones_there() {
        let old = "format = 1\n[archive]\nsector_size_shift = 3\n[mine]\nx = 1\n";
        let out = merge(old, &full()).unwrap().unwrap();
        let mine = out.find("[mine]").unwrap();
        assert!(out.find("[map]").unwrap() > mine && out.find("[pack]").unwrap() > mine, "{out}");
        let back: Manifest = toml::from_str(&out).unwrap();
        assert_eq!(back.pack.output.as_deref(), Some("o.w3x"));
        assert_eq!(back.map.unwrap().name, "n");
    }

    #[test]
    fn a_text_that_isnt_toml_is_an_error() {
        assert!(merge("format = = 1", &full()).is_err());
        assert!(merge("[map]\n[map]\n", &full()).is_err());
    }
}
