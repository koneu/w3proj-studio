//! Optional fast transfer of game files (setting `game.fastTransfer`, off by default): a small HTTP/1.1 server on
//! 127.0.0.1 that answers `GET /<token>/read?install=…&mode=…&tileset=…&path=…` with one file of the game's storage.
//! The page's `fetch` takes it at several times the speed of the Tauri IPC (about 480 MB/s against 100–120 on
//! Windows in the spike); `GameService.read` falls back to the IPC whenever a request here fails.
//!
//! What it may do is narrow on purpose:
//! - it listens on 127.0.0.1 only, on a port the system picks;
//! - every request carries the server's token (128 bits from the OS random generator) in its path, compared in
//!   constant time; the token goes to the page by a Tauri command and is never printed;
//! - `Host` must be `127.0.0.1:<port>` and `Origin` the app's own (a page elsewhere can't ask, and DNS rebinding
//!   can't either); the CORS header names only that origin;
//! - GET only, no body, one route; it looks a game path up in the storage that is already open (`GameSource`), never a
//!   filesystem path, and a path that looks like one (absolute, a drive, `..`) is refused anyway;
//! - the request head is bounded ([`Limits::max_head`]), reads time out, a head must arrive within a deadline, and
//!   connections and requests per connection are bounded;
//! - [`Server::stop`] (and dropping it) closes the port and every open connection; the app stops it when it exits.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Bytes of the token (128 bits); it is written as twice as many lowercase hex digits.
pub const TOKEN_BYTES: usize = 16;

/// What a connection may take. The defaults are the app's; tests make them small.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Bytes of a request head (request line and headers) at most; a longer one gets 431 and the connection closes.
    pub max_head: usize,
    /// Header lines at most.
    pub max_headers: usize,
    /// Connections open at once at most; one more gets 503 and is closed.
    pub max_connections: usize,
    /// Requests on one connection at most; the last answer says `Connection: close`.
    pub max_requests: usize,
    /// One read waiting longer than this ends the connection (an idle keep-alive one too).
    pub read_timeout: Duration,
    /// A request head must arrive whole within this, however slowly its bytes drip in.
    pub head_deadline: Duration,
    /// One write waiting longer than this ends the connection (a client that stopped reading).
    pub write_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_head: 8 * 1024,
            max_headers: 64,
            max_connections: 16,
            max_requests: 1000,
            read_timeout: Duration::from_secs(5),
            head_deadline: Duration::from_secs(10),
            write_timeout: Duration::from_secs(30),
        }
    }
}

/// Why a game file couldn't be served.
#[derive(Debug)]
pub enum ReadError {
    /// That install's storage isn't open (only the Tauri commands open one): 409, the page asks the IPC instead.
    NotOpened,
    /// The storage has no such file: 404 with the message, which the page passes on as `game_read` would.
    NotFound(String),
    /// Anything else: 500, the page asks the IPC instead (which says what went wrong).
    Failed(String),
}

/// The game files the server may hand out: lookups by game path in an already opened storage.
pub trait GameSource: Send + Sync + 'static {
    fn read(&self, install: &str, path: &str, mode: &str, tileset: &Option<String>) -> Result<Vec<u8>, ReadError>;
}

// ---------------------------------------------------------------- request parsing (pure; hostile input)

/// A request head as the server reads it.
#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    /// The origin-form target (`/…`), as sent.
    pub target: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    /// The client asked to close after this answer (or spoke HTTP/1.0 without keep-alive).
    pub close: bool,
}

/// Where the head ends (just past its blank line) in `buf`, if it's there.
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// Parses a request head (up to and including its blank line). Strict: CRLF line ends, single spaces in the request
/// line, an origin-form target, token header names, no folded lines, no body; a refusal says why.
pub fn parse_head(head: &[u8], limits: &Limits) -> Result<Request, &'static str> {
    if head.len() > limits.max_head {
        return Err("head too large");
    }
    let Some(head) = head.strip_suffix(b"\r\n\r\n") else { return Err("no blank line") };
    // Visible ASCII, spaces and tabs, and the CRLFs between lines only.
    if head.iter().any(|&b| !(b == b'\t' || b == b'\r' || b == b'\n' || (0x20..0x7f).contains(&b))) {
        return Err("a byte that isn't printable ASCII");
    }
    let text = std::str::from_utf8(head).map_err(|_| "not ASCII")?;
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or("");
    if line.contains('\r') || line.contains('\n') || line.contains('\t') {
        return Err("a bare CR or LF");
    }
    let parts: Vec<&str> = line.split(' ').collect();
    let [method, target, version] = parts[..] else { return Err("not a request line") };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("not a method");
    }
    if !target.starts_with('/') || target.starts_with("//") {
        return Err("not an origin-form target");
    }
    let http10 = match version {
        "HTTP/1.1" => false,
        "HTTP/1.0" => true,
        _ => return Err("not HTTP/1.x"),
    };
    let (mut host, mut origin) = (None, None);
    let (mut close, mut keep_alive) = (false, false);
    let mut count = 0;
    for line in lines {
        count += 1;
        if count > limits.max_headers {
            return Err("too many headers");
        }
        if line.contains('\r') || line.contains('\n') {
            return Err("a bare CR or LF");
        }
        let Some((name, value)) = line.split_once(':') else { return Err("a header without a colon") };
        if name.is_empty() || !name.bytes().all(is_tchar) {
            // Also a folded line (one starting with a space or tab).
            return Err("not a header name");
        }
        let value = value.trim_matches(|c| c == ' ' || c == '\t');
        match name.to_ascii_lowercase().as_str() {
            "host" => {
                if host.replace(value.to_string()).is_some() {
                    return Err("two Host headers");
                }
            }
            "origin" => {
                if origin.replace(value.to_string()).is_some() {
                    return Err("two Origin headers");
                }
            }
            "content-length" => {
                if value != "0" {
                    return Err("a body");
                }
            }
            "transfer-encoding" => return Err("a body"),
            "connection" => {
                for t in value.split(',') {
                    let t = t.trim().to_ascii_lowercase();
                    if t == "close" {
                        close = true;
                    } else if t == "keep-alive" {
                        keep_alive = true;
                    }
                }
            }
            _ => {}
        }
    }
    // HTTP/1.0 closes unless it asks to keep the connection.
    let close = close || (http10 && !keep_alive);
    Ok(Request { method: method.to_string(), target: target.to_string(), host, origin, close })
}

/// `%XX` and `+` decoded; None for a broken escape or bytes that aren't UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let hex = b.get(i + 1..i + 3)?;
                let hex = std::str::from_utf8(hex).ok()?;
                if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return None;
                }
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// A game path (`Units\UnitData.slk`, `War3.w3mod:Units\UnitData.slk`): nothing that reads as a filesystem path
/// (absolute, a drive, a UNC name, `.` or `..` segments) and no control characters. The lookup never touches the
/// filesystem; this refuses such paths anyway.
pub fn game_path_ok(p: &str) -> bool {
    let b = p.as_bytes();
    if b.is_empty() || b.len() > 1024 || b.iter().any(|&c| c < 0x20 || c == 0x7f) {
        return false;
    }
    if b[0] == b'/' || b[0] == b'\\' || b[0] == b'~' {
        return false;
    }
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return false;
    }
    !p.split(['/', '\\', ':']).any(|seg| seg == ".." || seg == ".")
}

/// Compares two byte strings in time that depends on their lengths only.
fn same(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for (i, &y) in b.iter().enumerate() {
        let x = a.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

/// An answer before it's written.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    /// Whether it may carry the CORS header (the request came from the app's origin).
    pub cors: bool,
    pub close: bool,
}

impl Reply {
    fn refuse(status: u16, why: &str) -> Reply {
        Reply { status, body: why.as_bytes().to_vec(), cors: false, close: true }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// What the server's checks need: its address, token and the app's origin.
struct Gate {
    host: String,
    token: String,
    origin: String,
}

/// The answer to a parsed request: the checks in order (method, Host, Origin, token, route, query), then the lookup.
fn answer(req: &Request, gate: &Gate, source: &dyn GameSource) -> Reply {
    if req.method != "GET" {
        return Reply::refuse(405, "GET only");
    }
    if req.host.as_deref() != Some(gate.host.as_str()) {
        return Reply::refuse(403, "wrong Host");
    }
    if req.origin.as_deref() != Some(gate.origin.as_str()) {
        return Reply::refuse(403, "wrong Origin");
    }
    let (path, query) = req.target.split_once('?').unwrap_or((req.target.as_str(), ""));
    let mut segments = path.split('/');
    segments.next();
    let token = segments.next().unwrap_or("");
    if !same(token.as_bytes(), gate.token.as_bytes()) {
        return Reply::refuse(403, "wrong token");
    }
    let route: Vec<&str> = segments.collect();
    if route != ["read"] {
        return Reply { cors: true, ..Reply::refuse(404, "no such route") };
    }
    let bad = |why: &str| Reply { cors: true, ..Reply::refuse(400, why) };
    let (mut install, mut mode, mut tileset, mut file) = (None, None, None, None);
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let Some(v) = percent_decode(v) else { return bad("a broken escape") };
        let slot = match k {
            "install" => &mut install,
            "mode" => &mut mode,
            "tileset" => &mut tileset,
            "path" => &mut file,
            _ => return bad("an unknown parameter"),
        };
        if slot.replace(v).is_some() {
            return bad("a parameter twice");
        }
    }
    let (Some(install), Some(mode), Some(file)) = (install, mode, file) else { return bad("a parameter missing") };
    if install.is_empty() || install.chars().any(char::is_control) {
        return bad("not an install folder");
    }
    if !game_path_ok(&file) {
        return bad("not a game path");
    }
    let tileset = tileset.filter(|t| !t.is_empty());
    if tileset.as_ref().is_some_and(|t| t.len() > 8 || !t.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return bad("not a tileset");
    }
    let close = req.close;
    match source.read(&install, &file, &mode, &tileset) {
        Ok(body) => Reply { status: 200, body, cors: true, close },
        Err(ReadError::NotFound(m)) => Reply { status: 404, body: m.into_bytes(), cors: true, close },
        Err(ReadError::NotOpened) => Reply { status: 409, body: b"that install isn't open".to_vec(), cors: true, close },
        Err(ReadError::Failed(m)) => Reply { status: 500, body: m.into_bytes(), cors: true, close },
    }
}

fn write_reply(stream: &mut TcpStream, reply: &Reply, origin: &str) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: {}\r\n",
        reply.status,
        reason(reply.status),
        reply.body.len(),
        if reply.status == 200 { "application/octet-stream" } else { "text/plain; charset=utf-8" },
        if reply.close { "close" } else { "keep-alive" },
    );
    if reply.status == 405 {
        head.push_str("Allow: GET\r\n");
    }
    if reply.cors {
        head.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"));
    }
    head.push_str("\r\n");
    if reply.body.len() <= 64 * 1024 {
        let mut all = head.into_bytes();
        all.extend_from_slice(&reply.body);
        stream.write_all(&all)
    } else {
        stream.write_all(head.as_bytes())?;
        stream.write_all(&reply.body)
    }
}

// ---------------------------------------------------------------- the server

struct Shared {
    gate: Gate,
    source: Arc<dyn GameSource>,
    limits: Limits,
    stop: AtomicBool,
    /// Open connections (a clone of each, so stopping can close them), by number.
    conns: Mutex<HashMap<u64, TcpStream>>,
    next: AtomicU64,
    /// Files served (200 answers): for tests and the app smoke.
    served: AtomicU64,
}

/// A running server; stopping or dropping it closes its port and its connections.
pub struct Server {
    addr: SocketAddr,
    shared: Arc<Shared>,
    accept: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Server {
    // Never the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server").field("addr", &self.addr).finish_non_exhaustive()
    }
}

/// 128 bits from the OS random generator, as lowercase hex.
pub fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(format!("the OS random generator: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Server {
    /// Starts serving `source` to pages of `origin` (e.g. `tauri://localhost`) on 127.0.0.1, a port the system picks.
    pub fn start(source: Arc<dyn GameSource>, origin: &str, limits: Limits) -> io::Result<Server> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            gate: Gate { host: format!("127.0.0.1:{}", addr.port()), token: new_token()?, origin: origin.to_string() },
            source,
            limits,
            stop: AtomicBool::new(false),
            conns: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            served: AtomicU64::new(0),
        });
        let s = shared.clone();
        let accept = std::thread::Builder::new().name("game-transfer".into()).spawn(move || accept_loop(listener, s))?;
        Ok(Server { addr, shared, accept: Some(accept) })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The token every request's path starts with. Hand it to the page only; never print it.
    pub fn token(&self) -> &str {
        &self.shared.gate.token
    }

    pub fn origin(&self) -> &str {
        &self.shared.gate.origin
    }

    /// Files served so far.
    pub fn served(&self) -> u64 {
        self.shared.served.load(Ordering::Relaxed)
    }

    /// Connections open now.
    pub fn connections(&self) -> usize {
        self.shared.conns.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// Closes the port, then every open connection. Returns once the listener is gone.
    pub fn stop(&mut self) {
        let Some(accept) = self.accept.take() else { return };
        self.shared.stop.store(true, Ordering::SeqCst);
        // Wakes the accept loop, which sees the flag and drops the listener.
        // (Should that connection fail, the loop is left to end at its next connection rather than waited on for good.)
        if TcpStream::connect_timeout(&self.addr, Duration::from_secs(1)).is_ok() {
            let _ = accept.join();
        }
        if let Ok(conns) = self.shared.conns.lock() {
            for c in conns.values() {
                let _ = c.shutdown(Shutdown::Both);
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    for conn in listener.incoming() {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let mut stream = match conn {
            Ok(s) => s,
            Err(_) => {
                // Out of descriptors and the like: don't spin.
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
        };
        let _ = stream.set_nonblocking(false);
        let id = shared.next.fetch_add(1, Ordering::Relaxed);
        {
            let mut conns = shared.conns.lock().unwrap_or_else(|e| e.into_inner());
            let clone = if conns.len() < shared.limits.max_connections { stream.try_clone().ok() } else { None };
            let Some(clone) = clone else {
                drop(conns);
                let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
                let _ = write_reply(&mut stream, &Reply::refuse(503, "too many connections"), "");
                let _ = stream.shutdown(Shutdown::Both);
                continue;
            };
            conns.insert(id, clone);
        }
        let s = shared.clone();
        let started = std::thread::Builder::new().name("game-transfer-conn".into()).spawn(move || {
            serve_connection(stream, &s);
            s.conns.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        });
        if started.is_err() {
            if let Some(c) = shared.conns.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                let _ = c.shutdown(Shutdown::Both);
            }
        }
    }
}

fn serve_connection(mut stream: TcpStream, shared: &Shared) {
    let limits = &shared.limits;
    let _ = stream.set_nodelay(true);
    let _ = stream.set_write_timeout(Some(limits.write_timeout));
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    for served in 1..=limits.max_requests {
        let started = Instant::now();
        let end = loop {
            if let Some(end) = head_end(&buf) {
                break Some(end);
            }
            if buf.len() >= limits.max_head {
                break None;
            }
            let left = limits.head_deadline.saturating_sub(started.elapsed());
            if left.is_zero() || shared.stop.load(Ordering::SeqCst) {
                if !buf.is_empty() {
                    let _ = write_reply(&mut stream, &Reply::refuse(408, "too slow"), "");
                }
                let _ = stream.shutdown(Shutdown::Both);
                return;
            }
            let _ = stream.set_read_timeout(Some(left.min(limits.read_timeout)));
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    let _ = stream.shutdown(Shutdown::Both);
                    return;
                }
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        };
        let reply = match end {
            Some(end) if end <= limits.max_head => {
                let head: Vec<u8> = buf.drain(..end).collect();
                match parse_head(&head, limits) {
                    Ok(req) => answer(&req, &shared.gate, &*shared.source),
                    Err(why) => Reply::refuse(400, why),
                }
            }
            _ => Reply::refuse(431, "head too large"),
        };
        let close = reply.close || served == limits.max_requests || shared.stop.load(Ordering::SeqCst);
        let reply = Reply { close, ..reply };
        if reply.status == 200 {
            shared.served.fetch_add(1, Ordering::Relaxed);
        }
        if write_reply(&mut stream, &reply, &shared.gate.origin).is_err() || close {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_128_bits_of_hex_and_differ() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 2 * TOKEN_BYTES);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn same_compares_whole_strings() {
        assert!(same(b"abcd", b"abcd"));
        assert!(!same(b"abce", b"abcd"));
        assert!(!same(b"abc", b"abcd"));
        assert!(!same(b"abcde", b"abcd"));
        assert!(!same(b"", b"abcd"));
        // Lengths that differ by a multiple of 256 still differ.
        assert!(!same(&[0u8; 256], &[]));
    }

    #[test]
    fn game_paths_that_read_as_filesystem_paths_are_refused() {
        for ok in ["Units\\UnitData.slk", "War3.w3mod:Units/UnitData.slk", "_Locales\\enus.w3mod:x.txt", "a..b.txt"] {
            assert!(game_path_ok(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "\\\\server\\share\\x", "\\Windows\\x", "C:\\Windows\\win.ini", "c:/x", "..\\..\\x", "Units/../../x", "War3.w3mod:..\\x", "./x", "~/x", "a\u{0}b", "a\nb"] {
            assert!(!game_path_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn percent_decoding_refuses_broken_escapes_and_non_utf8() {
        assert_eq!(percent_decode("Units%5CUnitData.slk").as_deref(), Some("Units\\UnitData.slk"));
        assert_eq!(percent_decode("a+b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("%"), None);
        assert_eq!(percent_decode("%4"), None);
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%+1"), None);
        assert_eq!(percent_decode("%ff"), None);
    }
}
