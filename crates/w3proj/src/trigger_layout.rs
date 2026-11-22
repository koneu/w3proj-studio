//! The trigger tree as folders, `map/triggers/`: one file per trigger, so people working on different triggers
//! edit different files, and editors and linters see each script as a file of its own.
//!
//! ```text
//! map/triggers/triggers.json              format, war3map.wtg/.wct versions, the map item, the script mode, and what
//!                                         an imported map keeps as it was (id counters, the variable table's order)
//! map/triggers/header.j                   the custom script header (header.lua in a Lua map; absent: no text)
//! map/triggers/order.txt                  the root's entries, one per line (`$name`: a variable's place in the tree)
//! map/triggers/variables.json             variables at the root (all of a Classic map's), one JSON object per line
//! map/triggers/<Folder>/_category.json    a category (type 4) or library folder (type 2)
//! map/triggers/<Folder>/order.txt, variables.json
//! map/triggers/<Folder>/<Name>.gui.json      a GUI trigger
//! map/triggers/<Folder>/<Name>.comment.json  a comment
//! map/triggers/<Folder>/<Name>.j          a custom-text trigger or script item (.vjass, .lua in a Lua map), its
//!                                         metadata in one first line `// @w3proj {…}` (`-- @w3proj {…}` in Lua)
//! ```
//!
//! This is the only layout of a map whose war3map.wtg the game's TriggerData decodes. Unpack splits war3map.wtg and
//! war3map.wct into it (`split_map`, which reads the files back and compares the bytes before they are used), pack
//! assembles them again (`assemble`); a map whose triggers can't come back byte for byte keeps both files raw. The
//! tree comes from the order of the files (`order.txt`, then entries it doesn't list, alphabetically), never from
//! parent ids: World Editor maps have categories that share an id. Imported items keep their ids, the id counters
//! and the variable table's order (`counts`, `variableOrder`); new items have none, and pack gives them free ids,
//! raising a counter only for ids it gave out. Every text goes through `crate::lossless` (a zero byte is written as
//! U+10FF00), and a file that is absent means "no text" where an empty file is an empty text.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value};

use crate::codec::Registry;
use crate::triggerdata::TriggerData;
use crate::wct::{self, Wct};
use crate::wtg::{self, Category, Count, Eca, Element, Item, Trigger, TriggerFile, Variable};
use crate::{Error, Result};

/// The layout's folder under `map/`.
pub const DIR: &str = "triggers";
/// The layout's root file, relative to `map/`.
pub const ROOT_FILE: &str = "triggers/triggers.json";
const PREFIX: &str = "triggers/";
pub const FORMAT: &str = "w3proj.triggers/1";
const FORMAT_NAME: &str = "w3proj.triggers/";
const FORMAT_MAJOR: u64 = 1;
/// The archive files the layout stands for.
pub const WTG: &str = "war3map.wtg";
pub const WCT: &str = "war3map.wct";
/// What unpack and verify call the layout where they name a file's codec.
pub const CODEC_ID: &str = "trigger-folders";
const ORDER: &str = "order.txt";
const VARIABLES: &str = "variables.json";
const CATEGORY: &str = "_category.json";
const ROOT_JSON: &str = "triggers.json";
const HEADERS: [&str; 2] = ["header.j", "header.lua"];
const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
/// How long a file or folder name's stem may be.
const MAX_STEM: usize = 80;
/// Byte 0 of a text, in a file (`crate::lossless` writes byte b that isn't UTF-8 as U+10FF00 + b, and reads U+10FF00 as 0).
const ZERO: &str = "\u{10FF00}";

fn bad(m: impl Into<String>) -> Error {
    Error::Format(m.into())
}

/// The map's script language, which decides `header.j` or `header.lua` and the extension of new script files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Jass,
    Lua,
}

impl Lang {
    pub fn ext(self) -> &'static str {
        match self {
            Lang::Jass => ".j",
            Lang::Lua => ".lua",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Lang::Jass => "JASS",
            Lang::Lua => "Lua",
        }
    }

    /// The language of a script file by its extension (`.j` and `.vjass` JASS, `.lua` Lua; any case).
    pub fn of_file(name: &str) -> Option<Lang> {
        let l = name.to_ascii_lowercase();
        if l.ends_with(".lua") {
            Some(Lang::Lua)
        } else if l.ends_with(".j") || l.ends_with(".vjass") {
            Some(Lang::Jass)
        } else {
            None
        }
    }
}

/// The map's language: war3map.w3i's `scriptType` (1: Lua), from its JSON or the raw file; JASS when there is none or
/// it can't be read (unpack and pack decide the same way, so the files' extensions agree).
pub fn language(files: &BTreeMap<String, Vec<u8>>, codecs: &Registry) -> Lang {
    let find = |name: &str| files.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, b)| b);
    let doc: Option<Value> = if let Some(json) = find("war3map.w3i.json") {
        serde_json::from_slice(json).ok()
    } else if let Some(raw) = find("war3map.w3i") {
        codecs.for_archive_name("war3map.w3i").find_map(|c| c.decode("war3map.w3i", raw).ok()).and_then(|j| serde_json::from_slice(&j).ok())
    } else {
        None
    };
    if doc.and_then(|d| d.get("scriptType").and_then(Value::as_u64)) == Some(1) {
        Lang::Lua
    } else {
        Lang::Jass
    }
}

/// Where the map script comes from (`triggers.json` `script`): made by Studio's generator and kept out of git
/// (`.w3proj/derived/`, `crate::derived`), or a source the project tracks in `map/` (the World Editor's, a hand-edited
/// one, one with code no trigger makes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptMode {
    Generated,
    Kept,
}

impl ScriptMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ScriptMode::Generated => "generated",
            ScriptMode::Kept => "kept",
        }
    }

    pub fn parse(s: &str) -> Option<ScriptMode> {
        match s {
            "generated" => Some(ScriptMode::Generated),
            "kept" => Some(ScriptMode::Kept),
            _ => None,
        }
    }
}

/// The map item of a Reforged tree (type 1, the tree's root).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    pub id: Option<u32>,
    pub name: String,
    pub is_comment: u32,
    pub expanded: u32,
}

/// What a tree node is.
#[derive(Clone, Debug)]
pub enum Kind {
    /// A category (4) or library folder (2).
    Folder { ty: u32, name: String, is_comment: u32, expanded: u32 },
    /// A GUI or custom-text trigger (8), comment (16) or script item (32); its `id` and `parent` aren't used. `text`:
    /// its war3map.wct text (types 8 and 32; None: no text).
    Trigger { t: Trigger, text: Option<String> },
    /// A variable's place in the tree (64).
    Var { name: String },
}

#[derive(Clone, Debug)]
pub struct Node {
    /// The folder it is in (an index into `Tree::nodes`); None: the root.
    pub parent: Option<usize>,
    /// Kept from an import; None: new, pack gives it one.
    pub id: Option<u32>,
    pub kind: Kind,
    /// Its file or folder below `map/triggers/`, as read (`from_files`).
    pub file: Option<String>,
}

/// A variable of the map-wide table.
#[derive(Clone, Debug)]
pub struct Var {
    /// Its `id` isn't used (`id` is); its `parent` only when it has no node.
    pub v: Variable,
    pub id: Option<u32>,
    /// Whether a node in the tree places it (Reforged).
    pub node: bool,
}

/// The trigger tree between war3map.wtg + war3map.wct and the files of `map/triggers/`. Nodes are in tree order
/// (a preorder: a folder, then what is in it).
#[derive(Clone, Debug)]
pub struct Tree {
    pub reforged: bool,
    pub version: u32,
    pub unknown: u32,
    pub wct_reforged: bool,
    pub wct_version: u32,
    pub wct_comment: String,
    /// None: war3map.wct has no header slot (Classic version 0); Some(None): no text.
    pub header: Option<Option<String>>,
    /// The header's file, as read.
    pub header_file: Option<String>,
    pub root: Option<Root>,
    /// The id counters as imported (Reforged); None: worked out from the ids.
    pub counts: Option<Vec<Count>>,
    /// The variable table's order as imported, when it isn't the tree's.
    pub variable_order: Option<Vec<String>>,
    pub script: ScriptMode,
    pub nodes: Vec<Node>,
    pub vars: Vec<Var>,
}

fn type_index(ty: u32) -> usize {
    match ty {
        1 => 0,
        2 => 1,
        4 => 2,
        8 => 3,
        16 => 4,
        32 => 5,
        64 => 6,
        _ => 7,
    }
}

/// A custom-text trigger or script item: code in war3map.wct, a script file in the layout.
pub(crate) fn is_script(t: &Trigger) -> bool {
    t.ty == 32 || (t.ty == 8 && t.is_custom)
}

fn has_slot(ty: u32) -> bool {
    ty == 8 || ty == 32
}

fn item_parent(it: &Item) -> i32 {
    match it {
        Item::Category(c) => c.parent,
        Item::Trigger(t) => t.parent,
        Item::Element(e) => e.parent,
    }
}

fn item_name(it: &Item) -> &str {
    match it {
        Item::Category(c) => &c.name,
        Item::Trigger(t) => &t.name,
        Item::Element(e) => &e.name,
    }
}

/// A variable name `order.txt` can hold (`$name`, one line).
fn check_var_name(name: &str) -> std::result::Result<(), String> {
    if name.is_empty() || name.contains(['\n', '\r']) {
        Err(format!("variable name {name:?} can't be a line of order.txt"))
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------- binary → tree

/// The tree of a decoded war3map.wtg and war3map.wct (an import: every item keeps its id). Errs with the reason when
/// the layout can't hold them (then unpack keeps both files raw).
pub fn from_binary(tf: &TriggerFile, w: &Wct) -> Result<Tree> {
    let no = |m: String| bad(format!("the triggers can't go into map/{DIR}/: {m}"));
    let mut items: &[Item] = &tf.items;
    let root = if tf.reforged {
        match items.first() {
            Some(Item::Category(c)) if c.ty == 1 => {
                if c.parent != -1 {
                    return Err(no(format!("the map item has the parent {}", c.parent)));
                }
                items = &items[1..];
                Some(Root { id: Some(c.id), name: c.name.clone(), is_comment: c.is_comment, expanded: c.expanded })
            }
            _ => return Err(no("war3map.wtg's first item isn't the map item".into())),
        }
    } else {
        None
    };
    let slots = items.iter().filter(|i| matches!(i, Item::Trigger(t) if has_slot(t.ty))).count();
    if w.texts.len() != slots {
        return Err(no(format!("war3map.wct has {} texts for {slots} triggers with a text slot", w.texts.len())));
    }
    let mut var_index: HashMap<&str, usize> = HashMap::new();
    for (k, v) in tf.variables.iter().enumerate() {
        check_var_name(&v.name).map_err(no)?;
        if var_index.insert(&v.name, k).is_some() {
            return Err(no(format!("two variables are named {}", v.name)));
        }
    }
    let mut texts = w.texts.iter();
    let mut take_text = |t: &Trigger| -> Result<Option<String>> {
        if !has_slot(t.ty) {
            return Ok(None);
        }
        let text = texts.next().cloned().flatten();
        if is_script(t) && text.is_none() {
            return Err(no(format!("\"{}\" is a custom text with no text in war3map.wct", t.name)));
        }
        Ok(text)
    };
    let mut nodes: Vec<Node> = Vec::new();
    let mut var_node: Vec<bool> = vec![false; tf.variables.len()];
    if tf.reforged {
        let root_id = root.as_ref().and_then(|r| r.id).map_or(-1, |id| id as i32);
        // Folders open on the way down: an item's parent is the nearest of them with its id (a preorder).
        let mut open: Vec<(i32, usize)> = Vec::new();
        for it in items {
            let p = item_parent(it);
            while open.last().is_some_and(|(id, _)| *id != p) {
                open.pop();
            }
            let (folder, want) = match open.last() {
                Some(&(id, idx)) => (Some(idx), id),
                None => (None, root_id),
            };
            if p != want {
                return Err(no(format!("\"{}\" isn't in a folder before it (its parent is {p})", item_name(it))));
            }
            let idx = nodes.len();
            match it {
                Item::Category(c) => {
                    if c.ty == 1 {
                        return Err(no("war3map.wtg has a second map item".into()));
                    }
                    nodes.push(Node { parent: folder, id: Some(c.id), kind: Kind::Folder { ty: c.ty, name: c.name.clone(), is_comment: c.is_comment, expanded: c.expanded }, file: None });
                    open.push((c.id as i32, idx));
                }
                Item::Trigger(t) => {
                    let text = take_text(t)?;
                    nodes.push(Node { parent: folder, id: Some(t.id), kind: Kind::Trigger { t: t.clone(), text }, file: None });
                }
                Item::Element(e) => {
                    let k = *var_index.get(e.name.as_str()).ok_or_else(|| no(format!("the variable node \"{}\" has no variable", e.name)))?;
                    let v = &tf.variables[k];
                    if v.id != e.id || v.parent != e.parent {
                        return Err(no(format!("the variable {} and its node have different ids or parents", e.name)));
                    }
                    if std::mem::replace(&mut var_node[k], true) {
                        return Err(no(format!("the variable {} has two nodes", e.name)));
                    }
                    nodes.push(Node { parent: folder, id: Some(e.id), kind: Kind::Var { name: e.name.clone() }, file: None });
                }
            }
        }
    } else {
        // Classic: the categories, then the triggers, each naming its category by id.
        let mut cats: Vec<&Category> = Vec::new();
        let mut first: HashMap<i32, usize> = HashMap::new();
        let mut in_cat: Vec<Vec<(&Trigger, Option<String>)>> = Vec::new();
        for it in items {
            match it {
                Item::Category(c) => {
                    if c.ty != 4 || c.parent != -1 || c.expanded != 1 {
                        return Err(no(format!("the Classic category \"{}\" isn't a plain one", c.name)));
                    }
                    first.entry(c.id as i32).or_insert(cats.len());
                    cats.push(c);
                    in_cat.push(Vec::new());
                }
                Item::Trigger(t) => {
                    if t.ty != 8 {
                        return Err(no(format!("the Classic item \"{}\" has the type {}", t.name, t.ty)));
                    }
                    let text = take_text(t)?;
                    let at = *first.get(&t.parent).ok_or_else(|| no(format!("the Classic trigger \"{}\" is in no category", t.name)))?;
                    in_cat[at].push((t, text));
                }
                Item::Element(e) => return Err(no(format!("the Classic map has a variable node {}", e.name))),
            }
        }
        for (c, triggers) in cats.into_iter().zip(in_cat) {
            let folder = nodes.len();
            nodes.push(Node { parent: None, id: Some(c.id), kind: Kind::Folder { ty: 4, name: c.name.clone(), is_comment: c.is_comment, expanded: 1 }, file: None });
            for (t, text) in triggers {
                nodes.push(Node { parent: Some(folder), id: None, kind: Kind::Trigger { t: t.clone(), text }, file: None });
            }
        }
    }
    let vars: Vec<Var> = tf
        .variables
        .iter()
        .zip(&var_node)
        .map(|(v, node)| Var { v: v.clone(), id: tf.reforged.then_some(v.id), node: *node })
        .collect();
    let mut tree = Tree {
        reforged: tf.reforged,
        version: tf.version,
        unknown: tf.unknown,
        wct_reforged: w.reforged,
        wct_version: w.version,
        wct_comment: w.comment.clone(),
        header: w.header.clone(),
        header_file: None,
        root,
        counts: tf.reforged.then(|| tf.counts.clone()),
        variable_order: None,
        script: ScriptMode::Kept,
        nodes,
        vars,
    };
    let table: Vec<String> = tf.variables.iter().map(|v| v.name.clone()).collect();
    if tree.tree_order() != table {
        tree.variable_order = Some(table);
    }
    Ok(tree)
}

impl Tree {
    /// The variable table in tree order: variables in the order of their nodes, then those without one as listed.
    pub fn tree_order(&self) -> Vec<String> {
        let mut out: Vec<String> = self.nodes.iter().filter_map(|n| if let Kind::Var { name } = &n.kind { Some(name.clone()) } else { None }).collect();
        let placed: HashSet<&str> = out.iter().map(String::as_str).collect();
        let rest: Vec<String> = self.vars.iter().filter(|v| !placed.contains(v.v.name.as_str())).map(|v| v.v.name.clone()).collect();
        out.extend(rest);
        out
    }

    /// The language its files are in (a `.lua` header or script file: Lua), for writing them again.
    pub fn lang_hint(&self) -> Lang {
        let files = self.header_file.iter().chain(self.nodes.iter().filter_map(|n| n.file.as_ref()));
        for f in files {
            if Lang::of_file(f) == Some(Lang::Lua) {
                return Lang::Lua;
            }
        }
        Lang::Jass
    }

    fn shown(&self, node: usize) -> String {
        match &self.nodes[node].file {
            Some(f) => format!("map/{PREFIX}{f}"),
            None => match &self.nodes[node].kind {
                Kind::Folder { name, .. } => format!("the folder \"{name}\""),
                Kind::Trigger { t, .. } => format!("\"{}\"", t.name),
                Kind::Var { name } => format!("the variable node {name}"),
            },
        }
    }
}

// ---------------------------------------------------------------- tree → binary

/// war3map.wtg and war3map.wct of a tree, and what is worth a warning. Items without an id get free ones (Reforged:
/// from the type's counter up, past the ids in use; a counter is raised only for ids given out here). Errs on what the
/// map can't hold: a Classic map has no nested folders, library folders, comments, script items or variable nodes,
/// and keeps every trigger in a category.
pub fn to_binary(tree: &Tree) -> Result<(TriggerFile, Wct, Vec<String>)> {
    check_strings(tree)?;
    let mut warnings = Vec::new();
    let classic = !tree.reforged;
    if classic {
        let refuse = |what: String| bad(format!("{what}: a Classic map (war3map.wtg version {}) can't hold that", tree.version));
        if tree.root.is_some() {
            return Err(refuse(format!("map/{ROOT_FILE} has a map item (\"root\")")));
        }
        for (i, n) in tree.nodes.iter().enumerate() {
            match &n.kind {
                Kind::Folder { .. } if n.parent.is_some() => return Err(refuse(format!("{} is a folder inside a folder", tree.shown(i)))),
                Kind::Folder { ty, .. } if *ty != 4 => return Err(refuse(format!("{} is a library folder (type {ty})", tree.shown(i)))),
                Kind::Trigger { t, .. } if t.ty != 8 => {
                    let what = if t.ty == 16 { "a comment" } else { "a script item" };
                    return Err(refuse(format!("{} is {what} (type {})", tree.shown(i), t.ty)));
                }
                Kind::Trigger { .. } if n.parent.is_none() => return Err(refuse(format!("{} is a trigger outside every category", tree.shown(i)))),
                Kind::Var { .. } => return Err(refuse(format!("{} places a variable in the tree ($ in order.txt)", tree.shown(i)))),
                _ => {}
            }
        }
    }
    let root = match (&tree.root, classic) {
        (Some(r), false) => Some(r),
        (None, false) => return Err(bad(format!("map/{ROOT_FILE} has no map item (\"root\"), which a Reforged tree needs"))),
        _ => None,
    };
    let var_at: HashMap<&str, usize> = tree.vars.iter().enumerate().map(|(k, v)| (v.v.name.as_str(), k)).collect();
    // Ids.
    let mut used: Vec<HashSet<u32>> = vec![HashSet::new(); 8];
    if let Some(id) = root.and_then(|r| r.id) {
        used[0].insert(id);
    }
    for n in &tree.nodes {
        if let Some(id) = n.id {
            let ty = match &n.kind {
                Kind::Folder { ty, .. } => *ty,
                Kind::Trigger { t, .. } => t.ty,
                Kind::Var { .. } => 64,
            };
            used[type_index(ty)].insert(id);
        }
    }
    for v in &tree.vars {
        if let Some(id) = v.id {
            used[6].insert(id);
        }
    }
    let mut counts: Vec<Count> = match &tree.counts {
        Some(c) if c.len() == 8 => c.clone(),
        Some(c) => return Err(bad(format!("map/{ROOT_FILE}: \"counts\" has {} entries, not 8", c.len()))),
        None => (0..8u32)
            .map(|k| Count { count: used[k as usize].iter().filter(|id| *id >> 24 == k).map(|id| (id & 0xFF_FFFF) + 1).max().unwrap_or(0), deleted: Vec::new() })
            .collect(),
    };
    let mut fresh = |k: usize, used: &mut Vec<HashSet<u32>>| -> u32 {
        let mut n = counts[k].count;
        while used[k].contains(&(((k as u32) << 24) | (n & 0xFF_FFFF))) {
            n += 1;
        }
        let id = ((k as u32) << 24) | (n & 0xFF_FFFF);
        used[k].insert(id);
        counts[k].count = counts[k].count.max(n + 1);
        id
    };
    let mut var_ids: Vec<Option<u32>> = tree.vars.iter().map(|v| v.id).collect();
    let mut ids: Vec<u32> = Vec::with_capacity(tree.nodes.len());
    let root_id = root.map(|r| r.id.unwrap_or_else(|| fresh(0, &mut used)));
    let mut next_category = tree.nodes.iter().filter(|n| matches!(n.kind, Kind::Folder { .. })).filter_map(|n| n.id).max().map_or(0, |m| m.wrapping_add(1));
    for (i, n) in tree.nodes.iter().enumerate() {
        let id = match (&n.kind, n.id) {
            (Kind::Var { name }, _) => {
                let k = *var_at.get(name.as_str()).ok_or_else(|| bad(format!("{} names no variable of a variables.json", tree.shown(i))))?;
                match var_ids[k] {
                    Some(id) => id,
                    None if classic => 0,
                    None => {
                        let id = fresh(6, &mut used);
                        var_ids[k] = Some(id);
                        id
                    }
                }
            }
            (_, Some(id)) => id,
            (Kind::Folder { .. }, None) if classic => {
                let id = next_category;
                next_category = next_category.wrapping_add(1);
                id
            }
            (Kind::Folder { ty, .. }, None) => fresh(type_index(*ty), &mut used),
            (Kind::Trigger { .. }, None) if classic => 0,
            (Kind::Trigger { t, .. }, None) => fresh(type_index(t.ty), &mut used),
        };
        ids.push(id);
    }
    if !classic {
        for id in var_ids.iter_mut().filter(|id| id.is_none()) {
            *id = Some(fresh(6, &mut used));
        }
    }
    // Items and texts.
    let mut items = Vec::with_capacity(tree.nodes.len() + 1);
    if let (Some(r), Some(id)) = (root, root_id) {
        items.push(Item::Category(Category { ty: 1, id, name: r.name.clone(), is_comment: r.is_comment, expanded: r.expanded, parent: -1 }));
    }
    let top = root_id.map_or(-1, |id| id as i32);
    let mut texts = Vec::new();
    let mut node_parent: HashMap<&str, i32> = HashMap::new();
    let mut trigger_index = 0u32;
    for (i, n) in tree.nodes.iter().enumerate() {
        let parent = n.parent.map_or(top, |p| ids[p] as i32);
        match &n.kind {
            Kind::Folder { ty, name, is_comment, expanded } => items.push(Item::Category(Category {
                ty: *ty,
                id: ids[i],
                name: name.clone(),
                is_comment: *is_comment,
                expanded: if classic { 1 } else { *expanded },
                parent: if classic { -1 } else { parent },
            })),
            Kind::Trigger { t, text } => {
                let mut t = t.clone();
                t.id = if classic { trigger_index } else { ids[i] };
                t.parent = parent;
                trigger_index += 1;
                if has_slot(t.ty) {
                    if is_script(&t) && text.is_none() {
                        return Err(bad(format!("{} has no text", tree.shown(i))));
                    }
                    texts.push(text.clone());
                }
                items.push(Item::Trigger(t));
            }
            Kind::Var { name } => {
                node_parent.insert(name, parent);
                items.push(Item::Element(Element { ty: 64, id: ids[i], name: name.clone(), parent }));
            }
        }
    }
    // The variable table.
    let tree_order = tree.tree_order();
    let order = match &tree.variable_order {
        Some(o) => {
            let a: BTreeSet<&str> = o.iter().map(String::as_str).collect();
            let b: BTreeSet<&str> = tree_order.iter().map(String::as_str).collect();
            if a == b && a.len() == o.len() {
                o.clone()
            } else {
                warnings.push(format!("map/{ROOT_FILE}: \"variableOrder\" doesn't list the variables there are, so the tree's order is used"));
                tree_order
            }
        }
        None => tree_order,
    };
    let variables = order
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let k = var_at[name.as_str()];
            let var = &tree.vars[k];
            let mut v = var.v.clone();
            if classic {
                v.id = i as u32;
                v.parent = -1;
            } else {
                v.id = var_ids[k].unwrap_or(0);
                v.parent = node_parent.get(name.as_str()).copied().unwrap_or(var.v.parent);
            }
            v
        })
        .collect();
    let tf = TriggerFile { reforged: tree.reforged, version: tree.version, counts: if classic { Vec::new() } else { counts }, unknown: tree.unknown, variables, items };
    let w = Wct { reforged: tree.wct_reforged, version: tree.wct_version, comment: tree.wct_comment.clone(), header: tree.header.clone(), texts };
    Ok((tf, w, warnings))
}

/// Errs on a name, description, value or comment holding a zero byte (`\u0000`, or U+10FF00, which `crate::lossless`
/// writes as one): war3map.wtg ends its strings with one, so such a string would break the file. Texts (war3map.wct)
/// may hold them: they are stored with their length.
fn check_strings(tree: &Tree) -> Result<()> {
    use crate::wtg::Param;
    fn zero(s: &str) -> bool {
        s.contains('\0') || s.contains(ZERO)
    }
    fn param(p: &Param) -> bool {
        zero(&p.value) || p.call.as_ref().is_some_and(|c| zero(&c.name) || c.params.iter().any(param)) || p.index.as_deref().is_some_and(param)
    }
    fn eca(e: &Eca) -> bool {
        zero(&e.name) || e.params.iter().any(param) || e.children.iter().any(eca)
    }
    let refuse = |what: String| Err(bad(format!("{what} holds a zero byte, which war3map.wtg can't store in a name or value")));
    if zero(&tree.wct_comment) {
        return refuse(format!("map/{ROOT_FILE}: \"wctComment\""));
    }
    if tree.root.as_ref().is_some_and(|r| zero(&r.name)) {
        return refuse(format!("map/{ROOT_FILE}: the map item's name"));
    }
    for (i, n) in tree.nodes.iter().enumerate() {
        let bad = match &n.kind {
            Kind::Folder { name, .. } | Kind::Var { name } => zero(name),
            Kind::Trigger { t, .. } => zero(&t.name) || zero(&t.description) || t.ecas.iter().any(eca),
        };
        if bad {
            return refuse(tree.shown(i));
        }
    }
    for v in &tree.vars {
        if [&v.v.name, &v.v.ty, &v.v.initial_value].iter().any(|s| zero(s)) {
            return refuse(format!("the variable {:?} (a variables.json in map/{DIR}/)", v.v.name));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- texts and frontmatter

/// A text (`crate::lossless`) as a file's bytes: UTF-8, a zero byte as U+10FF00.
fn text_file(text: &str) -> Vec<u8> {
    text.replace('\0', ZERO).into_bytes()
}

/// A file's bytes as a text: UTF-8 as it is (U+10FF00 + b is byte b); a file that isn't UTF-8 (saved in a code page)
/// goes into the map byte for byte.
pub(crate) fn file_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => crate::lossless::decode(bytes),
    }
}

fn marker(lua: bool) -> &'static str {
    if lua {
        "-- @w3proj"
    } else {
        "// @w3proj"
    }
}

/// A script file's frontmatter (None: it has none) and its text.
pub type Split = (Option<Map<String, Value>>, Vec<u8>);

/// A script file: the text's BOM (if it has one), the frontmatter line with the text's own line ending (LF when it
/// has none), then the text as it is.
pub fn with_frontmatter(meta: &Map<String, Value>, body: &[u8], lua: bool) -> Vec<u8> {
    let (bom, rest) = match body.strip_prefix(&BOM[..]) {
        Some(rest) => (&BOM[..], rest),
        None => (&[][..], body),
    };
    let eol: &[u8] = match rest.iter().position(|&c| c == b'\n') {
        Some(i) if i > 0 && rest[i - 1] == b'\r' => b"\r\n",
        _ => b"\n",
    };
    let mut out = bom.to_vec();
    out.extend_from_slice(marker(lua).as_bytes());
    out.push(b' ');
    out.extend_from_slice(Value::Object(meta.clone()).to_string().as_bytes());
    out.extend_from_slice(eol);
    out.extend_from_slice(rest);
    out
}

/// A script file's frontmatter and text: exactly the first line (after a BOM) goes, the BOM stays in front of the
/// text; everything else passes as it is. No frontmatter: the whole file is the text. Err: why the first line, which
/// looks like frontmatter, can't be read (it is on line 1).
pub fn split_frontmatter(file: &[u8], lua: bool) -> std::result::Result<Split, String> {
    let (bom, rest) = match file.strip_prefix(&BOM[..]) {
        Some(rest) => (&BOM[..], rest),
        None => (&[][..], file),
    };
    let end = rest.iter().position(|&c| c == b'\n');
    let line = &rest[..end.unwrap_or(rest.len())];
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let starts = |m: &str| line.strip_prefix(m.as_bytes()).filter(|after| after.is_empty() || matches!(after[0], b' ' | b'\t' | b'{'));
    let Some(json) = starts(marker(lua)) else {
        if starts(marker(!lua)).is_some() {
            return Err(format!("the frontmatter starts with {}, a {} file's needs {}", marker(!lua), if lua { "Lua" } else { "JASS" }, marker(lua)));
        }
        return Ok((None, file.to_vec()));
    };
    let json = std::str::from_utf8(json).map_err(|_| "the frontmatter isn't UTF-8".to_string())?;
    let meta = match serde_json::from_str::<Value>(json.trim()) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Err("the frontmatter isn't a JSON object".into()),
        Err(e) => return Err(format!("malformed frontmatter ({e})")),
    };
    let mut body = bom.to_vec();
    if let Some(e) = end {
        body.extend_from_slice(&rest[e + 1..]);
    }
    Ok((Some(meta), body))
}

/// Whether a text defines `InitTrig_<name>` (`function InitTrig_X takes …` in JASS, `function InitTrig_X(` in Lua).
pub(crate) fn defines_init_trig(text: &str, name: &str) -> bool {
    let want = format!("InitTrig_{name}");
    let mut rest = text;
    while let Some(i) = rest.find("function") {
        let before_ok = rest[..i].chars().next_back().is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        let after = &rest[i + "function".len()..];
        let trimmed = after.trim_start_matches([' ', '\t']);
        if before_ok && trimmed.len() < after.len() {
            if let Some(tail) = trimmed.strip_prefix(want.as_str()) {
                if tail.starts_with([' ', '\t', '(']) {
                    return true;
                }
            }
        }
        rest = after;
    }
    false
}

// ---------------------------------------------------------------- slugs

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9",
];

/// A display name as a file or folder name's stem, the same on every system: characters Windows or Linux refuse,
/// spaces, a leading `$` (order.txt's variable mark) or `.` (a hidden file) and trailing dots become `_`; a name with
/// no letter or digit gets `fixed` (comment, folder, trigger, script); a Windows device name gets `_` after it; at
/// most 80 characters.
pub fn slug(name: &str, fixed: &str) -> String {
    if !name.chars().any(char::is_alphanumeric) {
        return fixed.to_string();
    }
    let mut s: String = name
        .chars()
        .enumerate()
        .map(|(i, c)| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | ' ' => '_',
            '$' | '.' if i == 0 => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cut = |s: &mut String| {
        if s.chars().count() > MAX_STEM {
            *s = s.chars().take(MAX_STEM).collect();
        }
        let kept = s.trim_end_matches('.').len();
        let dots = s.len() - kept;
        s.truncate(kept);
        s.extend(std::iter::repeat_n('_', dots));
    };
    cut(&mut s);
    let base = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&base.as_str()) {
        s.push('_');
        cut(&mut s);
    }
    s
}

/// A file name's stem: without the layout's suffix (`.gui.json`, `.comment.json`, `.j`, `.vjass`, `.lua`; any case).
fn stem_of(name: &str) -> &str {
    let l = name.to_ascii_lowercase();
    for suffix in [".gui.json", ".comment.json", ".vjass", ".lua", ".j"] {
        if l.ends_with(suffix) {
            return &name[..name.len() - suffix.len()];
        }
    }
    name
}

// ---------------------------------------------------------------- tree → files

/// What a node is for keeping file names: folder, GUI, comment, script.
fn kind_key(n: &Node) -> Option<(u8, Option<u32>, &str)> {
    match &n.kind {
        Kind::Folder { name, .. } => Some((0, n.id, name)),
        Kind::Trigger { t, .. } if t.ty == 16 => Some((2, n.id, &t.name)),
        Kind::Trigger { t, .. } if is_script(t) => Some((3, n.id, &t.name)),
        Kind::Trigger { t, .. } => Some((1, n.id, &t.name)),
        Kind::Var { .. } => None,
    }
}

type Kept = HashMap<String, Vec<(u8, Option<u32>, String, String)>>;

/// The file names of a tree read from disk, per folder (below `map/triggers/`, "" the root): kind, id, name, file name.
fn kept_names(tree: &Tree) -> Kept {
    let mut out: Kept = HashMap::new();
    for n in &tree.nodes {
        let (Some((kind, id, name)), Some(file)) = (kind_key(n), &n.file) else { continue };
        let (dir, file) = file.rsplit_once('/').unwrap_or(("", file));
        out.entry(dir.to_string()).or_default().push((kind, id, name.to_string(), file.to_string()));
    }
    out
}

struct Writer<'a> {
    tree: &'a Tree,
    lang: Lang,
    children: HashMap<Option<usize>, Vec<usize>>,
    kept: Kept,
    out: BTreeMap<String, Vec<u8>>,
}

fn object(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn line(m: Map<String, Value>) -> Vec<u8> {
    let mut s = Value::Object(m).to_string();
    s.push('\n');
    s.into_bytes()
}

/// A GUI trigger's JSON: one key per line; an ECA on one line unless it holds others (then one key per line too).
fn layout(v: &Value, indent: &str, top: bool, out: &mut String) {
    let inner = format!("{indent}  ");
    let nests = |m: &Map<String, Value>| ["ecas", "children"].iter().any(|k| m.get(*k).and_then(Value::as_array).is_some_and(|a| !a.is_empty()));
    match v {
        Value::Object(m) if top || nests(m) => {
            out.push_str("{\n");
            for (i, (k, x)) in m.iter().enumerate() {
                out.push_str(&inner);
                out.push_str(&Value::String(k.clone()).to_string());
                out.push_str(": ");
                layout(x, &inner, false, out);
                out.push_str(if i + 1 < m.len() { ",\n" } else { "\n" });
            }
            out.push_str(indent);
            out.push('}');
        }
        Value::Array(a) if a.iter().any(Value::is_object) => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                out.push_str(&inner);
                layout(x, &inner, false, out);
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            out.push_str(indent);
            out.push(']');
        }
        _ => out.push_str(&v.to_string()),
    }
}

/// triggers.json: one key per line, an array one element per line.
fn root_json(m: &Map<String, Value>) -> Vec<u8> {
    let mut out = String::from("{\n");
    for (i, (k, v)) in m.iter().enumerate() {
        out.push_str("  ");
        out.push_str(&Value::String(k.clone()).to_string());
        out.push_str(": ");
        match v {
            Value::Array(a) if !a.is_empty() => {
                out.push_str("[\n");
                for (j, x) in a.iter().enumerate() {
                    out.push_str("    ");
                    out.push_str(&x.to_string());
                    out.push_str(if j + 1 < a.len() { ",\n" } else { "\n" });
                }
                out.push_str("  ]");
            }
            _ => out.push_str(&v.to_string()),
        }
        out.push_str(if i + 1 < m.len() { ",\n" } else { "\n" });
    }
    out.push_str("}\n");
    out.into_bytes()
}

fn ecas_value(ecas: &[Eca]) -> Value {
    serde_json::to_value(ecas).unwrap_or(Value::Array(Vec::new()))
}

impl Writer<'_> {
    fn put(&mut self, rel: String, bytes: Vec<u8>) {
        self.out.insert(format!("{PREFIX}{rel}"), bytes);
    }

    fn var_line(&self, var: &Var, node: bool) -> String {
        let v = &var.v;
        let mut m = object(vec![
            ("name", v.name.clone().into()),
            ("type", v.ty.clone().into()),
            ("isArray", v.is_array.into()),
            ("arraySize", v.array_size.into()),
            ("initialized", v.initialized.into()),
            ("initialValue", v.initial_value.clone().into()),
            ("unknown", v.unknown.into()),
        ]);
        if let Some(id) = var.id {
            m.insert("id".into(), id.into());
        }
        if self.tree.reforged && !node {
            m.insert("node".into(), false.into());
            if v.parent != -1 {
                m.insert("parent".into(), v.parent.into());
            }
        }
        Value::Object(m).to_string()
    }

    fn folder(&mut self, folder: Option<usize>, dir: &str) -> Result<()> {
        let tree = self.tree;
        let kids = self.children.get(&folder).cloned().unwrap_or_default();
        let at = |name: &str| if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
        let mut used: HashSet<String> = [ORDER, VARIABLES, CATEGORY].iter().map(|s| s.to_string()).collect();
        if folder.is_none() {
            used.insert(ROOT_JSON.into());
            used.extend(HEADERS.iter().map(|s| s.to_string()));
        }
        let mut stems: HashSet<String> = HashSet::new();
        let mut names: Vec<Option<String>> = vec![None; kids.len()];
        // An item keeps the file name it has on disk.
        if let Some(cands) = self.kept.get(dir) {
            let mut taken = vec![false; cands.len()];
            for (i, &k) in kids.iter().enumerate() {
                let Some(key) = kind_key(&tree.nodes[k]) else { continue };
                let found = cands.iter().enumerate().position(|(j, c)| !taken[j] && c.0 == key.0 && c.1 == key.1 && c.2 == key.2 && !used.contains(&c.3.to_lowercase()));
                if let Some(j) = found {
                    taken[j] = true;
                    let name = cands[j].3.clone();
                    used.insert(name.to_lowercase());
                    if key.0 != 0 {
                        stems.insert(stem_of(&name).to_lowercase());
                    }
                    names[i] = Some(name);
                }
            }
        }
        // The others get a slug, unique in the folder in any case, a file's stem whatever its extension.
        for (i, &k) in kids.iter().enumerate() {
            if names[i].is_some() {
                continue;
            }
            let (base, ext, file) = match &tree.nodes[k].kind {
                Kind::Folder { name, .. } => (slug(name, "folder"), "", false),
                Kind::Trigger { t, .. } if t.ty == 16 => (slug(&t.name, "comment"), ".comment.json", true),
                Kind::Trigger { t, .. } if is_script(t) => (slug(&t.name, if t.ty == 32 { "script" } else { "trigger" }), self.lang.ext(), true),
                Kind::Trigger { t, .. } => (slug(&t.name, "trigger"), ".gui.json", true),
                Kind::Var { .. } => continue,
            };
            for n in 1.. {
                let stem = if n == 1 { base.clone() } else { format!("{base}~{n}") };
                let name = format!("{stem}{ext}");
                let taken = used.contains(&name.to_lowercase()) || (file && stems.contains(&stem.to_lowercase()));
                if !taken {
                    used.insert(name.to_lowercase());
                    if file {
                        stems.insert(stem.to_lowercase());
                    }
                    names[i] = Some(name);
                    break;
                }
            }
        }
        let mut order: Vec<String> = Vec::new();
        let mut vars: Vec<String> = Vec::new();
        for (i, &k) in kids.iter().enumerate() {
            let node = &tree.nodes[k];
            let name = names[i].clone().unwrap_or_default();
            match &node.kind {
                Kind::Folder { ty, name: display, is_comment, expanded } => {
                    let mut m = object(vec![("type", (*ty).into())]);
                    if let Some(id) = node.id {
                        m.insert("id".into(), id.into());
                    }
                    m.insert("name".into(), display.clone().into());
                    m.insert("isComment".into(), (*is_comment).into());
                    if tree.reforged {
                        m.insert("expanded".into(), (*expanded).into());
                    }
                    self.put(format!("{}/{CATEGORY}", at(&name)), line(m));
                    order.push(name.clone());
                    self.folder(Some(k), &at(&name))?;
                }
                Kind::Trigger { t, text } => {
                    let mut m = object(vec![("type", t.ty.into())]);
                    if let Some(id) = node.id {
                        m.insert("id".into(), id.into());
                    }
                    m.insert("name".into(), t.name.clone().into());
                    m.insert("description".into(), t.description.clone().into());
                    let bytes = if t.ty == 16 {
                        m.insert("isComment".into(), t.is_comment.into());
                        if !t.enabled {
                            m.insert("enabled".into(), false.into());
                        }
                        for (key, on) in [("isCustom", t.is_custom), ("initiallyOff", t.initially_off), ("runOnInit", t.run_on_init)] {
                            if on {
                                m.insert(key.into(), true.into());
                            }
                        }
                        if !t.ecas.is_empty() {
                            m.insert("ecas".into(), ecas_value(&t.ecas));
                        }
                        line(m)
                    } else if is_script(t) {
                        if t.is_comment != 0 {
                            m.insert("isComment".into(), t.is_comment.into());
                        }
                        m.insert("enabled".into(), t.enabled.into());
                        m.insert("initiallyOff".into(), t.initially_off.into());
                        m.insert("runOnInit".into(), t.run_on_init.into());
                        if !t.is_custom {
                            m.insert("isCustom".into(), false.into());
                        }
                        if !t.ecas.is_empty() {
                            m.insert("ecas".into(), ecas_value(&t.ecas));
                        }
                        let text = text.as_deref().ok_or_else(|| bad(format!("{} has no text", tree.shown(k))))?;
                        with_frontmatter(&m, &text_file(text), Lang::of_file(&name) == Some(Lang::Lua))
                    } else {
                        m.insert("isComment".into(), t.is_comment.into());
                        m.insert("enabled".into(), t.enabled.into());
                        m.insert("initiallyOff".into(), t.initially_off.into());
                        m.insert("runOnInit".into(), t.run_on_init.into());
                        m.insert("ecas".into(), ecas_value(&t.ecas));
                        if let Some(text) = text {
                            m.insert("wctText".into(), text.clone().into());
                        }
                        let mut s = String::new();
                        layout(&Value::Object(m), "", true, &mut s);
                        s.push('\n');
                        s.into_bytes()
                    };
                    order.push(name.clone());
                    self.put(at(&name), bytes);
                }
                Kind::Var { name: var } => {
                    let v = tree.vars.iter().find(|v| &v.v.name == var).ok_or_else(|| bad(format!("{} names no variable", tree.shown(k))))?;
                    order.push(format!("${var}"));
                    vars.push(self.var_line(v, true));
                }
            }
        }
        if folder.is_none() {
            for v in tree.vars.iter().filter(|v| !v.node) {
                vars.push(self.var_line(v, false));
            }
        }
        if !order.is_empty() {
            self.put(at(ORDER), (order.join("\n") + "\n").into_bytes());
        }
        if !vars.is_empty() {
            self.put(at(VARIABLES), (vars.join("\n") + "\n").into_bytes());
        }
        Ok(())
    }
}

/// The files of `map/triggers/` for a tree (keys relative to `map/`). `lang`: the map's language (the header's name,
/// new script files' extension); `existing`: the tree as on disk, whose items keep their file names.
pub fn to_files(tree: &Tree, lang: Lang, existing: Option<&Tree>) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut children: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
    for (i, n) in tree.nodes.iter().enumerate() {
        children.entry(n.parent).or_default().push(i);
    }
    let mut w = Writer { tree, lang, children, kept: existing.map(kept_names).unwrap_or_default(), out: BTreeMap::new() };
    let mut m = object(vec![
        ("format", FORMAT.into()),
        ("reforged", tree.reforged.into()),
        ("version", tree.version.into()),
        ("unknown", tree.unknown.into()),
        ("wctVersion", tree.wct_version.into()),
        ("wctComment", tree.wct_comment.clone().into()),
    ]);
    if tree.wct_reforged != tree.reforged {
        m.insert("wctReforged".into(), tree.wct_reforged.into());
    }
    if let Some(r) = &tree.root {
        let mut o = Map::new();
        if let Some(id) = r.id {
            o.insert("id".into(), id.into());
        }
        o.insert("name".into(), r.name.clone().into());
        o.insert("isComment".into(), r.is_comment.into());
        o.insert("expanded".into(), r.expanded.into());
        m.insert("root".into(), Value::Object(o));
    }
    m.insert("script".into(), tree.script.as_str().into());
    if let Some(c) = &tree.counts {
        m.insert("counts".into(), serde_json::to_value(c).map_err(|e| bad(e.to_string()))?);
    }
    if let Some(o) = &tree.variable_order {
        m.insert("variableOrder".into(), o.clone().into());
    }
    w.put(ROOT_JSON.into(), root_json(&m));
    if let Some(Some(h)) = &tree.header {
        w.put(format!("header{}", lang.ext()), text_file(h));
    }
    w.folder(None, "")?;
    Ok(w.out)
}

// ---------------------------------------------------------------- files → tree

/// A JSON object's fields, checked against the keys a file may have.
struct Obj<'a> {
    m: &'a Map<String, Value>,
    at: String,
}

impl<'a> Obj<'a> {
    fn new(v: &'a Value, at: String, allowed: &[&str]) -> Result<Obj<'a>> {
        let m = v.as_object().ok_or_else(|| bad(format!("{at}: not a JSON object")))?;
        Obj::of(m, at, allowed)
    }

    fn of(m: &'a Map<String, Value>, at: String, allowed: &[&str]) -> Result<Obj<'a>> {
        if let Some(k) = m.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(bad(format!("{at}: unknown field \"{k}\" (known: {})", allowed.join(", "))));
        }
        Ok(Obj { m, at })
    }

    fn get(&self, k: &str) -> Option<&'a Value> {
        self.m.get(k).filter(|v| !v.is_null())
    }

    fn u32(&self, k: &str) -> Result<Option<u32>> {
        self.get(k)
            .map(|v| v.as_u64().filter(|n| *n <= u32::MAX as u64).map(|n| n as u32).ok_or_else(|| bad(format!("{}: \"{k}\" must be a whole number from 0 to {}", self.at, u32::MAX))))
            .transpose()
    }

    fn i32(&self, k: &str) -> Result<Option<i32>> {
        self.get(k)
            .map(|v| v.as_i64().and_then(|n| i32::try_from(n).ok()).ok_or_else(|| bad(format!("{}: \"{k}\" must be a whole number", self.at))))
            .transpose()
    }

    fn bool(&self, k: &str) -> Result<Option<bool>> {
        self.get(k).map(|v| v.as_bool().ok_or_else(|| bad(format!("{}: \"{k}\" must be true or false", self.at)))).transpose()
    }

    fn str(&self, k: &str) -> Result<Option<String>> {
        self.get(k).map(|v| v.as_str().map(str::to_string).ok_or_else(|| bad(format!("{}: \"{k}\" must be a string", self.at)))).transpose()
    }

    fn need_str(&self, k: &str) -> Result<String> {
        self.str(k)?.ok_or_else(|| bad(format!("{}: \"{k}\" is missing", self.at)))
    }

    fn ecas(&self) -> Result<Vec<Eca>> {
        match self.get("ecas") {
            Some(e) => serde_json::from_value(e.clone()).map_err(|e| bad(format!("{}: \"ecas\": {e}", self.at))),
            None => Ok(Vec::new()),
        }
    }
}

fn parse_json(bytes: &[u8], at: &str) -> Result<Value> {
    serde_json::from_slice(bytes).map_err(|e| bad(format!("{at}:{}: {e}", e.line())))
}

const TRIGGER_KEYS: [&str; 10] = ["type", "id", "name", "description", "isComment", "enabled", "isCustom", "initiallyOff", "runOnInit", "ecas"];

/// What reading the files found worth a warning (`from_files_noted`); Display gives the line `from_files` warns with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub kind: NoteKind,
    /// The file, relative to `map/` (`triggers/…`).
    pub file: String,
    /// Its line, from 1.
    pub line: Option<usize>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteKind {
    /// An order.txt entry that names nothing there.
    OrderMissing,
    /// An order.txt entry listed a second time.
    OrderTwice,
    /// An order.txt `$name` entry for a variable its folder's variables.json doesn't have.
    OrderNotVariable,
    /// A variable defined a second time, alike (one is kept).
    VariableTwice,
    /// A variable placed in two folders' order.txt.
    VariablePlacedTwice,
}

impl std::fmt::Display for Note {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.line {
            Some(l) => write!(f, "map/{}:{l}: {}", self.file, self.message),
            None => write!(f, "map/{}: {}", self.file, self.message),
        }
    }
}

struct Reader<'a> {
    files: BTreeMap<&'a str, &'a [u8]>,
    /// Folder (below `map/triggers/`, "" the root) → its files and sub-folders.
    dirs: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)>,
    classic: bool,
    nodes: Vec<Node>,
    vars: Vec<Var>,
    /// Name → index in `vars`, and the file that defines it.
    var_at: HashMap<String, (usize, String)>,
    warnings: Vec<Note>,
}

/// Keys a variables.json line may have.
const VARIABLE_KEYS: [&str; 10] = ["name", "type", "isArray", "arraySize", "initialized", "initialValue", "unknown", "id", "node", "parent"];

/// One line of a variables.json (`at`: file and line, for messages): the variable, its id (none in a Classic map) and
/// whether it asks for a node in the tree.
pub(crate) fn parse_variable_line(l: &str, at: &str, classic: bool) -> Result<(Variable, Option<u32>, bool)> {
    let value: Value = serde_json::from_str(l).map_err(|e| bad(format!("{at}: {e}")))?;
    let o = Obj::new(&value, at.to_string(), &VARIABLE_KEYS)?;
    let name = o.need_str("name")?;
    check_var_name(&name).map_err(|m| bad(format!("{at}: {m}")))?;
    let v = Variable {
        name,
        ty: o.need_str("type")?,
        unknown: o.u32("unknown")?.unwrap_or(1),
        is_array: o.bool("isArray")?.unwrap_or(false),
        array_size: o.u32("arraySize")?.unwrap_or(1),
        initialized: o.bool("initialized")?.unwrap_or(false),
        initial_value: o.str("initialValue")?.unwrap_or_default(),
        id: 0,
        parent: o.i32("parent")?.unwrap_or(-1),
    };
    let node = !classic && o.bool("node")?.unwrap_or(true);
    let id = if classic { None } else { o.u32("id")? };
    Ok((v, id, node))
}

/// Whether two definitions of a variable are the same (type, array, size, initial value).
pub(crate) fn same_variable(a: &Variable, b: &Variable) -> bool {
    a.ty == b.ty && a.is_array == b.is_array && a.array_size == b.array_size && a.initialized == b.initialized && a.initial_value == b.initial_value
}

/// A folder's `_category.json` (`shown`: its path for messages): type, id, name, isComment, expanded.
pub(crate) fn parse_category(bytes: &[u8], shown: &str) -> Result<(u32, Option<u32>, String, u32, u32)> {
    let v = parse_json(bytes, shown)?;
    let o = Obj::new(&v, shown.to_string(), &["type", "id", "name", "isComment", "expanded"])?;
    let ty = o.u32("type")?.unwrap_or(4);
    if ty != 2 && ty != 4 {
        return Err(bad(format!("{shown}: a folder is a category (type 4) or library (type 2), not type {ty}")));
    }
    Ok((ty, o.u32("id")?, o.need_str("name")?, o.u32("isComment")?.unwrap_or(0), o.u32("expanded")?.unwrap_or(1)))
}

enum Entry {
    Dir(String),
    File(String),
    Var(String),
}

impl Reader<'_> {
    fn shown(path: &str) -> String {
        format!("map/{PREFIX}{path}")
    }

    /// The variables of a folder's variables.json, those that are kept (an identical one defined before is dropped):
    /// name and whether the line asks for a node.
    fn variables(&mut self, path: &str) -> Result<Vec<(String, bool)>> {
        let Some(bytes) = self.files.get(path).copied() else { return Ok(Vec::new()) };
        let text = std::str::from_utf8(bytes).map_err(|_| bad(format!("{} isn't UTF-8 text", Reader::shown(path))))?;
        let mut out = Vec::new();
        for (ln, l) in text.split('\n').enumerate() {
            let l = l.strip_suffix('\r').unwrap_or(l);
            if l.trim().is_empty() {
                continue;
            }
            let at = format!("{}:{}", Reader::shown(path), ln + 1);
            let (v, id, node) = parse_variable_line(l, &at, self.classic)?;
            let name = v.name.clone();
            if let Some((k, first)) = self.var_at.get(&name) {
                if !same_variable(&self.vars[*k].v, &v) {
                    return Err(bad(format!("{at}: the variable {name} is also defined in {first}, differently")));
                }
                self.warnings.push(Note {
                    kind: NoteKind::VariableTwice,
                    file: format!("{PREFIX}{path}"),
                    line: Some(ln + 1),
                    message: format!("the variable {name} is also defined in {first}; one is kept"),
                });
                out.push((name, false));
                continue;
            }
            self.var_at.insert(name.clone(), (self.vars.len(), at));
            self.vars.push(Var { v, id, node: false });
            out.push((name, node));
        }
        Ok(out)
    }

    fn folder(&mut self, dir: &str, folder: Option<usize>) -> Result<()> {
        let (files, subdirs) = self.dirs.get(dir).cloned().unwrap_or_default();
        let at = |name: &str| if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
        let root = dir.is_empty();
        let own = |n: &str| n == ORDER || n == VARIABLES || (!root && n == CATEGORY) || (root && (n == ROOT_JSON || HEADERS.contains(&n)));
        let here = self.variables(&at(VARIABLES))?;
        let mut entries: Vec<Entry> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        if let Some(bytes) = self.files.get(at(ORDER).as_str()).copied() {
            let file = format!("{PREFIX}{}", at(ORDER));
            let mut note = |kind: NoteKind, ln: usize, message: String| self.warnings.push(Note { kind, file: file.clone(), line: Some(ln + 1), message });
            for (ln, l) in String::from_utf8_lossy(bytes).split('\n').enumerate() {
                let l = l.strip_suffix('\r').unwrap_or(l);
                if l.is_empty() {
                    continue;
                }
                if !seen.insert(l.to_string()) {
                    note(NoteKind::OrderTwice, ln, format!("{l} is listed twice"));
                    continue;
                }
                if let Some(v) = l.strip_prefix('$') {
                    if here.iter().any(|(n, _)| n == v) {
                        entries.push(Entry::Var(v.to_string()));
                    } else {
                        note(NoteKind::OrderNotVariable, ln, format!("{l} isn't a variable of {}", Reader::shown(&at(VARIABLES))));
                    }
                } else if subdirs.contains(l) {
                    entries.push(Entry::Dir(l.to_string()));
                } else if files.contains(l) && !own(l) {
                    entries.push(Entry::File(l.to_string()));
                } else {
                    note(NoteKind::OrderMissing, ln, format!("{l} isn't there"));
                }
            }
        }
        // What order.txt doesn't list comes after what it does, alphabetically.
        let mut rest: Vec<(bool, &String)> = subdirs.iter().filter(|d| !seen.contains(*d)).map(|d| (true, d)).collect();
        rest.extend(files.iter().filter(|f| !own(f) && !seen.contains(*f)).map(|f| (false, f)));
        rest.sort_by(|a, b| (a.1.to_lowercase(), a.1).cmp(&(b.1.to_lowercase(), b.1)));
        entries.extend(rest.into_iter().map(|(dir, n)| if dir { Entry::Dir(n.clone()) } else { Entry::File(n.clone()) }));
        for (n, node) in &here {
            if *node && !seen.contains(&format!("${n}")) {
                entries.push(Entry::Var(n.clone()));
            }
        }
        for e in entries {
            let idx = self.nodes.len();
            match e {
                Entry::Dir(name) => {
                    let path = at(&name);
                    let cat_path = format!("{path}/{CATEGORY}");
                    let (ty, id, display, is_comment, expanded) = match self.files.get(cat_path.as_str()).copied() {
                        Some(bytes) => parse_category(bytes, &Reader::shown(&cat_path))?,
                        None => (4, None, name.clone(), 0, 1),
                    };
                    self.nodes.push(Node { parent: folder, id, kind: Kind::Folder { ty, name: display, is_comment, expanded }, file: Some(path.clone()) });
                    self.folder(&path, Some(idx))?;
                }
                Entry::File(name) => {
                    let path = at(&name);
                    let (id, t, text) = self.item(&path)?;
                    self.nodes.push(Node { parent: folder, id, kind: Kind::Trigger { t, text }, file: Some(path) });
                }
                Entry::Var(name) => {
                    let k = self.var_at[&name].0;
                    if self.vars[k].node {
                        self.warnings.push(Note {
                            kind: NoteKind::VariablePlacedTwice,
                            file: format!("{PREFIX}{}", at(ORDER)),
                            line: None,
                            message: format!("the variable {name} is placed in another folder already"),
                        });
                        continue;
                    }
                    self.vars[k].node = true;
                    self.nodes.push(Node { parent: folder, id: self.vars[k].id, kind: Kind::Var { name }, file: None });
                }
            }
        }
        Ok(())
    }

    fn item(&mut self, path: &str) -> Result<(Option<u32>, Trigger, Option<String>)> {
        read_item(path, self.files[path], self.classic)
    }
}

/// A trigger file (`path` below `map/triggers/`): its id, the trigger (id and parent unused) and its text.
pub(crate) fn read_item(path: &str, bytes: &[u8], classic: bool) -> Result<(Option<u32>, Trigger, Option<String>)> {
    {
        let shown = Reader::shown(path);
        let lower = path.to_ascii_lowercase();
        let blank = |ty: u32, name: String| Trigger {
            ty,
            name,
            description: String::new(),
            is_comment: 0,
            id: 0,
            enabled: true,
            is_custom: false,
            initially_off: false,
            run_on_init: false,
            parent: 0,
            ecas: Vec::new(),
        };
        if lower.ends_with(".gui.json") || lower.ends_with(".comment.json") {
            let gui = lower.ends_with(".gui.json");
            let v = parse_json(bytes, &shown)?;
            let mut keys = TRIGGER_KEYS.to_vec();
            if gui {
                keys.retain(|k| *k != "isCustom");
                keys.push("wctText");
            }
            let o = Obj::new(&v, shown.clone(), &keys)?;
            let want = if gui { 8 } else { 16 };
            let ty = o.u32("type")?.unwrap_or(want);
            if ty != want {
                return Err(bad(format!("{shown}: a .{} file is type {want}, not {ty}", if gui { "gui.json" } else { "comment.json" })));
            }
            let mut t = blank(ty, o.need_str("name")?);
            t.description = o.str("description")?.unwrap_or_default();
            t.is_comment = o.u32("isComment")?.unwrap_or(if gui { 0 } else { 1 });
            t.enabled = o.bool("enabled")?.unwrap_or(true);
            t.is_custom = o.bool("isCustom")?.unwrap_or(false);
            t.initially_off = o.bool("initiallyOff")?.unwrap_or(false);
            t.run_on_init = o.bool("runOnInit")?.unwrap_or(false);
            t.ecas = o.ecas()?;
            let text = if gui { o.str("wctText")? } else { None };
            return Ok((o.u32("id")?, t, text));
        }
        let Some(lang) = Lang::of_file(path) else {
            return Err(bad(format!("{shown} isn't a file of the trigger layout (.gui.json, .comment.json, .j, .vjass or .lua)")));
        };
        let (meta, body) = split_frontmatter(bytes, lang == Lang::Lua).map_err(|m| bad(format!("{shown}:1: {m}")))?;
        let text = file_text(&body);
        let Some(meta) = meta else {
            // Made outside Studio: a custom-text trigger if it defines InitTrig_<its name>, else a script item.
            let file = path.rsplit('/').next().unwrap_or(path);
            let name = stem_of(file).to_string();
            let ty = if classic || defines_init_trig(&text, &name) { 8 } else { 32 };
            let mut t = blank(ty, name);
            t.is_custom = true;
            return Ok((None, t, Some(text)));
        };
        let o = Obj::of(&meta, format!("{shown}:1"), &TRIGGER_KEYS)?;
        let ty = o.u32("type")?.ok_or_else(|| bad(format!("{shown}:1: the frontmatter has no \"type\"")))?;
        if ty != 8 && ty != 32 {
            return Err(bad(format!("{shown}:1: a script file is a custom-text trigger (type 8) or script item (type 32), not type {ty}")));
        }
        let mut t = blank(ty, o.need_str("name")?);
        t.description = o.str("description")?.unwrap_or_default();
        t.is_comment = o.u32("isComment")?.unwrap_or(0);
        t.enabled = o.bool("enabled")?.unwrap_or(true);
        t.is_custom = o.bool("isCustom")?.unwrap_or(true);
        t.initially_off = o.bool("initiallyOff")?.unwrap_or(false);
        t.run_on_init = o.bool("runOnInit")?.unwrap_or(false);
        t.ecas = o.ecas()?;
        if ty == 8 && !t.is_custom {
            return Err(bad(format!("{shown}:1: a script file's trigger is a custom text (\"isCustom\" can't be false for type 8)")));
        }
        Ok((o.u32("id")?, t, Some(text)))
    }
}

/// The tree in project files (keys relative to `map/`; those outside `map/triggers/` aren't looked at), and what is
/// worth a warning (order.txt entries that aren't there, a variable defined twice alike). Errs, naming the file (and
/// line), on a file that can't be read: never a half-read tree.
pub fn from_files(files: &BTreeMap<String, Vec<u8>>) -> Result<(Tree, Vec<String>)> {
    let (tree, notes) = from_files_noted(files)?;
    Ok((tree, notes.iter().map(Note::to_string).collect()))
}

/// `from_files`, with the warnings as notes (kind, file, line): Check Trigger Tree (`crate::trigger_check`) tells them
/// apart and offers fixes.
pub fn from_files_noted(files: &BTreeMap<String, Vec<u8>>) -> Result<(Tree, Vec<Note>)> {
    let ours: BTreeMap<&str, &[u8]> = files.iter().filter_map(|(k, v)| Some((k.strip_prefix(PREFIX)?, v.as_slice()))).collect();
    let root_bytes = ours.get(ROOT_JSON).ok_or_else(|| bad(format!("map/{ROOT_FILE} is missing")))?;
    let shown = format!("map/{ROOT_FILE}");
    let v = parse_json(root_bytes, &shown)?;
    let format = v.get("format").and_then(Value::as_str).ok_or_else(|| bad(format!("{shown}: \"format\" is missing")))?;
    let major = format.strip_prefix(FORMAT_NAME).and_then(|r| r.split('.').next()).and_then(|m| m.parse::<u64>().ok());
    match major {
        Some(FORMAT_MAJOR) => {}
        Some(m) if m > FORMAT_MAJOR => {
            return Err(bad(format!("{shown} is in the format {format}, made by a newer W3Proj Studio; this one reads {FORMAT}: update it")))
        }
        _ => return Err(bad(format!("{shown}: \"format\" is {format:?}, not {FORMAT}"))),
    }
    let o = Obj::new(&v, shown.clone(), &["format", "reforged", "version", "unknown", "wctVersion", "wctComment", "wctReforged", "root", "script", "counts", "variableOrder"])?;
    let reforged = o.bool("reforged")?.ok_or_else(|| bad(format!("{shown}: \"reforged\" is missing")))?;
    let version = o.u32("version")?.ok_or_else(|| bad(format!("{shown}: \"version\" is missing")))?;
    let wct_version = o.u32("wctVersion")?.ok_or_else(|| bad(format!("{shown}: \"wctVersion\" is missing")))?;
    let wct_reforged = o.bool("wctReforged")?.unwrap_or(reforged);
    let script = match o.str("script")? {
        Some(s) => ScriptMode::parse(&s).ok_or_else(|| bad(format!("{shown}: \"script\" is \"generated\" or \"kept\", not {s:?}")))?,
        None => ScriptMode::Kept,
    };
    let root = match o.get("root") {
        Some(r) => {
            let at = format!("{shown}: \"root\"");
            let ro = Obj::new(r, at, &["id", "name", "isComment", "expanded"])?;
            Some(Root { id: ro.u32("id")?, name: ro.need_str("name")?, is_comment: ro.u32("isComment")?.unwrap_or(0), expanded: ro.u32("expanded")?.unwrap_or(1) })
        }
        None => None,
    };
    let counts = match o.get("counts") {
        Some(c) => Some(serde_json::from_value::<Vec<Count>>(c.clone()).map_err(|e| bad(format!("{shown}: \"counts\": {e}")))?),
        None => None,
    };
    let variable_order = match o.get("variableOrder") {
        Some(c) => Some(serde_json::from_value::<Vec<String>>(c.clone()).map_err(|e| bad(format!("{shown}: \"variableOrder\": {e}")))?),
        None => None,
    };
    // The header: header.j or header.lua; none: no text.
    let headers: Vec<&str> = HEADERS.iter().copied().filter(|h| ours.contains_key(h)).collect();
    if headers.len() > 1 {
        return Err(bad(format!("map/{PREFIX}header.j and map/{PREFIX}header.lua are both there: a map has one custom script header")));
    }
    let header_slot = wct_reforged || wct_version >= 1;
    let header_file = headers.first().map(|h| h.to_string());
    if !header_slot && header_file.is_some() {
        return Err(bad(format!("map/{PREFIX}{}: war3map.wct version {wct_version} has no custom script header", headers[0])));
    }
    let header = header_slot.then(|| header_file.as_ref().map(|h| file_text(ours[h.as_str()])));
    let mut dirs: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new();
    dirs.entry(String::new()).or_default();
    for path in ours.keys() {
        let parts: Vec<&str> = path.split('/').collect();
        for d in 0..parts.len() {
            let dir = parts[..d].join("/");
            let e = dirs.entry(dir).or_default();
            if d + 1 == parts.len() {
                e.0.insert(parts[d].to_string());
            } else {
                e.1.insert(parts[d].to_string());
            }
        }
    }
    let mut r = Reader { files: ours, dirs, classic: !reforged, nodes: Vec::new(), vars: Vec::new(), var_at: HashMap::new(), warnings: Vec::new() };
    r.folder("", None)?;
    let tree = Tree {
        reforged,
        version,
        unknown: o.u32("unknown")?.unwrap_or(2),
        wct_reforged,
        wct_version,
        wct_comment: o.str("wctComment")?.unwrap_or_default(),
        header,
        header_file,
        root,
        counts,
        variable_order,
        script,
        nodes: r.nodes,
        vars: r.vars,
    };
    Ok((tree, r.warnings))
}

/// Errs on a script file (or the header) in the other language than the map's: never compiled as it is.
pub fn check_language(tree: &Tree, lang: Lang) -> Result<()> {
    let files = tree.header_file.iter().chain(tree.nodes.iter().filter(|n| matches!(&n.kind, Kind::Trigger { t, .. } if is_script(t))).filter_map(|n| n.file.as_ref()));
    for f in files {
        if let Some(l) = Lang::of_file(f).filter(|l| *l != lang) {
            return Err(bad(format!(
                "map/{PREFIX}{f}:1: a {} file in a {} map (war3map.w3i scriptType {}); custom texts aren't translated: rewrite it as a {} file",
                l.name(),
                lang.name(),
                u8::from(lang == Lang::Lua),
                lang.ext()
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- unpack and pack

/// The files of `map/triggers/` for a map's war3map.wtg and war3map.wct (keys relative to `map/`), read with the
/// game's TriggerData. The files are read back as pack reads them and must give both files byte for byte; Err: why
/// not (unpack then keeps both raw).
pub fn split_map(wtg_bytes: &[u8], wct_bytes: &[u8], data: &TriggerData, lang: Lang) -> Result<BTreeMap<String, Vec<u8>>> {
    let tf = wtg::parse(wtg_bytes, data)?;
    let w = wct::parse(wct_bytes)?;
    let tree = from_binary(&tf, &w)?;
    let files = to_files(&tree, lang, None)?;
    same_bytes(&files, wtg_bytes, wct_bytes)?;
    Ok(files)
}

/// Errs unless `files` (the layout) pack into these war3map.wtg and war3map.wct.
fn same_bytes(files: &BTreeMap<String, Vec<u8>>, wtg_bytes: &[u8], wct_bytes: &[u8]) -> Result<()> {
    let (back, _) = from_files(files)?;
    let (tf, w, _) = to_binary(&back)?;
    if wtg::write(&tf) != wtg_bytes {
        return Err(bad(format!("war3map.wtg doesn't come back byte for byte from map/{DIR}/")));
    }
    if wct::write(&w) != wct_bytes {
        return Err(bad(format!("war3map.wct doesn't come back byte for byte from map/{DIR}/")));
    }
    Ok(())
}

/// Whether project files (relative to `map/`) hold the layout: `triggers/triggers.json`, unless packed raw (a file of
/// the map's own by that name).
pub fn is_layout(files: &BTreeMap<String, Vec<u8>>, raw: &[String]) -> bool {
    files.contains_key(ROOT_FILE) && !raw.iter().any(|r| r == ROOT_FILE)
}

/// Whether a project path is the layout's (below `map/triggers/`).
pub fn is_layout_path(path: &str) -> bool {
    path.starts_with(PREFIX)
}

/// Errs on a GUI function the game's TriggerData doesn't know, or one given another number of parameters than it
/// takes: war3map.wtg stores parameters without a count, so such a file can't be read back (by the World Editor
/// either). Names the file.
pub fn check_functions(tree: &Tree, data: &TriggerData) -> Result<()> {
    use crate::wtg::Param;
    fn param(p: &Param, data: &TriggerData) -> std::result::Result<(), String> {
        if let Some(c) = &p.call {
            if c.has_params {
                let n = data.arg_count(c.kind, &c.name).ok_or_else(|| format!("\"{}\" isn't a function of the game's TriggerData.txt", c.name))?;
                if n != c.params.len() {
                    return Err(format!("\"{}\" takes {n} parameters, the file gives {}", c.name, c.params.len()));
                }
            }
            for q in &c.params {
                param(q, data)?;
            }
        }
        match &p.index {
            Some(i) => param(i, data),
            None => Ok(()),
        }
    }
    fn eca(e: &Eca, data: &TriggerData) -> std::result::Result<(), String> {
        let n = data.arg_count(e.kind, &e.name).ok_or_else(|| format!("\"{}\" isn't a function of the game's TriggerData.txt", e.name))?;
        if n != e.params.len() {
            return Err(format!("\"{}\" takes {n} parameters, the file gives {}", e.name, e.params.len()));
        }
        for p in &e.params {
            param(p, data)?;
        }
        e.children.iter().try_for_each(|c| eca(c, data))
    }
    for (i, n) in tree.nodes.iter().enumerate() {
        if let Kind::Trigger { t, .. } = &n.kind {
            t.ecas.iter().try_for_each(|e| eca(e, data)).map_err(|m| bad(format!("{}: {m}", tree.shown(i))))?;
        }
    }
    Ok(())
}

/// war3map.wtg and war3map.wct of the layout in project files, for `lang`, and the warnings. Check Trigger Tree
/// (`crate::trigger_check`) runs first: its errors (conflict markers, files that can't be read, a variable defined
/// twice differently, names only case tells apart, a script file in the other language, …) stop the pack; the rest,
/// a stored id found twice too, is told; nothing is repaired here. With the game's TriggerData, a GUI function it doesn't
/// know is an error too (`check_functions`).
pub fn assemble(files: &BTreeMap<String, Vec<u8>>, lang: Lang, data: Option<&TriggerData>) -> Result<(Vec<u8>, Vec<u8>, Vec<String>)> {
    let issues = crate::trigger_check::check(files, Some(lang));
    let errors: Vec<String> = issues.iter().filter(|i| i.stops_pack()).map(ToString::to_string).collect();
    if !errors.is_empty() {
        let n = errors.len();
        let shown = errors.iter().take(10).cloned().collect::<Vec<_>>().join("; ");
        let more = if n > 10 { format!("; and {} more", n - 10) } else { String::new() };
        return Err(bad(format!(
            "map/{DIR}/ has {n} error{} (Check Trigger Tree), so it isn't packed: {shown}{more}. W3Proj Studio's Problems view or `w3proj triggers --check` lists them, with fixes where one is safe",
            if n == 1 { "" } else { "s" }
        )));
    }
    let mut warnings: Vec<String> = issues.iter().map(ToString::to_string).collect();
    let (tree, _) = from_files(files)?;
    check_language(&tree, lang)?;
    if let Some(data) = data {
        check_functions(&tree, data)?;
    }
    let (tf, w, more) = to_binary(&tree)?;
    warnings.extend(more);
    Ok((wtg::write(&tf), wct::write(&w), warnings))
}

/// The script mode `triggers.json` names, when the project files hold the layout.
pub fn script_mode(files: &BTreeMap<String, Vec<u8>>) -> Result<Option<ScriptMode>> {
    files.get(ROOT_FILE).map(|b| mode_of(b)).transpose()
}

fn mode_of(bytes: &[u8]) -> Result<ScriptMode> {
    let shown = format!("map/{ROOT_FILE}");
    let v = parse_json(bytes, &shown)?;
    match v.get("script") {
        None | Some(Value::Null) => Ok(ScriptMode::Kept),
        Some(s) => s.as_str().and_then(ScriptMode::parse).ok_or_else(|| bad(format!("{shown}: \"script\" is \"generated\" or \"kept\", not {s}"))),
    }
}

/// The script mode of a project whose `map/` folder this is; None without the layout. A root file that is there but
/// can't be read is an error.
pub fn script_mode_on_disk(map_dir: &Path) -> Result<Option<ScriptMode>> {
    match std::fs::read(map_dir.join(DIR).join(ROOT_JSON)) {
        Ok(b) => mode_of(&b).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Project(format!("map/{ROOT_FILE} can't be read: {e}"))),
    }
}

/// What `set_script_mode` did.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct ModeChange {
    /// The mode before.
    pub was: &'static str,
    /// The script moved (its name: `war3map.j` or `war3map.lua`), None when there was none to move.
    pub moved: Option<String>,
}

/// Switches a project's map script between a tracked file (`kept`: `map/war3map.j|lua`) and a generated one in the store
/// (`generated`: `.w3proj/derived/`, `crate::derived`). The script there is moved to the other place as it is (the caller
/// makes it again afterwards); the record of what a generated script was made from is cleared either way (a moved script
/// isn't known to follow anything). Order, so no step loses the script: the new place written, then `triggers.json`, then
/// the old place removed. Refused, nothing written: a project without `map/triggers/` (its triggers kept raw, or none:
/// its script stays tracked), a `triggers.json` that can't be read, both `war3map.j` and `war3map.lua` at the old place,
/// or a different script already at the new place (moving one would replace the other: delete one first). The same
/// mode again changes nothing.
pub fn set_script_mode(project: &Path, mode: ScriptMode) -> Result<ModeChange> {
    use crate::derived;
    let map_dir = project.join(crate::project::MAP_DIR);
    let path = map_dir.join(DIR).join(ROOT_JSON);
    let shown = format!("map/{ROOT_FILE}");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::Project(format!(
                "the project has no {shown} (its triggers are kept raw, or it has none), so its map script stays a tracked file in map/"
            )))
        }
        Err(e) => return Err(Error::Project(format!("{shown} can't be read: {e}"))),
    };
    let was = mode_of(&bytes)?;
    if was == mode {
        return Ok(ModeChange { was: was.as_str(), moved: None });
    }
    let mut doc = match parse_json(&bytes, &shown)? {
        Value::Object(m) => m,
        _ => return Err(bad(format!("{shown} isn't a JSON object"))),
    };
    doc.insert("script".into(), mode.as_str().into());
    let tracked: Vec<(String, Vec<u8>)> = match std::fs::read_dir(&map_dir) {
        Ok(entries) => {
            let mut out = Vec::new();
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if derived::SCRIPT_FILES.iter().any(|s| s.eq_ignore_ascii_case(&name)) && entry.file_type()?.is_file() {
                    let b = std::fs::read(entry.path()).map_err(|e| Error::Project(format!("map/{name} can't be read: {e}")))?;
                    out.push((name, b));
                }
            }
            out
        }
        Err(e) => return Err(Error::Project(format!("map/ can't be read: {e}"))),
    };
    let stored: Vec<(String, Vec<u8>)> = derived::read_script_store(project)?.into_iter().collect();
    let store_shown = derived::STORE_DIR.join("/");
    let (from, to, from_shown, to_shown) = match mode {
        ScriptMode::Generated => (&tracked, &stored, "map".to_string(), store_shown.clone()),
        ScriptMode::Kept => (&stored, &tracked, store_shown.clone(), "map".to_string()),
    };
    if from.len() > 1 {
        return Err(Error::Project(format!("{from_shown}/ has both {} and {}: keep one (delete the other), then try again", from[0].0, from[1].0)));
    }
    if let (Some((name, b)), Some((other, ob))) = (from.first(), to.first()) {
        if !(name.eq_ignore_ascii_case(other) && b == ob) {
            return Err(Error::Project(format!(
                "{from_shown}/{name} and {to_shown}/{other} are both there: moving one would replace the other; delete the one you don't want, then try again"
            )));
        }
    }
    let moved = from.first().map(|(n, _)| n.clone());
    match (mode, from.first()) {
        (ScriptMode::Generated, Some((name, b))) => derived::sync_script_store(project, Some((name, b)))?,
        (ScriptMode::Kept, Some((name, b))) => crate::project::write_atomic(&map_dir.join(name), b)?,
        _ => {}
    }
    if mode == ScriptMode::Generated {
        derived::ensure_ignored(project)?;
    }
    crate::project::write_atomic(&path, &root_json(&doc))?;
    match (mode, from.first()) {
        (ScriptMode::Generated, Some((name, _))) => std::fs::remove_file(map_dir.join(name))?,
        (ScriptMode::Kept, Some(_)) => derived::sync_script_store(project, None)?,
        _ => {}
    }
    derived::clear_script_record(project)?;
    Ok(ModeChange { was: was.as_str(), moved })
}

/// The layout's files on disk (keys relative to `map/`); none without `map/triggers/`. One that can't be read is an error.
pub fn read_disk(map_dir: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut out = BTreeMap::new();
    for rel in crate::project::walk(&map_dir.join(DIR))? {
        let path = format!("{PREFIX}{rel}");
        let bytes = std::fs::read(crate::paths::join_rel(map_dir, &path)).map_err(|e| Error::Project(format!("map/{path} can't be read: {e}")))?;
        out.insert(path, bytes);
    }
    Ok(out)
}

/// The map script of project files (relative to `map/`): its name and bytes.
fn script_in(files: &BTreeMap<String, Vec<u8>>) -> Option<(String, Vec<u8>)> {
    crate::derived::SCRIPT_FILES.iter().find_map(|s| files.iter().find(|(k, _)| k.eq_ignore_ascii_case(s)).map(|(k, b)| (k.clone(), b.clone())))
}

/// For a sync from a map into a project (`files`: the map's, relative to `map/`, the layout made by `split_map`):
/// items that have a file in the project's `map/triggers/` keep its name (so a `~2` doesn't move to another item, and
/// a file renamed by hand stays so), and the script mode is decided. The map's script is "generated" when Studio wrote
/// it (the project's `.w3proj/generated-script` holds its hash) or it is the generated one the project has already;
/// then it is taken out of `files` and returned, for the store (`crate::derived`). Otherwise it is "kept", a tracked
/// file in `map/`. Nothing happens to files without the layout. The renamed files must pack into the same
/// war3map.wtg and war3map.wct, or the sync stops.
pub fn prepare_sync(project: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<Option<(String, Vec<u8>)>> {
    if !files.contains_key(ROOT_FILE) {
        return Ok(None);
    }
    let map_dir = project.join(crate::project::MAP_DIR);
    let disk = read_disk(&map_dir)?;
    let (mut tree, _) = from_files(files)?;
    let (tf, w, _) = to_binary(&tree)?;
    // Files on disk that can't be read keep no names (the map's files replace them anyway).
    let old = (!disk.is_empty()).then(|| from_files(&disk).ok().map(|(t, _)| t)).flatten();
    let script = script_in(files);
    let generated = match &script {
        Some((name, bytes)) => {
            let studios = crate::derived::script_stamp(project).is_some_and(|stamp| std::str::from_utf8(bytes).is_ok_and(|t| crate::derived::script_hash(t) == stamp));
            let already = old.as_ref().is_some_and(|t| t.script == ScriptMode::Generated)
                && crate::derived::read_script_store(project)?.iter().any(|(k, b)| k.eq_ignore_ascii_case(name) && b == bytes);
            studios || already
        }
        None => false,
    };
    tree.script = if generated { ScriptMode::Generated } else { ScriptMode::Kept };
    let renamed = to_files(&tree, tree.lang_hint(), old.as_ref())?;
    same_bytes(&renamed, &wtg::write(&tf), &wct::write(&w))?;
    files.retain(|k, _| !is_layout_path(k));
    files.extend(renamed);
    if generated {
        if let Some((name, _)) = &script {
            return Ok(files.remove(name).map(|b| (name.clone(), b)));
        }
    }
    Ok(None)
}

/// A made-up map's war3map.wtg and war3map.wct for tests (the functions are those of tests/fixtures/TriggerData.txt):
/// Reforged with the map item, a category, a library folder with a folder in it, GUI triggers with nested ECAs, a
/// custom-text trigger (CRLF), script items (LF, no final newline, a zero byte), a comment, variable nodes in two
/// folders with a table order that isn't the tree's, unsorted deleted ids and a header. `classic`: a Classic (version
/// 7) map with two categories, a GUI and a custom-text trigger, no comment, script item or node.
pub fn sample_map(classic: bool) -> (Vec<u8>, Vec<u8>) {
    use crate::wtg::{Call, Param};
    let param = |ty: i32, value: &str| Param { ty, value: value.into(), call: None, index: None };
    let eca = |kind: u32, group: Option<u32>, name: &str, params: Vec<Param>, children: Vec<Eca>| Eca { kind, group, name: name.into(), enabled: true, params, children };
    let call = Param { ty: 2, value: "GetFooValue".into(), call: Some(Box::new(Call { kind: 3, name: "GetFooValue".into(), has_params: true, params: vec![param(0, "2")], trailer: Some(0) })), index: None };
    let gui_ecas = vec![
        eca(0, None, "MapFooStart", Vec::new(), Vec::new()),
        eca(1, None, "IsFooReady", vec![param(0, "1"), call], Vec::new()),
        eca(2, None, "IfThenElseMultiple", Vec::new(), vec![eca(1, Some(0), "IsFooReady", vec![param(0, "1"), param(0, "3")], Vec::new()), eca(2, Some(1), "LogFoo", vec![param(3, "\"then\"")], Vec::new())]),
        eca(2, None, "DoFooThing", vec![param(3, "\"x\""), param(0, "1.5")], Vec::new()),
    ];
    let trigger = |ty: u32, name: &str, custom: bool, id: u32, parent: i32, ecas: Vec<Eca>| {
        Item::Trigger(Trigger { ty, name: name.into(), description: format!("About {name}.\nSecond line."), is_comment: u32::from(ty == 16), id, enabled: true, is_custom: custom, initially_off: false, run_on_init: false, parent, ecas })
    };
    let cat = |ty: u32, name: &str, id: u32, parent: i32| Item::Category(Category { ty, id, name: name.into(), is_comment: 0, expanded: 1, parent });
    let var = |name: &str, ty: &str, id: u32, parent: i32| Variable { name: name.into(), ty: ty.into(), unknown: 1, is_array: false, array_size: 1, initialized: true, initial_value: "3".into(), id, parent };
    let setup = "function Trig_Setup_Players_Actions takes nothing returns nothing\r\nendfunction\r\nfunction InitTrig_Setup_Players takes nothing returns nothing\r\nendfunction\r\n";
    if classic {
        let items = vec![cat(4, "Initialization", 0, -1), cat(4, "Setup", 3, -1), trigger(8, "Melee Initialization", false, 0, 0, gui_ecas.into_iter().map(|mut e| { e.children.clear(); e }).collect()), trigger(8, "Setup Players", true, 1, 3, Vec::new())];
        let tf = TriggerFile { reforged: false, version: 7, counts: Vec::new(), unknown: 2, variables: vec![var("Counter", "integer", 0, -1)], items };
        let w = Wct { reforged: false, version: 1, comment: String::new(), header: Some(Some("// header\n".into())), texts: vec![None, Some(setup.into())] };
        return (wtg::write(&tf), wct::write(&w));
    }
    let (initialization, systems, sub): (i32, i32, i32) = (2 << 24, 1 << 24, (2 << 24) | 1);
    let items = vec![
        cat(1, "Sample.w3x", 0, -1),
        cat(4, "Initialization", initialization as u32, 0),
        trigger(8, "Melee Initialization", false, 3 << 24, initialization, gui_ecas),
        trigger(8, "Setup Players", true, (3 << 24) | 1, initialization, Vec::new()),
        Item::Element(Element { ty: 64, id: 6 << 24, name: "BossHP".into(), parent: initialization }),
        cat(2, "Systems", systems as u32, 0),
        trigger(32, "Damage Engine", true, 5 << 24, systems, Vec::new()),
        trigger(16, "-----", false, 4 << 24, systems, Vec::new()),
        cat(4, "Sub", sub as u32, systems),
        trigger(8, "Nested", false, (3 << 24) | 2, sub, Vec::new()),
        trigger(32, "Padded", true, (5 << 24) | 1, sub, Vec::new()),
        Item::Element(Element { ty: 64, id: (6 << 24) | 1, name: "Counter".into(), parent: 0 }),
    ];
    let mut counts: Vec<Count> = [1, 1, 3, 4, 1, 2, 2, 0].iter().map(|&count| Count { count, deleted: Vec::new() }).collect();
    counts[2].deleted = vec![2];
    counts[3].deleted = vec![3, 0x10];
    counts[3].count = 0x11;
    let variables = vec![var("Counter", "integer", (6 << 24) | 1, 0), var("BossHP", "real", 6 << 24, initialization)];
    let tf = TriggerFile { reforged: true, version: 7, counts, unknown: 2, variables, items };
    let texts = vec![None, Some(setup.into()), Some("library DamageEngine\n    // ...\nendlibrary".into()), None, Some("library Padded\nendlibrary\0\0".into())];
    let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(Some("// header\r\n".into())), texts };
    (wtg::write(&tf), wct::write(&w))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `super::assemble` without the game's TriggerData.
    fn assemble(files: &BTreeMap<String, Vec<u8>>, lang: Lang) -> Result<(Vec<u8>, Vec<u8>, Vec<String>)> {
        super::assemble(files, lang, None)
    }

    fn fixture_data() -> TriggerData {
        TriggerData::parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/TriggerData.txt")).unwrap())
    }

    /// What would break war3map.wtg is refused, naming the file: a zero byte in a name (`\u0000`, or U+10FF00, which is
    /// one), a function TriggerData doesn't know or a wrong number of parameters (with the game's TriggerData).
    #[test]
    fn what_would_break_war3map_wtg_is_refused() {
        let data = fixture_data();
        let (wtg_bytes, wct_bytes) = sample_map(false);
        let files = split_map(&wtg_bytes, &wct_bytes, &data, Lang::Jass).unwrap();
        super::assemble(&files, Lang::Jass, Some(&data)).unwrap();
        let gui = "triggers/Initialization/Melee_Initialization.gui.json";
        for (from, to, why) in [
            ("\"name\": \"Melee Initialization\"", "\"name\": \"Melee\\u0000\"", "holds a zero byte"),
            ("\"name\": \"Melee Initialization\"", "\"name\": \"Melee\u{10FF00}\"", "holds a zero byte"),
            ("\"DoFooThing\"", "\"DoFooThings\"", "\"DoFooThings\" isn't a function"),
            ("{\"type\":0,\"value\":\"1.5\"}", "{\"type\":0,\"value\":\"1.5\"},{\"type\":0,\"value\":\"2\"}", "\"DoFooThing\" takes 2 parameters, the file gives 3"),
        ] {
            let mut f = files.clone();
            let text = text(&f, gui);
            assert!(text.contains(from), "{from} not in {text}");
            f.insert(gui.into(), text.replace(from, to).into_bytes());
            let e = super::assemble(&f, Lang::Jass, Some(&data)).unwrap_err().to_string();
            assert!(e.contains(why) && e.contains(gui), "{e}");
        }
    }

    #[test]
    fn the_sample_maps_split_with_the_fixtures_trigger_data() {
        let data = fixture_data();
        for classic in [false, true] {
            let (wtg_bytes, wct_bytes) = sample_map(classic);
            let files = split_map(&wtg_bytes, &wct_bytes, &data, Lang::Jass).unwrap();
            assert!(files.len() > 4, "{:?}", files.keys());
            // Control: without the functions it can't be read.
            assert!(split_map(&wtg_bytes, &wct_bytes, &TriggerData::parse(""), Lang::Jass).is_err());
        }
    }

    fn trigger(ty: u32, name: &str, custom: bool, id: u32, parent: i32) -> Item {
        Item::Trigger(Trigger {
            ty,
            name: name.into(),
            description: "two\r\nlines \"quoted\"".into(),
            is_comment: u32::from(ty == 16),
            id,
            enabled: true,
            is_custom: custom,
            initially_off: false,
            run_on_init: false,
            parent,
            ecas: Vec::new(),
        })
    }

    fn cat(ty: u32, name: &str, id: u32, parent: i32) -> Item {
        Item::Category(Category { ty, id, name: name.into(), is_comment: 0, expanded: 1, parent })
    }

    fn var(name: &str, id: u32, parent: i32) -> Variable {
        Variable { name: name.into(), ty: "integer".into(), unknown: 1, is_array: false, array_size: 1, initialized: true, initial_value: "3".into(), id, parent }
    }

    fn counts(c: &[u32]) -> Vec<Count> {
        (0..8).map(|k| Count { count: c.get(k).copied().unwrap_or(0), deleted: Vec::new() }).collect()
    }

    /// Packs files as pack does and compares with the binary.
    fn round_trip(tf: &TriggerFile, w: &Wct, lang: Lang) -> BTreeMap<String, Vec<u8>> {
        let (wtg_bytes, wct_bytes) = (wtg::write(tf), wct::write(w));
        let tree = from_binary(tf, w).unwrap();
        let files = to_files(&tree, lang, None).unwrap();
        let (a, b, _) = assemble(&files, lang).unwrap();
        assert!(a == wtg_bytes, "war3map.wtg differs");
        assert!(b == wct_bytes, "war3map.wct differs");
        files
    }

    fn text(files: &BTreeMap<String, Vec<u8>>, path: &str) -> String {
        String::from_utf8(files[path].clone()).unwrap_or_else(|_| panic!("{path} isn't UTF-8"))
    }

    /// The stage 0 selftest: texts no local map has (BOM, CR-only, code pages, a real U+10FF00, a first line that
    /// looks like frontmatter, zero bytes inside, BOM-only, empty and missing texts) come back in JASS and Lua.
    #[test]
    fn texts_no_map_has_come_back_byte_for_byte() {
        let raw: Vec<Option<Vec<u8>>> = vec![
            Some(b"\xEF\xBB\xBFfunction A takes nothing returns nothing\r\nendfunction\r\n".to_vec()),
            Some(b"line1\rline2\r".to_vec()),
            Some(b"mixed\r\nlf\nend".to_vec()),
            Some(b"// \xC7\xD1\xB1\xB9 cp949\r\nx\xFF\r\n".to_vec()),
            Some("real \u{10FF00} and \u{10FFFF}\n".as_bytes().to_vec()),
            Some(b"// @w3proj {\"type\":32}\nbody\n".to_vec()),
            Some(b"-- @w3proj {\"type\":32}\nbody\n".to_vec()),
            Some(b"zero\x00inside\x00\x00".to_vec()),
            Some(b"\n\n\n".to_vec()),
            Some(Vec::new()),
            Some(b"\xEF\xBB\xBF".to_vec()),
            Some(b"no newline at all".to_vec()),
        ];
        let mut items = vec![cat(1, "T.w3x", 0, -1)];
        for k in 0..raw.len() {
            items.push(trigger(32, &format!("Script {k}"), true, (5 << 24) | k as u32, 0));
        }
        // A GUI trigger with no text slot content and one with dormant custom text.
        items.push(trigger(8, "Gui", false, 3 << 24, 0));
        items.push(trigger(8, "Gui with text", false, (3 << 24) | 1, 0));
        let mut texts: Vec<Option<String>> = raw.iter().map(|t| t.as_ref().map(|b| crate::lossless::decode(b))).collect();
        texts.push(None);
        texts.push(Some("dormant\0".into()));
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 0, 2, 0, raw.len() as u32]), unknown: 2, variables: Vec::new(), items };
        let w = Wct { reforged: true, version: 1, comment: "c".into(), header: Some(Some(crate::lossless::decode(b"\xEF\xBB\xBFheader\n"))), texts };
        for lang in [Lang::Jass, Lang::Lua] {
            let files = round_trip(&tf, &w, lang);
            assert!(files.contains_key(&format!("triggers/header{}", lang.ext())));
            // Zero bytes are written as U+10FF00, so the file is plain text.
            let zero = files.iter().find(|(k, _)| k.contains("Script_7")).unwrap();
            assert!(std::str::from_utf8(zero.1).unwrap().contains("zero\u{10FF00}inside"));
            // Control: a changed text changes the output.
            let key = files.keys().find(|k| k.contains("Script_1.")).unwrap().clone();
            let mut changed = files.clone();
            changed.get_mut(&key).unwrap().push(b'x');
            assert_ne!(assemble(&changed, lang).unwrap().1, wct::write(&w));
        }
    }

    #[test]
    fn frontmatter_keeps_the_text_exactly() {
        let meta = object(vec![("type", 32.into()), ("name", "S".into())]);
        for (body, expect) in [
            (&b"a\r\nb"[..], &b"// @w3proj {\"type\":32,\"name\":\"S\"}\r\na\r\nb"[..]),
            (b"a\nb\r\n", b"// @w3proj {\"type\":32,\"name\":\"S\"}\na\nb\r\n"),
            (b"", b"// @w3proj {\"type\":32,\"name\":\"S\"}\n"),
            (b"\xEF\xBB\xBFx\r\n", b"\xEF\xBB\xBF// @w3proj {\"type\":32,\"name\":\"S\"}\r\nx\r\n"),
            (b"one\rline", b"// @w3proj {\"type\":32,\"name\":\"S\"}\none\rline"),
        ] {
            let file = with_frontmatter(&meta, body, false);
            assert_eq!(file, expect, "{:?}", String::from_utf8_lossy(body));
            let (m, back) = split_frontmatter(&file, false).unwrap();
            assert_eq!((m.unwrap(), back.as_slice()), (meta.clone(), body));
        }
        // Lua's comment.
        let file = with_frontmatter(&meta, b"x\n", true);
        assert!(file.starts_with(b"-- @w3proj {"));
        // No frontmatter: the whole file is the text.
        assert_eq!(split_frontmatter(b"function f()\n", true).unwrap(), (None, b"function f()\n".to_vec()));
        assert_eq!(split_frontmatter(b"// @w3projection\n", false).unwrap().0, None);
    }

    #[test]
    fn malformed_frontmatter_is_an_error_with_file_and_line() {
        for (file, lua, why) in [
            (&b"// @w3proj {\"type\": 32,\nx"[..], false, "malformed frontmatter"),
            (b"// @w3proj [1]\n", false, "isn't a JSON object"),
            (b"-- @w3proj {}\n", false, "a JASS file's needs // @w3proj"),
            (b"// @w3proj {}\n", true, "a Lua file's needs -- @w3proj"),
        ] {
            assert!(split_frontmatter(file, lua).unwrap_err().contains(why), "{:?}", String::from_utf8_lossy(file));
        }
        // Through the reader: the file and line 1 are named, and an unknown key or wrong type is an error too.
        let base = minimal();
        for (body, why) in [
            ("// @w3proj {\"type\":32\n", "map/triggers/S.j:1: malformed frontmatter"),
            ("// @w3proj {\"type\":32,\"name\":\"S\",\"nmae\":1}\n", "map/triggers/S.j:1: unknown field \"nmae\""),
            ("// @w3proj {\"type\":16,\"name\":\"S\"}\n", "map/triggers/S.j:1: a script file is"),
            ("// @w3proj {\"name\":\"S\"}\n", "has no \"type\""),
        ] {
            let mut files = base.clone();
            files.insert("triggers/S.j".into(), body.as_bytes().to_vec());
            let e = from_files(&files).unwrap_err().to_string();
            assert!(e.contains(why), "{e}");
        }
    }

    /// The files of an empty Reforged tree.
    fn minimal() -> BTreeMap<String, Vec<u8>> {
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1]), unknown: 2, variables: Vec::new(), items: vec![cat(1, "M.w3x", 0, -1)] };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: Vec::new() };
        round_trip(&tf, &w, Lang::Jass)
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Melee Initialization", "trigger"), "Melee_Initialization");
        assert_eq!(slug("a<b>c:d\"e/f\\g|h?i*j", "trigger"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(slug("$Boss", "folder"), "_Boss");
        assert_eq!(slug(".hidden", "trigger"), "_hidden");
        assert_eq!(slug("end..", "trigger"), "end__");
        assert_eq!(slug("-----------", "comment"), "comment");
        assert_eq!(slug("", "folder"), "folder");
        assert_eq!(slug("con", "trigger"), "con_");
        assert_eq!(slug("COM1.x", "trigger"), "COM1.x_");
        assert_eq!(slug("Größe 한국", "trigger"), "Größe_한국");
        assert_eq!(slug(&"x".repeat(100), "trigger").chars().count(), 80);
        assert_eq!(slug(&format!("{}...", "y".repeat(78)), "trigger"), format!("{}__", "y".repeat(78)));
    }

    #[test]
    fn collisions_get_numbers_in_tree_order_in_any_case_and_across_extensions() {
        let items = vec![
            cat(1, "M.w3x", 0, -1),
            trigger(16, "-----", false, 4 << 24, 0),
            trigger(16, "-----", false, (4 << 24) | 1, 0),
            trigger(8, "Damage Engine", true, 3 << 24, 0),
            trigger(32, "Damage Engine", true, 5 << 24, 0),
            trigger(8, "damage engine", false, (3 << 24) | 1, 0),
            trigger(8, "order", false, (3 << 24) | 2, 0),
            trigger(32, "header", true, (5 << 24) | 1, 0),
            cat(4, "Damage Engine", 2 << 24, 0),
            cat(4, "$X", (2 << 24) | 1, 0),
        ];
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 2, 3, 2, 2]), unknown: 2, variables: Vec::new(), items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: vec![Some("a".into()), Some("b".into()), None, None, Some("c".into())] };
        let files = round_trip(&tf, &w, Lang::Jass);
        let order = text(&files, "triggers/order.txt");
        assert_eq!(
            order,
            "comment.comment.json\ncomment~2.comment.json\nDamage_Engine.j\nDamage_Engine~2.j\ndamage_engine~3.gui.json\norder.gui.json\nheader~2.j\nDamage_Engine\n_X\n"
        );
        assert!(files.contains_key("triggers/Damage_Engine/_category.json") && files.contains_key("triggers/_X/_category.json"));
    }

    #[test]
    fn order_txt_unlisted_and_missing_entries() {
        let items = vec![cat(1, "M.w3x", 0, -1), trigger(8, "B", false, 3 << 24, 0), trigger(8, "A", false, (3 << 24) | 1, 0), Item::Element(Element { ty: 64, id: 6 << 24, name: "v".into(), parent: 0 })];
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 0, 2, 0, 0, 1]), unknown: 2, variables: vec![var("v", 6 << 24, 0)], items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: vec![None, None] };
        let files = round_trip(&tf, &w, Lang::Jass);
        assert_eq!(text(&files, "triggers/order.txt"), "B.gui.json\nA.gui.json\n$v\n");
        let names = |files: &BTreeMap<String, Vec<u8>>| {
            let (tree, warnings) = from_files(files).unwrap();
            let names: Vec<String> = tree.nodes.iter().map(|n| match &n.kind {
                Kind::Trigger { t, .. } => t.name.clone(),
                Kind::Var { name } => format!("${name}"),
                Kind::Folder { name, .. } => name.clone(),
            }).collect();
            (names, warnings)
        };
        // No order.txt: alphabetical, the variable's node after.
        let mut f = files.clone();
        f.remove("triggers/order.txt");
        assert_eq!(names(&f).0, ["A", "B", "$v"]);
        // A file dropped in and a listed one that's gone: appended, and a warning.
        let mut f = files.clone();
        f.insert("triggers/order.txt".into(), b"Gone.gui.json\r\nB.gui.json\n\n$v\n".to_vec());
        f.insert("triggers/New.j".into(), b"function InitTrig_New takes nothing returns nothing\nendfunction\n".to_vec());
        f.insert("triggers/Lib.j".into(), b"library Lib\nendlibrary\n".to_vec());
        let (n, warnings) = names(&f);
        assert_eq!(n, ["B", "$v", "A", "Lib", "New"]);
        assert!(warnings.len() == 1 && warnings[0].contains("order.txt:1: Gone.gui.json isn't there"), "{warnings:?}");
        let (tree, _) = from_files(&f).unwrap();
        let ty = |name: &str| tree.nodes.iter().find_map(|n| match &n.kind { Kind::Trigger { t, .. } if t.name == name => Some((t.ty, t.is_custom)), _ => None }).unwrap();
        assert_eq!((ty("New"), ty("Lib")), ((8, true), (32, true)), "InitTrig_<name>: a custom-text trigger, else a script item");
        // They pack, with fresh ids from the counters.
        let (wtg_bytes, wct_bytes, _) = assemble(&f, Lang::Jass).unwrap();
        let data = TriggerData::parse("");
        let back = wtg::parse(&wtg_bytes, &data).unwrap();
        let ids: Vec<u32> = back.items.iter().filter_map(|i| if let Item::Trigger(t) = i { Some(t.id) } else { None }).collect();
        // B and A keep theirs; Lib (a script item) and New (a trigger) get the next of their counters.
        assert_eq!(ids, [3 << 24, (3 << 24) | 1, 5 << 24, (3 << 24) | 2]);
        assert_eq!(wct::parse(&wct_bytes).unwrap().texts.len(), 4);
    }

    /// Imported ids that don't follow the editor's numbering (FOE's, made by a tool) leave the counters alone; only ids
    /// pack gives out raise them.
    #[test]
    fn counters_rise_only_for_ids_pack_gave_out() {
        let items = vec![cat(1, "M.w3x", 0, -1), cat(4, "Tool", 0x1FF_F2B6, 0), trigger(8, "T", false, 0x2FF_FB90, 0x1FF_F2B6)];
        let mut c = counts(&[1, 0, 18, 3]);
        c[3].deleted = vec![9, 2, 5];
        let tf = TriggerFile { reforged: true, version: 7, counts: c.clone(), unknown: 2, variables: Vec::new(), items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: vec![None] };
        let mut files = round_trip(&tf, &w, Lang::Jass);
        let json = text(&files, "triggers/triggers.json");
        assert!(json.contains("{\"count\":3,\"deleted\":[9,2,5]}"), "kept verbatim, unsorted: {json}");
        // A new trigger: the next id from the trigger counter, which rises past it; the others stay.
        files.insert("triggers/Tool/New.gui.json".into(), b"{\"name\":\"New\"}".to_vec());
        let (wtg_bytes, _, _) = assemble(&files, Lang::Jass).unwrap();
        let back = wtg::parse(&wtg_bytes, &TriggerData::parse("")).unwrap();
        let new = back.items.iter().find_map(|i| if let Item::Trigger(t) = i { (t.name == "New").then_some(t.id) } else { None }).unwrap();
        assert_eq!(new, (3 << 24) | 3);
        assert_eq!(back.counts[3].count, 4);
        assert_eq!((back.counts[2].count, &back.counts[3].deleted), (18, &vec![9, 2, 5]));
    }

    /// Two categories with one id (Forsaken07Interlude): the tree comes from the order, and pack writes them back.
    #[test]
    fn duplicate_category_ids_are_kept() {
        let items = vec![cat(1, "M.w3x", 0, -1), cat(4, "Initialization", 0x200_0003, 0), trigger(8, "A", false, 3 << 24, 0x200_0003), cat(4, "MapEvents", 0x200_0003, 0), trigger(8, "B", false, (3 << 24) | 1, 0x200_0003)];
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 4, 2]), unknown: 2, variables: Vec::new(), items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: vec![None, None] };
        let files = round_trip(&tf, &w, Lang::Jass);
        assert!(files.contains_key("triggers/Initialization/A.gui.json") && files.contains_key("triggers/MapEvents/B.gui.json"));
    }

    fn classic() -> (TriggerFile, Wct) {
        let items = vec![cat(4, "Init", 5, -1), cat(4, "Other", 7, -1), trigger(8, "Melee", false, 0, 5), trigger(8, "Custom", true, 1, 7)];
        let variables = vec![var("b", 0, -1), var("a", 1, -1)];
        let tf = TriggerFile { reforged: false, version: 7, counts: Vec::new(), unknown: 2, variables, items };
        let w = Wct { reforged: false, version: 1, comment: String::new(), header: Some(Some("h\n".into())), texts: vec![None, Some("function InitTrig_Custom takes nothing returns nothing\nendfunction\n".into())] };
        (tf, w)
    }

    #[test]
    fn classic_maps_have_no_root_ids_or_nesting_and_refuse_what_they_cant_hold() {
        let (tf, w) = classic();
        let files = round_trip(&tf, &w, Lang::Jass);
        let root = text(&files, "triggers/triggers.json");
        assert!(!root.contains("\"root\"") && !root.contains("counts"), "{root}");
        assert_eq!(text(&files, "triggers/Init/_category.json"), "{\"type\":4,\"id\":5,\"name\":\"Init\",\"isComment\":0}\n");
        assert!(!text(&files, "triggers/Init/Melee.gui.json").contains("\"id\""));
        assert!(!text(&files, "triggers/variables.json").contains("\"id\""));
        assert!(!text(&files, "triggers/triggers.json").contains("variableOrder"));
        // A version 4 file too.
        let mut v4 = tf.clone();
        v4.version = 4;
        round_trip(&v4, &w, Lang::Jass);
        for (path, body, why) in [
            ("triggers/Init/Sub/_category.json", "{\"name\":\"Sub\"}", "a folder inside a folder"),
            ("triggers/Init/C.comment.json", "{\"name\":\"C\"}", "is a comment"),
            ("triggers/Init/S.j", "// @w3proj {\"type\":32,\"name\":\"S\"}\n", "is a script item"),
            ("triggers/Root.gui.json", "{\"name\":\"R\"}", "outside every category"),
            ("triggers/Lib/_category.json", "{\"type\":2,\"name\":\"Lib\"}", "library folder"),
        ] {
            let mut f = files.clone();
            f.insert(path.into(), body.as_bytes().to_vec());
            let e = assemble(&f, Lang::Jass).unwrap_err().to_string();
            assert!(e.contains(why) && e.contains("Classic"), "{path}: {e}");
        }
        // A variable node ($ in order.txt) can't be either.
        let mut f = files.clone();
        f.insert("triggers/order.txt".into(), b"Init\nOther\n$a\n".to_vec());
        assert!(assemble(&f, Lang::Jass).unwrap_err().to_string().contains("places a variable in the tree"));
        // A script file without frontmatter is a custom-text trigger in a Classic map.
        let mut f = files.clone();
        f.insert("triggers/Init/Plain.j".into(), b"// code\n".to_vec());
        let (tree, _) = from_files(&f).unwrap();
        assert!(tree.nodes.iter().any(|n| matches!(&n.kind, Kind::Trigger { t, .. } if t.name == "Plain" && t.ty == 8 && t.is_custom)));
        assemble(&f, Lang::Jass).unwrap();
    }

    #[test]
    fn variable_order_is_kept_when_it_isnt_the_trees_and_dropped_when_it_no_longer_fits() {
        let items = vec![cat(1, "M.w3x", 0, -1), cat(4, "F", 2 << 24, 0), Item::Element(Element { ty: 64, id: 6 << 24, name: "a".into(), parent: 2 << 24 }), Item::Element(Element { ty: 64, id: (6 << 24) | 1, name: "b".into(), parent: 0 })];
        let variables = vec![var("b", (6 << 24) | 1, 0), var("a", 6 << 24, 2 << 24)];
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 1, 0, 0, 0, 2]), unknown: 2, variables, items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: Vec::new() };
        let files = round_trip(&tf, &w, Lang::Jass);
        assert!(text(&files, "triggers/triggers.json").contains("\"variableOrder\": [\n    \"b\",\n    \"a\"\n  ]"));
        assert_eq!(text(&files, "triggers/F/order.txt"), "$a\n");
        // A variable added by hand: the order no longer lists them all, so the tree's order is used, with a warning.
        let mut f = files.clone();
        let mut root_vars = text(&f, "triggers/variables.json");
        root_vars.push_str("{\"name\":\"c\",\"type\":\"real\"}\n");
        f.insert("triggers/variables.json".into(), root_vars.into_bytes());
        let (wtg_bytes, _, warnings) = assemble(&f, Lang::Jass).unwrap();
        assert!(warnings.iter().any(|w| w.contains("variableOrder")), "{warnings:?}");
        let back = wtg::parse(&wtg_bytes, &TriggerData::parse("")).unwrap();
        assert_eq!(back.variables.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        // Defined twice: alike is a warning, otherwise an error.
        let mut f = files.clone();
        let line = String::from_utf8(f["triggers/variables.json"].clone()).unwrap();
        f.insert("triggers/F/variables.json".into(), format!("{}{line}", text(&files, "triggers/F/variables.json")).into_bytes());
        let (_, _, warnings) = assemble(&f, Lang::Jass).unwrap();
        assert!(warnings.iter().any(|w| w.contains("also defined")), "{warnings:?}");
        f.insert("triggers/F/variables.json".into(), line.replace("integer", "real").into_bytes());
        assert!(assemble(&f, Lang::Jass).unwrap_err().to_string().contains("differently"));
    }

    /// A Reforged variable with no node in the tree (its own parent kept) goes into the root's variables.json, marked.
    #[test]
    fn variables_without_a_node_come_back() {
        let items = vec![cat(1, "M.w3x", 0, -1), cat(4, "F", 2 << 24, 0)];
        let variables = vec![var("loose", 6 << 24, -1), var("parented", (6 << 24) | 1, 2 << 24)];
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 1, 0, 0, 0, 2]), unknown: 2, variables, items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: Vec::new() };
        let files = round_trip(&tf, &w, Lang::Jass);
        let vars = text(&files, "triggers/variables.json");
        assert!(vars.contains("\"name\":\"loose\"") && vars.contains("\"node\":false") && vars.contains("\"parent\":33554432"), "{vars}");
        assert!(!text(&files, "triggers/order.txt").contains('$'));
    }

    /// The strings the map refers to (`TRIGSTR_…`) are found in the trigger files, so pack's pruning keeps them.
    #[test]
    fn string_references_in_trigger_files_are_found() {
        let mut files = minimal();
        files.insert("triggers/G.gui.json".into(), b"{\"name\":\"TRIGSTR_012\"}".to_vec());
        files.insert("triggers/L.vjass".into(), b"// @w3proj {\"type\":32,\"name\":\"L\"}\ncall BJDebugMsg(\"TRIGSTR_013\")\n".to_vec());
        let refs = crate::wts::map_string_refs(&files, &Registry::default()).unwrap();
        assert!(refs.contains(&crate::wts::StringNum::from_u64(12)) && refs.contains(&crate::wts::StringNum::from_u64(13)), "{refs:?}");
    }

    #[test]
    fn no_text_and_empty_text_are_told_apart_by_the_file() {
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1]), unknown: 2, variables: Vec::new(), items: vec![cat(1, "M.w3x", 0, -1)] };
        let none = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: Vec::new() };
        let empty = Wct { header: Some(Some(String::new())), ..none.clone() };
        assert!(!round_trip(&tf, &none, Lang::Lua).contains_key("triggers/header.lua"));
        assert_eq!(round_trip(&tf, &empty, Lang::Lua)["triggers/header.lua"], b"");
    }

    #[test]
    fn a_file_of_the_other_language_is_an_error() {
        let mut files = minimal();
        files.insert("triggers/S.lua".into(), b"-- @w3proj {\"type\":32,\"name\":\"S\"}\nx = 1\n".to_vec());
        let e = assemble(&files, Lang::Jass).unwrap_err().to_string();
        assert!(e.contains("map/triggers/S.lua:1: a Lua file in a JASS map"), "{e}");
        assemble(&files, Lang::Lua).unwrap();
        let mut files = minimal();
        files.insert("triggers/header.j".into(), b"// h\n".to_vec());
        assert!(assemble(&files, Lang::Lua).unwrap_err().to_string().contains("header.j:1: a JASS file in a Lua map"));
    }

    #[test]
    fn a_newer_format_and_unknown_files_are_refused() {
        let mut files = minimal();
        let root = text(&files, ROOT_FILE).replace("w3proj.triggers/1", "w3proj.triggers/2");
        files.insert(ROOT_FILE.into(), root.into_bytes());
        assert!(from_files(&files).unwrap_err().to_string().contains("newer W3Proj Studio"));
        let mut files = minimal();
        files.insert("triggers/notes.txt".into(), b"x".to_vec());
        assert!(from_files(&files).unwrap_err().to_string().contains("notes.txt isn't a file of the trigger layout"));
    }

    #[test]
    fn what_the_layout_cant_hold_is_refused_at_unpack() {
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: vec![None] };
        // A parent that isn't the folder before it.
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1]), unknown: 2, variables: Vec::new(), items: vec![cat(1, "M", 0, -1), trigger(8, "T", false, 3 << 24, 77)] };
        assert!(from_binary(&tf, &w).unwrap_err().to_string().contains("isn't in a folder before it"));
        // More texts than triggers.
        let tf = TriggerFile { items: vec![cat(1, "M", 0, -1)], ..tf };
        assert!(from_binary(&tf, &w).unwrap_err().to_string().contains("1 texts for 0 triggers"));
    }

    #[test]
    fn existing_items_keep_their_file_names() {
        let items = vec![cat(1, "M.w3x", 0, -1), trigger(16, "---", false, 4 << 24, 0), trigger(16, "---", false, (4 << 24) | 1, 0), trigger(16, "---", false, (4 << 24) | 2, 0)];
        let tf = TriggerFile { reforged: true, version: 7, counts: counts(&[1, 0, 0, 0, 3]), unknown: 2, variables: Vec::new(), items };
        let w = Wct { reforged: true, version: 1, comment: String::new(), header: Some(None), texts: Vec::new() };
        let files = round_trip(&tf, &w, Lang::Jass);
        assert_eq!(text(&files, "triggers/order.txt"), "comment.comment.json\ncomment~2.comment.json\ncomment~3.comment.json\n");
        let (old, _) = from_files(&files).unwrap();
        // The first one deleted: the others keep comment~2 and comment~3.
        let mut tf2 = tf.clone();
        tf2.items.remove(1);
        let tree = from_binary(&tf2, &w).unwrap();
        let again = to_files(&tree, Lang::Jass, Some(&old)).unwrap();
        assert_eq!(text(&again, "triggers/order.txt"), "comment~2.comment.json\ncomment~3.comment.json\n");
        // Control: without the files on disk they would be renumbered.
        assert_eq!(text(&to_files(&tree, Lang::Jass, None).unwrap(), "triggers/order.txt"), "comment.comment.json\ncomment~2.comment.json\n");
    }
}
