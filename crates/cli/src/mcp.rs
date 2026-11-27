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

/// Sends one request to the app and gives its answer; what the app says before it (a long tool's progress
/// notifications, one line each) goes to the second argument as it comes.
type Send = dyn Fn(&str, &mut dyn FnMut(&str)) -> io::Result<String> + std::marker::Send + Sync;

/// How a line of the app that isn't the answer starts: a notification, which has no id (the app writes them in this
/// order; an answer starts with its id).
const NOTE: &str = r#"{"jsonrpc":"2.0","method":"notifications/"#;

/// The answer among the lines the app sends for one request: lines before it that are notifications go to `note`.
fn read_reply(mut lines: impl BufRead, note: &mut dyn FnMut(&str)) -> io::Result<String> {
    loop {
        let mut reply = String::new();
        if lines.read_line(&mut reply)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let reply = reply.trim_end();
        if reply.starts_with(NOTE) {
            note(reply);
        } else {
            return Ok(reply.to_owned());
        }
    }
}

fn failure(id: &Value, code: i32, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn initialize(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str().unwrap_or_default();
    json!({
        "protocolVersion": PROTOCOLS.iter().find(|p| **p == asked).unwrap_or(&PROTOCOLS[0]),
        "capabilities": { "tools": { "listChanged": true } },
        "serverInfo": { "name": "w3proj-studio", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Tools of W3Proj Studio, a Warcraft III map editor. They work on the project open in the running app, and read it as last saved; only terrain_screenshot shows unsaved changes. read_guide explains kinds of work, such as terrain, melee maps and spells: read it before you start on one. Plan a big job before building, check after each stage, and fix what's wrong instead of rebuilding what works.",
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

/// The answer to one line from the client; None for notifications. `note` gets what the app says before the answer
/// (progress), for the client.
fn respond(line: &str, send: &Send, note: &mut dyn FnMut(&str)) -> Option<String> {
    let Ok(req) = serde_json::from_str::<Value>(line) else {
        return Some(failure(&Value::Null, -32700, "not JSON"));
    };
    let id = req.get("id")?;
    let method = req.get("method")?.as_str()?;
    let result = match method {
        "initialize" => initialize(&req["params"]),
        "ping" => json!({}),
        "tools/list" | "tools/call" => {
            // A client that gave a progress token hears how far a long call is: the app sends such lines only to a
            // bridge that says it reads them (`w3progress`).
            let marked = (method == "tools/call" && !req["params"]["_meta"]["progressToken"].is_null()).then(|| {
                let mut req = req.clone();
                req["w3progress"] = json!(true);
                req.to_string()
            });
            match send(marked.as_deref().unwrap_or(line), note) {
                Ok(reply) => return Some(reply),
                Err(_) => offline(method),
            }
        }
        _ => return Some(failure(id, -32601, &format!("unknown method {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

/// Stands for the app's tool list; changes when the list does, or when the app comes or goes.
fn revision(send: &Send) -> String {
    send(r#"{"jsonrpc":"2.0","id":"revision","method":"w3/revision"}"#, &mut |_| {})
        .ok()
        .and_then(|reply| serde_json::from_str::<Value>(&reply).ok())
        .and_then(|reply| reply["result"]["revision"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "offline".into())
}

#[cfg(windows)]
fn studio(line: &str, note: &mut dyn FnMut(&str)) -> io::Result<String> {
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
    read_reply(io::BufReader::new(&pipe), note)
}

/// The app's Unix socket (w3proj::mcp_pipe_name): one connection per request, as with the pipe. Only in a
/// folder that is this user's alone: a socket in a folder others can write to may be someone else's, who would
/// then see the requests and answer them.
#[cfg(unix)]
fn studio(line: &str, note: &mut dyn FnMut(&str)) -> io::Result<String> {
    let path = w3proj::mcp_pipe_name();
    if let Some(dir) = std::path::Path::new(&path).parent() {
        w3proj::private_dir(dir).map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, e))?;
    }
    let stream = std::os::unix::net::UnixStream::connect(path)?;
    (&stream).write_all(format!("{line}\n").as_bytes())?;
    read_reply(io::BufReader::new(&stream), note)
}

#[cfg(not(any(windows, unix)))]
fn studio(_: &str, _: &mut dyn FnMut(&str)) -> io::Result<String> {
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
    // Requests still being answered: at the end of the input they're waited for, so a client that closes stdin after
    // its last request (`echo … | w3proj mcp`) still gets every answer.
    let mut answering: Vec<std::thread::JoinHandle<()>> = Vec::new();
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
        answering.retain(|h| !h.is_finished());
        answering.push(std::thread::spawn(move || {
            if let Some(reply) = respond(&line, &*send, &mut |note| print(&out, note)) {
                print(&out, &reply);
            }
        }));
    }
    for h in answering {
        let _ = h.join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(line: &str, _: &mut dyn FnMut(&str)) -> io::Result<String> {
        let id = serde_json::from_str::<Value>(line).unwrap()["id"].clone();
        Ok(json!({ "jsonrpc": "2.0", "id": id, "result": { "from": "app" } }).to_string())
    }
    fn down(_: &str, _: &mut dyn FnMut(&str)) -> io::Result<String> {
        Err(io::ErrorKind::NotFound.into())
    }
    fn parsed(reply: Option<String>) -> Value {
        serde_json::from_str(&reply.unwrap()).unwrap()
    }

    #[test]
    fn initialize_needs_no_app_and_agrees_on_a_version() {
        let old = r#"{"id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#;
        assert_eq!(parsed(respond(old, &down, &mut |_| {}))["result"]["protocolVersion"], "2024-11-05");
        let future = r#"{"id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#;
        assert_eq!(parsed(respond(future, &down, &mut |_| {}))["result"]["protocolVersion"], PROTOCOLS[0]);
    }

    #[test]
    fn tools_go_to_the_app() {
        let got = parsed(respond(r#"{"id":7,"method":"tools/list"}"#, &up, &mut |_| {}));
        assert_eq!((got["id"].clone(), got["result"]["from"].clone()), (json!(7), json!("app")));
    }

    #[test]
    fn without_the_app_the_client_is_told_what_to_do() {
        let list = parsed(respond(r#"{"id":1,"method":"tools/list"}"#, &down, &mut |_| {}));
        assert_eq!(list["result"]["tools"][0]["name"], "studio_status");
        let call = parsed(respond(r#"{"id":2,"method":"tools/call","params":{"name":"terrain_screenshot"}}"#, &down, &mut |_| {}));
        assert_eq!(call["result"]["isError"], true);
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("Start it"));
    }

    #[test]
    fn notifications_get_no_answer_and_rubbish_an_error() {
        assert!(respond(r#"{"method":"notifications/initialized"}"#, &up, &mut |_| {}).is_none());
        assert_eq!(parsed(respond("{nope", &up, &mut |_| {}))["error"]["code"], -32700);
        assert_eq!(parsed(respond(r#"{"id":3,"method":"resources/list"}"#, &up, &mut |_| {}))["error"]["code"], -32601);
    }

    #[test]
    fn a_long_calls_progress_reaches_the_client_before_its_answer() {
        // The app's lines for one request: two notifications, then the answer.
        let lines = concat!(
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t","progress":3,"message":"Working (3 s)"}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t","progress":6,"message":"Working (6 s)"}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":4,"result":{"content":[]}}"#,
            "\n",
        );
        let mut notes = Vec::new();
        let reply = read_reply(lines.as_bytes(), &mut |n| notes.push(n.to_owned())).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&reply).unwrap()["id"], 4);
        assert_eq!(notes.len(), 2);
        assert!(notes[1].contains(r#""progress":6"#));
        // An app that hangs up without an answer is an error, whatever it said before.
        assert!(read_reply(lines.lines().next().unwrap().as_bytes(), &mut |_| {}).is_err());
    }

    #[test]
    fn only_a_call_with_a_progress_token_asks_the_app_for_progress() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let got = seen.clone();
        let app = move |line: &str, note: &mut dyn FnMut(&str)| -> io::Result<String> {
            got.lock().unwrap().push(serde_json::from_str::<Value>(line).unwrap());
            note("a note");
            Ok(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into())
        };
        let mut notes = 0;
        respond(r#"{"id":1,"method":"tools/call","params":{"name":"x","_meta":{"progressToken":7}}}"#, &app, &mut |_| notes += 1);
        respond(r#"{"id":2,"method":"tools/call","params":{"name":"x"}}"#, &app, &mut |_| {});
        respond(r#"{"id":3,"method":"tools/list","params":{"_meta":{"progressToken":7}}}"#, &app, &mut |_| {});
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0]["w3progress"], true);
        assert_eq!(seen[0]["params"]["_meta"]["progressToken"], 7, "the request is otherwise as the client sent it");
        assert!(seen[1].get("w3progress").is_none() && seen[2].get("w3progress").is_none());
        assert_eq!(notes, 1, "what the app says on the way is passed on");
    }

    #[test]
    fn the_revision_tells_the_app_coming_and_going() {
        assert_eq!(revision(&down), "offline");
        let answer = |_: &str, _: &mut dyn FnMut(&str)| -> io::Result<String> { Ok(r#"{"result":{"revision":"a1"}}"#.into()) };
        assert_eq!(revision(&answer), "a1");
    }
}
