//! The trigger tree of a project (`map/triggers/`, `w3proj::trigger_layout`) for the app's code, in one call each way.
//!
//! `read` hands the app the whole tree as it works with it (`TriggerFile` and `CustomTextFile`, app/src/lib/triggers/wtg.ts):
//! every item with an id, given in memory where the files store none (new items) or store one twice (World Editor maps
//! have categories that share an id, which would make the app's parent ids ambiguous); `stored` maps such an in-memory
//! id back to what the files have. `plan` and `write` slice a tree the app hands back into the files again and touch
//! only those whose content changed: an item unchanged since it was read keeps its file as it is (a hand-made
//! `order.txt` or a frontmatter written by another tool too), a deleted item's file goes, a renamed item's file is
//! renamed. Imported ids, counters and the variable table's order stay; the order goes with the first save that adds,
//! removes or renames a variable.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use w3proj::trigger_layout::{self as tl, Kind, Lang, Tree};
use w3proj::wct::Wct;
use w3proj::wtg::{Item, TriggerFile};

use crate::flatview::Also;
use crate::{err, exists_checked, CmdResult};

/// Where the layout's files are, as project paths.
const PREFIX: &str = "map/";

/// One save of the trigger files at a time (two would each read the files and decide from them).
static WRITING: Mutex<()> = Mutex::new(());

/// The app's `CustomTextFile`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Custom {
    pub reforged: bool,
    pub version: u32,
    pub comment: String,
    pub header: Option<String>,
    pub texts: Vec<Option<String>>,
}

/// The tree as `read` hands it to the app.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub file: TriggerFile,
    pub custom: Custom,
    /// Per item of `file.items`: its file or folder (a project path), None for the map item and variable nodes.
    pub files: Vec<Option<String>>,
    /// The custom script header's file (None: the header has no text).
    pub header_file: Option<String>,
    /// In-memory ids that aren't the ones the files store, by namespace ("f" folders and the map item, "t" triggers,
    /// comments and script items, "v" variables) and id: the stored id, None when the files store none.
    pub stored: BTreeMap<String, Option<u32>>,
    pub language: &'static str,
    pub script: &'static str,
    pub warnings: Vec<String>,
}

/// What the app hands back to be saved.
#[derive(Deserialize, Debug)]
pub struct Save {
    pub file: TriggerFile,
    pub custom: Custom,
    /// `Read::stored`, as read.
    #[serde(default)]
    pub stored: BTreeMap<String, Option<u32>>,
}

/// The files a save changes: written (project path → bytes) and removed (project paths).
#[derive(Debug, Default)]
pub struct Plan {
    pub write: BTreeMap<String, Vec<u8>>,
    pub delete: Vec<String>,
    /// The tree as it will be on disk (for the files of its items afterwards).
    files_after: Vec<Option<String>>,
    header_after: Option<String>,
}

/// What `write` did: every file written or removed (removed ones with size and time 0), and the files of the saved
/// tree's items (as `Read::files`, in the order of the `TriggerFile` saved).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub also: Vec<Also>,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    pub files: Vec<Option<String>>,
    pub header_file: Option<String>,
}

fn ns(ty: u32) -> char {
    match ty {
        1 | 2 | 4 => 'f',
        64 => 'v',
        _ => 't',
    }
}

fn key(ns: char, id: u32) -> String {
    format!("{ns}{id}")
}

fn node_type(n: &tl::Node) -> u32 {
    match &n.kind {
        Kind::Folder { ty, .. } => *ty,
        Kind::Trigger { t, .. } => t.ty,
        Kind::Var { .. } => 64,
    }
}

/// The map's script language: war3map.w3i's `scriptType` (its JSON, else the raw file read with the format definitions).
fn language(project: &Path, formats: &[PathBuf]) -> Lang {
    let map_dir = project.join(w3proj::project::MAP_DIR);
    let mut files = BTreeMap::new();
    if let Ok(b) = std::fs::read(map_dir.join("war3map.w3i.json")) {
        files.insert("war3map.w3i.json".to_string(), b);
        // The JSON needs no format definitions.
        return tl::language(&files, &w3proj::Registry::empty());
    }
    match std::fs::read(map_dir.join("war3map.w3i")) {
        Ok(b) => {
            files.insert("war3map.w3i".to_string(), b);
            match w3proj::Registry::for_project(project, formats) {
                Ok(r) => tl::language(&files, &r),
                Err(_) => Lang::Jass,
            }
        }
        Err(_) => Lang::Jass,
    }
}

fn lang_name(l: Lang) -> &'static str {
    match l {
        Lang::Jass => "jass",
        Lang::Lua => "lua",
    }
}

/// The layout's files on disk (keys relative to `map/`); empty without `map/triggers/`.
fn disk(project: &Path) -> CmdResult<BTreeMap<String, Vec<u8>>> {
    tl::read_disk(&project.join(w3proj::project::MAP_DIR)).map_err(err)
}

/// The tree on disk; None without `map/triggers/`. Files that are there but can't be read are an error (never "no
/// triggers": a save would write over them).
fn tree_on_disk(project: &Path) -> CmdResult<Option<(Tree, Vec<String>, BTreeMap<String, Vec<u8>>)>> {
    let files = disk(project)?;
    if files.is_empty() {
        return Ok(None);
    }
    if !files.contains_key(tl::ROOT_FILE) {
        return Err(format!("map/{} is missing, so the files in map/{}/ can't be read as triggers", tl::ROOT_FILE, tl::DIR));
    }
    let (tree, warnings) = tl::from_files(&files).map_err(err)?;
    Ok(Some((tree, warnings, files)))
}

/// The files of a tree's items, as `Read::files` (the map item first in a Reforged tree).
fn item_files(tree: &Tree) -> Vec<Option<String>> {
    let mut out = Vec::with_capacity(tree.nodes.len() + 1);
    if tree.reforged {
        out.push(None);
    }
    for n in &tree.nodes {
        out.push(match n.kind {
            Kind::Var { .. } => None,
            _ => n.file.as_ref().map(|f| format!("{PREFIX}{f}")),
        });
    }
    out
}

/// The project's trigger tree, for the app (`triggers_read`); None when it has no `map/triggers/`.
pub fn read(root: &str, formats: &[PathBuf]) -> CmdResult<Option<Read>> {
    let project = Path::new(root);
    let Some((tree, warnings, _)) = tree_on_disk(project)? else { return Ok(None) };
    in_memory(&tree, language(project, formats), warnings).map(Some)
}

/// The tree as the app holds it: ids given where the files have none or the same one twice.
fn in_memory(tree: &Tree, lang: Lang, warnings: Vec<String>) -> CmdResult<Read> {
    let mut t = tree.clone();
    let mut seen: HashSet<(char, u32)> = HashSet::new();
    let root_stored = t.root.as_ref().map(|r| r.id);
    if let Some(id) = t.root.as_ref().and_then(|r| r.id) {
        seen.insert(('f', id));
    }
    // Per node: the stored id when memory gets another one (Some(None): the files store none).
    let mut differs: Vec<Option<Option<u32>>> = vec![None; t.nodes.len()];
    for (i, n) in t.nodes.iter_mut().enumerate() {
        let ty = node_type(n);
        // A variable node takes its variable's id; a Classic trigger's id is its place (the files store none).
        if ty == 64 || (!tree.reforged && ns(ty) == 't') {
            continue;
        }
        match n.id {
            Some(id) if seen.insert((ns(ty), id)) => {}
            Some(id) => {
                differs[i] = Some(Some(id));
                n.id = None;
            }
            None => differs[i] = Some(None),
        }
    }
    let mut var_differs: BTreeMap<String, Option<u32>> = BTreeMap::new();
    if tree.reforged {
        let mut seen_vars: HashSet<u32> = HashSet::new();
        for v in &mut t.vars {
            match v.id {
                Some(id) if seen_vars.insert(id) => {}
                other => {
                    var_differs.insert(v.v.name.clone(), other);
                    v.id = None;
                }
            }
        }
    }
    let (file, w, _) = tl::to_binary(&t).map_err(err)?;
    let mut stored = BTreeMap::new();
    let offset = usize::from(tree.reforged);
    if let (Some(None), Some(Item::Category(c))) = (root_stored, file.items.first()) {
        stored.insert(key('f', c.id), None);
    }
    for (i, d) in differs.iter().enumerate() {
        let Some(d) = d else { continue };
        let mem = match &file.items[offset + i] {
            Item::Category(c) => (ns(c.ty), c.id),
            Item::Trigger(x) => (ns(x.ty), x.id),
            Item::Element(e) => ('v', e.id),
        };
        stored.insert(key(mem.0, mem.1), *d);
    }
    for v in &file.variables {
        if let Some(d) = var_differs.get(&v.name) {
            stored.insert(key('v', v.id), *d);
        }
    }
    Ok(Read {
        files: item_files(tree),
        header_file: tree.header_file.as_ref().map(|h| format!("{PREFIX}triggers/{h}")),
        file,
        custom: Custom { reforged: w.reforged, version: w.version, comment: w.comment, header: w.header.flatten(), texts: w.texts },
        stored,
        language: lang_name(lang),
        script: tree.script.as_str(),
        warnings,
    })
}

/// The ids (namespace, id) a tree's files store.
fn stored_ids(tree: &Tree) -> HashSet<(char, u32)> {
    let mut out = HashSet::new();
    if let Some(id) = tree.root.as_ref().and_then(|r| r.id) {
        out.insert(('f', id));
    }
    for n in &tree.nodes {
        if let (Some(id), false) = (n.id, matches!(n.kind, Kind::Var { .. })) {
            out.insert((ns(node_type(n)), id));
        }
    }
    for v in &tree.vars {
        if let Some(id) = v.id {
            out.insert(('v', id));
        }
    }
    out
}

/// The tree a save holds, with the ids the files are to store: an in-memory id goes back to the stored one
/// (`Save::stored`), one the files on disk store stays, any other (a new item's) isn't stored. Counters, the script
/// mode and the variable table's order come from the tree on disk.
fn saved_tree(save: &Save, existing: Option<&Tree>) -> CmdResult<Tree> {
    let mut tf = save.file.clone();
    // A variable and its node share their id and folder.
    let nodes: Vec<(String, u32, i32)> = tf.items.iter().filter_map(|i| if let Item::Element(e) = i { Some((e.name.clone(), e.id, e.parent)) } else { None }).collect();
    for v in &mut tf.variables {
        if let Some((_, id, parent)) = nodes.iter().find(|(n, _, _)| *n == v.name) {
            v.id = *id;
            v.parent = *parent;
        }
    }
    let c = &save.custom;
    let header_slot = c.reforged || c.version >= 1;
    let w = Wct { reforged: c.reforged, version: c.version, comment: c.comment.clone(), header: header_slot.then(|| c.header.clone()), texts: c.texts.clone() };
    let mut tree = tl::from_binary(&tf, &w).map_err(|e| e.to_string().replace("the triggers can't go into map/triggers/: ", "the triggers can't be saved: "))?;
    let on_disk = existing.map(stored_ids).unwrap_or_default();
    let back = |ns: char, mem: u32| -> Option<u32> {
        match save.stored.get(&key(ns, mem)) {
            Some(s) => *s,
            None => on_disk.contains(&(ns, mem)).then_some(mem),
        }
    };
    if let Some(r) = &mut tree.root {
        r.id = r.id.and_then(|m| back('f', m));
    }
    for n in &mut tree.nodes {
        let ty = node_type(n);
        n.id = n.id.and_then(|m| back(ns(ty), m));
    }
    for v in &mut tree.vars {
        v.id = v.id.and_then(|m| back('v', m));
    }
    // A variable node's id is its variable's.
    let var_ids: BTreeMap<String, Option<u32>> = tree.vars.iter().map(|v| (v.v.name.clone(), v.id)).collect();
    for n in &mut tree.nodes {
        if let Kind::Var { name } = &n.kind {
            n.id = var_ids.get(name).copied().flatten();
        }
    }
    let names: Vec<String> = tf.variables.iter().map(|v| v.name.clone()).collect();
    tree.counts = existing.and_then(|e| e.counts.clone());
    tree.variable_order = match existing {
        Some(e) if e.variable_order.is_some() => {
            let before: BTreeSet<&str> = e.vars.iter().map(|v| v.v.name.as_str()).collect();
            let now: BTreeSet<&str> = names.iter().map(String::as_str).collect();
            (before == now && names != tree.tree_order()).then_some(names)
        }
        _ => None,
    };
    if let Some(e) = existing {
        tree.script = e.script;
        tree.header_file = e.header_file.clone();
    }
    Ok(tree)
}

/// The folder of a path relative to `map/` ("" for none).
fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// What a save changes on disk (`triggers_plan`): nothing is written. Without `map/triggers/` only `create` makes it
/// (a new map); a project whose triggers are kept raw (war3map.wtg, war3map.wct) never gets it next to them.
pub fn plan(root: &str, formats: &[PathBuf], save: &Save, create: bool) -> CmdResult<Plan> {
    let project = Path::new(root);
    let existing = tree_on_disk(project).map_err(|e| format!("The triggers weren't saved: map/{}/ can't be read ({e}).", tl::DIR))?;
    if existing.is_none() {
        if !create {
            return Err(format!("The triggers weren't saved: the project has no map/{}/.", tl::DIR));
        }
        let map_dir = project.join(w3proj::project::MAP_DIR);
        for raw in [tl::WTG, tl::WCT] {
            if exists_checked(&map_dir.join(raw))? {
                return Err(format!("The triggers weren't saved: the project keeps map/{raw} raw, and map/{}/ would be a second copy.", tl::DIR));
            }
        }
    }
    let (old, disk) = match &existing {
        Some((t, _, files)) => (Some(t), files.clone()),
        None => (None, BTreeMap::new()),
    };
    let lang = language(project, formats);
    let tree = saved_tree(save, old)?;
    tl::check_language(&tree, lang).map_err(err)?;
    let new = tl::to_files(&tree, lang, old).map_err(err)?;
    // The files the tree on disk would be written as: where the save gives the same, the item didn't change and its
    // file stays as it is (a file made by hand, an order.txt that leaves entries out).
    let canon = match old {
        Some(t) => tl::to_files(t, lang, Some(t)).unwrap_or_default(),
        None => BTreeMap::new(),
    };
    let mut plan = Plan::default();
    for (path, bytes) in &new {
        let base = path.rsplit('/').next().unwrap_or(path);
        // An order.txt or _category.json that isn't there reads as the one the layout would write.
        let same_as_read = canon.get(path) == Some(bytes) && (disk.contains_key(path) || base == "order.txt" || base == "_category.json");
        if same_as_read || disk.get(path) == Some(bytes) {
            continue;
        }
        plan.write.insert(format!("{PREFIX}{path}"), bytes.clone());
    }
    let mut dirs: HashSet<&str> = HashSet::new();
    for p in new.keys() {
        let mut d = dir_of(p);
        while !d.is_empty() && dirs.insert(d) {
            d = dir_of(d);
        }
    }
    for path in disk.keys() {
        if !new.contains_key(path) && (canon.contains_key(path) || !dirs.contains(dir_of(path))) {
            plan.delete.push(format!("{PREFIX}{path}"));
        }
    }
    // The files of the items once saved: read back from what the disk will hold.
    let mut after = disk;
    for p in &plan.delete {
        after.remove(&p[PREFIX.len()..]);
    }
    for (p, b) in &plan.write {
        after.insert(p[PREFIX.len()..].to_string(), b.clone());
    }
    if let Ok((t, _)) = tl::from_files(&after) {
        plan.files_after = item_files(&t);
        plan.header_after = t.header_file.map(|h| format!("{PREFIX}triggers/{h}"));
    }
    Ok(plan)
}

/// A plan as the app takes it: `{ write: [{ path, text }], delete: [path] }` (the layout's files are UTF-8 text: a
/// byte that isn't is written as a private-use character, `crate::lossless`).
pub fn plan_json(p: &Plan) -> CmdResult<serde_json::Value> {
    let write = p
        .write
        .iter()
        .map(|(path, b)| Ok(serde_json::json!({ "path": path, "text": String::from_utf8(b.clone()).map_err(|_| format!("{path} isn't UTF-8 text"))? })))
        .collect::<CmdResult<Vec<_>>>()?;
    Ok(serde_json::json!({ "write": write, "delete": p.delete }))
}

/// Saves the app's tree into `map/triggers/` (`triggers_write`): `plan`, then its files written (each in one step) and
/// removed, with the folders that are left empty.
pub fn write(root: &str, formats: &[PathBuf], save: &Save, create: bool) -> CmdResult<Written> {
    let _one = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let plan = plan(root, formats, save, create)?;
    let project = Path::new(root);
    let mut also = Vec::new();
    for (path, bytes) in &plan.write {
        let at = w3proj::paths::join_rel(project, path);
        crate::write_lands_inside(project, &at)?;
        let s = crate::write_file(&at, |f| std::io::Write::write_all(f, bytes))?;
        also.push(Also { path: at.to_string_lossy().into_owned(), size: s.size, modified: s.modified });
    }
    let triggers_dir = project.join(w3proj::project::MAP_DIR).join(tl::DIR);
    for path in &plan.delete {
        let at = w3proj::paths::join_rel(project, path);
        crate::write_lands_inside(project, &at)?;
        match std::fs::remove_file(&at) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{path} wasn't removed: {e}")),
        }
        also.push(Also { path: at.to_string_lossy().into_owned(), size: 0, modified: 0 });
        // Folders left empty go (up to map/triggers/, which stays).
        let mut dir = at.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == triggers_dir || !d.starts_with(&triggers_dir) || std::fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }
    Ok(Written {
        also,
        written: plan.write.keys().cloned().collect(),
        deleted: plan.delete.clone(),
        files: plan.files_after,
        header_file: plan.header_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/trigger-folders")
    }

    /// A temporary folder, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Scratch {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("w3proj-backend-triggers-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A copy of the trigger-folders fixture (a project with `map/triggers/`) in a temporary folder.
    fn project() -> Scratch {
        let dir = Scratch::new();
        for (rel, bytes) in tl::read_disk(&fixture().join("map")).unwrap() {
            let to = w3proj::paths::join_rel(&dir.path().join("map"), &rel);
            std::fs::create_dir_all(to.parent().unwrap()).unwrap();
            std::fs::write(to, bytes).unwrap();
        }
        dir
    }

    fn save_of(r: &Read) -> Save {
        Save { file: r.file.clone(), custom: r.custom.clone(), stored: r.stored.clone() }
    }

    /// The mini map's trigger folders (made by hand, as a map made in Studio: no ids) read as the app holds them, with
    /// the custom text and the header, and are written back as they are: its files are what the layout writes.
    #[test]
    fn the_mini_map_reads_and_writes_back_unchanged() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map").to_string_lossy().to_string();
        let r = read(&root, &[]).unwrap().unwrap();
        let names: Vec<&str> = r.file.items.iter().map(|i| match i {
            Item::Category(c) => c.name.as_str(),
            Item::Trigger(t) => t.name.as_str(),
            Item::Element(e) => e.name.as_str(),
        }).collect();
        assert_eq!(names, ["Mini", "Foo Setup", "Foo Init", "Foo Branch", "A note", "fooList", "Foo Script"]);
        assert!(r.custom.header.as_deref().is_some_and(|h| h.contains("FooHelper")));
        assert!(r.custom.texts[2].as_deref().is_some_and(|t| t.starts_with("function Trig_Foo_Script_Actions")), "{:?}", r.custom.texts);
        assert_eq!(r.file.variables.len(), 2);
        // No id stored: every one is given in memory.
        assert_eq!(r.stored.len(), r.file.items.len() - 1 + r.file.variables.len(), "{:?}", r.stored);
        let lay = disk(Path::new(&root)).unwrap();
        let (tree, _) = tl::from_files(&lay).unwrap();
        let again = tl::to_files(&tree, Lang::Jass, Some(&tree)).unwrap();
        assert_eq!(again, lay, "the fixture is what the layout writes");
        let plan = plan(&root, &[], &save_of(&r), false).unwrap();
        assert!(plan.write.is_empty() && plan.delete.is_empty(), "{:?} {:?}", plan.write.keys(), plan.delete);
    }

    /// Read and saved again unchanged: nothing is written or removed.
    #[test]
    fn an_unchanged_tree_writes_nothing() {
        let p = project();
        let root = p.path().to_string_lossy().to_string();
        let r = read(&root, &[]).unwrap().unwrap();
        assert_eq!(r.files.len(), r.file.items.len());
        let plan = plan(&root, &[], &save_of(&r), false).unwrap();
        assert!(plan.write.is_empty() && plan.delete.is_empty(), "{:?} {:?}", plan.write.keys(), plan.delete);
    }

    /// One custom text changed: only its file is written; a trigger deleted: only its file goes, and order.txt
    /// changes; a category renamed: its folder moves.
    #[test]
    fn only_the_changed_files_are_written() {
        let p = project();
        let root = p.path().to_string_lossy().to_string();
        let r = read(&root, &[]).unwrap().unwrap();
        let mut s = save_of(&r);
        let k = s.custom.texts.iter().position(|t| t.as_deref().is_some_and(|t| t.contains("DamageEngine"))).unwrap();
        s.custom.texts[k] = Some("library DamageEngine\nendlibrary\n".into());
        let w = write(&root, &[], &s, false).unwrap();
        assert_eq!(w.written, vec!["map/triggers/Systems/Damage_Engine.j".to_string()]);
        assert!(w.deleted.is_empty());
        let body = std::fs::read_to_string(p.path().join("map/triggers/Systems/Damage_Engine.j")).unwrap();
        assert!(body.starts_with("// @w3proj {") && body.ends_with("library DamageEngine\nendlibrary\n"), "{body}");
        // Deleting the nested GUI trigger.
        let r = read(&root, &[]).unwrap().unwrap();
        let mut s = save_of(&r);
        let at = s.file.items.iter().position(|i| matches!(i, Item::Trigger(t) if t.name == "Nested")).unwrap();
        s.file.items.remove(at);
        let slot = s.file.items[..at].iter().filter(|i| matches!(i, Item::Trigger(t) if t.ty == 8 || t.ty == 32)).count();
        s.custom.texts.remove(slot);
        let w = write(&root, &[], &s, false).unwrap();
        assert_eq!(w.deleted, vec!["map/triggers/Systems/Sub/Nested.gui.json".to_string()]);
        assert_eq!(w.written, vec!["map/triggers/Systems/Sub/order.txt".to_string()]);
        // Renaming the category Initialization.
        let r = read(&root, &[]).unwrap().unwrap();
        let mut s = save_of(&r);
        for i in &mut s.file.items {
            if let Item::Category(c) = i {
                if c.name == "Initialization" {
                    c.name = "Setup".into();
                }
            }
        }
        let w = write(&root, &[], &s, false).unwrap();
        assert!(w.written.iter().all(|p| p.starts_with("map/triggers/Setup/") || p == "map/triggers/order.txt"), "{:?}", w.written);
        assert!(w.deleted.iter().all(|p| p.starts_with("map/triggers/Initialization/")), "{:?}", w.deleted);
        assert!(!p.path().join("map/triggers/Initialization").exists());
        let back = read(&root, &[]).unwrap().unwrap();
        assert_eq!(back.file.items.len(), r.file.items.len());
    }

    /// Imported ids stay stored, a new item gets none in its file; adding a variable drops variableOrder.
    #[test]
    fn ids_and_the_variable_order() {
        let p = project();
        let root = p.path().to_string_lossy().to_string();
        let r = read(&root, &[]).unwrap().unwrap();
        let mut s = save_of(&r);
        // A new comment at the end of the root, with a made-up in-memory id.
        let parent = match &s.file.items[0] {
            Item::Category(c) => c.id as i32,
            _ => unreachable!(),
        };
        s.file.items.push(Item::Trigger(w3proj::wtg::Trigger {
            ty: 16, name: "Note".into(), description: String::new(), is_comment: 1, id: 0x0400_0099, enabled: true,
            is_custom: false, initially_off: false, run_on_init: false, parent, ecas: Vec::new(),
        }));
        let w = write(&root, &[], &s, false).unwrap();
        assert!(w.written.contains(&"map/triggers/Note.comment.json".to_string()), "{:?}", w.written);
        let note = std::fs::read_to_string(p.path().join("map/triggers/Note.comment.json")).unwrap();
        assert!(!note.contains("\"id\""), "{note}");
        let rootjson = std::fs::read_to_string(p.path().join("map/triggers/triggers.json")).unwrap();
        assert!(rootjson.contains("variableOrder"), "the fixture has one: {rootjson}");
        // A variable added: the table order goes.
        let r = read(&root, &[]).unwrap().unwrap();
        let mut s = save_of(&r);
        let mut v = s.file.variables[0].clone();
        v.name = "Extra".into();
        v.id = 0x0600_0050;
        v.parent = -1;
        s.file.variables.push(v);
        write(&root, &[], &s, false).unwrap();
        let rootjson = std::fs::read_to_string(p.path().join("map/triggers/triggers.json")).unwrap();
        assert!(!rootjson.contains("variableOrder"), "{rootjson}");
    }

    /// Two categories with the same stored id get different ids in memory, and their children stay theirs; saving
    /// writes the shared id back to both.
    #[test]
    fn duplicate_category_ids_are_kept_in_the_files_and_unique_in_memory() {
        let p = project();
        let root = p.path().to_string_lossy().to_string();
        let cat = |dir: &str| p.path().join("map/triggers").join(dir).join("_category.json");
        let systems = std::fs::read_to_string(cat("Systems")).unwrap();
        let init = std::fs::read_to_string(cat("Initialization")).unwrap();
        let id = |s: &str| s.split("\"id\":").nth(1).unwrap().split([',', '}']).next().unwrap().trim().to_string();
        std::fs::write(cat("Systems"), systems.replace(&format!("\"id\":{}", id(&systems)), &format!("\"id\":{}", id(&init)))).unwrap();
        let r = read(&root, &[]).unwrap().unwrap();
        let ids: Vec<u32> = r.file.items.iter().filter_map(|i| if let Item::Category(c) = i { Some(c.id) } else { None }).collect();
        let unique: HashSet<u32> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "{ids:?}");
        assert_eq!(r.stored.len(), 1, "{:?}", r.stored);
        let plan = plan(&root, &[], &save_of(&r), false).unwrap();
        assert!(plan.write.is_empty() && plan.delete.is_empty(), "{:?} {:?}", plan.write.keys(), plan.delete);
    }

    /// No map/triggers/: refused unless asked to create it; a tree that can't be read is never written over.
    #[test]
    fn absent_and_unreadable_trees() {
        let p = project();
        let root = p.path().to_string_lossy().to_string();
        let r = read(&root, &[]).unwrap().unwrap();
        let empty = Scratch::new();
        let eroot = empty.path().to_string_lossy().to_string();
        assert!(read(&eroot, &[]).unwrap().is_none());
        assert!(write(&eroot, &[], &save_of(&r), false).unwrap_err().contains("no map/triggers/"));
        let w = write(&eroot, &[], &save_of(&r), true).unwrap();
        assert!(w.written.contains(&"map/triggers/triggers.json".to_string()));
        std::fs::write(p.path().join("map/triggers/Systems/_category.json"), "{not json").unwrap();
        let e = write(&root, &[], &save_of(&r), false).unwrap_err();
        assert!(e.contains("can't be read") && e.contains("_category.json"), "{e}");
    }
}
