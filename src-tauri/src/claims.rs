//! Claim check: does each cited paper say what the sentence citing it claims?
//! ruru lists the citing sentences and keeps the verdicts; Claude reads the cited paper and
//! proposes a verdict per sentence; the author records the ones they accept with `ruru verdict`.

use crate::{claude, ruru};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const SYSTEM_PROMPT: &str = "\
You check citations in an academic paper. For each sentence below that cites one paper, you \
read that paper and judge whether it supports what the sentence attributes to it.

Judge only what the sentence attributes to the cited paper, not the rest of the sentence \
(often the authors' own result). Verdicts:
- supported: the paper says it. Give `quote`, the paper's own words copied verbatim from the \
text you were given (one or two sentences, no ellipses, no paraphrase), and `page`.
- partial: the paper says something narrower or weaker. Give the quote, page, and a `note` on \
what is overstated or narrower.
- unsupported: the paper doesn't say it, or says otherwise. `note` says what the paper does say.
- not-found: you read it and couldn't find the passage either way. `note` says where you looked.
- background: the citation is a general pointer (\"see [x]\", software, a dataset), with \
nothing specific to check. `note` says why.

Never judge from memory or from the title: only from the text given. Search the text for the \
key terms before deciding not-found. Keep notes to one or two sentences. Leave fields empty \
when they don't apply. You may read files but must not change anything.";

#[derive(Serialize, Deserialize, Clone)]
pub struct Verdict {
    pub claim: String,
    pub verdict: String,
    pub page: String,
    pub quote: String,
    pub note: String,
    /// Whether the quote appears in the text Claude was given (ignoring spacing, hyphenation
    /// and punctuation). `ruru verdict` refuses a quote it can't find in the PDF.
    pub quote_found: bool,
}

#[derive(Serialize)]
pub struct Judgement {
    pub key: String,
    /// What the verdicts rest on: pdf, abstract, draft or software (`ruru verdict --from`).
    pub from: String,
    pub verdicts: Vec<Verdict>,
    pub cost_usd: f64,
}

/// `ruru claims PROJECT`: every citing sentence with its keys and verdicts. None when the
/// folder isn't a ruru project.
pub fn list(root: &Path) -> Result<Option<Value>, String> {
    let Some(project) = ruru::project_for(root) else { return Ok(None) };
    ruru::run(&["claims", &project]).map(Some)
}

/// Asks Claude for a verdict on each of `claims` (ids) citing `key`; all of them when empty.
pub fn judge(root: &Path, key: &str, claims: &[String]) -> Result<Judgement, String> {
    let project = ruru::project_for(root).ok_or("this folder isn't a ruru project")?;
    let listed = ruru::run(&["claims", &project, "-k", key])?;
    let wanted: Vec<&Value> = listed["claims"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| claims.is_empty() || claims.iter().any(|id| c["id"] == id.as_str()))
        .collect();
    if wanted.is_empty() {
        return Err(format!("no claims cite {key} (save and try again if you just added one)"));
    }
    let check = wanted[0]["checks"].as_array().into_iter().flatten().find(|c| c["key"] == key).cloned().unwrap_or(Value::Null);
    let source = read_source(key, &check)?;

    let mut prompt = format!("Cited paper: [@{key}] {}\n{}\n\nClaims citing it:\n", check["title"].as_str().unwrap_or(""), source.how);
    for claim in &wanted {
        prompt.push_str(&format!("- id {} ({}:{}): {}\n", claim["id"].as_str().unwrap_or(""), claim["file"].as_str().unwrap_or(""), claim["line"], claim["text"].as_str().unwrap_or("")));
    }
    prompt.push_str("\nGive one verdict per claim id.");

    let ids: Vec<&str> = wanted.iter().filter_map(|c| c["id"].as_str()).collect();
    let dirs: Vec<&Path> = source.dirs.iter().map(PathBuf::as_path).collect();
    let answer = claude::ask(&source.cwd, &dirs, SYSTEM_PROMPT, &prompt, &schema(&ids))?;

    let haystack = normalize(&source.text);
    let verdicts = answer.output["verdicts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let field = |name: &str| v[name].as_str().unwrap_or("").trim().to_string();
            let claim = field("claim");
            if !ids.contains(&claim.as_str()) {
                return None;
            }
            let quote = field("quote");
            let quote_found = !quote.is_empty() && haystack.contains(&normalize(&quote));
            Some(Verdict { claim, verdict: field("verdict"), page: field("page"), quote, note: field("note"), quote_found })
        })
        .collect();
    Ok(Judgement { key: key.to_string(), from: source.from, verdicts, cost_usd: answer.cost_usd })
}

/// Records one accepted verdict with `ruru verdict` (one commit in the library).
pub fn record(root: &Path, key: &str, from: &str, verdict: &Verdict) -> Result<String, String> {
    let project = ruru::project_for(root).ok_or("this folder isn't a ruru project")?;
    let mut args = vec!["verdict", &project, &verdict.claim, key, &verdict.verdict, "--by", "claude", "--from", from];
    for (flag, value) in [("-p", &verdict.page), ("--quote", &verdict.quote), ("--note", &verdict.note)] {
        if !value.is_empty() {
            args.extend([flag, value.as_str()]);
        }
    }
    let output = ruru::command(&args)?.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() { Ok(stdout) } else { Err(if stderr.is_empty() { stdout } else { stderr }) }
}

struct Source {
    from: String,
    /// What Claude is told about where to read.
    how: String,
    /// Everything it was given, for checking quotes.
    text: String,
    cwd: PathBuf,
    dirs: Vec<PathBuf>,
}

/// Gets the cited work's text: the PDF's pages, a draft's .tex files, software's README, or
/// failing those the abstract.
fn read_source(key: &str, check: &Value) -> Result<Source, String> {
    let work = std::env::temp_dir().join("tuhi-claims").join(key.replace(['/', '\\', '.'], "_"));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let kind = check["kind"].as_str().unwrap_or("");
    let read: Vec<PathBuf> = check["read"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(PathBuf::from)).collect();

    if kind == "paper" && check["has_pdf"].as_bool().unwrap_or(false) {
        let text = pdf_pages(key)?;
        let file = format!("{}.txt", work.file_name().unwrap().to_string_lossy());
        fs::write(work.join(&file), &text).map_err(|e| e.to_string())?;
        return Ok(Source {
            from: "pdf".into(),
            how: format!(
                "Its full text is in {file} in the working directory, with \"=== PDF page N ===\" before each page. \
                 Give `page` as the page number printed on that page when one is visible, else the PDF page."
            ),
            text,
            cwd: work,
            dirs: Vec::new(),
        });
    }
    if (kind == "draft" || kind == "software") && !read.is_empty() {
        let text = read.iter().filter_map(|p| fs::read_to_string(p).ok()).collect::<Vec<_>>().join("\n");
        let dirs = read.iter().filter_map(|p| p.parent().map(Path::to_path_buf)).collect();
        let list = read.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
        let page = if kind == "draft" { "the file and line, e.g. main.tex:120" } else { "the README section or file" };
        return Ok(Source {
            from: kind.into(),
            how: format!("It is {} {kind}; read these files: {list}. Give `page` as {page}.", if kind == "draft" { "an unpublished" } else { "a" }),
            text,
            cwd: work,
            dirs,
        });
    }
    if kind == "paper" {
        let shown = ruru::run(&["show", key])?;
        let abstract_ = shown["abstract"].as_str().unwrap_or("").trim().to_string();
        if abstract_.is_empty() {
            return Err(format!("{key} has no PDF or abstract in the library. Run `ruru pdf missing --cited PROJECT --fetch --open` to get the PDF."));
        }
        return Ok(Source {
            from: "abstract".into(),
            how: format!("There's no PDF, only the abstract (judge from it alone; leave `page` empty):\n\n{abstract_}"),
            text: abstract_,
            cwd: work,
            dirs: Vec::new(),
        });
    }
    Err(format!("{key} isn't in your ruru library, so there's nothing to check it against."))
}

/// The PDF's text page by page, in one ruru process.
fn pdf_pages(key: &str) -> Result<String, String> {
    let first = ruru::run(&["pdf", "text", key, "--page", "1"])?;
    let pages = first["pages"].as_u64().ok_or_else(|| format!("couldn't read the PDF of {key}"))?;
    let script: String = (1..=pages).map(|n| format!("pdf text {key} --page {n} --json\n")).collect();
    let mut child = ruru::command(&["batch", "-F", "-"])?
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(script.as_bytes()).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let results: Vec<Value> = serde_json::from_slice(&output.stdout).map_err(|_| format!("couldn't read the PDF of {key}"))?;
    let mut text = String::new();
    for (n, result) in results.iter().enumerate() {
        text.push_str(&format!("=== PDF page {} ===\n{}\n\n", n + 1, result["data"]["text"].as_str().unwrap_or("")));
    }
    Ok(text)
}

fn schema(ids: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": { "type": "string", "enum": ids },
                        "verdict": { "type": "string", "enum": ["supported", "partial", "unsupported", "not-found", "background"] },
                        "page": { "type": "string" },
                        "quote": { "type": "string" },
                        "note": { "type": "string" }
                    },
                    "required": ["claim", "verdict", "page", "quote", "note"]
                }
            }
        },
        "required": ["verdicts"]
    })
}

/// Letters and digits only, lower-cased, with ligatures spelled out: what's left of a quote
/// after line breaks, hyphenation and spacing in the PDF's text layer.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            'ﬁ' => out.push_str("fi"),
            'ﬂ' => out.push_str("fl"),
            'ﬀ' => out.push_str("ff"),
            'ﬃ' => out.push_str("ffi"),
            'ﬄ' => out.push_str("ffl"),
            c if c.is_alphanumeric() => out.extend(c.to_lowercase()),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_match_across_line_breaks_and_ligatures() {
        let page = "the eﬃcient esti-\nmator is   robust.";
        assert!(normalize(page).contains(&normalize("The efficient estimator is robust")));
        assert!(!normalize(page).contains(&normalize("the estimator is efficient")));
    }
}
