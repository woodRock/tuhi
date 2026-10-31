//! Citations: the paper's own .bib entries, plus Jesse's ruru library when it's installed.
//! tuhi only reads ruru (list, show, check, project list); anything that changes the library
//! or a bib file is shown to the user as a command to run.

use crate::{project, tools};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct BibEntry {
    pub key: String,
    /// Root-relative .bib file.
    pub file: String,
    pub line: usize,
    pub title: String,
    pub author: String,
    pub year: String,
}

#[derive(Serialize)]
pub struct Paper {
    pub key: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub venue: Option<String>,
    pub status: String,
    pub tags: Vec<String>,
    /// Kept for this paper's ruru project.
    pub in_project: bool,
}

#[derive(Serialize)]
pub struct Library {
    /// Every entry in the project's .bib files.
    pub bib: Vec<BibEntry>,
    /// Whether ruru is installed; when false `papers` is empty.
    pub ruru: bool,
    /// The ruru project whose files live in this folder, if any.
    pub project: Option<String>,
    pub papers: Vec<Paper>,
}

/// `ruru ARGS…` with `TUHI_RURU_LIBRARY` as the library when set (tests use a copy).
pub(crate) fn command(args: &[&str]) -> Result<std::process::Command, String> {
    let mut command = tools::command("ruru")?;
    command.args(args);
    if let Ok(library) = std::env::var("TUHI_RURU_LIBRARY") {
        command.arg("-L").arg(library);
    }
    Ok(command)
}

pub(crate) fn run(args: &[&str]) -> Result<Value, String> {
    let output = command(args)?.arg("--json").output().map_err(|e| e.to_string())?;
    serde_json::from_slice(&output.stdout)
        .map_err(|_| format!("ruru {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()))
}

pub fn library(root: &Path, files: &[String]) -> Library {
    let bib = files.iter().filter(|f| f.ends_with(".bib")).flat_map(|f| read_bib(root, f)).collect();
    if tools::which("ruru").is_none() {
        return Library { bib, ruru: false, project: None, papers: Vec::new() };
    }
    let project = project_for(root);
    let papers = run(&["list"])
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|p| {
            let strings = |field: &str| -> Vec<String> {
                p[field].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
            };
            let projects = strings("projects");
            Paper {
                key: p["key"].as_str().unwrap_or_default().to_string(),
                title: p["title"].as_str().unwrap_or_default().to_string(),
                authors: strings("authors"),
                year: p["year"].as_i64(),
                venue: p["venue"].as_str().map(String::from),
                status: p["status"].as_str().unwrap_or_default().to_string(),
                tags: strings("tags"),
                in_project: project.as_ref().is_some_and(|name| projects.contains(name)),
            }
        })
        .collect();
    Library { bib, ruru: true, project, papers }
}

/// The ruru project with a .tex or .bib file inside `root`.
pub(crate) fn project_for(root: &Path) -> Option<String> {
    let root = root.canonicalize().ok()?;
    let inside = |path: Option<&str>| {
        path.map(PathBuf::from).and_then(|p| p.canonicalize().ok()).is_some_and(|p| p.starts_with(&root))
    };
    run(&["project", "list"]).ok()?.as_array()?.iter().find_map(|p| {
        let tex = p["tex"].as_array().into_iter().flatten().any(|t| inside(t.as_str()));
        (tex || inside(p["bib"].as_str())).then(|| p["name"].as_str().map(String::from)).flatten()
    })
}

/// `ruru show KEY`: the paper with its abstract, Jesse's notes and agent notes.
pub fn show(key: &str) -> Result<Value, String> {
    if key.starts_with('-') {
        return Err(format!("not a key: {key}"));
    }
    let value = run(&["show", key])?;
    if value.get("key").is_none() {
        return Err(format!("{key} is not in your ruru library"));
    }
    Ok(value)
}

/// `ruru check MAIN.tex`: cited keys missing from the bib, unused, stale and duplicate entries.
/// Run on the file rather than the project so it checks this folder's files as saved.
pub fn check(root: &Path, main: &str) -> Result<Option<Value>, String> {
    if tools::which("ruru").is_none() {
        return Ok(None);
    }
    let path = project::resolve(root, main)?;
    run(&["check", &path.to_string_lossy()]).map(Some)
}

/// Entries of one .bib file: key, line and a few fields for completion and hover.
fn read_bib(root: &Path, file: &str) -> Vec<BibEntry> {
    let Ok(text) = project::resolve(root, file).and_then(|p| fs::read_to_string(p).map_err(|e| e.to_string())) else {
        return Vec::new();
    };
    parse_bib(&text, file)
}

fn parse_bib(text: &str, file: &str) -> Vec<BibEntry> {
    let mut out: Vec<BibEntry> = Vec::new();
    let starts: Vec<usize> = text.match_indices('@').map(|(i, _)| i).collect();
    for (n, &start) in starts.iter().enumerate() {
        let entry = &text[start..starts.get(n + 1).copied().unwrap_or(text.len())];
        let Some(open) = entry.find(['{', '(']) else { continue };
        let kind = entry[1..open].trim().to_ascii_lowercase();
        if kind.is_empty() || !kind.chars().all(|c| c.is_ascii_alphanumeric()) || ["comment", "string", "preamble"].contains(&kind.as_str()) {
            continue;
        }
        let body = &entry[open + 1..];
        let Some(comma) = body.find(',') else { continue };
        let key = body[..comma].trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            continue;
        }
        let fields = &body[comma + 1..];
        out.push(BibEntry {
            key: key.to_string(),
            file: file.to_string(),
            line: text[..start].matches('\n').count() + 1,
            title: field(fields, "title"),
            author: field(fields, "author"),
            year: field(fields, "year"),
        });
    }
    out
}

/// A field's value with braces and quotes stripped and whitespace collapsed.
fn field(fields: &str, name: &str) -> String {
    let lower = fields.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name).map(|i| i + from) {
        from = i + name.len();
        let before_ok = i == 0 || !lower.as_bytes()[i - 1].is_ascii_alphanumeric();
        let rest = fields[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let value = rest[1..].trim_start();
        let raw = match value.chars().next() {
            Some('{') => balanced(value),
            Some('"') => value[1..].split('"').next().unwrap_or_default(),
            _ => value.split([',', '}', '\n']).next().unwrap_or_default(),
        };
        return raw.replace(['{', '}'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    }
    String::new()
}

/// The text inside a `{…}` group, which may itself contain braces.
fn balanced(value: &str) -> &str {
    let mut depth = 0;
    for (i, c) in value.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &value[1..i];
                }
            }
            _ => {}
        }
    }
    &value[1..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bib_entries() {
        let bib = "% refs\n@string{x = \"y\"}\n@article{smith2020,\n  author = {Smith, A. and Jones, B.},\n  booktitle = {Wrong},\n  title = {A {GC-MS} study},\n  year = 2020,\n}\n\n@InProceedings{ doe21 , title=\"Quoted\" }\n";
        let entries = parse_bib(bib, "refs.bib");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "smith2020");
        assert_eq!(entries[0].line, 3);
        assert_eq!(entries[0].title, "A GC-MS study");
        assert_eq!(entries[0].author, "Smith, A. and Jones, B.");
        assert_eq!(entries[0].year, "2020");
        assert_eq!(entries[1].key, "doe21");
        assert_eq!(entries[1].title, "Quoted");
    }
}
