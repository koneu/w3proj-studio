//! "Try to set up for …": adds this app's MCP server to an AI client's own configuration.
//! The places are where a standard installation keeps it, so this can fail, and it must fail
//! without damage: nothing is written for a client that isn't found or to a file that isn't plain
//! JSON, and the previous file stays next to it as a backup.

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

fn parse(text: &str, file: &Path) -> Result<Map<String, Value>, String> {
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str(text) {
        Ok(Value::Object(root)) => Ok(root),
        Ok(_) => Err(format!("{} doesn't hold a JSON object. It was left as it is.", file.display())),
        // Comments, trailing commas: writing it back would lose them.
        Err(e) => Err(format!("{} isn't plain JSON ({e}). It was left as it is.", file.display())),
    }
}

/// The file with our server in it; None when it already is.
fn merged(text: &str, file: &Path, key: &str, server: Value) -> Result<Option<String>, String> {
    let mut root = parse(text, file)?;
    let servers = root.entry(key).or_insert_with(|| json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return Err(format!("\"{key}\" in {} isn't an object. It was left as it is.", file.display()));
    };
    if servers.get(SERVER) == Some(&server) {
        return Ok(None);
    }
    servers.insert(SERVER.into(), server);
    serde_json::to_string_pretty(&root).map(|s| Some(s + "\n")).map_err(|e| e.to_string())
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
    let temp = sibling("w3proj-temp");
    let done = std::fs::write(&temp, text).and_then(|()| std::fs::rename(&temp, file));
    if let Err(e) = done {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Couldn't write {}: {e}", file.display()));
    }
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
        for (text, why) in [("// comment\n{}", "plain JSON"), ("[1]", "JSON object"), (r#"{"servers":[]}"#, "isn't an object"), ("{ broken", "plain JSON")] {
            home.write(&c, text);
            assert!(set_up(&c, "x").unwrap_err().contains(why), "{text}");
            assert_eq!(std::fs::read_to_string(&c.config).unwrap(), text);
        }
        assert_eq!(std::fs::read_dir(c.config.parent().unwrap()).unwrap().count(), 1, "no backup, no temp file");
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
