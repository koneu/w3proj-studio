//! `war3map.wtg` nests by recursion (actions in ifs, parameters in array indices and calls). A
//! stack overflow can't be caught: it would take the whole app down, so a crafted map must be
//! turned away by the parser. Needs no game: the trigger data here is made up.
//!
//! Each shape is also parsed at a sane depth, which has to work: otherwise an error at the deep
//! end could just mean the test built a broken file.

use w3proj::triggerdata::TriggerData;
use w3proj::wtg;

const DATA: &str = "[TriggerActions]\nDoNothing=0,nothing\nSetX=0,integer\n";
/// Just inside the parser's limit: this much has to fit, in the unoptimized build too.
const SANE: usize = 120;
const HOSTILE: usize = 200_000;

fn put(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

/// A classic version 7 file holding one trigger, with `actions` already written.
fn file(actions: &[u8]) -> Vec<u8> {
    let mut b = b"WTG!".to_vec();
    for v in [7, 0, 0, 0, 1] {
        put(&mut b, v); // version, categories, unknown, variables, triggers
    }
    b.extend_from_slice(b"t\0\0"); // name, description
    for v in [0, 1, 0, 0, 0, u32::MAX, 1] {
        put(&mut b, v); // comment, enabled, custom, off, on init, parent, one top-level action
    }
    b.extend_from_slice(actions);
    b
}

/// An action holding an action, `depth` levels.
fn nested_actions(depth: usize) -> Vec<u8> {
    let mut b = Vec::new();
    for i in 0..depth {
        put(&mut b, 2); // kind
        if i > 0 {
            put(&mut b, 0); // a child's group
        }
        b.extend_from_slice(b"DoNothing\0");
        put(&mut b, 1); // enabled
        put(&mut b, u32::from(i + 1 < depth)); // children
    }
    b
}

/// An action whose parameter is indexed by a parameter, `depth` levels.
fn nested_parameters(depth: usize) -> Vec<u8> {
    let mut b = Vec::new();
    put(&mut b, 2); // kind
    b.extend_from_slice(b"SetX\0");
    put(&mut b, 1); // enabled
    for i in 0..depth {
        put(&mut b, 0); // type
        b.push(0); // value
        put(&mut b, 0); // no call
        put(&mut b, u32::from(i + 1 < depth)); // an index follows
    }
    put(&mut b, 0); // children
    b
}

/// Parses in a thread with the default stack of a Rust thread; an overflow aborts the test run.
fn parse(bytes: Vec<u8>) -> Result<(), String> {
    std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(move || wtg::to_json(&bytes, &TriggerData::parse(DATA)).map(drop).map_err(|e| e.to_string()))
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn nested_actions_parse_up_to_a_limit() {
    parse(file(&nested_actions(SANE))).unwrap();
    assert!(parse(file(&nested_actions(HOSTILE))).unwrap_err().contains("nested"));
}

#[test]
fn nested_parameters_parse_up_to_a_limit() {
    parse(file(&nested_parameters(SANE))).unwrap();
    assert!(parse(file(&nested_parameters(HOSTILE))).unwrap_err().contains("nested"));
}
