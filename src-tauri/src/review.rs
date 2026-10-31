//! Reviewer comments: where they're stored, splitting a pasted letter into comments, and
//! finding the source line a comment is about.

use crate::synctex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Reviews live in the paper's repo so the triage travels with it. The frontend owns the
/// schema; this side only reads and writes the JSON.
pub fn reviews_dir(root: &Path) -> PathBuf {
    root.join(".tuhi").join("reviews")
}

fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(format!("bad review id {id:?}")) }
}

pub fn list(root: &Path) -> Result<Vec<Value>, String> {
    let Ok(entries) = fs::read_dir(reviews_dir(root)) else { return Ok(Vec::new()) };
    let mut reviews = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            reviews.push(serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?);
        }
    }
    reviews.sort_by_key(|r: &Value| r["created"].as_str().unwrap_or_default().to_string());
    Ok(reviews)
}

pub fn save(root: &Path, review: &Value) -> Result<(), String> {
    let id = review["id"].as_str().ok_or("review has no id")?;
    check_id(id)?;
    let dir = reviews_dir(root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(review).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.json")), text + "\n").map_err(|e| e.to_string())
}

/// Copies the annotated PDF next to the review and returns its root-relative path.
pub fn import_pdf(root: &Path, id: &str, source: &Path) -> Result<String, String> {
    check_id(id)?;
    let dir = reviews_dir(root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::copy(source, dir.join(format!("{id}.pdf"))).map_err(|e| format!("{}: {e}", source.display()))?;
    Ok(format!(".tuhi/reviews/{id}.pdf"))
}

// Splitting a pasted review letter

#[derive(Serialize, Debug, PartialEq)]
pub struct PastedComment {
    /// "R1", "R2", "AE" when the letter has reviewer headings.
    pub group: Option<String>,
    pub text: String,
    /// The longest quotation in the comment, used to find where it applies.
    pub quote: Option<String>,
}

/// Splits on numbered or bulleted items when the letter has them, otherwise on paragraphs.
pub fn split_comments(letter: &str) -> Vec<PastedComment> {
    let lines: Vec<&str> = letter.lines().collect();
    let numbered = lines.iter().any(|l| item_start(l).is_some());
    let mut comments = Vec::new();
    let mut group: Option<String> = None;
    let mut current: Vec<String> = Vec::new();

    let flush = |current: &mut Vec<String>, group: &Option<String>, comments: &mut Vec<PastedComment>| {
        let text = current.join("\n").trim().to_string();
        current.clear();
        if !text.is_empty() {
            comments.push(PastedComment { group: group.clone(), quote: longest_quote(&text), text });
        }
    };

    for line in lines {
        if let Some(heading) = group_heading(line) {
            flush(&mut current, &group, &mut comments);
            group = Some(heading);
        } else if let Some(rest) = item_start(line) {
            flush(&mut current, &group, &mut comments);
            current.push(rest.to_string());
        } else if line.trim().is_empty() && !numbered {
            flush(&mut current, &group, &mut comments);
        } else {
            current.push(line.trim().to_string());
        }
    }
    flush(&mut current, &group, &mut comments);
    comments
}

/// "Reviewer 2", "Reviewer #1:", "Associate Editor" → a short group label.
fn group_heading(line: &str) -> Option<String> {
    let t = line.trim().trim_end_matches(':').trim().to_lowercase();
    if t.len() > 40 {
        return None;
    }
    if let Some(rest) = t.strip_prefix("reviewer") {
        let n: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        let only_number = rest.chars().all(|c| c.is_ascii_digit() || " #:.-".contains(c));
        if !n.is_empty() && only_number {
            return Some(format!("R{n}"));
        }
    }
    match t.as_str() {
        "associate editor" | "ae" | "associate editor comments" => Some("AE".into()),
        "editor" | "editor comments" | "editor-in-chief" => Some("E".into()),
        _ => None,
    }
}

/// "1. …", "2) …", "(3) …", "Comment 4: …", "- …", "• …" → the text after the marker.
fn item_start(line: &str) -> Option<&str> {
    let t = line.trim_start();
    for bullet in ["- ", "• ", "* ", "– "] {
        if let Some(rest) = t.strip_prefix(bullet) {
            return Some(rest);
        }
    }
    let t2 = t.strip_prefix("Comment ").or_else(|| t.strip_prefix("comment ")).unwrap_or(t);
    let t2 = t2.strip_prefix('(').unwrap_or(t2);
    let digits = t2.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 3 {
        return None;
    }
    let rest = &t2[digits..];
    for sep in [". ", ") ", ": ", ".) "] {
        if let Some(rest) = rest.strip_prefix(sep) {
            return Some(rest);
        }
    }
    None
}

fn longest_quote(text: &str) -> Option<String> {
    let mut best: Option<&str> = None;
    for (open, close) in [('“', '”'), ('"', '"'), ('‘', '’')] {
        let mut rest = text;
        while let Some(start) = rest.find(open) {
            let after = &rest[start + open.len_utf8()..];
            let Some(end) = after.find(close) else { break };
            let quote = &after[..end];
            if quote.split_whitespace().count() >= 4 && best.is_none_or(|b| quote.len() > b.len()) {
                best = Some(quote);
            }
            rest = &after[end + close.len_utf8()..];
        }
    }
    best.map(str::to_string)
}

// Locating a comment in the source

#[derive(Serialize, Debug)]
pub struct Located {
    pub file: String,
    pub line: u32,
    /// "text" when the quote was found in the source, "position" when only SyncTeX placed it.
    pub method: &'static str,
    /// Share of the quote's words found, 1.0 for position matches.
    pub score: f64,
}

/// Finds the source line for a comment. A quote is matched against the source text, and the
/// page position (via SyncTeX on the current build) breaks ties or stands in when there is
/// no quote. Position-only results assume the reviewed PDF matches the current build.
pub fn locate(
    root: &Path,
    files: &[String],
    pdf: &Path,
    quote: Option<&str>,
    position: Option<(u32, f64, f64)>,
) -> Option<Located> {
    let near = position
        .filter(|_| pdf.exists())
        .and_then(|(page, x, y)| synctex::inverse(root, pdf, page, x, y).ok().flatten());

    if let Some(quote) = quote {
        let words = words_of(quote);
        if words.len() >= 3 {
            let mut candidates = Vec::new();
            for file in files.iter().filter(|f| f.ends_with(".tex")) {
                let Ok(text) = fs::read_to_string(root.join(file)) else { continue };
                candidates.extend(best_windows(&tex_words(&text), &words).into_iter().map(|(line, score)| (file, line, score)));
            }
            let best = candidates.iter().map(|c| c.2).fold(0.0, f64::max);
            if best >= 0.6 {
                // Among near-best matches, prefer the one closest to where SyncTeX points.
                let chosen = candidates
                    .iter()
                    .filter(|c| c.2 >= best - 0.05)
                    .min_by_key(|(file, line, score)| match &near {
                        Some(n) if &n.file == *file => (0, n.line.abs_diff(*line), (1000.0 * (1.0 - score)) as u32),
                        _ => (1, 0, (1000.0 * (1.0 - score)) as u32),
                    })?;
                return Some(Located { file: chosen.0.clone(), line: chosen.1, method: "text", score: chosen.2 });
            }
        }
    }
    near.map(|n| Located { file: n.file, line: n.line, method: "position", score: 1.0 })
}

/// Lowercased words of text extracted from a PDF, with ligatures undone.
fn words_of(text: &str) -> Vec<String> {
    let text = text
        .replace('ﬁ', "fi")
        .replace('ﬂ', "fl")
        .replace('ﬀ', "ff")
        .replace('ﬃ', "ffi")
        .replace('ﬄ', "ffl");
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Commands whose first argument is a key or path rather than words on the page.
const NON_PROSE_ARGS: &[&str] = &[
    "cite", "citep", "citet", "citeauthor", "citeyear", "nocite", "ref", "eqref", "autoref", "cref",
    "Cref", "pageref", "label", "includegraphics", "input", "include", "usepackage", "documentclass",
    "bibliography", "bibliographystyle", "begin", "end", "url", "href", "res", "graphicspath",
    "hspace", "vspace", "newcommand", "renewcommand",
];

fn skip_group(chars: &mut std::iter::Peekable<std::str::Chars>, open: char, close: char) {
    if chars.next_if_eq(&open).is_none() {
        return;
    }
    let mut depth = 1;
    for c in chars.by_ref() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return;
            }
        }
    }
}

/// Words of LaTeX source with their line numbers, skipping comments, command names and
/// inline maths (which never survives PDF text extraction intact).
fn tex_words(source: &str) -> Vec<(String, u32)> {
    let mut words = Vec::new();
    let mut in_math = false;
    for (index, line) in source.lines().enumerate() {
        let number = index as u32 + 1;
        let mut word = String::new();
        let mut chars = line.chars().peekable();
        let mut push = |word: &mut String| {
            if !word.is_empty() {
                words.push((std::mem::take(word), number));
            }
        };
        while let Some(c) = chars.next() {
            match c {
                '%' => break,
                '$' => {
                    push(&mut word);
                    in_math = !in_math;
                }
                '\\' => {
                    push(&mut word);
                    // Skip the command name, or the single escaped character.
                    let mut name = String::new();
                    while let Some(c) = chars.next_if(|c| c.is_ascii_alphabetic()) {
                        name.push(c);
                    }
                    if name.is_empty() {
                        chars.next();
                    } else if NON_PROSE_ARGS.contains(&name.as_str()) {
                        chars.next_if_eq(&'*');
                        skip_group(&mut chars, '[', ']');
                        skip_group(&mut chars, '{', '}');
                    }
                }
                _ if in_math => {}
                c if c.is_alphanumeric() => word.extend(c.to_lowercase()),
                _ => push(&mut word),
            }
        }
        push(&mut word);
    }
    words
}

/// Slides a window the length of the quote over the source and scores each position by how
/// many of the quote's words it contains. Returns (line, score) for local bests.
fn best_windows(source: &[(String, u32)], quote: &[String]) -> Vec<(u32, f64)> {
    let m = quote.len();
    if source.len() < m {
        return Vec::new();
    }
    let mut need: HashMap<&str, i32> = HashMap::new();
    for w in quote {
        *need.entry(w.as_str()).or_default() += 1;
    }
    let mut have: HashMap<&str, i32> = HashMap::new();
    let mut matched = 0i32;
    fn add<'q>(need: &HashMap<&'q str, i32>, have: &mut HashMap<&'q str, i32>, matched: &mut i32, w: &str, delta: i32) {
        // Key `have` by need's own &str so it outlives the window's borrowed word.
        let Some((&key, &n)) = need.get_key_value(w) else { return };
        let h = have.entry(key).or_default();
        let before = (*h).min(n);
        *h += delta;
        *matched += (*h).min(n) - before;
    }

    let mut scored = Vec::new();
    for (i, (w, _)) in source.iter().enumerate() {
        add(&need, &mut have, &mut matched, w, 1);
        if i >= m {
            add(&need, &mut have, &mut matched, &source[i - m].0, -1);
        }
        if i + 1 >= m {
            scored.push((i + 1 - m, matched as f64 / m as f64));
        }
    }
    let best = scored.iter().map(|s| s.1).fold(0.0, f64::max);
    // Keep each window that's within reach of the best and better than its neighbours.
    let mut out: Vec<(u32, f64)> = Vec::new();
    for (k, &(start, score)) in scored.iter().enumerate() {
        if score < best - 0.05 || score < 0.6 {
            continue;
        }
        let prev = if k > 0 { scored[k - 1].1 } else { 0.0 };
        let next = scored.get(k + 1).map_or(0.0, |s| s.1);
        if score >= prev && score >= next {
            // Report the line of the first window word that's actually in the quote.
            let line = source[start..start + m]
                .iter()
                .find(|(w, _)| need.contains_key(w.as_str()))
                .map_or(source[start].1, |(_, l)| *l);
            if out.last().is_none_or(|(l, _)| *l != line) {
                out.push((line, score));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_numbered_letter_with_reviewer_headings() {
        let letter = "Reviewer #1:\nThe paper studies alignment.\n\n1. The claim that \"joint fitting always beats pairwise alignment\" needs support.\n2) Fig. 3 is hard to read.\n   Please enlarge it.\n\nReviewer 2\n- Typo in Section 2.";
        let comments = split_comments(letter);
        assert_eq!(comments.len(), 4);
        assert_eq!(comments[0].text, "The paper studies alignment.");
        assert_eq!(comments[1].group.as_deref(), Some("R1"));
        assert_eq!(comments[1].quote.as_deref(), Some("joint fitting always beats pairwise alignment"));
        assert_eq!(comments[2].text, "Fig. 3 is hard to read.\nPlease enlarge it.");
        assert_eq!(comments[3].group.as_deref(), Some("R2"));
    }

    #[test]
    fn splits_unnumbered_letter_on_paragraphs() {
        let comments = split_comments("First point.\nStill first.\n\nSecond point.");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].text, "First point.\nStill first.");
    }

    #[test]
    fn finds_quote_through_latex_markup() {
        let source = "Intro text here.\n% a comment about joint fitting\nWe show that \\emph{joint fitting} beats\npairwise alignment~\\cite{x} on $K=5$ batches.\n";
        let quote = words_of("We show that joint ﬁtting beats pairwise alignment on batches");
        let hits = best_windows(&tex_words(source), &quote);
        assert_eq!(hits.first().map(|h| h.0), Some(3));
        assert!(hits[0].1 > 0.9);
    }
}
