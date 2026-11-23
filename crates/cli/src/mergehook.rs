//! `w3proj terrain merge-hook`: the command line over `backend::mergehook` (the hook's text and install, shared with the
//! app's "Install Merge Hook" command).

use std::path::Path;
use std::process::ExitCode;

use anyhow::{anyhow, Context, Result};

pub fn run(project: &Path, remove: bool) -> Result<ExitCode> {
    let me = std::env::current_exe().context("finding this program's path")?;
    let out = backend::mergehook::run(project, remove, &me.to_string_lossy()).map_err(|e| anyhow!(e))?;
    match out.action {
        "foreign" => {
            eprintln!("{}", out.message);
            Ok(ExitCode::FAILURE)
        }
        "noGit" => Err(anyhow!("running git (is it installed?)")),
        _ => {
            println!("{}", out.message);
            Ok(ExitCode::SUCCESS)
        }
    }
}
