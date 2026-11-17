//! Shared by the system tests of the CLI (`mod common;`).
#![allow(dead_code)] // each test crate compiles this module and uses only some of it

/// Whether a test that needs something this machine may not have (the game, a folder that can't be searched) must
/// fail instead of skip: `W3PROJ_REQUIRE_CORPUS=1`, the switch the TypeScript tests use (`corpusRequired`).
pub fn corpus_required() -> bool {
    std::env::var("W3PROJ_REQUIRE_CORPUS").as_deref() == Ok("1")
}

/// Skips the rest of a test (the caller returns) for a missing part, saying so on stderr, or panics when
/// `W3PROJ_REQUIRE_CORPUS=1`: a run that must have it never passes without it.
pub fn skip_or_fail(why: &str) {
    assert!(!corpus_required(), "W3PROJ_REQUIRE_CORPUS=1 but {why}");
    eprintln!("skipped: {why}");
}
