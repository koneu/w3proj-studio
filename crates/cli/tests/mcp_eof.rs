//! `w3proj mcp` answers every request it read, even when the client closes stdin right after the last one
//! (`echo … | w3proj mcp`). Studio isn't reachable here (the socket folder is an empty one of the test's own),
//! so the answers are the offline ones.
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// The test's socket folder under the build's scratch folder; removed when it goes out of scope (also on a failure).
struct TestDir(PathBuf);

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn answers_everything_read_before_stdin_closed() {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("w3proj-mcp-eof-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = TestDir(dir.clone());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_w3proj"))
        .arg("mcp")
        .env("XDG_RUNTIME_DIR", &dir)
        .env("USERNAME", "w3proj-mcp-eof-test")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let input = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#, "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, "\n",
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"studio_status","arguments":{}}}"#, "\n",
    );
    // The writing and the reading run on threads, so a server that never answers (or never ends) fails the test after
    // the deadline instead of hanging it; a server that ends before it read everything (BrokenPipe) is for the
    // answers' check below to judge.
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let mut stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let bytes = match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("w3proj mcp did not finish within 60 s of stdin closing");
        }
    };
    let status = child.wait().unwrap();
    writer.join().unwrap();
    reader.join().unwrap();
    assert!(status.success());
    let text = String::from_utf8(bytes).unwrap();
    let mut ids: Vec<i64> = text
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["id"].as_i64().unwrap())
        .collect();
    ids.sort();
    assert_eq!(ids, [1, 2, 3], "answers: {text}");
}
