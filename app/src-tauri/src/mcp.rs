//! The app's end of the MCP bridge (see `w3proj mcp`): a named pipe on Windows, a Unix socket
//! elsewhere (w3proj::mcp_pipe_name), open only while the server is on. Each connection is one
//! request. It goes to the webview, where the tools live, and the answer comes back through
//! `mcp_respond`. The pipe takes no remote clients, and its default access lets only this user
//! (and administrators) write to it; the socket is made for this user alone (mode 0600, in their
//! own runtime folder).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::CmdResult;

/// A tool may open a map first. Everything else is answered at once, or the webview isn't there.
const CALL_LIMIT: Duration = Duration::from_secs(120);
const QUICK_LIMIT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Shared {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Default, Clone)]
pub struct Mcp(Arc<Shared>);

/// Hands one request to the webview and waits for the answer; a late answer is dropped.
async fn ask(app: &AppHandle, mcp: &Mcp, line: &str) -> String {
    let request: Value = serde_json::from_str(line).unwrap_or(Value::Null);
    let limit = if request["method"] == "tools/call" { CALL_LIMIT } else { QUICK_LIMIT };
    let key = mcp.0.next.fetch_add(1, Ordering::Relaxed);
    let (answer, wait) = oneshot::channel();
    mcp.0.waiting.lock().unwrap().insert(key, answer);
    let sent = app.emit("w3://mcp-request", json!({ "key": key, "message": line }));
    let reply = match sent {
        Ok(()) => tokio::time::timeout(limit, wait).await.ok().and_then(Result::ok),
        Err(_) => None,
    };
    mcp.0.waiting.lock().unwrap().remove(&key);
    reply.unwrap_or_else(|| {
        let error = json!({ "code": -32000, "message": "W3Proj Studio didn't answer in time." });
        json!({ "jsonrpc": "2.0", "id": request["id"], "error": error }).to_string()
    })
}

/// Longer requests aren't read: they carry a tool's name and a few arguments.
const REQUEST_LIMIT: u64 = 1 << 20;

/// One connection, one request: a line in, the answer's line out.
async fn connection<S: tokio::io::AsyncRead + tokio::io::AsyncWrite>(app: AppHandle, mcp: Mcp, stream: S) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read.take(REQUEST_LIMIT));
    let mut line = String::new();
    if read.read_line(&mut line).await? == 0 {
        return Ok(());
    }
    let reply = ask(&app, &mcp, line.trim_end()).await;
    write.write_all(reply.as_bytes()).await?;
    write.write_all(b"\n").await?;
    write.flush().await?;
    // Closing now could cut off a big answer (a screenshot): the client hangs up first.
    let _ = tokio::time::timeout(Duration::from_secs(30), read.read_u8()).await;
    Ok(())
}

#[cfg(windows)]
mod pipe {
    use super::*;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    fn instance(first: bool) -> std::io::Result<NamedPipeServer> {
        ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).create(w3proj::mcp_pipe_name())
    }

    /// Serves until aborted. Fails at once if another copy of the app has the pipe.
    pub fn start(app: AppHandle, mcp: Mcp) -> std::io::Result<tauri::async_runtime::JoinHandle<()>> {
        let mut next = instance(true)?;
        Ok(tauri::async_runtime::spawn(async move {
            loop {
                if next.connect().await.is_err() {
                    break;
                }
                let Ok(following) = instance(false) else { break };
                let (app, mcp) = (app.clone(), mcp.clone());
                let client = std::mem::replace(&mut next, following);
                tauri::async_runtime::spawn(async move {
                    let _ = connection(app, mcp, client).await;
                });
            }
        }))
    }
}

#[cfg(unix)]
mod pipe {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::path::Path;

    /// The socket, for this user alone, in a folder that is theirs alone (made with mode 0700 when it's the
    /// temp-folder fallback; refused when it belongs to someone else or others can open it). A socket left by an
    /// app that ended without closing it is replaced; one that answers belongs to another running copy, and this
    /// one doesn't take over. Nothing but a socket is ever removed.
    pub fn bind(path: &Path) -> std::io::Result<std::os::unix::net::UnixListener> {
        use std::os::unix::fs::FileTypeExt;
        let denied = |msg: String| std::io::Error::new(std::io::ErrorKind::PermissionDenied, msg);
        // A socket's path has room for 107 bytes (sun_path); the system's own message for more says little.
        if path.as_os_str().len() > 107 {
            let msg = format!("the socket's path is longer than the system allows (107 bytes): {}. Set XDG_RUNTIME_DIR to a shorter folder.", path.display());
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, msg));
        }
        let dir = path.parent().ok_or_else(|| denied(format!("no folder for {}", path.display())))?;
        if !dir.exists() {
            std::fs::DirBuilder::new().mode(0o700).create(dir)?;
        }
        w3proj::private_dir(dir).map_err(|e| denied(format!("the MCP socket's folder isn't safe to use: {e}")))?;
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.file_type().is_socket() {
                return Err(denied(format!("{} is there and isn't a socket; it was left as it is", path.display())));
            }
            if std::os::unix::net::UnixStream::connect(path).is_ok() {
                return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "another copy of W3Proj Studio is already serving MCP"));
            }
            std::fs::remove_file(path)?;
        }
        let listener = std::os::unix::net::UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }

    /// Serves until aborted; the socket file goes when the server stops (see `mcp_serve`).
    pub fn start(app: AppHandle, mcp: Mcp) -> std::io::Result<tauri::async_runtime::JoinHandle<()>> {
        let listener = bind(Path::new(&w3proj::mcp_pipe_name()))?;
        let me = w3proj::own_uid();
        Ok(tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::UnixListener::from_std(listener) else { return };
            while let Ok((stream, _)) = listener.accept().await {
                // Only this user's processes are answered, whatever the folder lets through.
                if me.is_none() || stream.peer_cred().ok().map(|c| c.uid()) != me {
                    continue;
                }
                let (app, mcp) = (app.clone(), mcp.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = connection(app, mcp, stream).await;
                });
            }
        }))
    }

    /// Removes the socket file after the server stopped, so a client finds nothing rather than a dead socket.
    pub fn stopped() {
        let _ = std::fs::remove_file(w3proj::mcp_pipe_name());
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn folder(name: &str, mode: u32) -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!("w3proj-mcp-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
            dir
        }

        #[test]
        fn the_folder_must_be_this_users_alone() {
            let open = folder("open", 0o755);
            let e = bind(&open.join("s.sock")).unwrap_err();
            assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied, "{e}");
            assert!(!open.join("s.sock").exists(), "nothing is made in a folder others can open");
            std::fs::remove_dir_all(&open).unwrap();
            // A missing folder (the temp-folder fallback) is made, for this user alone.
            let parent = folder("parent", 0o700);
            let made = parent.join("w3proj-studio-x");
            let _listener = bind(&made.join("s.sock")).unwrap();
            assert_eq!(std::fs::metadata(&made).unwrap().permissions().mode() & 0o777, 0o700);
            std::fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn a_file_that_isnt_a_socket_is_never_removed() {
            let dir = folder("file", 0o700);
            std::fs::write(dir.join("s.sock"), "someone's data").unwrap();
            assert_eq!(bind(&dir.join("s.sock")).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
            assert_eq!(std::fs::read_to_string(dir.join("s.sock")).unwrap(), "someone's data");
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_live_socket_is_kept_and_a_dead_one_replaced() {
            let dir = folder("sock", 0o700);
            let path = dir.join("s.sock");
            let first = bind(&path).unwrap();
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "for this user alone");
            assert_eq!(bind(&path).unwrap_err().kind(), std::io::ErrorKind::AddrInUse, "another copy serves");
            drop(first);
            // The file is still there, but nothing answers: it's replaced.
            assert!(path.exists());
            let _second = bind(&path).unwrap();
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}

#[cfg(not(any(windows, unix)))]
mod pipe {
    use super::*;
    pub fn start(_: AppHandle, _: Mcp) -> std::io::Result<tauri::async_runtime::JoinHandle<()>> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "the MCP server doesn't run on this system"))
    }
}

/// Opens or closes the pipe.
#[tauri::command]
pub async fn mcp_serve(app: AppHandle, state: State<'_, Mcp>, enabled: bool) -> CmdResult<()> {
    let mcp = state.inner().clone();
    let mut server = mcp.0.server.lock().unwrap();
    if !enabled {
        if let Some(running) = server.take() {
            running.abort();
            #[cfg(unix)]
            pipe::stopped();
        }
    } else if server.is_none() {
        let started = pipe::start(app, mcp.clone()).map_err(|e| {
            // Windows: ERROR_ACCESS_DENIED / ERROR_PIPE_BUSY when another copy has the pipe.
            let taken = if cfg!(windows) { matches!(e.raw_os_error(), Some(5) | Some(231)) } else { e.kind() == std::io::ErrorKind::AddrInUse };
            if taken { "another copy of W3Proj Studio is already serving MCP".to_string() } else { e.to_string() }
        })?;
        *server = Some(started);
    }
    Ok(())
}

/// The webview's answer to a request.
#[tauri::command]
pub fn mcp_respond(state: State<'_, Mcp>, key: u64, message: String) {
    if let Some(waiting) = state.0.waiting.lock().unwrap().remove(&key) {
        let _ = waiting.send(message);
    }
}

pub const NO_BRIDGE: &str = "There's no w3proj (w3proj.exe on Windows) next to this program, or it's from before MCP. Build it with: cargo build --release -p w3proj-cli";

/// The bridge next to this program, for the client setup; None if it isn't there or can't serve:
/// an older build has no `mcp` command, and a client would only say the server failed.
#[tauri::command]
pub fn mcp_bridge_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let bridge = exe.parent()?.join(if cfg!(windows) { "w3proj.exe" } else { "w3proj" });
    let mut asks = std::process::Command::new(&bridge);
    asks.args(["mcp", "--help"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        asks.creation_flags(CREATE_NO_WINDOW);
    }
    asks.output().ok()?.status.success().then(|| bridge.to_string_lossy().into_owned())
}
