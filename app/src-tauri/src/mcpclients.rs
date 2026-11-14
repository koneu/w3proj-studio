//! "Try to set up for …": adds this app's MCP server to an AI client's own configuration.
//! The places are where a standard installation keeps it, so this can fail, and it must fail
//! without damage: nothing is written for a client that isn't found or to a file that isn't JSON
//! (comments and trailing commas, as the clients allow, are read, and kept when writing), and the
//! previous file stays next to it as a backup.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::CmdResult;

/// The name of the server in a client's list.
const SERVER: &str = "w3proj";
/// What a backup's name ends in.
const BACKUP: &str = "w3proj-backup";

struct Client {
    id: &'static str,
    name: &'static str,
    /// The configuration file.
    config: PathBuf,
    /// There when the client is installed.
    installed: PathBuf,
    /// Its list of servers: VS Code has its own name for it, and wants the kind in each entry.
    key: &'static str,
    typed: bool,
}

/// The first folder in `dir` whose name starts with `prefix`.
fn folder_starting(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let found = std::fs::read_dir(dir).ok()?.flatten().find(|d| d.file_name().to_string_lossy().starts_with(prefix))?;
    Some(found.path()).filter(|p| p.is_dir())
}

/// Where Claude Desktop keeps its settings. The Microsoft Store version has moved twice: into
/// its package, and from there to Claude-Data, leaving a `.user-data-left` file behind.
fn claude_desktop(appdata: &Path, local: &Path) -> PathBuf {
    if let Some(data) = folder_starting(&local.join("Claude-Data"), "claude_") {
        return data;
    }
    let packaged = folder_starting(&local.join("Packages"), "Claude_").map(|p| p.join("LocalCache").join("Roaming").join("Claude")).filter(|p| {
        let left = std::fs::read_dir(p).map(|d| d.flatten().any(|f| f.file_name().to_string_lossy().starts_with(".user-data-left")));
        p.is_dir() && !left.unwrap_or(false)
    });
    packaged.unwrap_or_else(|| appdata.join("Claude"))
}

fn clients(appdata: &Path, local: &Path, home: &Path) -> Vec<Client> {
    let claude = claude_desktop(appdata, local);
    // Paths join part by part: on Linux a backslash would be part of a file name.
    let code = appdata.join("Code").join("User");
    let mcp_servers = |id, name, config: PathBuf, installed: PathBuf| Client { id, name, config, installed, key: "mcpServers", typed: false };
    vec![
        mcp_servers("claudeDesktop", "Claude Desktop", claude.join("claude_desktop_config.json"), claude),
        mcp_servers("claudeCode", "Claude Code", home.join(".claude.json"), home.join(".claude")),
        Client { id: "vscode", name: "VS Code", config: code.join("mcp.json"), installed: code, key: "servers", typed: true },
        mcp_servers("cursor", "Cursor", home.join(".cursor").join("mcp.json"), home.join(".cursor")),
        mcp_servers("windsurf", "Windsurf", home.join(".codeium").join("windsurf").join("mcp_config.json"), home.join(".codeium").join("windsurf")),
    ]
}

fn known_clients() -> Vec<Client> {
    // Debug builds can be pointed at a stand-in, so trying this out can't touch real clients.
    #[cfg(debug_assertions)]
    if let Some(base) = std::env::var_os("W3PROJ_TEST_CLIENT_HOME").map(PathBuf::from) {
        return clients(&base.join("roaming"), &base.join("local"), &base.join("home"));
    }
    // Without its folders known, no client is offered: a missing variable must not become a relative path, which
    // would put a configuration file into whatever folder the app runs in.
    match system_folders() {
        Some((appdata, local, home)) => clients(&appdata, &local, &home),
        None => Vec::new(),
    }
}

/// The folders clients keep their settings in: on Windows %APPDATA%, %LOCALAPPDATA% and the profile; elsewhere
/// the XDG config folder (~/.config, where VS Code and Claude Desktop keep theirs), ~/.local/share and the home
/// folder (Claude Code, Cursor, Windsurf). An unset variable gives no folder rather than a relative path.
fn system_folders() -> Option<(PathBuf, PathBuf, PathBuf)> {
    // Only full paths count: an unset, empty or relative variable gives no folder.
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
    if cfg!(windows) {
        return Some((var("APPDATA")?, var("LOCALAPPDATA")?, var("USERPROFILE")?));
    }
    let home = var("HOME")?;
    let config = var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let data = var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share"));
    Some((config, data, home))
}

fn entry(client: &Client, bridge: &str) -> Value {
    if client.typed {
        json!({ "type": "stdio", "command": bridge, "args": ["mcp"] })
    } else {
        json!({ "command": bridge, "args": ["mcp"] })
    }
}

/// JSON with comments (`//`, `/* */`) and trailing commas, as VS Code, Claude Desktop and Cursor read their
/// settings, turned into plain JSON of the same length: comments and trailing commas become spaces (line
/// breaks stay), so a place in one is the same place in the other. Also says, per byte, which are in a comment.
fn blank_jsonc(text: &str) -> (String, Vec<bool>) {
    let b = text.as_bytes();
    let mut out = b.to_vec();
    let mut comment = vec![false; b.len()];
    let (mut i, mut in_string, mut comma) = (0, false, None::<usize>);
    while i < b.len() {
        let c = b[i];
        if in_string {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        let block = c == b'/' && b.get(i + 1) == Some(&b'*');
        if c == b'/' && (block || b.get(i + 1) == Some(&b'/')) {
            let end = if block {
                text[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2)
            } else {
                text[i..].find('\n').map_or(b.len(), |e| i + e)
            };
            for k in i..end {
                comment[k] = true;
                if b[k] != b'\n' && b[k] != b'\r' {
                    out[k] = b' ';
                }
            }
            i = end;
            continue;
        }
        match c {
            b'"' => in_string = true,
            b',' => {
                comma = Some(i);
                i += 1;
                continue;
            }
            b'}' | b']' => {
                if let Some(at) = comma {
                    out[at] = b' ';
                }
            }
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            comma = None;
        }
        i += 1;
    }
    // Only ASCII bytes were replaced, and only whole characters' bytes (comments end at ASCII), so it's still UTF-8.
    (String::from_utf8(out).unwrap_or_default(), comment)
}

fn parse(text: &str, file: &Path) -> Result<Map<String, Value>, String> {
    let (plain, _) = blank_jsonc(text.trim_start_matches('\u{feff}'));
    if plain.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str(&plain) {
        Ok(Value::Object(root)) => Ok(root),
        Ok(_) => Err(format!("{} doesn't hold a JSON object. It was left as it is.", file.display())),
        Err(e) => Err(format!("{} isn't valid JSON ({e}). It was left as it is.", file.display())),
    }
}

/// The file with our server in it; None when it already is. A file with comments or trailing commas is
/// changed only where the server goes, so they stay; a plain one is written out again.
fn merged(text: &str, file: &Path, key: &str, server: Value) -> Result<Option<String>, String> {
    let mut root = parse(text, file)?;
    let servers = root.entry(key).or_insert_with(|| json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return Err(format!("\"{key}\" in {} isn't an object. It was left as it is.", file.display()));
    };
    if servers.get(SERVER) == Some(&server) {
        return Ok(None);
    }
    servers.insert(SERVER.into(), server.clone());
    let body = text.trim_start_matches('\u{feff}');
    if blank_jsonc(body).0 == body {
        return serde_json::to_string_pretty(&root).map(|s| Some(s + "\n")).map_err(|e| e.to_string());
    }
    // Checked by reading it back: whatever went wrong, the file is left as it was and the user told what to add.
    let edited = edit_jsonc(text, key, &server).filter(|t| parse(t, file).ok().as_ref() == Some(&root));
    match edited {
        Some(t) => Ok(Some(t)),
        None => {
            let by_hand = serde_json::to_string_pretty(&json!({ SERVER: server })).unwrap_or_default();
            Err(format!(
                "{} has comments, and the server couldn't be added without losing them. It was left as it is. Add this to \"{key}\" in it by hand:\n{by_hand}",
                file.display()
            ))
        }
    }
}

/// A member of an object in plain JSON: where its key starts, and its value's span.
struct Member {
    key: String,
    key_start: usize,
    value: (usize, usize),
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// The end of the value starting at `i`, in JSON already known to be valid.
fn value_end(b: &[u8], mut i: usize) -> usize {
    match b.get(i) {
        Some(b'"') => {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            i + 1
        }
        Some(b'{' | b'[') => {
            let mut depth = 0;
            while i < b.len() {
                match b[i] {
                    b'"' => {
                        i = value_end(b, i);
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return i + 1;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            i
        }
        _ => {
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']') && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            i
        }
    }
}

/// The members of the object whose `{` is at `open`, and where its `}` is.
fn members(plain: &str, open: usize) -> Option<(Vec<Member>, usize)> {
    let b = plain.as_bytes();
    let mut list = Vec::new();
    let mut i = skip_ws(b, open + 1);
    while b.get(i) == Some(&b'"') {
        let key_end = value_end(b, i);
        let key = serde_json::from_str::<String>(plain.get(i..key_end)?).ok()?;
        let colon = skip_ws(b, key_end);
        if b.get(colon) != Some(&b':') {
            return None;
        }
        let start = skip_ws(b, colon + 1);
        let end = value_end(b, start);
        list.push(Member { key, key_start: i, value: (start, end) });
        i = skip_ws(b, end);
        if b.get(i) == Some(&b',') {
            i = skip_ws(b, i + 1);
        }
    }
    (b.get(i) == Some(&b'}')).then_some((list, i))
}

/// The spaces and tabs a line starts with, for the line `at` is on.
fn indent_at(text: &str, at: usize) -> &str {
    let start = text[..at].rfind('\n').map_or(0, |n| n + 1);
    let len = text[start..].bytes().take_while(|c| *c == b' ' || *c == b'\t').count();
    &text[start..start + len]
}

/// The text with our server put in by inserting or replacing only its own part: everything else, comments
/// and trailing commas included, stays as it was. None where the file's shape isn't one this knows.
fn edit_jsonc(text: &str, key: &str, server: &Value) -> Option<String> {
    let (plain, comment) = blank_jsonc(text);
    let b = plain.as_bytes();
    let bom = if text.starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 };
    let open = skip_ws(b, bom);
    // Line breaks as the file has them.
    let br = if text.contains("\r\n") { "\r\n" } else { "\n" };
    // A value as pretty JSON whose lines after the first start with `indent`.
    let rendered = |value: &Value, indent: &str| serde_json::to_string_pretty(value).unwrap_or_default().replace('\n', &format!("{br}{indent}"));
    // Nothing but comments: the object goes after them.
    if open == b.len() {
        return Some(format!("{}{br}{}{br}", text.trim_end(), rendered(&json!({ key: { SERVER: server } }), "")));
    }
    if b[open] != b'{' {
        return None;
    }
    let (list, close) = members(&plain, open)?;
    let (target_open, name, value) = match list.iter().find(|m| m.key == key) {
        Some(m) if b.get(m.value.0) == Some(&b'{') => {
            let (inner, _) = members(&plain, m.value.0)?;
            if let Some(own) = inner.iter().find(|s| s.key == SERVER) {
                let indent = indent_at(text, own.key_start);
                return Some(format!("{}{}{}", &text[..own.value.0], rendered(server, indent), &text[own.value.1..]));
            }
            (m.value.0, SERVER, server.clone())
        }
        Some(_) => return None,
        None => (open, key, json!({ SERVER: server })),
    };
    let (list, close) = if target_open == open { (list, close) } else { members(&plain, target_open)? };
    let name = serde_json::to_string(name).ok()?;
    // The end of the line `from` is on, when only comments (and a trailing comma) follow there: what's
    // inserted goes on a line of its own after it, so those stay on their line.
    let line_end = |from: usize| text[from..].find('\n').map(|n| from + n).filter(|&nl| nl < close && !comment[nl] && plain[from..nl].trim().is_empty());
    let Some(last) = list.last() else {
        let outer = indent_at(text, target_open);
        let indent = format!("{outer}  ");
        let member = format!("{name}: {}", rendered(&value, &indent));
        let after = target_open + 1;
        if let Some(nl) = line_end(after) {
            let at = if text.as_bytes()[nl - 1] == b'\r' { nl - 1 } else { nl };
            return Some(format!("{}{}{indent}{member}{}", &text[..at], &text[at..=nl], &text[at..]));
        }
        return Some(format!("{}{br}{indent}{member}{br}{outer}{}", &text[..after], &text[after..]));
    };
    let end = last.value.1;
    // An object written on one line stays on one.
    if !text[target_open..end].contains('\n') {
        return Some(format!("{}, {name}: {}{}", &text[..end], serde_json::to_string(&value).ok()?, &text[end..]));
    }
    let indent = indent_at(text, last.key_start).to_string();
    let member = format!("{name}: {}", rendered(&value, &indent));
    if let Some(nl) = line_end(end) {
        let trailing = text.as_bytes()[end..nl].iter().enumerate().any(|(k, c)| *c == b',' && !comment[end + k]);
        let at = if text.as_bytes()[nl - 1] == b'\r' { nl - 1 } else { nl };
        let eol = &text[at..=nl];
        // The file's own style: with a trailing comma after its last member, ours gets one too.
        let (comma, after) = if trailing { ("", ",") } else { (",", "") };
        return Some(format!("{}{comma}{}{eol}{indent}{member}{after}{}", &text[..end], &text[end..at], &text[at..]));
    }
    Some(format!("{},{br}{indent}{member}{}", &text[..end], &text[end..]))
}

/// Replaces the file in one step, with a backup first: clients may read or write it at any time.
fn replace(file: &Path, text: &str) -> Result<Option<PathBuf>, String> {
    let sibling = |ending: &str| {
        let mut name = file.as_os_str().to_owned();
        name.push(format!(".{ending}"));
        PathBuf::from(name)
    };
    let backup = file.exists().then(|| sibling(BACKUP));
    if let Some(backup) = &backup {
        std::fs::copy(file, backup).map_err(|e| format!("Couldn't back up {}: {e}", file.display()))?;
    }
    // atomic::write makes a missing folder; the clients' own folder is theirs to make, so it stays an error.
    let written = match file.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) if !dir.is_dir() => Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("{} doesn't exist", dir.display()))),
        _ => w3proj::atomic::write(file, text.as_bytes()),
    };
    written.map_err(|e| format!("Couldn't write {}: {e}", file.display()))?;
    Ok(backup)
}

fn set_up(client: &Client, bridge: &str) -> CmdResult<SetupResult> {
    if !client.installed.exists() {
        return Err(format!("{} wasn't found: there's no {}. If it's installed somewhere else, use Copy Client Setup.", client.name, client.installed.display()));
    }
    let text = match std::fs::read(&client.config) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| format!("{} isn't UTF-8 text. It was left as it is.", client.config.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Couldn't read {}: {e}", client.config.display())),
    };
    let path = client.config.to_string_lossy().into_owned();
    let Some(new) = merged(&text, &client.config, client.key, entry(client, bridge))? else {
        return Ok(SetupResult { path, changed: false, backup: None });
    };
    let backup = replace(&client.config, &new)?;
    Ok(SetupResult { path, changed: true, backup: backup.map(|b| b.to_string_lossy().into_owned()) })
}

#[derive(Serialize)]
pub struct ClientInfo {
    id: &'static str,
    name: &'static str,
    path: String,
    /// Looks installed; setting it up can still fail.
    found: bool,
    /// Its configuration names this server.
    configured: bool,
}

#[derive(Serialize, Debug)]
pub struct SetupResult {
    path: String,
    changed: bool,
    backup: Option<String>,
}

fn info(c: &Client) -> ClientInfo {
    let list = std::fs::read_to_string(&c.config).ok().and_then(|text| parse(&text, &c.config).ok());
    let configured = list.is_some_and(|root| root.get(c.key).and_then(|s| s.get(SERVER)).is_some());
    ClientInfo { id: c.id, name: c.name, path: c.config.to_string_lossy().into_owned(), found: c.installed.exists(), configured }
}

/// The clients this can try, and how each looks right now. Reads only.
#[tauri::command]
pub fn mcp_clients() -> Vec<ClientInfo> {
    known_clients().iter().map(info).collect()
}

/// Claude Code's own `claude` command, without a console window. A running Claude Code rewrites
/// its `.claude.json` from memory, so a change from outside can be lost; through this it can't.
fn claude(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut command = std::process::Command::new("claude");
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.output()
}

/// Through the `claude` command; None if it isn't there.
fn set_up_with_claude_command(client: &Client, bridge: &str) -> Option<CmdResult<SetupResult>> {
    // Not found first: nothing to replace yet, and an entry with an old path would make add fail.
    let _ = claude(&["mcp", "remove", "--scope", "user", SERVER]).ok()?;
    let added = claude(&["mcp", "add", "--scope", "user", SERVER, "--", bridge, "mcp"]).ok()?;
    let path = client.config.to_string_lossy().into_owned();
    Some(if added.status.success() {
        Ok(SetupResult { path, changed: true, backup: None })
    } else {
        Err(format!("claude mcp add failed: {}", String::from_utf8_lossy(&added.stderr).trim()))
    })
}

/// Adds the server to one client's configuration.
#[tauri::command]
pub fn mcp_client_setup(id: String) -> CmdResult<SetupResult> {
    let bridge = crate::mcp::mcp_bridge_path().ok_or(crate::mcp::NO_BRIDGE)?;
    let all = known_clients();
    let client = all.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown client {id}"))?;
    if client.id == "claudeCode" && std::env::var_os("W3PROJ_TEST_CLIENT_HOME").is_none() {
        if let Some(done) = set_up_with_claude_command(client, &bridge) {
            return done;
        }
    }
    set_up(client, &bridge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("w3proj-clients-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn client(&self, id: &str) -> Client {
            let (a, l, h) = (self.0.join("roaming"), self.0.join("local"), self.0.join("home"));
            clients(&a, &l, &h).into_iter().find(|c| c.id == id).unwrap()
        }
        fn write(&self, c: &Client, text: &str) {
            std::fs::create_dir_all(c.config.parent().unwrap()).unwrap();
            std::fs::create_dir_all(&c.installed).unwrap();
            std::fs::write(&c.config, text).unwrap();
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn json_of(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_client_that_isnt_there_is_said_and_nothing_is_made() {
        let home = Home::new();
        let c = home.client("cursor");
        assert!(set_up(&c, "w3proj.exe").unwrap_err().contains("wasn't found"));
        assert!(!c.installed.exists());
    }

    #[test]
    fn keeps_what_the_file_had_and_backs_it_up() {
        let home = Home::new();
        let c = home.client("claudeDesktop");
        let before = r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}},"z":1}"#;
        home.write(&c, before);
        let done = set_up(&c, "bridge.exe").unwrap();
        assert!(done.changed);
        assert_eq!(std::fs::read_to_string(done.backup.unwrap()).unwrap(), before);
        let got = json_of(&c.config);
        assert_eq!(got["theme"], "dark");
        assert_eq!(got["z"], 1);
        assert_eq!(got["mcpServers"]["other"]["command"], "x");
        assert_eq!(got["mcpServers"]["w3proj"], json!({ "command": "bridge.exe", "args": ["mcp"] }));
        let keys: Vec<_> = got.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["theme", "mcpServers", "z"]);
    }

    #[test]
    fn a_refused_write_leaves_the_old_file_and_no_temp_file() {
        let home = Home::new();
        let c = home.client("claudeDesktop");
        let before = r#"{"theme":"dark"}"#;
        home.write(&c, before);
        let mut perm = std::fs::metadata(&c.config).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&c.config, perm.clone()).unwrap();
        let err = set_up(&c, "bridge.exe").unwrap_err();
        assert!(err.contains("Couldn't write"), "{err}");
        assert_eq!(std::fs::read_to_string(&c.config).unwrap(), before);
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        std::fs::set_permissions(&c.config, perm).unwrap();
        let names: Vec<_> = std::fs::read_dir(c.config.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp") && !n.ends_with("w3proj-temp")), "{names:?}");
    }

    #[test]
    fn a_missing_folder_is_still_an_error_and_not_made() {
        let home = Home::new();
        let dir = home.0.join("nope");
        let err = replace(&dir.join("c.json"), "{}").unwrap_err();
        assert!(err.contains("Couldn't write"), "{err}");
        assert!(!dir.exists());
    }

    #[test]
    fn a_write_keeps_the_files_permissions() {
        let home = Home::new();
        let c = home.client("claudeDesktop");
        home.write(&c, "{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&c.config, std::fs::Permissions::from_mode(0o600)).unwrap();
            set_up(&c, "bridge.exe").unwrap();
            assert_eq!(std::fs::metadata(&c.config).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn vs_code_has_its_own_form() {
        let home = Home::new();
        let c = home.client("vscode");
        std::fs::create_dir_all(&c.installed).unwrap();
        let done = set_up(&c, "bridge.exe").unwrap();
        assert!(done.backup.is_none(), "there was nothing to back up");
        assert_eq!(json_of(&c.config)["servers"]["w3proj"], json!({ "type": "stdio", "command": "bridge.exe", "args": ["mcp"] }));
    }

    #[test]
    fn a_second_try_changes_nothing_and_a_moved_program_is_updated() {
        let home = Home::new();
        let c = home.client("windsurf");
        std::fs::create_dir_all(&c.installed).unwrap();
        assert!(set_up(&c, "a.exe").unwrap().changed);
        assert!(!set_up(&c, "a.exe").unwrap().changed);
        assert!(set_up(&c, "b.exe").unwrap().changed);
        assert_eq!(json_of(&c.config)["mcpServers"]["w3proj"]["command"], "b.exe");
    }

    #[test]
    fn files_it_cant_understand_are_left_alone() {
        let home = Home::new();
        let c = home.client("vscode");
        for (text, why) in [("// comment\n[1]", "JSON object"), ("[1]", "JSON object"), (r#"{"servers":[]}"#, "isn't an object"), ("{ broken", "valid JSON"), ("{ /* open", "valid JSON")] {
            home.write(&c, text);
            assert!(set_up(&c, "x").unwrap_err().contains(why), "{text}");
            assert_eq!(std::fs::read_to_string(&c.config).unwrap(), text);
        }
        assert_eq!(std::fs::read_dir(c.config.parent().unwrap()).unwrap().count(), 1, "no backup, no temp file");
    }

    /// What a file says once comments and trailing commas are taken out, through the code's own reading.
    fn jsonc_of(path: &Path) -> Value {
        Value::Object(parse(&std::fs::read_to_string(path).unwrap(), path).unwrap())
    }

    /// Sets up `client` in a file holding `before`; gives the text written, after checking that every comment of
    /// `before` is still in it, in order, and that it reads as `before` plus the server.
    fn set_up_keeping(home: &Home, id: &str, before: &str, comments: &[&str]) -> String {
        let c = home.client(id);
        home.write(&c, before);
        let done = set_up(&c, "bridge.exe").unwrap_or_else(|e| panic!("refused: {e}"));
        assert!(done.changed);
        assert_eq!(std::fs::read_to_string(done.backup.unwrap()).unwrap(), before);
        let after = std::fs::read_to_string(&c.config).unwrap();
        let mut rest = after.as_str();
        for piece in comments {
            assert!(before.contains(piece), "{piece:?} isn't in the file to begin with");
            let at = rest.find(piece).unwrap_or_else(|| panic!("lost {piece:?}:\n{after}"));
            rest = &rest[at + piece.len()..];
        }
        let mut want = Value::Object(parse(before, &c.config).unwrap());
        want.as_object_mut().unwrap().entry(c.key).or_insert_with(|| json!({}))[SERVER] = entry(&c, "bridge.exe");
        assert_eq!(jsonc_of(&c.config), want, "{after}");
        after
    }

    #[test]
    fn comments_and_trailing_commas_stay() {
        let home = Home::new();
        // VS Code: comments around and in its list, a trailing comma after the last server.
        let vscode = "// My servers\n{\n  /* the list */\n  \"servers\": {\n    \"other\": { \"command\": \"x\" }, // keep me\n  },\n  \"inputs\": [],\n}\n";
        let after = set_up_keeping(&home, "vscode", vscode, &["// My servers\n{\n  /* the list */\n", "}, // keep me\n"]);
        assert!(after.contains("// keep me\n    \"w3proj\": {"), "after the last server's line, its comment with it:\n{after}");
        // Claude Desktop: no list yet; line ends as Windows writes them.
        let after = set_up_keeping(&home, "claudeDesktop", "{\r\n  // theme\r\n  \"theme\": \"dark\"\r\n}\r\n", &["{\r\n  // theme\r\n"]);
        assert_eq!(after.matches('\n').count(), after.matches("\r\n").count(), "{after:?}");
        // An empty list with a comment in it, a list on one line, a file of comments only, a URL in a string.
        set_up_keeping(&home, "cursor", "{\n  \"mcpServers\": { // none yet\n  }\n}\n", &["{ // none yet\n"]);
        set_up_keeping(&home, "windsurf", "{ \"a\": \"http://x/*y*/\", \"mcpServers\": { \"o\": {} } } // end\n", &["} } // end\n"]);
        set_up_keeping(&home, "claudeCode", "// nothing here yet\n", &["// nothing here yet\n"]);
    }

    #[test]
    fn our_entry_in_a_file_with_comments_is_replaced_in_place() {
        let home = Home::new();
        let c = home.client("cursor");
        let before = "{\n  // mine\n  \"mcpServers\": {\n    \"w3proj\": { \"command\": \"old.exe\", \"args\": [\"mcp\"] }, // ours\n    \"b\": {}\n  }\n}\n";
        home.write(&c, before);
        assert!(set_up(&c, "new.exe").unwrap().changed);
        let after = std::fs::read_to_string(&c.config).unwrap();
        assert!(after.contains("// mine") && after.contains("}, // ours\n    \"b\": {}"), "{after}");
        assert_eq!(jsonc_of(&c.config)["mcpServers"]["w3proj"]["command"], "new.exe");
        assert!(!set_up(&c, "new.exe").unwrap().changed, "a second try changes nothing");
        assert!(info(&c).configured, "the status reads a file with comments");
    }

    #[test]
    fn a_file_with_comments_that_cant_be_edited_safely_is_left_with_what_to_add() {
        let home = Home::new();
        let c = home.client("vscode");
        // The same key twice: the last one counts, so an edit of the first can't be shown to work.
        let before = "// two lists\n{ \"servers\": {}, \"servers\": { \"x\": {} } }\n";
        home.write(&c, before);
        let why = set_up(&c, "bridge.exe").unwrap_err();
        assert!(why.contains("has comments") && why.contains("by hand") && why.contains("\"w3proj\"") && why.contains("bridge.exe"), "{why}");
        assert_eq!(std::fs::read_to_string(&c.config).unwrap(), before);
        assert_eq!(std::fs::read_dir(c.config.parent().unwrap()).unwrap().count(), 1, "no backup, no temp file");
    }

    #[test]
    fn random_text_never_panics_and_what_is_written_has_the_server() {
        // Fixed seed; pieces of JSON with comments, put together at random, most of them broken.
        let pieces = ["{", "}", "[", "]", ",", ":", "\"mcpServers\"", "\"w3proj\"", "\"a\"", "1", "\"/*\"", "// c\n", "/* c */", "/*", "\n", "\r\n", " ", "\\", "\"", "\u{feff}", "é"];
        let mut s: u64 = 20261108;
        let file = Path::new("x.json");
        let server = json!({ "command": "b" });
        let mut edited = 0;
        for _ in 0..20000 {
            let mut text = String::new();
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            for _ in 0..(s >> 60) + 2 {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                text.push_str(pieces[(s >> 33) as usize % pieces.len()]);
            }
            if let Ok(Some(out)) = merged(&text, file, "mcpServers", server.clone()) {
                assert_eq!(parse(&out, file).unwrap()["mcpServers"][SERVER], server, "{text:?} gave {out:?}");
                edited += usize::from(text.contains("//") || text.contains("/* c */"));
            }
        }
        // Control: files with comments were edited, so the comparison reached the editing.
        assert!(edited > 100, "only {edited} files with comments were edited");
    }

    #[test]
    fn a_byte_order_mark_is_fine() {
        let home = Home::new();
        let c = home.client("cursor");
        home.write(&c, "\u{feff}{\"a\":1}");
        assert!(set_up(&c, "x").unwrap().changed);
        assert_eq!(json_of(&c.config)["a"], 1);
    }

    /// A path below `base`, given with `/`: joined part by part, as the code does, so it means the same on every system.
    fn at(base: &Path, rel: &str) -> PathBuf {
        rel.split('/').fold(base.to_path_buf(), |p, part| p.join(part))
    }

    #[test]
    fn client_paths_have_no_backslash_in_a_file_name_off_windows() {
        let home = Home::new();
        for id in ["claudeDesktop", "claudeCode", "vscode", "cursor", "windsurf"] {
            let c = home.client(id);
            for p in [&c.config, &c.installed] {
                assert!(p.starts_with(&home.0), "{id}: {}", p.display());
                if !cfg!(windows) {
                    assert!(p.components().all(|part| !part.as_os_str().to_string_lossy().contains('\\')), "{id}: {}", p.display());
                }
            }
        }
        assert_eq!(home.client("cursor").config, at(&home.0, "home/.cursor/mcp.json"));
        assert_eq!(home.client("vscode").config, at(&home.0, "roaming/Code/User/mcp.json"));
    }

    #[test]
    fn the_store_version_of_claude_desktop_is_found() {
        let home = Home::new();
        let packaged = at(&home.0, "local/Packages/Claude_abc123/LocalCache/Roaming/Claude");
        std::fs::create_dir_all(&packaged).unwrap();
        assert_eq!(home.client("claudeDesktop").config, packaged.join("claude_desktop_config.json"));
    }

    #[test]
    fn claude_desktop_moved_out_of_its_package() {
        let home = Home::new();
        let packaged = at(&home.0, "local/Packages/Claude_abc123/LocalCache/Roaming/Claude");
        std::fs::create_dir_all(&packaged).unwrap();
        std::fs::write(packaged.join(".user-data-left.claude_abc123"), "{}").unwrap();
        assert_eq!(home.client("claudeDesktop").config, at(&home.0, "roaming/Claude/claude_desktop_config.json"), "what it left isn't read");
        let data = at(&home.0, "local/Claude-Data/claude_abc123");
        std::fs::create_dir_all(&data).unwrap();
        assert_eq!(home.client("claudeDesktop").config, data.join("claude_desktop_config.json"));
    }

    #[test]
    fn status_shows_found_and_configured() {
        let home = Home::new();
        let c = home.client("cursor");
        assert!(!info(&c).found);
        home.write(&c, r#"{"mcpServers":{"w3proj":{"command":"x"}}}"#);
        let now = info(&c);
        assert!(now.found && now.configured);
    }
}
