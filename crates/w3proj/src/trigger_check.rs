//! Check Trigger Tree: what the files of `map/triggers/` (`crate::trigger_layout`) can get wrong that one file per
//! trigger doesn't stop, mostly after a Git merge: disjoint files merge without a textual conflict, not without a
//! semantic one. The Problems view (backend `triggers_check`), `w3proj triggers --check` and pack (`assemble`) run this
//! one check:
//!
//! - errors, which pack refuses: unresolved conflict markers; a file that can't be read (malformed JSON or
//!   frontmatter, an unknown field, a file the layout doesn't know); a variable defined twice differently; names that
//!   differ only in case in one folder (they can't both be checked out on Windows or macOS); a script file in the
//!   other language.
//! - an error pack only tells (`Issue::stops_pack`): two triggers, comments or script items, or two variables, with
//!   the same stored id (a copied file, both sides of a rename/rename merge). Pack writes ids back as they are, as for
//!   any import.
//! - warnings: order.txt entries that name nothing there or come twice, files and folders order.txt doesn't list
//!   (they come after the listed ones, alphabetically), a variable defined twice alike (one is kept), two triggers
//!   whose names give one `gg_trg_` global, a custom-text trigger that defines another's `InitTrig_` but not its own
//!   (the map's data is sound; the generated script is what breaks, and the script checks tell that).
//!
//! Folders' ids are never reported: World Editor maps have categories that share an id (16 campaign maps), and those
//! are kept as imported. Fixes are on request only (`fix`), never on pack: Renumber (the later item of a stored id
//! loses it, and pack gives it a free one), Order (order.txt written as the tree is read), Collapse (the later of two
//! alike definitions goes).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use crate::trigger_layout::{self as tl, Kind, Lang, NoteKind, Tree};
use crate::wtg::Variable;
use crate::{Error, Result};

const PREFIX: &str = "triggers/";
const ORDER: &str = "order.txt";
const VARIABLES: &str = "variables.json";
const CATEGORY: &str = "_category.json";
const HEADERS: [&str; 2] = ["header.j", "header.lua"];

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// A repair that can be asked for.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Fix {
    /// The later item of a stored id found twice loses it (pack gives it a free one).
    Renumber,
    /// order.txt written as the tree is read: listed entries that aren't there go, unlisted ones are added.
    Order,
    /// The later of two alike definitions of a variable goes.
    Collapse,
}

impl Fix {
    pub fn parse(s: &str) -> Option<Fix> {
        match s {
            "renumber" => Some(Fix::Renumber),
            "order" => Some(Fix::Order),
            "collapse" => Some(Fix::Collapse),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Fix::Renumber => "renumber",
            Fix::Order => "order",
            Fix::Collapse => "collapse",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub severity: Severity,
    /// What kind of issue: conflict, malformed, variableConflict, variableTwice, duplicateId, orderMissing, orderTwice,
    /// orderNotVariable, orderUnlisted, variablePlacedTwice, caseCollision, nameCollision, initTrig, language.
    pub code: &'static str,
    /// The file (a project path, `map/triggers/…`).
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
}

impl Issue {
    /// Whether pack refuses it: every error but a stored id found twice, which pack writes back as it is (as an
    /// import's own would be; the World Editor's maps are packed as they were unpacked) and only tells.
    pub fn stops_pack(&self) -> bool {
        self.severity == Severity::Error && self.code != "duplicateId"
    }
}

impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.line {
            Some(l) => write!(f, "{}:{l}: {}", self.file, self.message),
            None => write!(f, "{}: {}", self.file, self.message),
        }
    }
}

fn issue(severity: Severity, code: &'static str, file: &str, line: Option<usize>, message: String, fix: Option<Fix>) -> Issue {
    Issue { severity, code, file: format!("map/{file}"), line, message, fix }
}

/// A reader's error ("map/triggers/<file>[:<line>]: what") as an issue at that file and line; `fallback`: the file
/// when the message names none.
fn located(code: &'static str, e: &Error, fallback: &str) -> Issue {
    let m = e.to_string();
    let parsed = m.strip_prefix("map/").and_then(|rest| {
        let (head, what) = rest.split_once(": ")?;
        let (file, line) = match head.rsplit_once(':') {
            Some((f, n)) if n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty() => (f, n.parse().ok()),
            _ => (head, None),
        };
        file.starts_with(PREFIX).then(|| (file.to_string(), line, what.to_string()))
    });
    match parsed {
        Some((file, line, what)) => issue(Severity::Error, code, &file, line, what, None),
        None => {
            // A message whose file has a space after a colon in it, or names none: as it is.
            let what = m.strip_prefix(&format!("map/{fallback}: ")).or_else(|| m.strip_prefix(&format!("map/{fallback} "))).map(str::to_string).unwrap_or(m);
            issue(Severity::Error, code, fallback, None, what, None)
        }
    }
}

/// The line (from 1) of a file's first unresolved conflict and how many there are: `<<<<<<<` opening a block that a
/// later `>>>>>>>` closes, each at the start of a line as Git writes them.
fn conflicts(bytes: &[u8]) -> Option<(usize, usize)> {
    let text = String::from_utf8_lossy(bytes);
    let marker = |l: &str, m: &str| l.strip_prefix(m).is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '\t', '\r']));
    let (mut first, mut count, mut open) = (None, 0, None);
    for (n, l) in text.split('\n').enumerate() {
        if marker(l, "<<<<<<<") {
            open = Some(n + 1);
        } else if marker(l, ">>>>>>>") {
            if let Some(at) = open.take() {
                first.get_or_insert(at);
                count += 1;
            }
        }
    }
    first.map(|f| (f, count))
}

/// The script identifier of a name (`gg_trg_<it>`, `InitTrig_<it>`), as the app's generator makes it
/// (app/src/lib/script/names.ts `ident`): trailing white space dropped, every byte of the UTF-8 text that isn't a
/// letter, digit or `_` becomes `_`, and a trailing `_` gets a `u` after it.
pub fn ident(name: &str) -> String {
    let mut s: String = name.trim_end().bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'_' { b as char } else { '_' }).collect();
    if s.ends_with('_') {
        s.push('u');
    }
    s
}

/// The `InitTrig_` names a text defines (`function InitTrig_X takes …` in JASS, `function InitTrig_X(` in Lua).
fn init_trigs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for l in text.lines() {
        let t = l.trim_start();
        let Some(rest) = t.strip_prefix("function") else { continue };
        let rest = rest.trim_start_matches([' ', '\t']);
        if rest.len() == t.len() - "function".len() {
            continue;
        }
        if let Some(name) = rest.strip_prefix("InitTrig_") {
            let id: String = name.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if !id.is_empty() {
                out.push(id);
            }
        }
    }
    out
}

/// One definition of a variable, as read from a variables.json line.
struct Def {
    var: Variable,
    file: String,
    line: usize,
}

/// The issues of the layout in `files` (keys relative to `map/`; others aren't looked at). `lang`: the map's script
/// language (a script file of the other one is an error); None: not checked. Nothing without `map/triggers/`.
pub fn check(files: &BTreeMap<String, Vec<u8>>, lang: Option<Lang>) -> Vec<Issue> {
    let ours: BTreeMap<&str, &[u8]> = files.iter().filter(|(k, _)| k.starts_with(PREFIX)).map(|(k, v)| (k.as_str(), v.as_slice())).collect();
    let mut out = Vec::new();
    if ours.is_empty() {
        return out;
    }
    case_collisions(&ours, &mut out);
    // Unresolved conflicts first: such a file can't be read, and that error would only repeat it.
    let mut conflicted: BTreeSet<&str> = BTreeSet::new();
    for (path, bytes) in &ours {
        if let Some((line, n)) = conflicts(bytes) {
            conflicted.insert(path);
            let more = if n > 1 { format!(" (and {} more)", n - 1) } else { String::new() };
            out.push(issue(Severity::Error, "conflict", path, Some(line), format!("an unresolved merge conflict{more}: resolve it (keep one side, remove the <<<<<<< ======= >>>>>>> lines)"), None));
        }
    }
    let Some(root) = ours.get(tl::ROOT_FILE) else {
        out.push(issue(Severity::Error, "malformed", tl::ROOT_FILE, None, format!("is missing, so the files in map/{}/ can't be read as triggers", tl::DIR), None));
        return out;
    };
    // The root file alone tells whether it can be read, and whether the tree is Classic.
    let mut classic = false;
    if !conflicted.contains(tl::ROOT_FILE) {
        let only: BTreeMap<String, Vec<u8>> = [(tl::ROOT_FILE.to_string(), root.to_vec())].into();
        match tl::from_files(&only) {
            Ok((t, _)) => classic = !t.reforged,
            Err(e) => out.push(located("malformed", &e, tl::ROOT_FILE)),
        }
    }
    // Every other file on its own, so that all of them are told, not the first.
    let mut defs: Vec<Def> = Vec::new();
    for (path, bytes) in &ours {
        if conflicted.contains(path) || *path == tl::ROOT_FILE {
            continue;
        }
        let rel = &path[PREFIX.len()..];
        let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
        if name == ORDER || (dir.is_empty() && HEADERS.contains(&name)) {
            continue;
        }
        if name == VARIABLES {
            let Ok(text) = std::str::from_utf8(bytes) else {
                out.push(issue(Severity::Error, "malformed", path, None, "isn't UTF-8 text".into(), None));
                continue;
            };
            for (ln, l) in text.split('\n').enumerate() {
                let l = l.strip_suffix('\r').unwrap_or(l);
                if l.trim().is_empty() {
                    continue;
                }
                match tl::parse_variable_line(l, &format!("map/{path}:{}", ln + 1), classic) {
                    Ok((var, _, _)) => defs.push(Def { var, file: path.to_string(), line: ln + 1 }),
                    Err(e) => out.push(located("malformed", &e, path)),
                }
            }
            continue;
        }
        if !dir.is_empty() && name == CATEGORY {
            if let Err(e) = tl::parse_category(bytes, &format!("map/{path}")) {
                out.push(located("malformed", &e, path));
            }
            continue;
        }
        if let Err(e) = tl::read_item(rel, bytes, classic) {
            out.push(located("malformed", &e, path));
        }
    }
    // A variable defined twice differently: the tree can't be read (which one?). The root's definitions count as the
    // first, as the tree reads them first.
    defs.sort_by(|a, b| (a.file != format!("{PREFIX}{VARIABLES}"), &a.file, a.line).cmp(&(b.file != format!("{PREFIX}{VARIABLES}"), &b.file, b.line)));
    let mut by_name: BTreeMap<&str, Vec<&Def>> = BTreeMap::new();
    for d in &defs {
        by_name.entry(d.var.name.as_str()).or_default().push(d);
    }
    for (name, list) in &by_name {
        let Some(first) = list.first() else { continue };
        for d in &list[1..] {
            if !tl::same_variable(&first.var, &d.var) {
                let how = describe(&first.var, &d.var);
                out.push(issue(Severity::Error, "variableConflict", &d.file, Some(d.line), format!("the variable {name} is also defined in map/{}:{}, differently ({how}): keep one definition", first.file, first.line), None));
            }
        }
    }
    if out.iter().any(|i| i.severity == Severity::Error) {
        return out;
    }
    let (tree, notes) = match tl::from_files_noted(files) {
        Ok(t) => t,
        Err(e) => {
            out.push(located("malformed", &e, tl::ROOT_FILE));
            return out;
        }
    };
    for n in &notes {
        let (code, fix) = match n.kind {
            NoteKind::OrderMissing => ("orderMissing", Fix::Order),
            NoteKind::OrderTwice => ("orderTwice", Fix::Order),
            NoteKind::OrderNotVariable => ("orderNotVariable", Fix::Order),
            NoteKind::VariablePlacedTwice => ("variablePlacedTwice", Fix::Order),
            NoteKind::VariableTwice => ("variableTwice", Fix::Collapse),
        };
        out.push(issue(Severity::Warning, code, &n.file, n.line, n.message.clone(), Some(fix)));
    }
    unlisted(files, &tree, lang.unwrap_or_else(|| tree.lang_hint()), &mut out);
    duplicate_ids(&tree, &defs, &mut out);
    names(&tree, &mut out);
    if let Some(lang) = lang {
        language(&tree, lang, &mut out);
    }
    out
}

/// How two definitions of a variable differ.
fn describe(a: &Variable, b: &Variable) -> String {
    let mut d = Vec::new();
    if a.ty != b.ty {
        d.push(format!("type {} / {}", a.ty, b.ty));
    }
    if a.is_array != b.is_array || a.array_size != b.array_size {
        let arr = |v: &Variable| if v.is_array { format!("array of {}", v.array_size) } else { "no array".into() };
        d.push(format!("{} / {}", arr(a), arr(b)));
    }
    if a.initialized != b.initialized || a.initial_value != b.initial_value {
        let init = |v: &Variable| if v.initialized { format!("{:?}", v.initial_value) } else { "no initial value".into() };
        d.push(format!("initial value {} / {}", init(a), init(b)));
    }
    d.join(", ")
}

/// Names in one folder that are the same but for case: on Windows and macOS only one of them can be checked out.
fn case_collisions(ours: &BTreeMap<&str, &[u8]>, out: &mut Vec<Issue>) {
    let mut children: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in ours.keys() {
        let parts: Vec<&str> = path.split('/').collect();
        for d in 1..parts.len() {
            children.entry(parts[..d].join("/")).or_default().insert(parts[d].to_string());
        }
    }
    for (dir, names) in &children {
        let mut seen: HashMap<String, &String> = HashMap::new();
        for n in names {
            if let Some(first) = seen.get(&n.to_lowercase()) {
                out.push(issue(
                    Severity::Error,
                    "caseCollision",
                    &format!("{dir}/{n}"),
                    None,
                    format!("differs from {dir}/{first} only in case: Windows and macOS check out one of them; rename one"),
                    None,
                ));
            } else {
                seen.insert(n.to_lowercase(), n);
            }
        }
    }
}

/// Files and folders a folder's order.txt doesn't list (it comes after the listed ones, alphabetically). A folder
/// without an order.txt is in alphabetical order on purpose.
fn unlisted(files: &BTreeMap<String, Vec<u8>>, tree: &Tree, lang: Lang, out: &mut Vec<Issue>) {
    let Ok(canon) = tl::to_files(tree, lang, Some(tree)) else { return };
    for (path, bytes) in &canon {
        if !path.ends_with(ORDER) || path.rsplit('/').next() != Some(ORDER) {
            continue;
        }
        let Some(disk) = files.get(path) else { continue };
        let listed: BTreeSet<&str> = std::str::from_utf8(disk).unwrap_or("").split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
        for entry in String::from_utf8_lossy(bytes).split('\n').filter(|l| !l.is_empty()) {
            if !listed.contains(entry) {
                out.push(issue(Severity::Warning, "orderUnlisted", path, None, format!("{entry} isn't listed, so it comes after the listed entries (alphabetically)"), Some(Fix::Order)));
            }
        }
    }
}

/// The nodes and variables that hold a stored id an earlier one holds too (triggers, comments and script items share
/// one set, variables another; folders aren't looked at), in tree order: (node index or None, variable index or None).
fn later_duplicates(tree: &Tree) -> (Vec<usize>, Vec<usize>) {
    let mut nodes = Vec::new();
    let mut seen: HashMap<u32, usize> = HashMap::new();
    for (i, n) in tree.nodes.iter().enumerate() {
        if let (Kind::Trigger { .. }, Some(id)) = (&n.kind, n.id) {
            if seen.insert(id, i).is_some() {
                nodes.push(i);
            }
        }
    }
    let mut vars = Vec::new();
    if tree.reforged {
        let mut seen: HashMap<u32, usize> = HashMap::new();
        for (k, v) in tree.vars.iter().enumerate() {
            if let Some(id) = v.id {
                if seen.insert(id, k).is_some() {
                    vars.push(k);
                }
            }
        }
    }
    (nodes, vars)
}

fn node_name(tree: &Tree, i: usize) -> String {
    match &tree.nodes[i].kind {
        Kind::Folder { name, .. } | Kind::Var { name } => name.clone(),
        Kind::Trigger { t, .. } => t.name.clone(),
    }
}

fn duplicate_ids(tree: &Tree, defs: &[Def], out: &mut Vec<Issue>) {
    let (nodes, vars) = later_duplicates(tree);
    let first_with = |id: u32, before: usize| tree.nodes[..before].iter().position(|n| matches!(n.kind, Kind::Trigger { .. }) && n.id == Some(id));
    for i in nodes {
        let n = &tree.nodes[i];
        let id = n.id.unwrap_or(0);
        let file = format!("{PREFIX}{}", n.file.as_deref().unwrap_or(""));
        let other = first_with(id, i).map(|j| format!("map/{PREFIX}{}", tree.nodes[j].file.as_deref().unwrap_or(""))).unwrap_or_default();
        let line = matches!(&n.kind, Kind::Trigger { t, .. } if tl::is_script(t)).then_some(1);
        out.push(issue(
            Severity::Error,
            "duplicateId",
            &file,
            line,
            format!("\"{}\" has the id {id:#x}, as {other} has: two items can't share one (a copied file, or both sides of a merge); Renumber gives this one a new id on pack", node_name(tree, i)),
            Some(Fix::Renumber),
        ));
    }
    for k in vars {
        let v = &tree.vars[k];
        let id = v.id.unwrap_or(0);
        let at = |name: &str| defs.iter().find(|d| d.var.name == name);
        let (file, line) = at(&v.v.name).map_or((format!("{PREFIX}{VARIABLES}"), None), |d| (d.file.clone(), Some(d.line)));
        let other = tree.vars[..k].iter().find(|o| o.id == Some(id)).map(|o| o.v.name.clone()).unwrap_or_default();
        out.push(issue(
            Severity::Error,
            "duplicateId",
            &file,
            line,
            format!("the variable {} has the id {id:#x}, as the variable {other} has; Renumber gives it a new id on pack", v.v.name),
            Some(Fix::Renumber),
        ));
    }
}

/// Two triggers whose names give one `gg_trg_` global; a custom-text trigger that defines another's `InitTrig_` and
/// not its own (the map script calls `InitTrig_<its name>`).
fn names(tree: &Tree, out: &mut Vec<Issue>) {
    let mut globals: HashMap<String, usize> = HashMap::new();
    for (i, n) in tree.nodes.iter().enumerate() {
        let Kind::Trigger { t, text } = &n.kind else { continue };
        if t.ty != 8 {
            continue;
        }
        let file = format!("{PREFIX}{}", n.file.as_deref().unwrap_or(""));
        let id = ident(&t.name);
        // Only triggers the script makes code for clash (a second InitTrig_ function); World Editor maps have rows of
        // disabled "-----" separators that all give one name.
        let clashes = t.enabled && t.is_comment == 0 && t.name.chars().any(char::is_alphanumeric);
        match globals.get(&id) {
            _ if !clashes => {}
            Some(&j) => {
                let other = tree.nodes[j].file.as_deref().unwrap_or("");
                out.push(issue(
                    Severity::Warning,
                    "nameCollision",
                    &file,
                    None,
                    format!("\"{}\" and \"{}\" (map/{PREFIX}{other}) are both the trigger gg_trg_{id} in the map script: rename one", t.name, node_name(tree, j)),
                    None,
                ));
            }
            None => {
                globals.insert(id.clone(), i);
            }
        }
        if t.is_custom && t.enabled {
            if let Some(text) = text {
                let defined = init_trigs(text);
                if !defined.is_empty() && !defined.contains(&id) {
                    out.push(issue(
                        Severity::Warning,
                        "initTrig",
                        &file,
                        None,
                        format!("\"{}\" defines InitTrig_{} but not InitTrig_{id}, which the map script calls for it (renamed on one side of a merge?)", t.name, defined[0]),
                        None,
                    ));
                }
            }
        }
    }
}

fn language(tree: &Tree, lang: Lang, out: &mut Vec<Issue>) {
    let files = tree.header_file.iter().chain(tree.nodes.iter().filter(|n| matches!(&n.kind, Kind::Trigger { t, .. } if tl::is_script(t))).filter_map(|n| n.file.as_ref()));
    for f in files {
        if Lang::of_file(f).is_some_and(|l| l != lang) {
            let (other, want) = match lang {
                Lang::Jass => ("Lua", "JASS (.j)"),
                Lang::Lua => ("JASS", "Lua (.lua)"),
            };
            out.push(issue(
                Severity::Error,
                "language",
                &format!("{PREFIX}{f}"),
                Some(1),
                format!("a {other} file in a {} map (war3map.w3i scriptType): custom texts aren't translated; rewrite it in {want}", if lang == Lang::Lua { "Lua" } else { "JASS" }),
                None,
            ));
        }
    }
}

/// The files `fixes` change (keys relative to `map/`; None: the file goes), from the layout in `files`. Only what the
/// fixes are about changes; an item's file is written as the layout writes it. Errs when the tree can't be read.
pub fn fix(files: &BTreeMap<String, Vec<u8>>, lang: Lang, fixes: &[Fix]) -> Result<BTreeMap<String, Option<Vec<u8>>>> {
    let (tree, _) = tl::from_files_noted(files).map_err(|e| Error::Format(format!("the trigger tree can't be read, so nothing can be fixed: {e}")))?;
    let issues = check(files, Some(lang));
    let mut changed: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    let canon = tl::to_files(&tree, lang, Some(&tree))?;
    let mut fixed = tree.clone();
    if fixes.contains(&Fix::Renumber) {
        let (nodes, vars) = later_duplicates(&tree);
        for i in nodes {
            fixed.nodes[i].id = None;
        }
        for k in vars {
            fixed.vars[k].id = None;
            let name = fixed.vars[k].v.name.clone();
            for n in &mut fixed.nodes {
                if matches!(&n.kind, Kind::Var { name: v } if *v == name) {
                    n.id = None;
                }
            }
        }
        // The fixed tree keeps its own files' names (an item's name and id find its file).
        let after = tl::to_files(&fixed, lang, Some(&fixed))?;
        for (path, bytes) in &after {
            if canon.get(path) != Some(bytes) {
                changed.insert(path.clone(), Some(bytes.clone()));
            }
        }
    }
    let after = tl::to_files(&fixed, lang, Some(&fixed))?;
    let rewrite = |path: &str, changed: &mut BTreeMap<String, Option<Vec<u8>>>| {
        let want = after.get(path).cloned();
        if files.get(path) != want.as_ref() {
            changed.insert(path.to_string(), want);
        }
    };
    let rel = |i: &Issue| i.file.strip_prefix("map/").unwrap_or(&i.file).to_string();
    for i in &issues {
        let Some(f) = i.fix.filter(|f| fixes.contains(f)) else { continue };
        match f {
            Fix::Order => rewrite(&rel(i), &mut changed),
            Fix::Collapse => {
                let path = rel(i);
                rewrite(&path, &mut changed);
                // Its folder's order.txt may place the variable a second time.
                let order = match path.rsplit_once('/') {
                    Some((dir, _)) => format!("{dir}/{ORDER}"),
                    None => ORDER.to_string(),
                };
                rewrite(&order, &mut changed);
            }
            Fix::Renumber => {}
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> BTreeMap<String, Vec<u8>> {
        tl::read_disk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/trigger-folders/map")).unwrap()
    }

    fn codes(issues: &[Issue]) -> Vec<&'static str> {
        issues.iter().map(|i| i.code).collect()
    }

    fn set(f: &mut BTreeMap<String, Vec<u8>>, path: &str, text: &str) {
        f.insert(path.to_string(), text.as_bytes().to_vec());
    }

    fn text(f: &BTreeMap<String, Vec<u8>>, path: &str) -> String {
        String::from_utf8(f[path].clone()).unwrap()
    }

    /// The files with the fix's changes in them.
    fn applied(f: &BTreeMap<String, Vec<u8>>, changes: &BTreeMap<String, Option<Vec<u8>>>) -> BTreeMap<String, Vec<u8>> {
        let mut out = f.clone();
        for (p, b) in changes {
            match b {
                Some(b) => out.insert(p.clone(), b.clone()),
                None => out.remove(p),
            };
        }
        out
    }

    #[test]
    fn the_fixtures_have_nothing_to_report() {
        assert_eq!(check(&fixture(), Some(Lang::Jass)), Vec::new());
        let mini = tl::read_disk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map/map")).unwrap();
        assert_eq!(check(&mini, Some(Lang::Jass)), Vec::new());
        assert!(check(&BTreeMap::new(), Some(Lang::Jass)).is_empty(), "no layout, nothing to check");
    }

    /// The fixture's categories share an id (as World Editor maps' do): kept, not reported. Two triggers that share one
    /// (a file copied, both sides of a rename merged) are; Renumber takes the later one's id, the earlier keeps it.
    #[test]
    fn shared_ids_folders_kept_items_reported_and_renumbered() {
        let mut f = fixture();
        let cat = |f: &BTreeMap<String, Vec<u8>>, d: &str| text(f, &format!("triggers/{d}/_category.json"));
        let id_of = |s: &str| s.split("\"id\":").nth(1).unwrap().split([',', '}']).next().unwrap().trim().to_string();
        let init_id = id_of(&cat(&f, "Initialization"));
        let sys = cat(&f, "Systems");
        set(&mut f, "triggers/Systems/_category.json", &sys.replace(&format!("\"id\":{}", id_of(&sys)), &format!("\"id\":{init_id}")));
        assert_eq!(check(&f, Some(Lang::Jass)), Vec::new(), "folders sharing an id are the import's");
        // The GUI trigger copied into Systems under another file name.
        let gui = text(&f, "triggers/Initialization/Melee_Initialization.gui.json");
        assert!(gui.contains("\"id\""), "the fixture's trigger has an id: {gui}");
        set(&mut f, "triggers/Systems/Melee_Copy.gui.json", &gui);
        let issues = check(&f, Some(Lang::Jass));
        assert_eq!(codes(&issues), ["orderUnlisted", "duplicateId", "nameCollision"], "{issues:#?}");
        let dup = &issues[1];
        assert_eq!((dup.severity, dup.file.as_str(), dup.fix), (Severity::Error, "map/triggers/Systems/Melee_Copy.gui.json", Some(Fix::Renumber)));
        assert!(dup.message.contains("map/triggers/Initialization/Melee_Initialization.gui.json"), "{}", dup.message);
        let changes = fix(&f, Lang::Jass, &[Fix::Renumber]).unwrap();
        assert_eq!(changes.keys().collect::<Vec<_>>(), ["triggers/Systems/Melee_Copy.gui.json"], "only the later one is written");
        let after = applied(&f, &changes);
        assert!(!text(&after, "triggers/Systems/Melee_Copy.gui.json").contains("\"id\""));
        assert_eq!(text(&after, "triggers/Initialization/Melee_Initialization.gui.json"), gui, "the first keeps its id and its bytes");
        assert!(!codes(&check(&after, Some(Lang::Jass))).contains(&"duplicateId"));
        // A variable's id twice: reported at its line.
        let mut f = fixture();
        let vars = text(&f, "triggers/variables.json");
        let first = vars.lines().next().unwrap();
        let vid = id_of(first);
        let copy = first.replacen(&format!("\"name\":\"{}\"", first.split("\"name\":\"").nth(1).unwrap().split('"').next().unwrap()), "\"name\":\"Copied\"", 1);
        assert!(copy.contains(&format!("\"id\":{vid}")) && copy.contains("Copied"), "{copy}");
        set(&mut f, "triggers/variables.json", &format!("{vars}{copy}\n"));
        let issues = check(&f, Some(Lang::Jass));
        let dup = issues.iter().find(|i| i.code == "duplicateId").unwrap_or_else(|| panic!("{issues:#?}"));
        assert_eq!((dup.file.as_str(), dup.line), ("map/triggers/variables.json", Some(vars.lines().count() + 1)));
        let after = applied(&f, &fix(&f, Lang::Jass, &[Fix::Renumber]).unwrap());
        assert!(!codes(&check(&after, Some(Lang::Jass))).contains(&"duplicateId"), "{:?}", check(&after, Some(Lang::Jass)));
    }

    /// Two variables.json defining one name: alike is a warning that Collapse takes back to one; different is an error
    /// naming both places, and nothing can be fixed then.
    #[test]
    fn variables_defined_twice() {
        let mut f = fixture();
        let vars = text(&f, "triggers/variables.json");
        let line = vars.lines().next().unwrap().to_string();
        let init = text(&f, "triggers/Initialization/variables.json");
        set(&mut f, "triggers/Initialization/variables.json", &format!("{init}{line}\n"));
        let issues = check(&f, Some(Lang::Jass));
        assert!(issues.iter().all(|i| i.severity == Severity::Warning), "{issues:#?}");
        let twice = issues.iter().find(|i| i.code == "variableTwice").unwrap_or_else(|| panic!("{issues:#?}"));
        assert_eq!(twice.fix, Some(Fix::Collapse));
        let changes = fix(&f, Lang::Jass, &[Fix::Collapse]).unwrap();
        assert!(changes.contains_key(&twice.file["map/".len()..]), "{changes:?}");
        let after = applied(&f, &changes);
        assert_eq!(check(&after, Some(Lang::Jass)), Vec::new());
        assert_eq!(text(&after, "triggers/variables.json"), vars, "the first definition stays as it was");
        // Different: an error at the second line, and the tree can't be read.
        let mut f = fixture();
        let other = line.replacen("\"type\":\"", "\"type\":\"x", 1);
        assert_ne!(other, line);
        set(&mut f, "triggers/Initialization/variables.json", &format!("{init}{other}\n"));
        let issues = check(&f, Some(Lang::Jass));
        assert_eq!(codes(&issues), ["variableConflict"], "{issues:#?}");
        assert!(issues[0].message.contains("differently") && issues[0].message.contains("map/triggers/") && issues[0].message.contains("type"), "{}", issues[0].message);
        assert!(fix(&f, Lang::Jass, &[Fix::Collapse]).is_err());
    }

    /// order.txt: an entry whose file is gone and a file it doesn't list are warnings; Order writes the list again.
    #[test]
    fn order_entries_missing_and_unlisted() {
        let mut f = fixture();
        let order = text(&f, "triggers/Systems/order.txt");
        set(&mut f, "triggers/Systems/order.txt", &format!("Gone.gui.json\n{order}"));
        set(&mut f, "triggers/Systems/Dropped_In.j", "function Dropped takes nothing returns nothing\nendfunction\n");
        let issues = check(&f, Some(Lang::Jass));
        assert_eq!(codes(&issues), ["orderMissing", "orderUnlisted"], "{issues:#?}");
        assert_eq!((issues[0].file.as_str(), issues[0].line), ("map/triggers/Systems/order.txt", Some(1)));
        assert!(issues[1].message.starts_with("Dropped_In.j "), "{}", issues[1].message);
        let changes = fix(&f, Lang::Jass, &[Fix::Order]).unwrap();
        assert_eq!(changes.keys().collect::<Vec<_>>(), ["triggers/Systems/order.txt"]);
        let after = applied(&f, &changes);
        assert_eq!(check(&after, Some(Lang::Jass)), Vec::new());
        assert_eq!(text(&after, "triggers/Systems/order.txt"), format!("{order}Dropped_In.j\n"));
        assert!(fix(&f, Lang::Jass, &[Fix::Renumber]).unwrap().is_empty(), "another fix changes nothing here");
    }

    /// Conflict markers are an error at their line (and the file isn't reported again as unreadable); a malformed
    /// frontmatter, an unknown field and a file the layout doesn't know are each told, not only the first.
    #[test]
    fn conflicts_and_unreadable_files_all_told() {
        let mut f = fixture();
        let order = text(&f, "triggers/order.txt");
        set(&mut f, "triggers/order.txt", &format!("<<<<<<< HEAD\n{order}=======\nOther\n>>>>>>> theirs\n"));
        let body = text(&f, "triggers/Systems/Damage_Engine.j");
        set(&mut f, "triggers/Systems/Damage_Engine.j", &body.replacen("// @w3proj {", "// @w3proj {,", 1));
        let cat = text(&f, "triggers/Initialization/_category.json");
        set(&mut f, "triggers/Initialization/_category.json", &cat.replacen("{", "{\"colour\":1,", 1));
        set(&mut f, "triggers/Systems/notes.txt", "x");
        let issues = check(&f, Some(Lang::Jass));
        let mut got: Vec<(&str, &str, Option<usize>)> = issues.iter().map(|i| (i.code, i.file.as_str(), i.line)).collect();
        got.sort();
        assert_eq!(got, [
            ("conflict", "map/triggers/order.txt", Some(1)),
            ("malformed", "map/triggers/Initialization/_category.json", None),
            ("malformed", "map/triggers/Systems/Damage_Engine.j", Some(1)),
            ("malformed", "map/triggers/Systems/notes.txt", None),
        ], "{issues:#?}");
        assert!(issues.iter().all(|i| i.severity == Severity::Error));
        assert!(issues.iter().any(|i| i.message.contains("unknown field \"colour\"")), "{issues:#?}");
        // A lone <<<<<<< in a text (no closing marker) isn't a conflict.
        let mut f = fixture();
        let header = text(&f, "triggers/header.j");
        set(&mut f, "triggers/header.j", &format!("{header}<<<<<<< not one\n"));
        assert_eq!(check(&f, Some(Lang::Jass)), Vec::new());
    }

    /// Names: case-only differences in one folder, two triggers that give one gg_trg_ global, a custom text that
    /// defines another's InitTrig_, a file in the other language.
    #[test]
    fn names_case_inittrig_and_language() {
        let mut f = fixture();
        let body = text(&f, "triggers/Systems/Damage_Engine.j");
        set(&mut f, "triggers/Systems/damage_engine.j", &body);
        let issues = check(&f, Some(Lang::Jass));
        assert!(issues.iter().any(|i| i.code == "caseCollision" && i.severity == Severity::Error), "{issues:#?}");
        let mut f = fixture();
        let setup = text(&f, "triggers/Initialization/Setup_Players.j");
        assert!(setup.contains("InitTrig_Setup_Players"), "{setup}");
        set(&mut f, "triggers/Initialization/Setup_Players.j", &setup.replace("InitTrig_Setup_Players", "InitTrig_Old_Name"));
        let issues = check(&f, Some(Lang::Jass));
        assert_eq!(codes(&issues), ["initTrig"], "{issues:#?}");
        assert!(issues[0].message.contains("InitTrig_Old_Name") && issues[0].message.contains("InitTrig_Setup_Players"));
        assert_eq!(codes(&check(&fixture(), Some(Lang::Lua))).iter().filter(|c| **c == "language").count(), 4, "the header and three script files");
    }

    #[test]
    fn idents_follow_the_generator() {
        assert_eq!(ident("Melee Initialization"), "Melee_Initialization");
        assert_eq!(ident("Spawn! "), "Spawn_u");
        assert_eq!(ident("ä"), "__u");
        assert_eq!(init_trigs("function InitTrig_A takes nothing returns nothing\n  function   InitTrig_B()\nfunctionInitTrig_C\n"), ["A", "B"]);
    }
}
