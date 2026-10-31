//! Writes the response-to-reviewers letter for a review round as an editable LaTeX file.

use crate::{draft, project};
use serde_json::Value;
use std::fs;
use std::path::Path;

/// Writes `response/<round>.tex` and returns its root-relative path.
pub fn write(root: &Path, main: &str, review: &Value) -> Result<String, String> {
    let main_text = fs::read_to_string(project::resolve(root, main)?).map_err(|e| format!("{main}: {e}"))?;
    let title = paper_title(&main_text).unwrap_or_else(|| "the manuscript".into());
    let label = review["label"].as_str().unwrap_or("Revision");

    let mut cards: Vec<&Value> = review["cards"].as_array().map(|c| c.iter().collect()).unwrap_or_default();
    cards.sort_by_key(|c| card_order(c));

    let mut body = String::new();
    let mut group = String::new();
    for card in cards {
        let g = card["group"].as_str().unwrap_or_default();
        if g != group {
            group = g.to_string();
            body.push_str(&format!("\n\\section*{{{}}}\n", group_name(g)));
        }
        body.push_str(&card_section(root, card));
    }

    let letter = format!(
        r"\documentclass[11pt]{{article}}
\usepackage[margin=2.5cm]{{geometry}}
\usepackage[T1]{{fontenc}}
\usepackage[utf8]{{inputenc}}
\usepackage{{xcolor}}
\usepackage{{parskip}}

% Reviewer comments are set in grey; responses in the normal colour.
\newenvironment{{reviewer}}{{\par\color{{black!65}}\itshape}}{{\par}}
\newcommand{{\todo}}[1]{{\textcolor{{red}}{{[#1]}}}}

\begin{{document}}

\begin{{center}}
{{\Large Response to the reviewers}}\\[4pt]
{title}\\[4pt]
{label} \quad\textperiodcentered\quad \today
\end{{center}}

We thank the editor and reviewers for their careful reading of the manuscript. Each comment is
reproduced below in grey, followed by our response and the changes made. Locations refer to
the revised manuscript.
{body}
\end{{document}}
",
        title = escape(&title),
        label = escape(label),
    );

    let rel = format!("response/{}.tex", slug(label));
    let path = project::resolve(root, &rel)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, letter).map_err(|e| format!("{rel}: {e}"))?;
    Ok(rel)
}

fn card_section(root: &Path, card: &Value) -> String {
    let text = |k: &str| card[k].as_str().unwrap_or_default().trim().to_string();
    let mut out = format!("\n\\subsection*{{Comment {}}}\n\\begin{{reviewer}}\n", escape(&text("id")));
    let quote = text("quote");
    if !quote.is_empty() {
        out.push_str(&format!("Regarding ``{}'':\\\\\n", escape(&quote)));
    }
    out.push_str(&paragraphs(&escape(&text("comment"))));
    out.push_str("\n\\end{reviewer}\n\n");

    let status = text("status");
    let mut response = text("response");
    if response.is_empty() {
        response = card["proposal"]["response"].as_str().unwrap_or_default().trim().to_string();
    }
    let reason = text("reason");
    out.push_str("\\textbf{Response.} ");
    match status.as_str() {
        "wontfix" if response.is_empty() && reason.is_empty() => out.push_str("\\todo{Explain why this was not changed.}"),
        "wontfix" if response.is_empty() => out.push_str(&prose(&reason)),
        "wontfix" if reason.is_empty() => out.push_str(&prose(&response)),
        "wontfix" => out.push_str(&format!("{} {}", prose(&response), prose(&reason))),
        "open" | "proposed" => {
            out.push_str("\\todo{Not yet addressed.}");
            if !response.is_empty() {
                out.push_str(&format!(" Draft: {}", prose(&response)));
            }
        }
        _ if response.is_empty() => out.push_str("\\todo{Write a response.}"),
        _ => out.push_str(&prose(&response)),
    }
    out.push('\n');

    let accepted: Vec<&Value> = card["proposal"]["hunks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|h| h["state"] == "accepted")
        .collect();
    if !accepted.is_empty() {
        out.push_str("\n\\textbf{Changes.}\n\\begin{itemize}\n");
        for hunk in accepted {
            out.push_str(&format!("\\item {}\n", change_item(root, hunk)));
        }
        out.push_str("\\end{itemize}\n");
    }
    out
}

/// "In Method › Problem Formulation (paper.tex, line 43):" and the revised text, as source.
fn change_item(root: &Path, hunk: &Value) -> String {
    let file = hunk["file"].as_str().unwrap_or_default();
    let after = hunk["after"].as_str().unwrap_or_default();
    let near = hunk["line"].as_u64().map(|l| l as u32);
    let source = project::resolve(root, file).ok().and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default();
    let line = draft::locate(&source, after, near).map(|(start, _)| source[..start].matches('\n').count() as u32 + 1);

    let place = match line {
        Some(line) => {
            let section = section_at(&source, line);
            let at = format!("{}, line {line}", escape(file));
            if section.is_empty() { format!("In {at}:") } else { format!("In \\emph{{{}}} ({at}):", escape(&section)) }
        }
        None => format!("In {} \\todo{{this text has been edited since; check the location}}:", escape(file)),
    };
    let before = hunk["before"].as_str().unwrap_or_default();
    let (removed, added) = changed_part(before, after);
    let shown = match (removed.is_empty(), added.is_empty()) {
        (_, false) => format!("\\begin{{quote}}\\small {}\\end{{quote}}", paragraphs(&escape(added))),
        (false, true) => format!("Removed:\n\\begin{{quote}}\\small {}\\end{{quote}}", paragraphs(&escape(removed))),
        (true, true) => String::new(),
    };
    format!("{place}\n{shown}")
}

/// The words that differ between `before` and `after`, trimmed of the shared start and end,
/// so the letter quotes only the new or rewritten text.
fn changed_part<'a>(before: &'a str, after: &'a str) -> (&'a str, &'a str) {
    let mut prefix = before.bytes().zip(after.bytes()).take_while(|(a, b)| a == b).count();
    let max_suffix = before.len().min(after.len()) - prefix;
    let mut suffix = before.bytes().rev().zip(after.bytes().rev()).take(max_suffix).take_while(|(a, b)| a == b).count();
    // Widen to whole words: each cut must fall between words in both strings.
    let between_words = |s: &str, at: usize| {
        s.is_char_boundary(at)
            && (at == 0
                || at == s.len()
                || s[..at].ends_with(char::is_whitespace)
                || s[at..].starts_with(|c: char| c.is_whitespace() || c.is_ascii_punctuation()))
    };
    while prefix > 0 && !(between_words(before, prefix) && between_words(after, prefix)) {
        prefix -= 1;
    }
    while suffix > 0 && !(between_words(before, before.len() - suffix) && between_words(after, after.len() - suffix)) {
        suffix -= 1;
    }
    (before[prefix..before.len() - suffix].trim(), after[prefix..after.len() - suffix].trim())
}

/// The chain of section headings enclosing a line, e.g. "Method › Problem Formulation".
fn section_at(source: &str, line: u32) -> String {
    let mut levels: [Option<String>; 3] = [None, None, None];
    for text in source.lines().take(line as usize) {
        let t = text.trim_start();
        for (depth, command) in ["\\section", "\\subsection", "\\subsubsection"].iter().enumerate() {
            if let Some(rest) = t.strip_prefix(command) {
                let rest = rest.strip_prefix('*').unwrap_or(rest);
                if let Some(title) = braced(rest) {
                    levels[depth] = Some(title);
                    for deeper in levels.iter_mut().skip(depth + 1) {
                        *deeper = None;
                    }
                }
            }
        }
    }
    levels.into_iter().flatten().collect::<Vec<_>>().join(" › ")
}

/// Content of the `{…}` group at the start of `s`, braces balanced.
fn braced(s: &str) -> Option<String> {
    let s = s.strip_prefix('{')?;
    let mut depth = 1;
    for (i, c) in s.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[..i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn paper_title(main: &str) -> Option<String> {
    let start = main.find("\\title")?;
    let rest = main[start + 6..].trim_start();
    let rest = if rest.starts_with('[') { &rest[rest.find(']')? + 1..] } else { rest };
    let title = braced(rest.trim_start())?;
    // Drop \thanks{…} and line breaks; keep the words.
    let title = match title.find("\\thanks") {
        Some(i) => title[..i].to_string(),
        None => title,
    };
    Some(title.replace("\\\\", " ").split_whitespace().collect::<Vec<_>>().join(" "))
}

/// E, then AE, then R1, R2, …, then anything else; within a group by comment number.
fn card_order(card: &Value) -> (u32, u32, String, u32) {
    let group = card["group"].as_str().unwrap_or_default();
    let rank = match group {
        "E" => 0,
        "AE" => 1,
        g if g.starts_with('R') => 2,
        _ => 3,
    };
    let reviewer = group.trim_start_matches('R').parse().unwrap_or(u32::MAX);
    let number = card["id"].as_str().and_then(|id| id.rsplit('.').next()?.parse().ok()).unwrap_or(0);
    (rank, reviewer, group.to_string(), number)
}

fn group_name(group: &str) -> String {
    match group {
        "E" => "Editor".into(),
        "AE" => "Associate Editor".into(),
        g => match g.strip_prefix('R').and_then(|n| n.parse::<u32>().ok()) {
            Some(n) => format!("Reviewer {n}"),
            None => escape(g),
        },
    }
}

fn slug(label: &str) -> String {
    let s: String = label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() { "response".into() } else { s }
}

/// Plain text (reviewer comments) → LaTeX that typesets it literally.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '{' | '}' | '$' | '&' | '%' | '#' | '_' => {
                out.push('\\');
                out.push(c);
            }
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            _ => out.push(c),
        }
    }
    out
}

/// Author-written responses may contain LaTeX (maths, \emph); escape only what breaks
/// compilation when typed as plain prose: % & # anywhere, _ and ^ outside maths.
fn prose(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_math = false;
    let mut escaped = false;
    for c in text.chars() {
        if escaped {
            out.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' => {
                out.push(c);
                escaped = true;
            }
            '$' => {
                in_math = !in_math;
                out.push(c);
            }
            '%' | '&' | '#' => {
                out.push('\\');
                out.push(c);
            }
            '_' | '^' if !in_math => {
                out.push('\\');
                out.push(c);
                if c == '^' {
                    out.push_str("{}");
                }
            }
            _ => out.push(c),
        }
    }
    if in_math {
        out.push('$');
    }
    paragraphs(&out)
}

/// Blank lines in comments become paragraph breaks; single newlines stay spaces.
fn paragraphs(text: &str) -> String {
    text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn escapes_and_finds_sections() {
        assert_eq!(escape("50% of {x}_1 & #2"), "50\\% of \\{x\\}\\_1 \\& \\#2");
        assert_eq!(prose("We changed $f_k^{-1}$ in snake_case, 5%."), "We changed $f_k^{-1}$ in snake\\_case, 5\\%.");
        let source = "\\section{Method}\\label{m}\ntext\n\\subsection{Problem Formulation}\nmore\n\\section{Results}\nend\n";
        assert_eq!(section_at(source, 4), "Method › Problem Formulation");
        assert_eq!(section_at(source, 6), "Results");
        assert_eq!(paper_title("\\title{When Can It Be\nTrusted?\\thanks{x}}"), Some("When Can It Be Trusted?".into()));
    }

    #[test]
    fn quotes_only_the_changed_words() {
        let before = "equals mapping directly from A to C.";
        let after = "equals mapping directly from A to C. This holds for any warp.";
        assert_eq!(changed_part(before, after), ("", "This holds for any warp."));
        assert_eq!(changed_part("the fast method works", "the robust method works"), ("fast", "robust"));
        assert_eq!(changed_part("keep this. Drop that.", "keep this."), ("Drop that.", ""));
    }

    #[test]
    fn orders_groups_editor_first() {
        let mut cards = [json!({"group":"R2","id":"R2.1"}), json!({"group":"R1","id":"R1.10"}), json!({"group":"AE","id":"AE.1"}), json!({"group":"R1","id":"R1.2"})];
        cards.sort_by_key(card_order);
        let ids: Vec<&str> = cards.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["AE.1", "R1.2", "R1.10", "R2.1"]);
    }
}
