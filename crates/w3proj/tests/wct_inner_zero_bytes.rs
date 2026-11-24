//! Regression test for `wct.rs` taking a text by its stored length (trigger folders stage 2a, fe7554f9): the
//! Frostwolf Clan map's custom texts end in padding zeros before the terminating one. The reader used to refuse any
//! zero byte inside a text, so such a map's war3map.wct didn't parse and unpack kept both trigger files raw instead
//! of splitting them into map/triggers/.
//!
//! Only the public API that `wct.rs` had before the fix and has now is used, so `fails-without.mjs` can run it
//! against the old reader. Its file can't be taken whole from before the fix (the crate around it moved on), so the
//! base is dev's `wct.rs` with only the reader's check put back, `s[n - 1] != 0 || s[..n - 1].contains(&0)`:
//!
//!   node scripts/fails-without.mjs --base <that commit> --run "cargo test -p w3proj --test wct_inner_zero_bytes" \
//!     ../crates/w3proj/tests/wct_inner_zero_bytes.rs ../crates/w3proj/src/wct.rs

use std::path::Path;

use w3proj::trigger_layout as tl;
use w3proj::triggerdata::TriggerData;
use w3proj::wct;

fn put(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

/// A Reforged war3map.wct: version 1, empty comment, no header text, then `texts` as stored (each with its zero).
fn reforged(texts: &[&[u8]]) -> Vec<u8> {
    let mut b = Vec::new();
    put(&mut b, 0x8000_0004);
    put(&mut b, 1);
    b.push(0); // comment
    put(&mut b, 0); // header: no text
    for t in texts {
        put(&mut b, t.len() as u32);
        b.extend_from_slice(t);
    }
    b
}

#[test]
fn padding_zeros_before_the_terminating_one_belong_to_the_text() {
    let b = reforged(&[b"library Padded\nendlibrary\0\0\0", b"zero\0inside\0", b"plain\0"]);
    let w = wct::parse(&b).expect("zero bytes inside a text are part of it, not an error");
    assert_eq!(
        w.texts,
        vec![Some("library Padded\nendlibrary\0\0".to_string()), Some("zero\0inside".to_string()), Some("plain".to_string())]
    );
    assert_eq!(wct::write(&w), b, "written back byte for byte");

    // Controls: the terminating zero is still required, and a text running past the end is still refused.
    let mut unterminated = b.clone();
    *unterminated.last_mut().unwrap() = b'x';
    assert!(wct::parse(&unterminated).is_err());
    let mut truncated = reforged(&[b"plain\0"]);
    truncated.pop();
    assert!(wct::parse(&truncated).is_err());
}

/// What the fix is for: a map whose script item ends in padding zeros splits into map/triggers/ (the zeros written as
/// U+10FF00) and packs back to the very same war3map.wct.
#[test]
fn a_map_with_padded_texts_splits_into_the_trigger_folders() {
    let data = TriggerData::parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/TriggerData.txt")).unwrap());
    let (wtg, wct_bytes) = tl::sample_map(false);
    // Precondition: the sample holds a padded text (stored "...endlibrary\0\0\0"), else this proves nothing.
    assert!(wct_bytes.windows(13).any(|s| s == b"endlibrary\0\0\0"), "the sample map lost its padded text");

    let files = tl::split_map(&wtg, &wct_bytes, &data, tl::Lang::Jass).expect("a map with padded texts splits");
    let padded = files.iter().find(|(k, _)| k.contains("Padded")).map(|(_, v)| String::from_utf8(v.clone()).unwrap()).expect("Padded's file");
    assert!(padded.contains("endlibrary\u{10FF00}\u{10FF00}"), "{padded}");
    let (wtg_back, wct_back, _) = tl::assemble(&files, tl::Lang::Jass, Some(&data)).unwrap();
    assert!(wtg_back == wtg && wct_back == wct_bytes, "packs back byte for byte");
}
