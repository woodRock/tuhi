//! The paper repo's day-to-day git: what changed, commit, pull and push. Uses the git CLI, so
//! the user's credential helper (e.g. an Overleaf token in the keychain) does the signing in;
//! prompts are turned off so a missing login fails instead of hanging.

use crate::latexdiff::git;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Default)]
pub struct Status {
    /// False when the folder isn't a git repository.
    pub repo: bool,
    pub branch: Option<String>,
    /// e.g. "origin/main"; None before the first push.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Whether there's a remote to push to.
    pub remote: bool,
    pub files: Vec<Change>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    /// The old path of a rename.
    pub orig: Option<String>,
    /// M modified, A added, D deleted, R renamed, ? untracked, U conflicted.
    pub kind: char,
}

fn run(cmd: &mut Command) -> Result<String, String> {
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_ASKPASS", "true");
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    // Push and pull report on stderr even when they work.
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

pub fn status(root: &Path) -> Result<Status, String> {
    // --no-optional-locks: status mustn't rewrite the index, or the watcher would see that as a
    // commit and ask for status again.
    let Ok(out) = run(git(root)?.args(["--no-optional-locks", "status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"])) else {
        return Ok(Status::default());
    };
    let mut status = parse_status(&out);
    status.remote = run(git(root)?.arg("remote")).is_ok_and(|r| !r.is_empty());
    Ok(status)
}

fn parse_status(out: &str) -> Status {
    let mut status = Status { repo: true, ..Default::default() };
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if let Some(head) = entry.strip_prefix("## ") {
            let (names, counts) = head.split_once(" [").unwrap_or((head, ""));
            let (branch, upstream) = names.split_once("...").map_or((names, None), |(b, u)| (b, Some(u.to_string())));
            status.branch = Some(branch.trim_start_matches("No commits yet on ").to_string());
            status.upstream = upstream;
            for part in counts.trim_end_matches(']').split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
        let path = entry[3..].to_string();
        // A rename's old path comes as the next entry.
        let orig = if x == 'R' || x == 'C' { entries.next().map(str::to_string) } else { None };
        let kind = match (x, y) {
            ('?', _) => '?',
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => 'U',
            ('R', _) => 'R',
            ('A', _) => 'A',
            ('D', _) | (_, 'D') => 'D',
            _ => 'M',
        };
        status.files.push(Change { path, orig, kind });
    }
    status
}

/// What changed in one file since the last commit, as a unified diff.
pub fn diff(root: &Path, path: &str) -> Result<String, String> {
    let tracked = run(git(root)?.args(["ls-files", "--error-unmatch", "--", path])).is_ok();
    if tracked {
        run(git(root)?.args(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", path]))
    } else {
        // New files: everything is added. --no-index exits 1 when the files differ.
        let output = git(root)?.args(["diff", "--no-color", "--no-index", "--", "/dev/null", path]).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// Commits exactly `paths` (renames should list both paths), leaving other changes alone.
pub fn commit(root: &Path, message: &str, paths: &[String]) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Write a commit message first".into());
    }
    if paths.is_empty() {
        return Err("Nothing selected to commit".into());
    }
    run(git(root)?.args(["add", "-A", "--"]).args(paths))?;
    run(git(root)?.args(["commit", "-q", "-m", message.trim(), "--"]).args(paths))?;
    run(git(root)?.args(["log", "-1", "--format=%h"]))
}

pub fn pull(root: &Path) -> Result<String, String> {
    run(git(root)?.args(["pull", "--ff-only"])).map_err(|e| {
        if e.contains("Not possible to fast-forward") || e.contains("diverging") {
            "The remote and your commits have diverged. Merge them in a terminal (git pull), then push.".into()
        } else {
            e
        }
    })
}

pub fn push(root: &Path) -> Result<String, String> {
    let upstream = run(git(root)?.args(["rev-parse", "--abbrev-ref", "@{upstream}"])).is_ok();
    if upstream {
        run(git(root)?.arg("push"))
    } else {
        run(git(root)?.args(["push", "-u", "origin", "HEAD"]))
    }
    .map_err(|e| {
        if e.contains("rejected") || e.contains("fetch first") {
            "The remote has commits you don't have yet. Pull first, then push.".into()
        } else {
            e
        }
    })
}

/// Updates ahead/behind counts; failures (offline, no login) are ignored.
pub fn fetch(root: &Path) {
    if let Ok(mut cmd) = git(root) {
        let _ = run(cmd.args(["fetch", "--quiet"]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_status() {
        let out = "## main...origin/main [ahead 2, behind 1]\0 M main.tex\0?? figs/new.pdf\0R  b.tex\0a.tex\0D  old.bib\0UU conflict.tex\0";
        let s = parse_status(out);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        let kinds: Vec<(&str, char)> = s.files.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(kinds, [("main.tex", 'M'), ("figs/new.pdf", '?'), ("b.tex", 'R'), ("old.bib", 'D'), ("conflict.tex", 'U')]);
        assert_eq!(s.files[2].orig.as_deref(), Some("a.tex"));
        let fresh = parse_status("## No commits yet on main\0");
        assert_eq!(fresh.branch.as_deref(), Some("main"));
        assert_eq!(fresh.upstream, None);
    }

    #[test]
    fn commits_only_the_chosen_files() {
        let dir = std::env::temp_dir().join(format!("tuhi-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| run(git(&dir).unwrap().args(args)).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a.tex"), "a").unwrap();
        std::fs::write(dir.join("b.tex"), "b").unwrap();
        assert_eq!(status(&dir).unwrap().files.len(), 2);
        commit(&dir, "Add a", &["a.tex".into()]).unwrap();
        let left: Vec<String> = status(&dir).unwrap().files.into_iter().map(|c| c.path).collect();
        assert_eq!(left, ["b.tex"]);
        std::fs::write(dir.join("a.tex"), "a2").unwrap();
        assert!(diff(&dir, "a.tex").unwrap().contains("+a2"));
        assert!(diff(&dir, "b.tex").unwrap().contains("+b"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
