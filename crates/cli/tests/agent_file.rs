//! The agent file (AGENTS.md) a new or unpacked project gets: every command it names exists, it is written only when
//! absent, a sync never rewrites it, and it never goes into a packed map.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use w3proj::agent_file::{self, Kind};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mini-map")
}

fn workdir(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("agent-file-{test}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn w3proj(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_w3proj")).args(args).env_remove("W3PROJ_FORMATS").output().unwrap()
}

fn ok(args: &[&str]) -> String {
    let o = w3proj(args);
    let out = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    assert!(o.status.success(), "w3proj {args:?} failed: {out}");
    out
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// The subcommand names a `--help` lists under "Commands:".
fn commands(help: &str) -> BTreeSet<String> {
    help.lines()
        .skip_while(|l| !l.starts_with("Commands:"))
        .skip(1)
        .take_while(|l| !l.trim().is_empty())
        .filter_map(|l| l.split_whitespace().next())
        .filter(|n| *n != "help")
        .map(String::from)
        .collect()
}

const KINDS: [Kind; 3] = [Kind::Flat, Kind::Split, Kind::Campaign];

#[test]
fn the_text_names_only_commands_and_flags_that_exist() {
    let top = commands(&ok(&["--help"]));
    let terrain = commands(&ok(&["terrain", "--help"]));
    assert!(top.contains("pack") && top.contains("rebuild") && top.contains("check"), "control: the parse finds commands");
    for kind in KINDS {
        let text = agent_file::text(kind);
        let mut named = 0;
        for chunk in text.split("`w3proj ").skip(1) {
            let span = chunk.split('`').next().unwrap();
            let words: Vec<&str> = span.split_whitespace().take_while(|w| !w.starts_with('<') || w.len() == 1).collect();
            let sub = words.first().copied().unwrap_or("");
            if sub.starts_with("--") || sub.is_empty() {
                continue; // `w3proj --help`
            }
            assert!(top.contains(sub), "{kind:?}: `w3proj {span}`: no command {sub}");
            named += 1;
            let mut help_args = vec![sub];
            if sub == "terrain" {
                let leaf = words.get(1).copied().unwrap_or("");
                assert!(terrain.contains(leaf), "{kind:?}: `w3proj {span}`: no terrain command {leaf}");
                help_args.push(leaf);
            }
            help_args.push("--help");
            let help = ok(&help_args);
            for flag in span.split_whitespace().filter(|w| w.starts_with('-') && w.len() > 1) {
                assert!(help.contains(flag), "{kind:?}: `w3proj {span}`: {flag} is not a flag of {help_args:?}");
            }
        }
        assert!(named >= 6, "{kind:?}: the text names commands ({named})");
        // Bare `<command>` mentions in the numbered list and the flags in prose: pack, rebuild, check, mcp.
        for must in ["w3proj rebuild", "w3proj check", "w3proj pack"] {
            assert!(text.contains(must), "{kind:?}: {must}");
        }
    }
}

#[test]
fn the_text_differs_by_layout_and_names_no_claude_md() {
    let (flat, split, campaign) = (agent_file::text(Kind::Flat), agent_file::text(Kind::Split), agent_file::text(Kind::Campaign));
    assert!(flat.contains("war3map.w3e.txt") && !flat.contains("terrain/terrain.json"));
    assert!(split.contains("terrain/terrain.json"));
    assert!(campaign.contains("maps/<chapter>/") && !campaign.contains("war3map.w3e.txt"));
    assert_eq!(agent_file::FILE, "AGENTS.md");
}

#[test]
fn unpack_writes_it_once_and_never_rewrites_it() {
    let dir = workdir("unpack");
    let (map, project) = (dir.join("m.w3x"), dir.join("project"));
    ok(&["pack", s(&fixture()), "-o", s(&map)]);
    ok(&["unpack", s(&map), s(&project), "--game", "none"]);
    let file = project.join("AGENTS.md");
    assert_eq!(fs::read_to_string(&file).unwrap(), agent_file::text(Kind::Flat));
    assert!(!project.join("CLAUDE.md").exists());
    // The user edits it; a sync (unpack again) and a rebuild leave it alone.
    fs::write(&file, "mine\n").unwrap();
    ok(&["unpack", s(&map), s(&project), "--game", "none"]);
    assert_eq!(fs::read_to_string(&file).unwrap(), "mine\n", "a sync rewrote the user's file");
    // Control: removed, the sync writes it again.
    fs::remove_file(&file).unwrap();
    ok(&["unpack", s(&map), s(&project), "--game", "none"]);
    assert!(file.exists());
}

#[test]
fn pack_ignores_it_and_unpack_pack_unpack_is_identical() {
    let dir = workdir("pack");
    let (map, project, again, project2) = (dir.join("m.w3x"), dir.join("project"), dir.join("again.w3x"), dir.join("project2"));
    ok(&["pack", s(&fixture()), "-o", s(&map)]);
    ok(&["unpack", s(&map), s(&project), "--game", "none"]);
    ok(&["pack", s(&project), "-o", s(&again)]);
    assert_eq!(fs::read(&map).unwrap(), fs::read(&again).unwrap(), "the agent file changed the packed map");
    assert!(!String::from_utf8_lossy(&fs::read(&again).unwrap()).contains("Agent notes for this W3Proj"), "the text is in the map");
    // Unpacking the packed project again gives the same files, the agent file included.
    ok(&["unpack", s(&again), s(&project2), "--game", "none"]);
    assert_eq!(fs::read(project.join("AGENTS.md")).unwrap(), fs::read(project2.join("AGENTS.md")).unwrap());
    // An edited file doesn't change the pack either.
    fs::write(project.join("AGENTS.md"), "different\n").unwrap();
    let third = dir.join("third.w3x");
    ok(&["pack", s(&project), "-o", s(&third)]);
    assert_eq!(fs::read(&again).unwrap(), fs::read(&third).unwrap());
}

#[test]
fn ensure_is_idempotent_and_leaves_an_existing_file() {
    let dir = workdir("ensure");
    assert!(agent_file::ensure(&dir, Kind::Flat).unwrap());
    let first = fs::read(dir.join("AGENTS.md")).unwrap();
    assert!(!agent_file::ensure(&dir, Kind::Campaign).unwrap(), "second call writes nothing");
    assert_eq!(first, fs::read(dir.join("AGENTS.md")).unwrap());
}

#[test]
fn create_writes_it_for_a_map_and_a_campaign() {
    let dir = workdir("create");
    let (map, camp) = (dir.join("map"), dir.join("camp"));
    w3proj::create(&map, Some(w3proj::header::MapHeader { name: "M".into(), flags: 0, max_players: 1, unknown: 0 })).unwrap();
    w3proj::create(&camp, None).unwrap();
    assert_eq!(fs::read_to_string(map.join("AGENTS.md")).unwrap(), agent_file::text(Kind::Flat));
    assert_eq!(fs::read_to_string(camp.join("AGENTS.md")).unwrap(), agent_file::text(Kind::Campaign));
    // A map without a header (World Editor 3.0.1's) is no campaign.
    let bare = dir.join("bare");
    w3proj::project::create_as(&bare, None, false).unwrap();
    assert_eq!(fs::read_to_string(bare.join("AGENTS.md")).unwrap(), agent_file::text(Kind::Flat));
}
