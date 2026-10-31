//! Marked-up PDF of what changed since a git revision, via latexdiff.

use crate::{compile, tools};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Serialize)]
pub struct Revision {
    pub rev: String,
    pub date: String,
    pub subject: String,
    /// Branch and tag names pointing here, e.g. "HEAD -> master, tag: submitted-v1".
    pub refs: String,
}

fn git(root: &Path) -> Result<Command, String> {
    let mut cmd = tools::command("git")?;
    cmd.arg("-C").arg(root);
    Ok(cmd)
}

pub fn revisions(root: &Path) -> Result<Vec<Revision>, String> {
    let output = git(root)?
        .args(["log", "-n", "40", "--date=short", "--format=%h%x1f%ad%x1f%s%x1f%D"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("not a git repository".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\x1f');
            Some(Revision {
                rev: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                refs: parts.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

/// Builds `<main>-diff.pdf` comparing `rev` with the working tree. Everything happens in a
/// scratch copy under `work`, so the paper's repo is never touched.
pub fn make(root: &Path, main: &str, rev: &str, work: &Path) -> Result<compile::CompileResult, String> {
    if tools::which("latexdiff").is_none() {
        return Err("latexdiff isn't installed. Install it with: sudo tlmgr install latexdiff".into());
    }
    if !rev.chars().all(|c| c.is_ascii_alphanumeric() || "-_./~^".contains(c)) {
        return Err(format!("bad revision {rev:?}"));
    }
    let _ = fs::remove_dir_all(work);
    let old = work.join("old");
    let new = work.join("new");
    fs::create_dir_all(&old).map_err(|e| e.to_string())?;

    // The old version, straight from git.
    let mut archive = git(root)?
        .args(["archive", "--format=tar", rev])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let untar = tools::command("tar")?
        .arg("-x")
        .arg("-C")
        .arg(&old)
        .stdin(archive.stdout.take().ok_or("git archive gave no output")?)
        .output()
        .map_err(|e| e.to_string())?;
    let archived = archive.wait_with_output().map_err(|e| e.to_string())?;
    if !archived.status.success() || !untar.status.success() {
        return Err(format!("couldn't check out {rev}: {}", String::from_utf8_lossy(&archived.stderr).trim()));
    }

    // The current version, including figures and generated files the diff needs to compile.
    copy_tree(root, &new)?;

    let stem = Path::new(main).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let diff_name = match Path::new(main).parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => format!("{}/{stem}-diff.tex", dir.display()),
        None => format!("{stem}-diff.tex"),
    };
    let output = tools::command("latexdiff")?
        .arg("--flatten")
        // Leave section titles alone; markup inside them often breaks compilation.
        .arg("--exclude-textcmd=section,subsection,subsubsection")
        .arg(old.join(main))
        .arg(new.join(main))
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(format!("latexdiff failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    fs::write(new.join(&diff_name), &output.stdout).map_err(|e| e.to_string())?;
    compile::compile(&new, &diff_name, &work.join("out"))
}

pub(crate) fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == ".tuhi" || name_str == "node_modules" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            copy_tree(&path, &to.join(&name))?;
        } else {
            fs::copy(&path, to.join(&name)).map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    Ok(())
}
