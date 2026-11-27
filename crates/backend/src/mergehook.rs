//! `w3proj terrain merge-hook`: the opt-in git hook that runs Check Terrain Seams (`w3proj terrain seams`) after a
//! merge that touched two subterrains or `terrain.json` of a split project. Disjoint subterrain files stop textual
//! conflicts, not semantic ones: two branches editing near one seam can merge cleanly into a cliff or ramp no brush
//! would leave. The hook only reports (a post-merge hook can't undo the merge); nothing is changed.
//!
//! Installed into the repository's hooks folder as git names it (`git rev-parse --git-path hooks/post-merge`, so
//! worktrees and `core.hooksPath` are followed) as a POSIX shell script, which Git for Windows runs with its own sh.
//!
//! The hook is one block between [`BEGIN`] and [`END`], run in a subshell (its `exit`s end only the block). A
//! `post-merge` hook of someone else's (Git LFS installs one as soon as a project has LFS rules) keeps all its text: the
//! block goes in right after its `#!` line, so both run, and `--remove` takes only the block out again. A hook that
//! isn't an sh-like script (another `#!`, or none) is never touched: the command says so and prints the line to add.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// The line that marks a hook as this one (a later install replaces it, `--remove` removes it). A hook written before
/// the block existed is this line in a file of its own, without [`BEGIN`].
pub const MARK: &str = "# w3proj terrain merge-hook";
/// The first line of this hook's block.
pub const BEGIN: &str = "# >>> w3proj terrain merge-hook: begin >>>";
/// The last line of this hook's block.
pub const END: &str = "# <<< w3proj terrain merge-hook: end <<<";

/// The hook's text on its own (`#!/bin/sh` and [`hook_block`]).
pub fn hook_text(prefix: &str, w3proj: &str) -> String {
    format!("#!/bin/sh\n{}", hook_block(prefix, w3proj))
}

/// The hook's block, [`BEGIN`] to [`END`] with a newline after each line. `prefix`: the project's folder relative to
/// the repository's top (as `git rev-parse --show-prefix` gives it: forward slashes, a trailing one, empty at the
/// top); `w3proj`: the program to run (W3PROJ_BIN overrides it when the hook runs). Paths are written with forward
/// slashes whatever the system: sh on Windows takes them too. The subshell's `|| :` keeps a `set -e` of the script
/// around it from ending that script.
pub fn hook_block(prefix: &str, w3proj: &str) -> String {
    let slash = |s: &str| s.replace('\\', "/");
    let prefix = slash(prefix);
    let prefix = if prefix.is_empty() || prefix.ends_with('/') { prefix } else { format!("{prefix}/") };
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    format!(
        "{BEGIN}\n\
         {MARK}\n\
         # Checks the terrain seams of a split W3Proj project after a merge that touched two of its subterrains (or\n\
         # map/terrain/terrain.json): `w3proj terrain seams`. It only reports. Run `w3proj terrain merge-hook --remove`\n\
         # (or delete this block) to stop it; the rest of this file isn't part of it.\n\
         (\n\
         project={project}\n\
         w3proj=\"${{W3PROJ_BIN:-{program}}}\"\n\
         top=$(git rev-parse --show-toplevel) || exit 0\n\
         # What both sides changed since they parted: the merged branch (HEAD's second parent; a fast-forward: HEAD).\n\
         theirs=$(git rev-parse -q --verify HEAD^2 2>/dev/null || git rev-parse HEAD)\n\
         base=$(git merge-base ORIG_HEAD \"$theirs\" 2>/dev/null) || exit 0\n\
         changed=$(git diff --name-only \"$base\" HEAD -- \"$top/${{project}}map/terrain\" 2>/dev/null) || exit 0\n\
         [ -n \"$changed\" ] || exit 0\n\
         # Which subterrain folders the two sides changed; terrain.json counts as all of them.\n\
         count=$(printf '%s\\n' \"$changed\" | sed -n \"s#^${{project}}map/terrain/\\([^/]*\\)/.*#\\1#p\" | sort -u | wc -l)\n\
         count=$((count))\n\
         if [ \"$count\" -lt 2 ] && ! printf '%s\\n' \"$changed\" | grep -q \"^${{project}}map/terrain/terrain.json$\"; then exit 0; fi\n\
         echo \"w3proj: the merged branches changed $count subterrain(s) of ${{project:-.}}; checking the seams\"\n\
         \"$w3proj\" terrain seams \"$top/${{project}}.\" || echo \"w3proj: the merge left terrain seam issues (above): fix them before packing (w3proj pack refuses errors)\"\n\
         exit 0\n\
         ) || :\n\
         {END}\n",
        project = quote(&prefix),
        program = slash(w3proj),
    )
}

/// What `run` did. `action`: "installed", "updated", "removed", "none" (remove: there was no hook), "foreign" (a
/// `post-merge` hook that isn't this one: left as it is; `message` has the line to add to it) or "noGit" (git couldn't
/// be started).
#[derive(Serialize, Debug)]
pub struct Outcome {
    pub action: &'static str,
    pub git: bool,
    pub hook: String,
    pub message: String,
}

/// The project's folder relative to the repository's top and the hook's path, from git run in the project. `None`: git
/// can't be started.
fn locate(project: &Path) -> Result<Option<(String, PathBuf)>, String> {
    let git = |args: &[&str]| -> Result<Option<String>, String> {
        let out = match Command::new("git").args(args).current_dir(project).output() {
            Ok(o) => o,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("running git: {e}")),
        };
        if !out.status.success() {
            return Err(format!("{} isn't in a git repository: {}", project.display(), String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(Some(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string()))
    };
    let Some(prefix) = git(&["rev-parse", "--show-prefix"])? else { return Ok(None) };
    let Some(hook) = git(&["rev-parse", "--git-path", "hooks/post-merge"])? else { return Ok(None) };
    let hook = PathBuf::from(hook);
    let hook = if hook.is_absolute() { hook } else { project.join(hook) };
    Ok(Some((prefix, hook)))
}

/// What a `post-merge` hook on disk is, to this command.
#[derive(Debug, PartialEq)]
enum Found {
    /// This hook as written before the block existed: [`MARK`] in a file of its own. All of it is this hook's.
    Whole,
    /// This hook's block at these byte offsets (from the start of [`BEGIN`]'s line to past [`END`]'s line ending).
    Block(usize, usize),
    /// Someone else's sh-like script: the block can go in after its first line (its `#!`), at this byte offset.
    Shell(usize),
    /// Something this command doesn't change: why.
    Other(String),
}

/// The lines of `text` with their byte offsets (start, past the line ending), the line itself without "\r\n" / "\n".
fn lines_at(text: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let mut at = 0;
    text.split_inclusive('\n').map(move |l| {
        let start = at;
        at += l.len();
        (start, at, l.trim_end_matches('\n').trim_end_matches('\r'))
    })
}

/// Whether a `#!` line names a shell that runs this hook's block as sh would: sh, bash, dash, ash or ksh, directly or
/// through `env` (an `.exe` of them too, as Git for Windows might name one).
fn sh_like(shebang: &str) -> bool {
    let Some(rest) = shebang.strip_prefix("#!") else { return false };
    let mut words = rest.split_whitespace();
    let name = |w: &str| {
        let base = w.rsplit(['/', '\\']).next().unwrap_or(w);
        base.strip_suffix(".exe").unwrap_or(base).to_string()
    };
    let Some(first) = words.next().map(name) else { return false };
    let shell = if first == "env" { words.find(|w| !w.starts_with('-')).map(name).unwrap_or_default() } else { first };
    matches!(shell.as_str(), "sh" | "bash" | "dash" | "ash" | "ksh")
}

fn classify(text: &str) -> Found {
    let begin = lines_at(text).find(|l| l.2 == BEGIN);
    if let Some((start, _, _)) = begin {
        return match lines_at(text).skip_while(|l| l.0 <= start).find(|l| l.2 == END) {
            Some((_, end, _)) => Found::Block(start, end),
            None => Found::Other(format!("has the start of this hook's block (\"{BEGIN}\") but not its end (\"{END}\")")),
        };
    }
    if lines_at(text).any(|l| l.2 == MARK) {
        return Found::Whole;
    }
    match lines_at(text).next() {
        Some((_, end, first)) if sh_like(first) => Found::Shell(end),
        Some((_, _, first)) if first.starts_with("#!") => Found::Other(format!("isn't an sh script (it starts \"{first}\")")),
        _ => Found::Other("doesn't start with a #! line naming its shell".into()),
    }
}

/// Installs (or with `remove`, removes) the hook for `project`; `program` is the w3proj the hook runs. Someone else's
/// sh-like `post-merge` hook gets this hook's block after its `#!` line, its own text kept (action "installed"); one
/// that isn't sh-like is left as it is (action "foreign", the line to add to it in `message`). `remove` takes out only
/// the block, and removes the file only when nothing but its `#!` line is left.
pub fn run(project: &Path, remove: bool, program: &str) -> Result<Outcome, String> {
    if !project.join("map").join("terrain").join("terrain.json").is_file() && !remove {
        return Err(format!("{} has no split terrain (map/terrain/terrain.json): there are no seams to check", project.display()));
    }
    let Some((prefix, hook)) = locate(project)? else {
        return Ok(Outcome { action: "noGit", git: false, hook: String::new(), message: "git wasn't found (is it installed?)".into() });
    };
    let shown = hook.to_string_lossy().into_owned();
    let out = |action, message: String| Outcome { action, git: true, hook: shown.clone(), message };
    let existing = match std::fs::read_to_string(&hook) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{} is there but can't be read: {e}", hook.display())),
    };
    let found = existing.as_deref().map(classify);
    let write = |text: &str| -> Result<(), String> {
        w3proj::atomic::write(&hook, text.as_bytes()).map_err(|e| format!("writing {shown}: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("making {shown} runnable: {e}"))?;
        }
        Ok(())
    };
    if remove {
        let text = existing.as_deref().unwrap_or_default();
        return match found {
            None => Ok(out("none", format!("there is no post-merge hook ({shown})"))),
            Some(Found::Shell(_)) | Some(Found::Other(_)) => Err(format!("{shown} isn't the one `w3proj terrain merge-hook` installs and has no block of it: left as it is")),
            Some(Found::Whole) => {
                std::fs::remove_file(&hook).map_err(|e| format!("removing {shown}: {e}"))?;
                Ok(out("removed", format!("removed {shown}")))
            }
            Some(Found::Block(start, end)) => {
                let rest = format!("{}{}", &text[..start], &text[end..]);
                // Only a `#!` line left (the hook was this one alone): the file goes.
                let only_shebang = rest.trim().lines().count() <= 1 && rest.trim_start().starts_with("#!");
                if rest.trim().is_empty() || only_shebang {
                    std::fs::remove_file(&hook).map_err(|e| format!("removing {shown}: {e}"))?;
                    Ok(out("removed", format!("removed {shown}")))
                } else {
                    write(&rest)?;
                    Ok(out("removed", format!("removed this hook's block from {shown}; the rest of it is left as it was")))
                }
            }
        };
    }
    let block = hook_block(&prefix, program);
    let (text, action, said) = match found {
        None => (hook_text(&prefix, program), "installed", format!("installed {shown}")),
        Some(Found::Whole) => (hook_text(&prefix, program), "updated", format!("updated {shown}")),
        Some(Found::Block(start, end)) => {
            let t = existing.as_deref().unwrap_or_default();
            (format!("{}{block}{}", &t[..start], &t[end..]), "updated", format!("updated {shown}"))
        }
        Some(Found::Shell(at)) => {
            let t = existing.as_deref().unwrap_or_default();
            let newline = if t[..at].ends_with('\n') { "" } else { "\n" };
            (
                format!("{}{newline}{block}{}", &t[..at], &t[at..]),
                "installed",
                format!("added to {shown}, before the hook that was there (it is kept and runs after this one)"),
            )
        }
        Some(Found::Other(why)) => {
            return Ok(out(
                "foreign",
                format!(
                    "{shown} is there and {why}: it is left as it is. To check the seams after merges, add this line to it:\n  \"{}\" terrain seams \"$(git rev-parse --show-toplevel)/{prefix}.\"",
                    program.replace('\\', "/")
                ),
            ))
        }
    };
    if let Some(dir) = hook.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("making {}: {e}", dir.display()))?;
    }
    write(&text)?;
    // `git lfs install` writes no hook over one that is there, so a project that gets LFS later has to be told how.
    let lfs = if existing.is_none() { ". If a later `git lfs install` says \"Hook already exists\": run `git lfs install --force`, then install this hook again (both then run)" } else { "" };
    Ok(out(action, format!("{said} (it runs `w3proj terrain seams` after a merge that touched two subterrains; W3PROJ_BIN names another w3proj){lfs}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hook's paths have forward slashes whatever the system gave (a Windows program path, a prefix written with
    /// backslashes), the prefix ends in one, a quote in it is escaped for sh, and the top of the repository is "".
    #[test]
    fn the_hook_text_takes_windows_and_linux_paths() {
        let win = hook_text("maps\\My Map\\", "C:\\Program Files\\W3Proj\\w3proj.exe");
        assert!(win.contains("project='maps/My Map/'"), "{win}");
        assert!(win.contains("${W3PROJ_BIN:-C:/Program Files/W3Proj/w3proj.exe}"), "{win}");
        assert!(!win.contains("C:\\") && !win.contains("maps\\"), "{win}");
        let linux = hook_text("maps/one", "/home/me/.cargo/bin/w3proj");
        assert!(linux.contains("project='maps/one/'") && linux.contains("${W3PROJ_BIN:-/home/me/.cargo/bin/w3proj}"), "{linux}");
        assert!(hook_text("", "w3proj").contains("project=''"));
        assert!(hook_text("it's/", "w3proj").contains("project='it'\\''s/'"));
        assert!(linux.starts_with("#!/bin/sh\n") && linux.lines().any(|l| l == MARK));
        assert!(linux.lines().nth(1) == Some(BEGIN) && linux.ends_with(&format!("{END}\n")), "{linux}");
    }

    /// Which hooks get the block (sh-like `#!`, directly or through env, CRLF too) and which are refused; an old
    /// standalone hook is all ours; a block is found by its lines, and a begin without an end is refused.
    #[test]
    fn hooks_are_told_apart() {
        for ok in ["#!/bin/sh", "#!/usr/bin/env sh", "#!/bin/bash -e", "#!/usr/bin/env -S bash", "#!/usr/bin/dash", "#!C:/Git/bin/sh.exe"] {
            assert!(sh_like(ok), "{ok}");
        }
        for no in ["#!/usr/bin/env python3", "#!/usr/bin/perl", "#!/bin/zsh", "#!", "echo hi", "#!/usr/bin/env"] {
            assert!(!sh_like(no), "{no}");
        }
        let lfs = "#!/bin/sh\r\ngit lfs post-merge \"$@\"\r\n";
        assert_eq!(classify(lfs), Found::Shell(11));
        assert!(matches!(classify("#!/usr/bin/env python3\nprint(1)\n"), Found::Other(w) if w.contains("python3")));
        assert!(matches!(classify("echo hi\n"), Found::Other(_)));
        assert!(matches!(classify(""), Found::Other(_)));
        assert_eq!(classify(&format!("#!/bin/sh\n{MARK}\necho old\n")), Found::Whole);
        let block = hook_block("", "w3proj");
        let text = format!("#!/bin/sh\n{block}git lfs post-merge \"$@\"\n");
        assert_eq!(classify(&text), Found::Block(10, 10 + block.len()));
        assert!(matches!(classify(&format!("#!/bin/sh\n{BEGIN}\necho cut\n")), Found::Other(w) if w.contains("not its end")));
    }
}
