//! Claude explains a LaTeX error in plain English and, when it can, proposes a one-line fix
//! that the author applies with one click.

use crate::{claude, draft, project};
use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

const SYSTEM_PROMPT: &str = "\
You explain LaTeX compile errors to an academic author in plain English and propose the fix.

- `explanation`: two or three short sentences: what went wrong and why, without jargon.
- If the fix is an edit to the source, give `file`, `find` (copied verbatim from the source, \
long enough to be unique, normally the offending line or part of it) and `replace`. Keep \
everything else in the line as it is.
- If the fix is outside the source (install a package, a missing file, a class problem), leave \
`find` empty and say what to do in the explanation.
- You may read files in the project to find the cause. Do not modify anything.";

#[derive(Serialize)]
pub struct Fix {
    pub file: String,
    pub line: u32,
    /// The exact source text the fix replaces.
    pub before: String,
    pub after: String,
}

#[derive(Serialize)]
pub struct Explanation {
    pub explanation: String,
    pub fix: Option<Fix>,
    pub cost_usd: f64,
}

pub fn explain(root: &Path, message: &str, file: Option<&str>, line: Option<u32>, log: &str) -> Result<Explanation, String> {
    let mut prompt = format!("Error: {message}\n");
    if let Some(excerpt) = log_excerpt(log, message) {
        prompt.push_str(&format!("\nThe log around it:\n{excerpt}\n"));
    }
    if let (Some(file), Some(line)) = (file, line) {
        if let Ok(text) = project::resolve(root, file).and_then(|p| fs::read_to_string(p).map_err(|e| e.to_string())) {
            let lines: Vec<&str> = text.lines().collect();
            let (start, end) = ((line as usize).saturating_sub(15).max(1), (line as usize + 10).min(lines.len()));
            prompt.push_str(&format!("\nThe log points at {file}, line {line}. Source lines {start}-{end}:\n"));
            for (i, l) in lines.get(start - 1..end).unwrap_or_default().iter().enumerate() {
                prompt.push_str(&format!("{:>5}  {l}\n", start + i));
            }
        }
    }
    let answer = claude::ask(root, &[], SYSTEM_PROMPT, &prompt, &schema())?;
    let out = &answer.output;
    let field = |k: &str| out[k].as_str().unwrap_or("").to_string();

    let (fix_file, find, replace) = (field("file").trim_start_matches("./").to_string(), field("find"), field("replace"));
    let fix = (!find.trim().is_empty() && find != replace)
        .then(|| {
            let target = if fix_file.is_empty() { file?.to_string() } else { fix_file };
            let text = fs::read_to_string(project::resolve(root, &target).ok()?).ok()?;
            let near = line.filter(|_| Some(target.as_str()) == file);
            let (start, end) = draft::locate(&text, &find, near)?;
            Some(Fix { line: text[..start].matches('\n').count() as u32 + 1, before: text[start..end].to_string(), after: replace, file: target })
        })
        .flatten();
    Ok(Explanation { explanation: field("explanation"), fix, cost_usd: answer.cost_usd })
}

/// The lines of the log around the first line that mentions the error.
fn log_excerpt(log: &str, message: &str) -> Option<String> {
    let key: String = message.chars().take(40).collect();
    let lines: Vec<&str> = log.lines().collect();
    let at = lines.iter().position(|l| l.contains(key.trim()))?;
    Some(lines[at.saturating_sub(6)..(at + 12).min(lines.len())].join("\n"))
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "explanation": { "type": "string" },
            "file": { "type": "string" },
            "find": { "type": "string" },
            "replace": { "type": "string" }
        },
        "required": ["explanation", "file", "find", "replace"]
    })
}
