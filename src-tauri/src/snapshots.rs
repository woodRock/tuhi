//! Named versions of the paper ("submitted v1", "revision 1") as git tags under `tuhi/`.
//! A snapshot records the files exactly as they are, committed or not, without touching the
//! branch, the index or the working tree: the commit is built from a temporary index and is
//! reachable only through its tag. Tags stay local unless pushed with --tags.

use crate::latexdiff::{check_rev, git};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX: &str = "tuhi/";

#[derive(Serialize)]
pub struct Snapshot {
    /// The tag without the prefix, e.g. "submitted-v1"; pass `tuhi/<id>` to git.
    pub id: String,
    pub name: String,
    pub date: String,
    pub commit: String,
}

#[derive(Serialize)]
pub struct FileChange {
    pub file: String,
    /// None for binary files.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn list(root: &Path) -> Result<Vec<Snapshot>, String> {
    let out = run(git(root)?.args([
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname:strip=3)%1f%(contents:subject)%1f%(creatordate:short)%1f%(*objectname:short)%(objectname:short)",
        "refs/tags/tuhi/",
    ]))
    .map_err(|_| "not a git repository".to_string())?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\x1f');
            let id = parts.next()?.to_string();
            let name = parts.next().filter(|n| !n.is_empty()).unwrap_or(&id).to_string();
            let date = parts.next()?.to_string();
            // Annotated tags print the commit then the tag object; keep the commit.
            let commit = parts.next()?.chars().take(7).collect();
            Some(Snapshot { id, name, date, commit })
        })
        .collect())
}

/// A tree object of the working tree as it is now (tracked and untracked files, honouring
/// .gitignore), built in a throwaway index so the real one is untouched.
fn current_tree(root: &Path) -> Result<String, String> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let index: PathBuf = std::env::temp_dir().join(format!("tuhi-index-{}-{nanos}", std::process::id()));
    let with_index = |args: &[&str]| -> Result<String, String> { run(git(root)?.env("GIT_INDEX_FILE", &index).args(args)) };
    let result = (|| {
        // Start from HEAD so unchanged files needn't be hashed again.
        let _ = with_index(&["read-tree", "HEAD"]);
        with_index(&["add", "-A", "--", "."])?;
        with_index(&["write-tree"])
    })();
    let _ = fs::remove_file(&index);
    result
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "snapshot".into() } else { out }
}

pub fn create(root: &Path, name: &str) -> Result<Snapshot, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("give the snapshot a name".into());
    }
    let taken: Vec<String> = list(root)?.into_iter().map(|s| s.id).collect();
    let base = slug(name);
    let id = (1..).map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") }).find(|id| !taken.contains(id)).unwrap();

    let tree = current_tree(root)?;
    let mut commit_tree = git(root)?;
    commit_tree.args(["commit-tree", &tree, "-m", &format!("tuhi snapshot: {name}")]);
    if let Ok(head) = run(git(root)?.args(["rev-parse", "--verify", "-q", "HEAD"])) {
        commit_tree.args(["-p", &head]);
    }
    // Papers cloned from Overleaf may have no git identity set.
    if run(git(root)?.args(["config", "user.email"])).map(|e| e.is_empty()).unwrap_or(true) {
        for key in ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"] {
            commit_tree.env(key, "tuhi");
        }
        for key in ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"] {
            commit_tree.env(key, "tuhi@localhost");
        }
    }
    let commit = run(&mut commit_tree)?;
    let mut tag = git(root)?;
    tag.args(["tag", "-a", &format!("{PREFIX}{id}"), "-m", name, &commit]);
    if run(git(root)?.args(["config", "user.email"])).map(|e| e.is_empty()).unwrap_or(true) {
        tag.env("GIT_COMMITTER_NAME", "tuhi").env("GIT_COMMITTER_EMAIL", "tuhi@localhost");
    }
    run(&mut tag)?;
    list(root)?.into_iter().find(|s| s.id == id).ok_or_else(|| "the snapshot wasn't saved".into())
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    check_rev(id)?;
    run(git(root)?.args(["tag", "-d", &format!("{PREFIX}{id}")])).map(|_| ())
}

/// Lines added and removed per file between two revisions, or a revision and the current
/// files when `new` is None.
pub fn changes(root: &Path, old: &str, new: Option<&str>) -> Result<Vec<FileChange>, String> {
    check_rev(old)?;
    let new = match new {
        Some(rev) => {
            check_rev(rev)?;
            rev.to_string()
        }
        None => current_tree(root)?,
    };
    let out = run(git(root)?.args(["diff", "--numstat", old, &new]))?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, '\t');
            let added = parts.next()?.parse().ok();
            let removed = parts.next()?.parse().ok();
            Some(FileChange { added, removed, file: parts.next()?.to_string() })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_names() {
        assert_eq!(slug("Submitted v1"), "submitted-v1");
        assert_eq!(slug("  Revision 1 (to TAI) "), "revision-1-to-tai");
        assert_eq!(slug("!!"), "snapshot");
    }

    /// A snapshot of uncommitted work leaves the branch, index and working tree as they were.
    #[test]
    fn snapshots_without_touching_the_repo() {
        if crate::tools::which("git").is_none() {
            return;
        }
        let root = std::env::temp_dir().join(format!("tuhi-snap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let git_ok = |args: &[&str]| run(git(&root).unwrap().args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")).unwrap();
        git_ok(&["init", "-q"]);
        fs::write(root.join("main.tex"), "one\n").unwrap();
        git_ok(&["add", "."]);
        git_ok(&["commit", "-q", "-m", "first"]);
        fs::write(root.join("main.tex"), "one\ntwo\n").unwrap();
        fs::write(root.join("new.tex"), "new\n").unwrap();
        let head = git_ok(&["rev-parse", "HEAD"]);
        let status = git_ok(&["status", "--porcelain"]);

        let snap = create(&root, "Submitted v1").unwrap();
        assert_eq!(snap.id, "submitted-v1");
        assert_eq!(snap.name, "Submitted v1");
        assert_eq!(create(&root, "Submitted v1").unwrap().id, "submitted-v1-2");
        assert_eq!(git_ok(&["rev-parse", "HEAD"]), head);
        assert_eq!(git_ok(&["status", "--porcelain"]), status);
        assert_eq!(git_ok(&["show", "tuhi/submitted-v1:main.tex"]), "one\ntwo");

        let changes = changes(&root, "HEAD", Some("tuhi/submitted-v1")).unwrap();
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().any(|c| c.file == "main.tex" && c.added == Some(1) && c.removed == Some(0)));
        fs::write(root.join("main.tex"), "one\n").unwrap();
        let since = super::changes(&root, "tuhi/submitted-v1", None).unwrap();
        assert!(since.iter().any(|c| c.file == "main.tex" && c.removed == Some(1)));

        delete(&root, "submitted-v1-2").unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        assert!(delete(&root, "--all").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
