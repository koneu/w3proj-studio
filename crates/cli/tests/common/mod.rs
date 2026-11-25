//! Shared by the system tests of the CLI (`mod common;`).
#![allow(dead_code)] // each test crate compiles this module and uses only some of it

use std::process::Command;

/// Keeps what this machine has set up out of a `w3proj` run. The tests' fixtures are made up, and the game's
/// TriggerData.txt doesn't know their functions, so the game is switched off. "none" rather than an unset W3PROJ_GAME:
/// without it the CLI looks in the Windows default install. `--game` still wins, and a test that needs the real game
/// sets W3PROJ_GAME after this.
pub fn hermetic(cmd: &mut Command) -> &mut Command {
    cmd.env_remove("W3PROJ_FORMATS").env("W3PROJ_GAME", "none")
}

/// The `w3proj` binary under test, made [`hermetic`]: every test starts it through this.
pub fn w3proj_cmd() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_w3proj"));
    hermetic(&mut cmd);
    cmd
}

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
