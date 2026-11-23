//! `w3proj terrain merge-hook`: the opt-in git hook that runs Check Terrain Seams (`w3proj terrain seams`) after a
//! merge that touched two subterrains or `terrain.json` of a split project. Disjoint subterrain files stop textual
//! conflicts, not semantic ones: two branches editing near one seam can merge cleanly into a cliff or ramp no brush
//! would leave. The hook only reports (a post-merge hook can't undo the merge); nothing is changed.
//!
//! Installed into the repository's hooks folder as git names it (`git rev-parse --git-path hooks/post-merge`, so
//! worktrees and `core.hooksPath` are followed) as a POSIX shell script, which Git for Windows runs with its own sh. A
//! `post-merge` hook that isn't this one is never replaced: the command says so and prints the line to add to it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// The line that marks a hook as this one (a later install replaces it, `--remove` removes it).
pub const MARK: &str = "# w3proj terrain merge-hook";

/// The hook's text. `prefix`: the project's folder relative to the repository's top (as `git rev-parse --show-prefix`
/// gives it: forward slashes, a trailing one, empty at the top); `w3proj`: the program to run (W3PROJ_BIN overrides it
/// when the hook runs). Paths are written with forward slashes whatever the system: sh on Windows takes them too.
pub fn hook_text(prefix: &str, w3proj: &str) -> String {
    let slash = |s: &str| s.replace('\\', "/");
    let prefix = slash(prefix);
    let prefix = if prefix.is_empty() || prefix.ends_with('/') { prefix } else { format!("{prefix}/") };
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    format!(
        "#!/bin/sh\n\
         {MARK}\n\
         # Checks the terrain seams of a split W3Proj project after a merge that touched two of its subterrains (or\n\
         # map/terrain/terrain.json): `w3proj terrain seams`. It only reports. Remove this file, or run\n\
         # `w3proj terrain merge-hook --remove`, to stop it.\n\
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
         exit 0\n",
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

/// Installs (or with `remove`, removes) the hook for `project`; `program` is the w3proj the hook runs. Refuses to touch
/// a `post-merge` hook that isn't this one (action "foreign", the line to add to it in `message`).
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
    let ours = existing.as_deref().is_some_and(|t| t.lines().any(|l| l == MARK));
    if remove {
        return match (existing.is_some(), ours) {
            (false, _) => Ok(out("none", format!("there is no post-merge hook ({shown})"))),
            (true, false) => Err(format!("{shown} isn't the one `w3proj terrain merge-hook` installs: left as it is")),
            (true, true) => {
                std::fs::remove_file(&hook).map_err(|e| format!("removing {shown}: {e}"))?;
                Ok(out("removed", format!("removed {shown}")))
            }
        };
    }
    let text = hook_text(&prefix, program);
    if existing.is_some() && !ours {
        return Ok(out(
            "foreign",
            format!(
                "{shown} is there and isn't this hook: it is left as it is. To check the seams after merges, add this line to it:\n  \"{}\" terrain seams \"$(git rev-parse --show-toplevel)/{prefix}.\"",
                program.replace('\\', "/")
            ),
        ));
    }
    if let Some(dir) = hook.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("making {}: {e}", dir.display()))?;
    }
    w3proj::atomic::write(&hook, text.as_bytes()).map_err(|e| format!("writing {shown}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("making {shown} runnable: {e}"))?;
    }
    Ok(out(
        if ours { "updated" } else { "installed" },
        format!("{} {shown} (it runs `w3proj terrain seams` after a merge that touched two subterrains; W3PROJ_BIN names another w3proj)", if ours { "updated" } else { "installed" }),
    ))
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
    }
}
