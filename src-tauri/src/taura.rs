//! Provenance from taura, the ledger that links paper numbers and figures to code runs.
//! taura stays the source of truth: this only runs its CLI with --json and passes results on.

use crate::tools;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::thread;

#[derive(Serialize)]
pub struct Artifact {
    pub name: String,
    pub kind: String,
    /// Paper-relative path, e.g. "generated/fig1_data.pdf".
    pub output: String,
}

#[derive(Serialize)]
pub struct Report {
    /// `taura status`: code repo, last publish, counts.
    pub status: Value,
    /// `taura check` findings: id, severity, repo, location, message, fix.
    pub findings: Vec<Value>,
    /// `taura diff`: what publishing now would change.
    pub changes: Vec<Value>,
    pub artifacts: Vec<Artifact>,
}

fn run(root: &Path, args: &[&str]) -> Result<Value, String> {
    let output = tools::command("taura")?
        .arg("--json")
        .args(args)
        .arg("-C")
        .arg(root)
        .output()
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| format!("taura {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    Ok(value)
}

/// None when taura isn't installed or the paper isn't paired with a code repo.
pub fn report(root: &Path) -> Result<Option<Report>, String> {
    if tools::which("taura").is_none() {
        return Ok(None);
    }
    let status = match run(root, &["status"]) {
        Ok(status) => status,
        // Not set up with taura at all; anything else is a real failure worth showing.
        Err(e) if ["taura init", "not paired", "taura.lock", "is not inside"].iter().any(|m| e.contains(m)) => return Ok(None),
        Err(e) => return Err(e),
    };
    // check is the slow one (about a second); run it and diff side by side.
    let (check, diff) = thread::scope(|s| {
        let check = s.spawn(|| run(root, &["check"]));
        let diff = s.spawn(|| run(root, &["diff"]));
        (check.join().unwrap_or_else(|_| Err("taura check crashed".into())), diff.join().unwrap_or_else(|_| Err("taura diff crashed".into())))
    });
    let check = check?;
    let diff = diff?;
    Ok(Some(Report {
        status,
        findings: check["findings"].as_array().cloned().unwrap_or_default(),
        changes: diff["changes"].as_array().cloned().unwrap_or_default(),
        artifacts: artifacts(root),
    }))
}

/// Artifacts from the paper's taura.lock (`[artifacts.NAME]` tables).
fn artifacts(root: &Path) -> Vec<Artifact> {
    let Ok(lock) = fs::read_to_string(root.join("taura.lock")) else { return Vec::new() };
    let mut out: Vec<Artifact> = Vec::new();
    let mut in_artifact = false;
    for line in lock.lines().map(str::trim) {
        if line.starts_with('[') {
            in_artifact = false;
            if let Some(name) = line.strip_prefix("[artifacts.").and_then(|l| l.strip_suffix(']')) {
                out.push(Artifact { name: name.trim_matches('"').to_string(), kind: String::new(), output: String::new() });
                in_artifact = true;
            }
        } else if let (true, Some(current), Some((key, value))) = (in_artifact, out.last_mut(), line.split_once('=')) {
            let value = value.trim().trim_matches('"').to_string();
            match key.trim() {
                "kind" => current.kind = value,
                "output" => current.output = value,
                _ => {}
            }
        }
    }
    out
}

/// `taura trace` for a \res key, an artifact or file.tex:LINE, without the bulky
/// package lists in run environments.
pub fn trace(root: &Path, target: &str) -> Result<Value, String> {
    let mut value = run(root, &["trace", target])?;
    strip_packages(&mut value);
    Ok(value)
}

fn strip_packages(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("packages");
            map.values_mut().for_each(strip_packages);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_packages),
        _ => {}
    }
}
