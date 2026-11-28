//! The fast game file transfer's server (backend::fastgame) over real sockets: what it serves, and every check of
//! its security list (127.0.0.1 only, token, Host, Origin, CORS, GET only, timeouts, bounded heads, connections and
//! requests, no filesystem paths, the port closed on stop), then hostile request bytes in seeded rounds
//! (`W3PROJ_ROBUSTNESS_ROUNDS`, as robustness.rs): none panics, hangs or stops the server serving.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use backend::fastgame::{parse_head, Limits, ReadError, GameSource, Server};

const ORIGIN: &str = "tauri://localhost";
const INSTALL: &str = "/games/w3";

/// A stand-in storage: a few files of the one open install, counting the lookups.
struct Fake {
    files: HashMap<String, Vec<u8>>,
    asked: AtomicUsize,
}

impl GameSource for Fake {
    fn read(&self, install: &str, path: &str, mode: &str, tileset: &Option<String>) -> Result<Vec<u8>, ReadError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        if install != INSTALL {
            return Err(ReadError::NotOpened);
        }
        if mode == "broken" {
            return Err(ReadError::Failed("io: the storage is busy".into()));
        }
        let key = format!("{}{}", tileset.as_deref().map(|t| format!("{t}:")).unwrap_or_default(), path.replace('/', "\\")).to_lowercase();
        self.files.get(&key).cloned().ok_or_else(|| ReadError::NotFound(format!("not found: {path}")))
    }
}

fn fake() -> Arc<Fake> {
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    let files = HashMap::from([
        ("units\\unitdata.slk".to_string(), b"ID;PWXL;N;E\r\n".to_vec()),
        ("big.dds".to_string(), big),
        ("l:tiles.dds".to_string(), vec![7, 7, 7]),
        ("war3.w3mod:units\\a.txt".to_string(), vec![1, 2, 3]),
    ]);
    Arc::new(Fake { files, asked: AtomicUsize::new(0) })
}

fn quick() -> Limits {
    Limits {
        max_connections: 4,
        max_requests: 5,
        read_timeout: Duration::from_millis(300),
        head_deadline: Duration::from_millis(800),
        write_timeout: Duration::from_secs(5),
        ..Limits::default()
    }
}

fn start(limits: Limits) -> (Server, Arc<Fake>) {
    let f = fake();
    (Server::start(f.clone(), ORIGIN, limits).unwrap(), f)
}

#[derive(Debug)]
struct Answer {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// Reads one answer off a stream (None when it closed first).
fn read_answer(s: &mut TcpStream, pending: &mut Vec<u8>) -> Option<Answer> {
    let mut chunk = [0u8; 65536];
    let end = loop {
        if let Some(i) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => pending.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8(pending.drain(..end).collect()).unwrap();
    let mut lines = head.trim_end().split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(": ")).map(|(k, v)| (k.to_ascii_lowercase(), v.to_string())).collect();
    let len: usize = headers["content-length"].parse().unwrap();
    while pending.len() < len {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => pending.extend_from_slice(&chunk[..n]),
        }
    }
    let body = pending.drain(..len).collect();
    Some(Answer { status, headers, body })
}

fn connect(addr: SocketAddr) -> TcpStream {
    let s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s
}

/// One raw request on a new connection, its answer.
fn raw(addr: SocketAddr, bytes: &[u8]) -> Option<Answer> {
    let mut s = connect(addr);
    s.write_all(bytes).ok()?;
    read_answer(&mut s, &mut Vec::new())
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn target(server: &Server, path: &str) -> String {
    format!("/{}/read?install={}&mode=hd&path={}", server.token(), enc(INSTALL), enc(path))
}

fn get(server: &Server, target: &str, extra: &str) -> String {
    format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {ORIGIN}\r\n{extra}\r\n", server.port())
}

/// Whether the server closes the connection (reads end) within `within`.
fn closes_within(s: &mut TcpStream, within: Duration) -> bool {
    s.set_read_timeout(Some(within)).unwrap();
    let started = Instant::now();
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => return true,
            Ok(_) => continue,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => return true,
            Err(_) => return started.elapsed() < within,
        }
    }
}

#[test]
fn a_file_is_served_byte_for_byte_with_cors_for_the_app_only() {
    let (server, f) = start(Limits::default());
    assert!(server.addr().ip().is_loopback(), "bound to {}", server.addr());
    assert_eq!(server.addr().ip().to_string(), "127.0.0.1");
    let a = raw(server.addr(), get(&server, &target(&server, "Units\\UnitData.slk"), "").as_bytes()).unwrap();
    assert_eq!(a.status, 200);
    assert_eq!(a.body, f.files["units\\unitdata.slk"]);
    assert_eq!(a.headers["access-control-allow-origin"], ORIGIN);
    assert_eq!(a.headers["cache-control"], "no-store");
    // A big file, a full path and a tileset's file.
    let a = raw(server.addr(), get(&server, &target(&server, "big.dds"), "").as_bytes()).unwrap();
    assert_eq!((a.status, a.body.len()), (200, 3_000_000));
    assert!(a.body == f.files["big.dds"]);
    let a = raw(server.addr(), get(&server, &target(&server, "War3.w3mod:Units\\a.txt"), "").as_bytes()).unwrap();
    assert_eq!((a.status, a.body), (200, vec![1, 2, 3]));
    let t = format!("{}&tileset=L", target(&server, "tiles.dds"));
    let a = raw(server.addr(), get(&server, &t, "").as_bytes()).unwrap();
    assert_eq!((a.status, a.body), (200, vec![7, 7, 7]));
    assert_eq!(server.served(), 4);
}

#[test]
fn missing_files_say_so_and_an_install_not_open_or_a_failure_is_told_apart() {
    let (server, _) = start(Limits::default());
    let a = raw(server.addr(), get(&server, &target(&server, "Units\\Nope.slk"), "").as_bytes()).unwrap();
    assert_eq!((a.status, String::from_utf8(a.body).unwrap()), (404, "not found: Units\\Nope.slk".to_string()));
    assert_eq!(a.headers["access-control-allow-origin"], ORIGIN, "the page must read the message");
    let other = format!("/{}/read?install=%2Fother&mode=hd&path=x.txt", server.token());
    assert_eq!(raw(server.addr(), get(&server, &other, "").as_bytes()).unwrap().status, 409);
    let broken = format!("/{}/read?install={}&mode=broken&path=x.txt", server.token(), enc(INSTALL));
    assert_eq!(raw(server.addr(), get(&server, &broken, "").as_bytes()).unwrap().status, 500);
    assert_eq!(server.served(), 0);
}

#[test]
fn the_token_is_required_and_compared_whole() {
    let (server, f) = start(Limits::default());
    let good = target(&server, "Units\\UnitData.slk");
    let token = server.token().to_string();
    assert_eq!(token.len(), 32);
    let mut off_by_one = token.clone().into_bytes();
    off_by_one[31] = if off_by_one[31] == b'0' { b'1' } else { b'0' };
    let off_by_one = String::from_utf8(off_by_one).unwrap();
    for bad in [
        good.replacen(&token, &off_by_one, 1),
        good.replacen(&token, &token[..31], 1),
        good.replacen(&token, &format!("{token}0"), 1),
        good.replacen(&token, &token.to_uppercase(), 1),
        good.replacen(&format!("/{token}"), "", 1),
        "/read?path=x".to_string(),
        "/".to_string(),
    ] {
        let a = raw(server.addr(), get(&server, &bad, "").as_bytes()).unwrap();
        assert_eq!(a.status, 403, "{bad}");
        assert!(!a.headers.contains_key("access-control-allow-origin"));
    }
    assert_eq!(f.asked.load(Ordering::SeqCst), 0, "nothing looked up without the token");
    // Each server has its own token.
    let (other, _) = start(Limits::default());
    assert_ne!(other.token(), server.token());
    assert!(!format!("{server:?}").contains(server.token()), "the token is never printed");
    // Control: the right token works.
    assert_eq!(raw(server.addr(), get(&server, &good, "").as_bytes()).unwrap().status, 200);
}

#[test]
fn host_and_origin_must_be_exactly_the_servers_and_the_apps() {
    let (server, f) = start(Limits::default());
    let t = target(&server, "Units\\UnitData.slk");
    let port = server.port();
    let req = |host: Option<String>, origin: Option<&str>| {
        let mut r = format!("GET {t} HTTP/1.1\r\n");
        if let Some(h) = host {
            r += &format!("Host: {h}\r\n");
        }
        if let Some(o) = origin {
            r += &format!("Origin: {o}\r\n");
        }
        r + "\r\n"
    };
    for (host, origin) in [
        (None, Some(ORIGIN)),
        (Some(format!("localhost:{port}")), Some(ORIGIN)),
        (Some("127.0.0.1".to_string()), Some(ORIGIN)),
        (Some(format!("evil.example:{port}")), Some(ORIGIN)),
        (Some(format!("127.0.0.1:{}", port.wrapping_add(1))), Some(ORIGIN)),
        (Some(format!("127.0.0.1:{port}")), None),
        (Some(format!("127.0.0.1:{port}")), Some("null")),
        (Some(format!("127.0.0.1:{port}")), Some("http://evil.example")),
        (Some(format!("127.0.0.1:{port}")), Some("tauri://localhost.evil")),
        (Some(format!("127.0.0.1:{port}")), Some("http://127.0.0.1")),
    ] {
        let a = raw(server.addr(), req(host.clone(), origin).as_bytes()).unwrap();
        assert_eq!(a.status, 403, "{host:?} {origin:?}");
        assert!(!a.headers.contains_key("access-control-allow-origin"), "{host:?} {origin:?}");
    }
    // Two Hosts are refused outright.
    let two = format!("GET {t} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nHost: evil\r\nOrigin: {ORIGIN}\r\n\r\n");
    assert_eq!(raw(server.addr(), two.as_bytes()).unwrap().status, 400);
    assert_eq!(f.asked.load(Ordering::SeqCst), 0);
    assert_eq!(raw(server.addr(), req(Some(format!("127.0.0.1:{port}")), Some(ORIGIN)).as_bytes()).unwrap().status, 200);
}

#[test]
fn only_get_and_no_body() {
    let (server, f) = start(Limits::default());
    let t = target(&server, "Units\\UnitData.slk");
    for m in ["POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH", "CONNECT", "TRACE"] {
        let r = get(&server, &t, "").replacen("GET", m, 1);
        let a = raw(server.addr(), r.as_bytes()).unwrap();
        assert_eq!(a.status, 405, "{m}");
        assert_eq!(a.headers["allow"], "GET");
    }
    for extra in ["Content-Length: 5\r\n", "Transfer-Encoding: chunked\r\n"] {
        let a = raw(server.addr(), format!("{}hello", get(&server, &t, extra)).as_bytes()).unwrap();
        assert_eq!(a.status, 400, "{extra}");
    }
    for bad in ["get", "G\u{e9}T"] {
        let r = get(&server, &t, "").replacen("GET", bad, 1);
        assert_eq!(raw(server.addr(), r.as_bytes()).unwrap().status, 400, "{bad}");
    }
    assert_eq!(f.asked.load(Ordering::SeqCst), 0);
}

#[test]
fn filesystem_paths_and_other_routes_are_refused() {
    let (server, f) = start(Limits::default());
    let tok = server.token().to_string();
    for p in ["/etc/passwd", "C:\\Windows\\win.ini", "c:/boot.ini", "\\\\server\\share\\x", "..\\..\\..\\x", "Units/../../x", "War3.w3mod:..\\x", "", "a\u{0}b"] {
        let a = raw(server.addr(), get(&server, &target(&server, p), "").as_bytes()).unwrap();
        assert_eq!(a.status, 400, "{p:?}");
    }
    for route in [
        format!("/{tok}/fs?path=%2Fetc%2Fpasswd"),
        format!("/{tok}/fs/etc/passwd"),
        format!("/{tok}/read/../fs?path=x"),
        format!("/{tok}/read/"),
        format!("/{tok}"),
        format!("/{tok}/"),
        format!("/{tok}/list"),
        format!("/{tok}/READ?install=x&mode=hd&path=x"),
    ] {
        let a = raw(server.addr(), get(&server, &route, "").as_bytes()).unwrap();
        assert_eq!(a.status, 404, "{route}");
    }
    // Absolute-form and authority targets aren't origin-form.
    for t in [format!("http://127.0.0.1:{}/{tok}/read?path=x", server.port()), format!("//evil/{tok}/read"), "*".to_string()] {
        assert_eq!(raw(server.addr(), get(&server, &t, "").as_bytes()).unwrap().status, 400, "{t}");
    }
    // Parameters: unknown, twice, missing, broken escapes.
    for q in ["install=x&mode=hd&path=a&fs=1", "install=x&mode=hd&path=a&path=b", "mode=hd&path=a", "install=x&mode=hd&path=%zz", "install=x&mode=hd&path=a&tileset=..%2F"] {
        let a = raw(server.addr(), get(&server, &format!("/{tok}/read?{q}"), "").as_bytes()).unwrap();
        assert_eq!(a.status, 400, "{q}");
    }
    assert_eq!(f.asked.load(Ordering::SeqCst), 0);
}

#[test]
fn a_huge_head_is_refused_and_closed() {
    let (server, _) = start(quick());
    let t = target(&server, "Units\\UnitData.slk");
    let big = get(&server, &t, &format!("X-Pad: {}\r\n", "a".repeat(9000)));
    let mut s = connect(server.addr());
    let _ = s.write_all(big.as_bytes());
    let a = read_answer(&mut s, &mut Vec::new()).unwrap();
    assert_eq!(a.status, 431);
    assert!(closes_within(&mut s, Duration::from_secs(30)));
    // A head that never ends is cut at the limit too.
    let mut s = connect(server.addr());
    let _ = s.write_all(&vec![b'a'; 20000]);
    assert_eq!(read_answer(&mut s, &mut Vec::new()).map(|a| a.status), Some(431));
    // Too many header lines.
    let many: String = (0..100).map(|i| format!("X-{i}: y\r\n")).collect();
    assert_eq!(raw(server.addr(), get(&server, &t, &many).as_bytes()).unwrap().status, 400);
    // Control: a head under the limit is served.
    assert_eq!(raw(server.addr(), get(&server, &t, "X-Pad: aaaa\r\n").as_bytes()).unwrap().status, 200);
}

#[test]
fn slow_or_idle_clients_are_timed_out() {
    let (server, _) = start(quick());
    // Idle: nothing sent.
    let mut s = connect(server.addr());
    let started = Instant::now();
    // The limit is 0.3 s; the wait is wide so that a loaded machine doesn't fail it (only a connection that stays open does).
    assert!(closes_within(&mut s, Duration::from_secs(60)), "an idle connection stays open");
    assert!(started.elapsed() < Duration::from_secs(30), "closed after {:?}", started.elapsed());
    // A head dripping in a byte every 200 ms (each read in time, the whole head not).
    let mut s = connect(server.addr());
    let started = Instant::now();
    let head = get(&server, &target(&server, "Units\\UnitData.slk"), "");
    let mut writer = s.try_clone().unwrap();
    let drip = std::thread::spawn(move || {
        for b in head.bytes() {
            if writer.write_all(&[b]).is_err() || started.elapsed() > Duration::from_secs(60) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    let mut pending = Vec::new();
    let a = read_answer(&mut s, &mut pending);
    let took = started.elapsed();
    assert!(a.as_ref().is_none_or(|a| a.status == 408), "a dripping head was served: {a:?}");
    // The head deadline (0.8 s), not the client giving up (60 s), ended it.
    assert!(took < Duration::from_secs(30), "a dripping head held the connection {took:?}");
    let _ = s.shutdown(std::net::Shutdown::Both);
    drip.join().unwrap();
}

#[test]
fn connections_and_requests_per_connection_are_bounded() {
    let (server, _) = start(quick());
    let t = target(&server, "Units\\UnitData.slk");
    // Keep-alive: up to max_requests on one connection, the last says close.
    let mut s = connect(server.addr());
    let mut pending = Vec::new();
    for i in 1..=5 {
        s.write_all(get(&server, &t, "").as_bytes()).unwrap();
        let a = read_answer(&mut s, &mut pending).unwrap();
        assert_eq!(a.status, 200);
        assert_eq!(a.headers["connection"], if i == 5 { "close" } else { "keep-alive" }, "request {i}");
    }
    let _ = s.write_all(get(&server, &t, "").as_bytes());
    assert!(read_answer(&mut s, &mut pending).is_none(), "a sixth request on one connection was served");
    // Pipelined requests in one write are answered in order.
    let mut s = connect(server.addr());
    s.write_all(format!("{}{}", get(&server, &t, ""), get(&server, &target(&server, "War3.w3mod:Units\\a.txt"), "Connection: close\r\n")).as_bytes()).unwrap();
    let mut pending = Vec::new();
    assert_eq!(read_answer(&mut s, &mut pending).unwrap().body, b"ID;PWXL;N;E\r\n");
    let a = read_answer(&mut s, &mut pending).unwrap();
    assert_eq!((a.body, a.headers["connection"].as_str()), (vec![1, 2, 3], "close"));
    // Connections: four held open, a fifth is refused. A server of its own: on the one above a connection that is still
    // closing counts among the four (then a held one gets the 503 and the fifth its place), and idle ones are dropped
    // after 0.3 s, which a busy machine can take before the fifth is there (both: the fifth served, 8 of 150 runs
    // beside a CPU load, 2026-11-26).
    let patient = Duration::from_secs(30);
    let (server, _) = start(Limits { read_timeout: patient, head_deadline: patient, ..quick() });
    let t = target(&server, "Units\\UnitData.slk");
    let held: Vec<TcpStream> = (0..4).map(|_| connect(server.addr())).collect();
    let deadline = Instant::now() + Duration::from_secs(30);
    while server.connections() < 4 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(server.connections(), 4);
    let mut fifth = connect(server.addr());
    let _ = fifth.write_all(get(&server, &t, "").as_bytes());
    let a = read_answer(&mut fifth, &mut Vec::new());
    assert!(a.as_ref().is_none_or(|a| a.status == 503), "{a:?}");
    drop(held);
    // Freed places are taken again once the held ones have ended.
    let deadline = Instant::now() + Duration::from_secs(30);
    while server.connections() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(raw(server.addr(), get(&server, &t, "").as_bytes()).unwrap().status, 200);
}

#[test]
fn stopping_closes_the_port_and_open_connections() {
    let (mut server, _) = start(Limits::default());
    let addr = server.addr();
    let t = target(&server, "Units\\UnitData.slk");
    let mut kept = connect(addr);
    kept.write_all(get(&server, &t, "").as_bytes()).unwrap();
    assert_eq!(read_answer(&mut kept, &mut Vec::new()).unwrap().status, 200);
    server.stop();
    assert!(TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_err(), "the port still takes connections");
    assert!(closes_within(&mut kept, Duration::from_secs(30)), "a keep-alive connection stayed open");
    // Dropping does it too.
    let (server, _) = start(Limits::default());
    let addr = server.addr();
    drop(server);
    assert!(TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_err());
}

// ---------------------------------------------------------------- hostile input

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn rounds() -> usize {
    std::env::var("W3PROJ_ROBUSTNESS_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(200)
}

/// A valid request damaged in one of several ways: bytes flipped, inserted, cut, repeated; random bytes; pieces of
/// HTTP put together at random.
fn hostile(rng: &mut Rng, valid: &[u8]) -> Vec<u8> {
    const PIECES: &[&[u8]] = &[b"GET ", b"POST ", b" HTTP/1.1", b" HTTP/1.0", b"\r\n", b"\n", b"\r", b"\r\n\r\n", b"Host: ", b"Origin: ", b"Content-Length: ", b"Transfer-Encoding: chunked", b"Connection: keep-alive", b":", b" ", b"\t", b"%", b"%00", b"..", b"/", b"\\", b"?", b"&", b"=", b"\0", b"\xff", b"\xc3\xa9"];
    let mut v = valid.to_vec();
    match rng.below(6) {
        0 => {
            for _ in 0..1 + rng.below(8) {
                if v.is_empty() { break; }
                let i = rng.below(v.len());
                v[i] = rng.next() as u8;
            }
        }
        1 => {
            for _ in 0..1 + rng.below(4) {
                let piece = PIECES[rng.below(PIECES.len())];
                let i = rng.below(v.len() + 1);
                v.splice(i..i, piece.iter().copied());
            }
        }
        2 => {
            let i = rng.below(v.len() + 1);
            v.truncate(i);
        }
        3 => {
            let a = rng.below(v.len());
            let b = (a + rng.below(64)).min(v.len());
            let piece = v[a..b].to_vec();
            for _ in 0..rng.below(200) {
                v.extend_from_slice(&piece);
            }
        }
        4 => v = (0..rng.below(4096)).map(|_| rng.next() as u8).collect(),
        _ => v = (0..rng.below(40)).flat_map(|_| PIECES[rng.below(PIECES.len())].iter().copied()).collect(),
    }
    v
}

#[test]
fn hostile_heads_never_panic_the_parser() {
    let limits = Limits::default();
    let valid = b"GET /0123456789abcdef0123456789abcdef/read?install=x&mode=hd&path=Units%5CUnitData.slk HTTP/1.1\r\nHost: 127.0.0.1:1\r\nOrigin: tauri://localhost\r\nConnection: keep-alive\r\n\r\n";
    assert!(parse_head(valid, &limits).is_ok(), "control: the valid head parses");
    let mut rng = Rng::new(0xfa57);
    for round in 0..rounds() * 50 {
        let bytes = hostile(&mut rng, valid);
        let r = catch_unwind(AssertUnwindSafe(|| parse_head(&bytes, &limits)));
        assert!(r.is_ok(), "round {round}: parse_head panicked on {bytes:?}");
    }
}

#[test]
fn hostile_requests_never_hang_or_stop_the_server() {
    let (server, f) = start(quick());
    let valid = get(&server, &target(&server, "Units\\UnitData.slk"), "").into_bytes();
    let mut rng = Rng::new(0xbad5eed);
    let n = (rounds() / 2).max(20);
    for round in 0..n {
        let bytes = hostile(&mut rng, &valid);
        let mut s = connect(server.addr());
        let _ = s.write_all(&bytes);
        let _ = s.shutdown(std::net::Shutdown::Write);
        // Either an answer or a close, well within the head deadline plus the write.
        assert!(closes_within(&mut s, Duration::from_secs(60)), "round {round}: the connection hung on {bytes:?}");
    }
    // Still serving, and nothing was read except by requests that passed every check.
    let a = raw(server.addr(), &valid).unwrap();
    assert_eq!((a.status, a.body), (200, b"ID;PWXL;N;E\r\n".to_vec()));
    assert!(f.asked.load(Ordering::SeqCst) <= n + 1);
}

/// With the real game (W3PROJ_GAME): the bytes the server sends are `game_read`'s, for a few files. Skipped without.
#[test]
fn with_the_game_the_server_sends_what_game_read_returns() {
    let Ok(install) = std::env::var("W3PROJ_GAME") else {
        eprintln!("skipped: needs W3PROJ_GAME");
        return;
    };
    let cache = Arc::new(backend::GameCache::default());
    let g = cache.get(&install).unwrap();
    let server = Server::start(cache.clone(), ORIGIN, Limits::default()).unwrap();
    for path in ["Units\\UnitData.slk", "Units\\Human\\Footman\\Footman.mdx", "War3.w3mod:Scripts\\common.j"] {
        let want = backend::game_read(&g, path, "hd", &None).unwrap();
        let t = format!("/{}/read?install={}&mode=hd&path={}", server.token(), enc(&install), enc(path));
        let a = raw(server.addr(), get(&server, &t, "").as_bytes()).unwrap();
        assert_eq!(a.status, 200, "{path}");
        assert!(a.body == want, "{path}: {} bytes, game_read {}", a.body.len(), want.len());
    }
    // An install that isn't the open one is never opened by the server.
    let t = format!("/{}/read?install=%2Ftmp&mode=hd&path=x.txt", server.token());
    assert_eq!(raw(server.addr(), get(&server, &t, "").as_bytes()).unwrap().status, 409);
}
