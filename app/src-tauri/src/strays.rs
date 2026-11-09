//! Files an older version left with a `\` in their name. Before paths were joined part by part
//! (`lib/paths.ts`), a project path was put together with a hand-written `\`; on Linux that is an
//! ordinary character in a file name, so `<parent>/<project>\build\checkpoints\x.w3x` became one
//! oddly named file next to the project instead of a checkpoint in it, and `<folder>/a\b.txt` one
//! file in a folder of the project instead of `a/b.txt` below it.
//!
//! `scan` finds them (next to the project: only names that start with the project folder's name and
//! a `\`; inside it: every name with a `\`) and says what can be done with each; `fix` does it for
//! one, after checking again. Nothing is moved over a file that is there, and a file is deleted only
//! when the one where it belongs has the same bytes. On Windows a name can't hold a `\`, so there is
//! never anything to find.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// What can be done with a stray file.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StrayKind {
    /// Nothing is where it belongs: it can be moved there.
    Move,
    /// Where it belongs is a file with the same bytes: the stray is a copy and can be deleted.
    Duplicate,
    /// Where it belongs is something else: left alone.
    Conflict,
    /// Where it belongs couldn't be checked (or one of the two couldn't be read): left alone.
    Unreadable,
    /// Its name leads nowhere safe (`..`, `.`, a drive), or it is a folder: left alone.
    Unsafe,
}

#[derive(Serialize, Debug, Clone)]
pub struct Stray {
    /// The file as it is, a full path.
    pub path: String,
    /// The file as it is, from the folder holding the project (`/` between folders).
    pub shown: String,
    /// Where it belongs, below the project root with `/`; empty when nowhere safe.
    pub rel: String,
    pub kind: StrayKind,
    /// Why it is left alone, for Unreadable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where a stray file belongs: Some(Ok(path)) below `root`, Some(Err(why)) when its name leads nowhere
/// safe, None when it isn't a stray of this project.
pub fn belongs(root: &Path, file: &Path) -> Option<Result<PathBuf, String>> {
    let name = file.file_name()?.to_str()?;
    if !name.contains('\\') {
        return None;
    }
    let folder = file.parent()?;
    let rest = if Some(folder) == root.parent() {
        let own = root.file_name()?.to_str()?;
        name.strip_prefix(own)?.strip_prefix('\\')?
    } else if folder.starts_with(root) {
        name
    } else {
        return None;
    };
    let base = if Some(folder) == root.parent() { root } else { folder };
    let parts: Vec<&str> = rest.split('\\').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "." || *p == ".." || p.contains(':') || p.contains('/')) {
        return Some(Err(format!("{name}: its name doesn't lead to a place in the project")));
    }
    Some(Ok(parts.iter().fold(base.to_path_buf(), |p, part| p.join(part))))
}

/// Whether two files have the same bytes.
fn same_bytes(a: &Path, b: &Path) -> std::io::Result<bool> {
    if std::fs::metadata(a)?.len() != std::fs::metadata(b)?.len() {
        return Ok(false);
    }
    Ok(std::fs::read(a)? == std::fs::read(b)?)
}

fn classify(root: &Path, file: &Path, is_dir: bool) -> Option<Stray> {
    let target = belongs(root, file)?;
    let top = root.parent().unwrap_or(root);
    let shown = file.strip_prefix(top).unwrap_or(file).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    let rel_of = |t: &Path| t.strip_prefix(root).unwrap_or(t).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    let stray = |kind, rel: String, error: Option<String>| Stray { path: file.to_string_lossy().into_owned(), shown: shown.clone(), rel, kind, error };
    let target = match target {
        Ok(t) => t,
        Err(why) => return Some(stray(StrayKind::Unsafe, String::new(), Some(why))),
    };
    let rel = rel_of(&target);
    if is_dir {
        return Some(stray(StrayKind::Unsafe, rel, Some("a folder: move what is in it by hand".into())));
    }
    Some(match target.try_exists() {
        Ok(false) => stray(StrayKind::Move, rel, None),
        Ok(true) => match same_bytes(file, &target) {
            Ok(true) => stray(StrayKind::Duplicate, rel, None),
            Ok(false) => stray(StrayKind::Conflict, rel, None),
            Err(e) => stray(StrayKind::Unreadable, rel, Some(e.to_string())),
        },
        Err(e) => stray(StrayKind::Unreadable, rel, Some(e.to_string())),
    })
}

/// The stray files of the project at `root`: next to it and inside it (without `.git` and `node_modules`).
/// A folder that can't be read is passed over: what is in it isn't touched either way.
pub fn scan(root: &Path) -> Vec<Stray> {
    let mut out = Vec::new();
    if let Some(parent) = root.parent() {
        for entry in std::fs::read_dir(parent).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if !kind.is_symlink() {
                out.extend(classify(root, &entry.path(), kind.is_dir()));
            }
        }
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            if kind.is_dir() && !name.to_string_lossy().contains('\\') {
                if !(dir == root && (name == ".git" || name == "node_modules")) {
                    stack.push(path);
                }
                continue;
            }
            out.extend(classify(root, &path, kind.is_dir()));
        }
    }
    out.sort_by(|a, b| (&a.rel, &a.path).cmp(&(&b.rel, &b.path)));
    out
}

/// What `fix` did.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Fixed {
    Moved,
    Deleted,
}

/// Moves one stray file of the project at `root` where it belongs, or deletes it when the file there has the
/// same bytes. Everything is checked again here: the file must still be a stray of this project, and nothing
/// is ever written over.
pub fn fix(root: &Path, file: &Path) -> Result<Fixed, String> {
    let shown = file.display();
    let target = match belongs(root, file) {
        Some(Ok(t)) => t,
        Some(Err(why)) => return Err(why),
        None => return Err(format!("{shown} isn't a stray file of this project")),
    };
    let meta = std::fs::symlink_metadata(file).map_err(|e| format!("{shown}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{shown} isn't a file"));
    }
    let there = target.try_exists().map_err(|e| format!("{}: {e}", target.display()))?;
    if !there {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        // A link fails if something got there meanwhile, where a rename would write over it.
        match std::fs::hard_link(file, &target) {
            Ok(()) => {
                std::fs::remove_file(file).map_err(|e| format!("{shown}: {e}"))?;
                return Ok(Fixed::Moved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => {
                // A file system without links: checked once more, then renamed.
                if !target.try_exists().map_err(|e| format!("{}: {e}", target.display()))? {
                    std::fs::rename(file, &target).map_err(|e| format!("{shown}: {e}"))?;
                    return Ok(Fixed::Moved);
                }
            }
        }
    }
    if same_bytes(file, &target).map_err(|e| format!("{shown}: {e}"))? {
        std::fs::remove_file(file).map_err(|e| format!("{shown}: {e}"))?;
        return Ok(Fixed::Deleted);
    }
    Err(format!("{} is there already and differs: {shown} is left as it is", target.display()))
}

/// Only where a name can hold a `\`: on Windows these names are paths.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("w3proj-strays-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("proj").join("map")).unwrap();
        dir
    }

    #[test]
    fn a_name_with_a_backslash_belongs_below_the_project_and_nowhere_else() {
        let dir = temp("belongs");
        let root = dir.join("proj");
        let beside = dir.join(r"proj\build\checkpoints\proj 1.w3x");
        assert_eq!(belongs(&root, &beside), Some(Ok(root.join("build").join("checkpoints").join("proj 1.w3x"))));
        let inside = root.join("map").join(r"Scripts\a.lua");
        assert_eq!(belongs(&root, &inside), Some(Ok(root.join("map").join("Scripts").join("a.lua"))));
        // Another project's stray next to this one, a plain name, and a file elsewhere: not this project's.
        assert_eq!(belongs(&root, &dir.join(r"other\build\x.w3x")), None);
        assert_eq!(belongs(&root, &dir.join(r"proj2\build\x.w3x")), None);
        assert_eq!(belongs(&root, &root.join("map").join("plain.txt")), None);
        assert_eq!(belongs(&root, &std::env::temp_dir().join(r"a\b")), None);
        // A name that would climb out, or name a drive, leads nowhere.
        assert!(matches!(belongs(&root, &dir.join(r"proj\..\..\evil")), Some(Err(_))));
        assert!(matches!(belongs(&root, &root.join(r"C:\Users\x")), Some(Err(_))));
        assert!(matches!(belongs(&root, &dir.join(r"proj\")), Some(Err(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The strays a project opened on Linux before the fix has, each with what can be done; then fixed one by one:
    /// moved, a copy deleted, and one that differs from what is there left as it was.
    #[test]
    fn strays_are_found_and_moved_without_writing_over_anything() {
        let dir = temp("scan");
        let root = dir.join("proj");
        std::fs::create_dir_all(root.join("build").join("checkpoints")).unwrap();
        std::fs::write(root.join("build").join("checkpoints").join("same.w3x"), b"same").unwrap();
        std::fs::write(root.join("build").join("checkpoints").join("other.w3x"), b"them").unwrap();
        let moved = dir.join(r"proj\build\checkpoints\new.w3x");
        let copy = dir.join(r"proj\build\checkpoints\same.w3x");
        let clash = dir.join(r"proj\build\checkpoints\other.w3x");
        let inside = root.join(r"map\Scripts\a.lua");
        let theirs = dir.join(r"proj2\build\x.w3x");
        for (p, b) in [(&moved, &b"new"[..]), (&copy, b"same"), (&clash, b"mine"), (&inside, b"lua"), (&theirs, b"x")] {
            std::fs::write(p, b).unwrap();
        }
        let found = scan(&root);
        let kinds: Vec<(&str, StrayKind)> = found.iter().map(|s| (s.rel.as_str(), s.kind)).collect();
        assert_eq!(
            kinds,
            [
                ("build/checkpoints/new.w3x", StrayKind::Move),
                ("build/checkpoints/other.w3x", StrayKind::Conflict),
                ("build/checkpoints/same.w3x", StrayKind::Duplicate),
                ("map/Scripts/a.lua", StrayKind::Move),
            ],
            "{found:?}"
        );
        assert_eq!(found[0].shown, r"proj\build\checkpoints\new.w3x");
        assert_eq!(found[3].shown, r"proj/map\Scripts\a.lua");

        assert_eq!(fix(&root, &moved), Ok(Fixed::Moved));
        assert_eq!(std::fs::read(root.join("build").join("checkpoints").join("new.w3x")).unwrap(), b"new");
        assert!(!moved.exists());
        assert_eq!(fix(&root, &copy), Ok(Fixed::Deleted));
        assert!(!copy.exists());
        assert_eq!(std::fs::read(root.join("build").join("checkpoints").join("same.w3x")).unwrap(), b"same");
        assert!(fix(&root, &clash).is_err());
        assert_eq!(std::fs::read(&clash).unwrap(), b"mine", "the stray that differs stays");
        assert_eq!(std::fs::read(root.join("build").join("checkpoints").join("other.w3x")).unwrap(), b"them", "and so does the file there");
        assert_eq!(fix(&root, &inside), Ok(Fixed::Moved));
        assert_eq!(std::fs::read(root.join("map").join("Scripts").join("a.lua")).unwrap(), b"lua");
        // Not this project's, or not a stray: refused, untouched.
        assert!(fix(&root, &theirs).is_err());
        assert!(theirs.exists());
        assert!(fix(&root, &root.join("build").join("checkpoints").join("same.w3x")).is_err());
        // What is left: only the one that differs.
        let left: Vec<StrayKind> = scan(&root).iter().map(|s| s.kind).collect();
        assert_eq!(left, [StrayKind::Conflict]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
