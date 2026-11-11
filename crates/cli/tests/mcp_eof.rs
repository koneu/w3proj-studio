//! `w3proj mcp` answers every request it read, even when the client closes stdin right after the last one
//! (`echo … | w3proj mcp`). Studio isn't reachable here (the socket folder is an empty one of the test's own),
//! so the answers are the offline ones.
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn answers_everything_read_before_stdin_closed() {
    let dir = std::env::temp_dir().join(format!("w3proj-mcp-eof-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
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
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    let mut ids: Vec<i64> = text
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["id"].as_i64().unwrap())
        .collect();
    ids.sort();
    assert_eq!(ids, [1, 2, 3], "answers: {text}");
}
