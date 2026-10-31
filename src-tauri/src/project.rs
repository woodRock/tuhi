use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Files the editor is willing to open as text.
const TEXT_EXTENSIONS: &[&str] = &["tex", "bib", "sty", "cls", "bst", "txt", "md"];

#[derive(Serialize)]
pub struct Project {
    pub root: String,
    pub name: String,
    /// Root-relative path of the file containing `\documentclass`, if one was found.
    pub main: Option<String>,
    /// Root-relative paths, always `/`-separated.
    pub files: Vec<String>,
}

pub fn open(root: &Path) -> Result<Project, String> {
    let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    files.sort();
    let main = find_main(&root, &files);
    Ok(Project {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        root: root.to_string_lossy().into_owned(),
        main,
        files,
    })
}

/// Joins a root-relative path onto `root`, refusing anything that would escape it.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("{} is outside the project", rel.display()));
    }
    Ok(root.join(rel))
}

/// Inverse of `resolve`: turns a path TeX reported (often `./x.tex` or absolute) back into
/// a root-relative, `/`-separated path. Returns `None` for files outside the project.
pub fn relativize(root: &Path, path: &str) -> Option<String> {
    let path = Path::new(path);
    let abs = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let abs = abs.canonicalize().unwrap_or(abs);
    let rel = abs.strip_prefix(root).ok()?;
    Some(to_slash(rel))
}

fn to_slash(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(to_slash(rel));
            }
        }
    }
}

fn find_main(root: &Path, files: &[String]) -> Option<String> {
    let mut candidates: Vec<&String> = files
        .iter()
        .filter(|f| f.ends_with(".tex"))
        .filter(|f| {
            fs::read_to_string(root.join(f)).is_ok_and(|text| {
                text.lines().any(|l| l.trim_start().starts_with("\\documentclass"))
            })
        })
        .collect();
    // Prefer main.tex, then files at the top level, then alphabetical order.
    candidates.sort_by_key(|f| (!f.ends_with("main.tex"), f.contains('/'), f.to_string()));
    candidates.first().map(|f| f.to_string())
}
