use crate::{project, tools};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

#[derive(Serialize)]
pub struct CompileResult {
    pub ok: bool,
    pub pdf: Option<String>,
    pub engine: String,
    pub millis: u64,
    pub issues: Vec<Issue>,
    pub log: String,
}

#[derive(Serialize)]
pub struct Issue {
    pub severity: &'static str,
    /// Root-relative path, when the log says which file the problem is in.
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

/// Build output lives in the app's cache rather than the project, so Overleaf clones stay clean.
pub fn build_dir(cache: &Path, root: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    cache.join("builds").join(format!("{name}-{:016x}", hasher.finish()))
}

pub fn pdf_path(out: &Path, main: &str) -> PathBuf {
    out.join(stem(main)).with_extension("pdf")
}

fn stem(main: &str) -> String {
    Path::new(main).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn compile(root: &Path, main: &str, out: &Path) -> Result<CompileResult, String> {
    let started = Instant::now();
    project::resolve(root, main)?;
    fs::create_dir_all(out).map_err(|e| e.to_string())?;
    // \include writes .aux files into matching subfolders of the output directory.
    mirror_dirs(root, root, out);

    let engine = engine_for(&root.join(main));
    let status_ok = if tools::which("latexmk").is_some() {
        run_latexmk(root, main, out, &engine)?
    } else {
        run_manual(root, main, out, &engine)?
    };

    let log = fs::read_to_string(out.join(stem(main)).with_extension("log")).unwrap_or_default();
    let mut issues = parse_log(root, &log);
    let blg = fs::read_to_string(out.join(stem(main)).with_extension("blg")).unwrap_or_default();
    issues.extend(parse_blg(root, &blg));
    let pdf = pdf_path(out, main);
    let has_errors = issues.iter().any(|i| i.severity == "error");
    Ok(CompileResult {
        ok: status_ok && !has_errors && pdf.exists(),
        pdf: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
        engine,
        millis: started.elapsed().as_millis() as u64,
        issues,
        log,
    })
}

/// Honours `% !TEX program = xelatex` style magic comments; defaults to pdflatex.
fn engine_for(main: &Path) -> String {
    let text = fs::read_to_string(main).unwrap_or_default();
    for line in text.lines().take(20) {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('%') {
            let rest = rest.trim().to_ascii_lowercase();
            if let Some(value) = rest.strip_prefix("!tex program") {
                let value = value.trim_start_matches([' ', '=']).trim();
                if ["pdflatex", "xelatex", "lualatex"].contains(&value) {
                    return value.to_string();
                }
            }
        }
    }
    "pdflatex".to_string()
}

fn engine_args(out: &Path) -> Vec<String> {
    vec![
        "-synctex=1".into(),
        "-interaction=nonstopmode".into(),
        "-file-line-error".into(),
        format!("-output-directory={}", out.display()),
    ]
}

fn run_latexmk(root: &Path, main: &str, out: &Path, engine: &str) -> Result<bool, String> {
    let mode = match engine {
        "xelatex" => "-pdfxe",
        "lualatex" => "-pdflua",
        _ => "-pdf",
    };
    let status = tools::command("latexmk")?
        .current_dir(root)
        .env("max_print_line", "10000")
        .args([mode, "-f", "-synctex=1", "-interaction=nonstopmode", "-file-line-error"])
        .arg(format!("-outdir={}", out.display()))
        .arg(main)
        .output()
        .map_err(|e| e.to_string())?
        .status;
    Ok(status.success())
}

/// A small latexmk stand-in for machines without it: engine, bibtex when citations or
/// .bib files changed, then reruns until labels settle.
fn run_manual(root: &Path, main: &str, out: &Path, engine: &str) -> Result<bool, String> {
    let name = stem(main);
    let run_engine = || -> Result<bool, String> {
        let output = tools::command(engine)?
            .current_dir(root)
            .env("max_print_line", "10000")
            .args(engine_args(out))
            .arg(main)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(output.status.success())
    };

    let mut ok = run_engine()?;
    let aux = fs::read_to_string(out.join(&name).with_extension("aux")).unwrap_or_default();
    if aux.contains("\\bibdata") && bibtex_needed(root, out, &name, &aux) {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let inputs = format!("{}{sep}", root.display());
        tools::command("bibtex")?
            .current_dir(out)
            .env("BIBINPUTS", &inputs)
            .env("BSTINPUTS", &inputs)
            .arg(&name)
            .output()
            .map_err(|e| e.to_string())?;
        ok = run_engine()?;
    }
    for _ in 0..3 {
        let log = fs::read_to_string(out.join(&name).with_extension("log")).unwrap_or_default();
        if !log.contains("Rerun to get") && !log.contains("Label(s) may have changed") {
            break;
        }
        ok = run_engine()?;
    }
    Ok(ok)
}

fn bibtex_needed(root: &Path, out: &Path, name: &str, aux: &str) -> bool {
    // Fingerprint the citation-related lines of the .aux file.
    let mut hasher = DefaultHasher::new();
    for line in aux.lines().filter(|l| {
        l.starts_with("\\citation") || l.starts_with("\\bibdata") || l.starts_with("\\bibstyle")
    }) {
        line.hash(&mut hasher);
    }
    let fingerprint = format!("{:016x}", hasher.finish());
    let stamp = out.join(format!("{name}.tuhi-bib"));
    let previous = fs::read_to_string(&stamp).unwrap_or_default();
    let _ = fs::write(&stamp, &fingerprint);

    let bbl_time = modified(&out.join(name).with_extension("bbl"));
    let Some(bbl_time) = bbl_time else { return true };
    if previous != fingerprint {
        return true;
    }
    bib_files(aux).iter().any(|bib| {
        let path = root.join(bib).with_extension("bib");
        modified(&path).is_some_and(|t| t > bbl_time)
    })
}

fn bib_files(aux: &str) -> Vec<String> {
    aux.lines()
        .filter_map(|l| l.strip_prefix("\\bibdata{")?.strip_suffix('}'))
        .flat_map(|list| list.split(',').map(|s| s.trim().to_string()))
        .collect()
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn mirror_dirs(root: &Path, dir: &Path, out: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        if path.is_dir() && !hidden {
            if let Ok(rel) = path.strip_prefix(root) {
                let _ = fs::create_dir_all(out.join(rel));
            }
            mirror_dirs(root, &path, out);
        }
    }
}

/// Pulls errors and the more useful warnings out of a TeX log written with -file-line-error.
pub fn parse_log(root: &Path, log: &str) -> Vec<Issue> {
    let mut issues = Vec::new();
    let lines: Vec<&str> = log.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some((file, number, message)) = split_file_line(line) {
            // Include the next non-empty line; TeX often puts the useful part there.
            let mut message = message.to_string();
            if let Some(next) = lines.get(i + 1).filter(|n| !n.trim().is_empty() && !n.starts_with("l.")) {
                if !message.ends_with('.') && next.len() < 200 {
                    message = format!("{message} {}", next.trim());
                }
            }
            issues.push(Issue {
                severity: "error",
                file: project::relativize(root, file),
                line: Some(number),
                message,
            });
        } else if let Some(message) = line.strip_prefix("! ") {
            issues.push(Issue { severity: "error", file: None, line: None, message: message.to_string() });
        } else if line.contains("LaTeX Warning:") || line.starts_with("Package ") && line.contains(" Warning:") {
            let message = line.split_once("Warning:").map(|(_, m)| m.trim()).unwrap_or(line);
            issues.push(Issue {
                severity: "warning",
                file: None,
                line: input_line(message),
                message: message.to_string(),
            });
        } else if line.starts_with("Overfull \\hbox") || line.starts_with("Underfull \\hbox") {
            issues.push(Issue { severity: "info", file: None, line: lines_range(line), message: line.to_string() });
        }
    }
    issues
}

/// BibTeX problems, which never reach the TeX log: missing styles, bad .bib entries.
pub fn parse_blg(root: &Path, blg: &str) -> Vec<Issue> {
    let mut issues = Vec::new();
    let lines: Vec<&str> = blg.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some(message) = line.strip_prefix("Warning--") {
            issues.push(Issue { severity: "warning", file: None, line: None, message: format!("BibTeX: {message}") });
        } else if let Some(location) = line.strip_prefix("---line ") {
            // "---line 12 of file refs.bib" follows the message it belongs to.
            let message = if i > 0 { lines[i - 1].trim() } else { "" };
            let (number, file) = location.split_once(" of file ").unwrap_or((location, ""));
            let file = file.trim();
            issues.push(Issue {
                severity: "error",
                file: file.ends_with(".bib").then(|| project::relativize(root, file)).flatten(),
                line: if file.ends_with(".bib") { number.trim().parse().ok() } else { None },
                message: format!("BibTeX: {message}"),
            });
        }
    }
    issues
}

/// Splits `./file.tex:12: message` into its parts.
fn split_file_line(line: &str) -> Option<(&str, u32, &str)> {
    let mut search = 0;
    while let Some(offset) = line[search..].find(':') {
        let colon = search + offset;
        let rest = &line[colon + 1..];
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && rest[digits..].starts_with(": ") {
            let file = &line[..colon];
            if file.ends_with(".tex") || file.ends_with(".sty") || file.ends_with(".cls") || file.ends_with(".bbl") {
                let number = rest[..digits].parse().ok()?;
                return Some((file, number, &rest[digits + 2..]));
            }
        }
        search = colon + 1;
    }
    None
}

fn input_line(message: &str) -> Option<u32> {
    let (_, rest) = message.split_once("on input line ")?;
    rest.trim_end_matches('.').trim().parse().ok()
}

fn lines_range(line: &str) -> Option<u32> {
    let (_, rest) = line.split_once("at lines ")?;
    rest.split("--").next()?.trim().parse().ok()
}
