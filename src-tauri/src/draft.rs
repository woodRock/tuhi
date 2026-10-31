//! Asks Claude (via the `claude` CLI) to draft a change for one reviewer comment, then checks
//! each proposed edit still matches the source before the author sees it.

use crate::{claude, project};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

const SYSTEM_PROMPT: &str = "\
You help an academic author revise a LaTeX paper in response to peer review. For one reviewer \
comment you propose the smallest set of source edits that addresses it, and draft the author's \
reply to the reviewer.

Rules:
- Edit only what the comment calls for. Keep the author's voice, spelling conventions and LaTeX \
macros. Never rewrite surrounding text for style.
- Each edit's `find` must be copied verbatim from the current source (a sentence or clause is \
ideal, long enough to be unique) and `replace` is its full replacement.
- Never invent results, numbers, citations or references. Numbers in the paper come from macros \
such as \\res{...}; keep them as macros. Only cite keys that exist in the project's .bib files \
(search them). If a fix needs new data, experiments, citations you can't find, or a decision \
only the authors can make, leave the edits empty or partial and explain in `author_input`.
- The reply is one to three sentences in the first person plural, saying what changed and where, \
or politely why not. Don't thank the reviewer at length.
- You may read files in the project to check context. Do not modify anything.";

#[derive(Serialize, Deserialize)]
pub struct Hunk {
    pub file: String,
    /// 1-based line where `before` starts.
    pub line: u32,
    /// The exact text in the file now; applying the hunk replaces this.
    pub before: String,
    pub after: String,
    pub why: String,
    /// "pending" until the author accepts or rejects it.
    pub state: String,
}

#[derive(Serialize)]
pub struct Proposal {
    pub summary: String,
    pub hunks: Vec<Hunk>,
    /// Edits Claude suggested whose text couldn't be found in the source.
    pub unmatched: Vec<String>,
    pub response: String,
    pub author_input: String,
    pub cost_usd: f64,
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string", "description": "One line: what the change does." },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "file": { "type": "string", "description": "Project-relative path." },
                        "find": { "type": "string" },
                        "replace": { "type": "string" },
                        "why": { "type": "string", "description": "Short reason for this edit." }
                    },
                    "required": ["file", "find", "replace", "why"]
                }
            },
            "response": { "type": "string" },
            "author_input": { "type": "string", "description": "What the authors must supply or decide; empty if nothing." }
        },
        "required": ["summary", "edits", "response", "author_input"]
    })
}

/// The comment plus the source it points at, with line numbers.
fn prompt(root: &Path, files: &[String], card: &Value) -> String {
    let mut out = String::new();
    let field = |k: &str| card[k].as_str().unwrap_or_default().trim().to_string();
    out.push_str(&format!("Reviewer comment {} ({}):\n{}\n", field("id"), field("kind"), field("comment")));
    let quote = field("quote");
    if !quote.is_empty() {
        out.push_str(&format!("\nThe reviewer marked this text in the PDF:\n\"{quote}\"\n"));
    }

    let location = &card["location"];
    if let (Some(file), Some(line)) = (location["file"].as_str(), location["line"].as_u64()) {
        if let Ok(text) = project::resolve(root, file).and_then(|p| fs::read_to_string(p).map_err(|e| e.to_string())) {
            let lines: Vec<&str> = text.lines().collect();
            let line = line as usize;
            // Whole file when it's paper-sized, otherwise a generous window around the line.
            let (start, end) = if lines.len() <= 600 {
                (1, lines.len())
            } else {
                (line.saturating_sub(80).max(1), (line + 80).min(lines.len()))
            };
            out.push_str(&format!("\nThe comment points at {file}, line {line}. Source lines {start}-{end}:\n"));
            for (i, l) in lines[start - 1..end].iter().enumerate() {
                out.push_str(&format!("{:>5}  {l}\n", start + i));
            }
        }
    } else {
        out.push_str("\nThe comment isn't linked to a line yet; search the source for where it applies.\n");
    }
    out.push_str(&format!("\nProject files: {}\n", files.join(", ")));
    out
}

pub fn draft(root: &Path, card: &Value) -> Result<Proposal, String> {
    let files = project::open(root)?.files;
    let reply = claude::ask(root, &[], SYSTEM_PROMPT, &prompt(root, &files, card), &schema())?;
    let answer = &reply.output;

    let near = card["location"]["line"].as_u64().map(|l| l as u32);
    let mut hunks = Vec::new();
    let mut unmatched = Vec::new();
    for edit in answer["edits"].as_array().into_iter().flatten() {
        let file = edit["file"].as_str().unwrap_or_default().trim_start_matches("./").to_string();
        let find = edit["find"].as_str().unwrap_or_default();
        let replace = edit["replace"].as_str().unwrap_or_default();
        let source = project::resolve(root, &file).ok().and_then(|p| fs::read_to_string(p).ok());
        match source.as_deref().and_then(|s| locate(s, find, near.filter(|_| card["location"]["file"] == file.as_str()))) {
            Some((start, end)) if find.trim() != replace.trim() => {
                let text = source.as_deref().unwrap_or_default();
                hunks.push(Hunk {
                    line: text[..start].matches('\n').count() as u32 + 1,
                    before: text[start..end].to_string(),
                    after: replace.to_string(),
                    why: edit["why"].as_str().unwrap_or_default().to_string(),
                    state: "pending".into(),
                    file,
                });
            }
            Some(_) => {}
            None => unmatched.push(format!("{file}: {find}")),
        }
    }

    Ok(Proposal {
        summary: answer["summary"].as_str().unwrap_or_default().to_string(),
        hunks,
        unmatched,
        response: answer["response"].as_str().unwrap_or_default().to_string(),
        author_input: answer["author_input"].as_str().unwrap_or_default().to_string(),
        cost_usd: reply.cost_usd,
    })
}

/// Byte span of `find` in `text`, ignoring differences in whitespace. When it appears more
/// than once, takes the occurrence nearest `near_line`.
pub fn locate(text: &str, find: &str, near_line: Option<u32>) -> Option<(usize, usize)> {
    let (norm_text, offsets) = collapse_whitespace(text);
    let (norm_find, _) = collapse_whitespace(find.trim());
    if norm_find.is_empty() {
        return None;
    }
    let mut best: Option<(usize, usize)> = None;
    let mut best_distance = u32::MAX;
    let mut from = 0;
    while let Some(i) = norm_text[from..].find(&norm_find) {
        let s = from + i;
        let e = s + norm_find.len();
        let start = offsets[s];
        let last = offsets[e - 1];
        let end = last + text[last..].chars().next().map_or(1, char::len_utf8);
        let line = text[..start].matches('\n').count() as u32 + 1;
        let distance = near_line.map_or(0, |n| n.abs_diff(line));
        if best.is_none() || distance < best_distance {
            best = Some((start, end));
            best_distance = distance;
        }
        from = s + norm_text[s..].chars().next().map_or(1, char::len_utf8);
    }
    best
}

/// Text with each whitespace run turned into one space, plus each output byte's offset in
/// the original.
fn collapse_whitespace(text: &str) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(text.len());
    let mut offsets = Vec::with_capacity(text.len());
    let mut in_space = false;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if !in_space {
                out.push(' ');
                offsets.push(i);
                in_space = true;
            }
        } else {
            let before = out.len();
            out.push(c);
            offsets.extend(std::iter::repeat_n(i, out.len() - before));
            in_space = false;
        }
    }
    (out, offsets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_across_line_breaks_and_prefers_nearest() {
        let text = "alpha beta\ngamma delta\n\nfiller\nalpha beta gamma delta\n";
        let span = locate(text, "beta gamma", None).unwrap();
        assert_eq!(&text[span.0..span.1], "beta\ngamma");
        let span = locate(text, "beta gamma", Some(5)).unwrap();
        assert_eq!(&text[span.0..span.1], "beta gamma");
        assert!(locate(text, "not there", None).is_none());
    }

    /// Calls Claude for real: `TUHI_TEST_PROJECT=/path cargo test draft -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn drafts_a_change_for_a_real_comment() {
        let root = std::path::PathBuf::from(std::env::var("TUHI_TEST_PROJECT").expect("set TUHI_TEST_PROJECT"));
        let card = json!({
            "id": "R2.1",
            "kind": "Highlight",
            "quote": "By construction, the induced batch-to-batch transformations are cycle-consistent:",
            "comment": "Is cycle consistency actually guaranteed under corrupted anchors? Please qualify.",
            "location": { "file": "TAI_template.tex", "line": 43 }
        });
        let proposal = draft(&root, &card).unwrap();
        println!("summary: {}\nresponse: {}\nauthor_input: {}\ncost: ${:.3}", proposal.summary, proposal.response, proposal.author_input, proposal.cost_usd);
        for h in &proposal.hunks {
            println!("--- {}:{} ({})\n- {}\n+ {}", h.file, h.line, h.why, h.before, h.after);
        }
        println!("unmatched: {:?}", proposal.unmatched);
        assert!(!proposal.hunks.is_empty() || !proposal.author_input.is_empty());
    }

    #[test]
    fn keeps_multibyte_characters_intact() {
        let text = "Ko te reo Māori\n  tēnei.";
        let span = locate(text, "Māori tēnei", None).unwrap();
        assert_eq!(&text[span.0..span.1], "Māori\n  tēnei");
    }
}
