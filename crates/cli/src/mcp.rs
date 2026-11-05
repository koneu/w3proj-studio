//! `w3proj mcp`: the one MCP server. A client starts it and talks JSON-RPC over stdin and stdout.
//!
//! This process knows the protocol and nothing about tools: `tools/list` and `tools/call` go to
//! the running W3Proj Studio, where each extension provides its own. Every request is a new
//! connection to the app's pipe, so the app can start, stop or reload while the client stays
//! connected. Without the app, the client gets one tool that says what to do.

use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Newest first. Tools and their results are the same in all of them.
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// How often the app is asked whether its tools changed.
const WATCH: Duration = Duration::from_secs(2);

const OFFLINE: &str = "W3Proj Studio isn't reachable. Start it, run the command \"MCP: Turn Server \
                       On or Off\" there (or set mcp.enabled in its settings), and try again.";

type Send = dyn Fn(&str) -> io::Result<String> + std::marker::Send + Sync;

fn failure(id: &Value, code: i32, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn initialize(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str().unwrap_or_default();
    json!({
        "protocolVersion": PROTOCOLS.iter().find(|p| **p == asked).unwrap_or(&PROTOCOLS[0]),
        "capabilities": { "tools": { "listChanged": true } },
        "serverInfo": { "name": "w3proj-studio", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Tools of W3Proj Studio, a Warcraft III map editor. They work on the project open in the running app, and read it as last saved; only terrain_screenshot shows unsaved changes.",
    })
}

/// What `tools/list` and `tools/call` answer while the app can't be reached.
fn offline(method: &str) -> Value {
    if method == "tools/list" {
        json!({ "tools": [{
            "name": "studio_status",
            "description": "Says why W3Proj Studio's tools aren't available. They appear once the app runs with its MCP server on.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        }] })
    } else {
        json!({ "content": [{ "type": "text", "text": OFFLINE }], "isError": true })
    }
}

/// The answer to one line from the client; None for notifications.
fn respond(line: &str, send: &Send) -> Option<String> {
    let Ok(req) = serde_json::from_str::<Value>(line) else {
        return Some(failure(&Value::Null, -32700, "not JSON"));
    };
    let id = req.get("id")?;
    let method = req.get("method")?.as_str()?;
    let result = match method {
        "initialize" => initialize(&req["params"]),
        "ping" => json!({}),
        "tools/list" | "tools/call" => match send(line) {
            Ok(reply) => return Some(reply),
            Err(_) => offline(method),
        },
        _ => return Some(failure(id, -32601, &format!("unknown method {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

/// Stands for the app's tool list; changes when the list does, or when the app comes or goes.
fn revision(send: &Send) -> String {
    send(r#"{"jsonrpc":"2.0","id":"revision","method":"w3/revision"}"#)
        .ok()
        .and_then(|reply| serde_json::from_str::<Value>(&reply).ok())
        .and_then(|reply| reply["result"]["revision"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "offline".into())
}

#[cfg(windows)]
fn studio(line: &str) -> io::Result<String> {
    /// ERROR_PIPE_BUSY: the app is between two connections.
    const BUSY: i32 = 231;
    let name = w3proj::mcp_pipe_name();
    let mut tries = 0;
    let pipe = loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&name) {
            Err(e) if e.raw_os_error() == Some(BUSY) && tries < 40 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            other => break other?,
        }
    };
    (&pipe).write_all(format!("{line}\n").as_bytes())?;
    let mut reply = String::new();
    if io::BufReader::new(&pipe).read_line(&mut reply)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(reply.trim_end().to_owned())
}

#[cfg(not(windows))]
fn studio(_: &str) -> io::Result<String> {
    Err(io::ErrorKind::Unsupported.into())
}

pub fn run() -> anyhow::Result<()> {
    let send: Arc<Send> = Arc::new(studio);
    let out = Arc::new(Mutex::new(io::stdout()));
    let print = |out: &Mutex<io::Stdout>, line: &str| {
        let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
        // A client that's gone also closes stdin, which ends the loop below.
        let _ = writeln!(out, "{line}").and_then(|()| out.flush());
    };
    let mut watching = false;
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if !watching && line.contains("notifications/initialized") {
            watching = true;
            let (send, out) = (send.clone(), out.clone());
            std::thread::spawn(move || {
                let mut last = revision(&*send);
                loop {
                    std::thread::sleep(WATCH);
                    let now = revision(&*send);
                    if now != last {
                        last = now;
                        print(&out, r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#);
                    }
                }
            });
        }
        // A slow tool doesn't hold up the next request.
        let (send, out) = (send.clone(), out.clone());
        std::thread::spawn(move || {
            if let Some(reply) = respond(&line, &*send) {
                print(&out, &reply);
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(line: &str) -> io::Result<String> {
        let id = serde_json::from_str::<Value>(line).unwrap()["id"].clone();
        Ok(json!({ "jsonrpc": "2.0", "id": id, "result": { "from": "app" } }).to_string())
    }
    fn down(_: &str) -> io::Result<String> {
        Err(io::ErrorKind::NotFound.into())
    }
    fn parsed(reply: Option<String>) -> Value {
        serde_json::from_str(&reply.unwrap()).unwrap()
    }

    #[test]
    fn initialize_needs_no_app_and_agrees_on_a_version() {
        let old = r#"{"id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#;
        assert_eq!(parsed(respond(old, &down))["result"]["protocolVersion"], "2024-11-05");
        let future = r#"{"id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#;
        assert_eq!(parsed(respond(future, &down))["result"]["protocolVersion"], PROTOCOLS[0]);
    }

    #[test]
    fn tools_go_to_the_app() {
        let got = parsed(respond(r#"{"id":7,"method":"tools/list"}"#, &up));
        assert_eq!((got["id"].clone(), got["result"]["from"].clone()), (json!(7), json!("app")));
    }

    #[test]
    fn without_the_app_the_client_is_told_what_to_do() {
        let list = parsed(respond(r#"{"id":1,"method":"tools/list"}"#, &down));
        assert_eq!(list["result"]["tools"][0]["name"], "studio_status");
        let call = parsed(respond(r#"{"id":2,"method":"tools/call","params":{"name":"terrain_screenshot"}}"#, &down));
        assert_eq!(call["result"]["isError"], true);
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("Start it"));
    }

    #[test]
    fn notifications_get_no_answer_and_rubbish_an_error() {
        assert!(respond(r#"{"method":"notifications/initialized"}"#, &up).is_none());
        assert_eq!(parsed(respond("{nope", &up))["error"]["code"], -32700);
        assert_eq!(parsed(respond(r#"{"id":3,"method":"resources/list"}"#, &up))["error"]["code"], -32601);
    }

    #[test]
    fn the_revision_tells_the_app_coming_and_going() {
        assert_eq!(revision(&down), "offline");
        let answer = |_: &str| -> io::Result<String> { Ok(r#"{"result":{"revision":"a1"}}"#.into()) };
        assert_eq!(revision(&answer), "a1");
    }
}
