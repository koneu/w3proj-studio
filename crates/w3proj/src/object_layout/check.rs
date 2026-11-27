//! Check Objects: everything the files of `map/objects/` get wrong, all at once, mostly after a Git merge
//! (docs/object-folders-spec.md, section 5). The rules are pack's own (`parse_root`, `parse_object`, `listed_names`,
//! `encode_kind`), which stops at the first error; this one goes on. It reports and never edits.

use std::collections::HashMap;

use serde::Serialize;

use super::*;
use crate::trigger_check::Severity;

/// One finding.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub severity: Severity,
    /// The file, relative to `map/` as given (`objects/…`).
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    pub message: String,
}

/// The line (from 1) of the first conflict marker.
fn marker_line(bytes: &[u8]) -> Option<usize> {
    bytes.split(|&b| b == b'\n').position(has_conflict_markers).map(|i| i + 1)
}

fn error(file: &str, bytes: &[u8], e: Error) -> Issue {
    Issue { severity: Severity::Error, file: file.to_string(), line: marker_line(bytes), message: e.to_string() }
}

fn warning(file: &str, message: String) -> Issue {
    Issue { severity: Severity::Warning, file: file.to_string(), line: None, message }
}

/// What the layout's files among `files` (relative to `map/`) get wrong, by file; nothing for files without the layout.
/// An error is what pack refuses, a warning what it only mentions.
pub fn check(files: &Files, prefix: Prefix) -> Vec<Issue> {
    let mut out = Vec::new();
    let files = match layout_files(files, &[]) {
        Ok(f) => f,
        Err(e) => return vec![error(ROOT_FILE, b"", e)],
    };
    if files.is_empty() {
        return out;
    }
    let Some(root_bytes) = files.get(ROOT_FILE) else {
        let first = files.keys().next().expect("not empty");
        return vec![error(first, b"", bad(format!("map/{first} is an object file, but map/{ROOT_FILE} is missing: without it the objects can't be packed")))];
    };
    // Without a readable objects.json, which halves are packed isn't known: any is taken, so each file's own faults
    // still show.
    let versions = parse_root(root_bytes).unwrap_or_else(|e| {
        out.push(error(ROOT_FILE, root_bytes, e));
        [[Some(3); 2]; 7]
    });
    let root_ok = out.is_empty();
    for (i, kind) in KINDS.iter().enumerate() {
        let head = format!("{DIR}/{}/", kind.folder);
        let before = out.iter().filter(|x| x.severity == Severity::Error).count();
        // The ids of the files that read, by table.
        let mut ids: [HashMap<[u8; 4], &String>; 2] = Default::default();
        let mut names: [HashSet<String>; 2] = Default::default();
        let mut orders: [Option<(&String, &Vec<u8>)>; 2] = [None, None];
        for (path, bytes) in below(&files, &head) {
            let rest = &path[head.len()..];
            let table = rest.split_once('/').and_then(|(t, name)| Some((TABLES.iter().position(|x| *x == t)?, name)));
            match table {
                Some((t, ORDER)) => {
                    if has_conflict_markers(bytes) {
                        out.push(error(path, bytes, conflict(path)));
                    } else {
                        orders[t] = Some((path, bytes));
                    }
                }
                Some((t, name)) if !name.contains('/') && name.len() > 5 && name.ends_with(".json") => {
                    // A file that doesn't read still counts for order.txt: it is there.
                    names[t].insert(name[..name.len() - 5].to_string());
                    match parse_object(path, bytes, t, *kind, prefix, versions[i]) {
                        Ok((_, o)) => {
                            if o.halves.iter().all(Option::is_none) {
                                out.push(warning(path, format!("map/{path} has neither a \"data\" nor a \"skin\" half: nothing of it is packed")));
                            }
                            ids[t].insert(o.key(t).0, path);
                        }
                        Err(e) => out.push(error(path, bytes, e)),
                    }
                }
                _ => out.push(error(path, b"", not_part(path))),
            }
        }
        for (t, order) in orders.into_iter().enumerate() {
            let Some((path, bytes)) = order else { continue };
            let mut said = Vec::new();
            listed_names(&format!("map/{path}"), bytes, &|n| names[t].contains(n), &mut said);
            out.extend(said.into_iter().map(|m| warning(path, m)));
        }
        let mut twice: Vec<(&[u8; 4], &&String)> = ids[1].iter().filter(|(id, _)| ids[0].contains_key(*id)).collect();
        twice.sort_by_key(|(_, path)| path.as_str());
        for (id, path) in twice {
            out.push(error(path, b"", both_tables(path, ids[0][id])));
        }
        // What only the codec refuses, once the files themselves read.
        if root_ok && out.iter().filter(|x| x.severity == Severity::Error).count() == before {
            if let Err(e) = parse_kind(*kind, prefix, versions[i], &files, &mut Vec::new()).and_then(|d| encode_kind(*kind, prefix, &d)) {
                let message = e.to_string();
                let named = files.keys().find(|k| message.contains(&format!("map/{k}:")));
                out.push(error(named.map_or(ROOT_FILE, String::as_str), b"", e));
            }
        }
    }
    out.sort_by(|a, b| (a.severity != Severity::Error, &a.file).cmp(&(b.severity != Severity::Error, &b.file)));
    out
}
