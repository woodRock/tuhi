//! Writes the response-to-reviewers letter for a review round as an editable LaTeX file.

use crate::{draft, project, synctex};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Writes `response/<round>.tex` and returns its root-relative path. `pdf` is the paper's last
/// build, whose .aux and SyncTeX give the section, page, reference and citation numbers the
/// reviewers see.
pub fn write(root: &Path, main: &str, review: &Value, pdf: Option<&Path>) -> Result<String, String> {
    let main_text = fs::read_to_string(project::resolve(root, main)?).map_err(|e| format!("{main}: {e}"))?;
    let mut paper = Paper::read(root, pdf);
    paper.accepted = accepted_hunks(review);
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
        body.push_str(&card_section(&paper, card));
    }

    let letter = format!(
        r"\documentclass[11pt]{{article}}
\usepackage[margin=2.5cm]{{geometry}}
\usepackage[T1]{{fontenc}}
\usepackage[utf8]{{inputenc}}
\usepackage{{xcolor}}
\usepackage{{amsmath,amssymb}}
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
reproduced below in grey, followed by our response and the changes made. Section, page,
equation and reference numbers refer to the revised manuscript.
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

fn card_section(paper: &Paper, card: &Value) -> String {
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
    // Responses are the author's LaTeX; only references into the paper need its numbers.
    let response = paper.numbers(&response);
    let reason = paper.numbers(&text("reason"));
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
        let mut seen = Vec::new();
        for hunk in accepted {
            // Two hunks rewritten into one passage since would be quoted twice.
            let item = change_item(paper, hunk);
            if !seen.contains(&item) {
                out.push_str(&format!("\\item {item}\n"));
                seen.push(item);
            }
        }
        out.push_str("\\end{itemize}\n");
    }
    out
}

/// "In Section IV-A (Problem Formulation), page 3:" and the revised text as the reader sees
/// it. The edit is looked for in the current source: verbatim, else by the passage that still
/// shares most of its wording (a later edit or a hand edit may have reworded part of it).
fn change_item(paper: &Paper, hunk: &Value) -> String {
    let file = hunk["file"].as_str().unwrap_or_default();
    let before = hunk["before"].as_str().unwrap_or_default();
    let after = hunk["after"].as_str().unwrap_or_default();
    let source = paper.source(file);
    let line_of = |offset: usize| source[..offset].matches('\n').count() as u32 + 1;
    // The source line goes in a comment, for the author editing the letter.
    let item = |line: u32, flag: &str, shown: String| format!("{}{flag}: % {file}:{line}\n{shown}", paper.place(file, &source, line));

    match find_hunk(paper, hunk) {
        Found::Exact(start) => {
            // Still as accepted: quote just the words that changed.
            let ((rs, re), (s, e)) = changed_range(before, after);
            let (s, e) = whole_groups(after, s, e);
            let shown = if s < e {
                quote(&paper.readable(&after[s..e]))
            } else if rs < re {
                format!("Removed:\n{}", quote(&paper.readable(&before[rs..re])))
            } else {
                String::new()
            };
            item(line_of(start), "", shown)
        }
        Found::Reworded(start, end) => {
            let (s, e) = sentences_around(&source, start, end);
            let lead = if after.trim().is_empty() { "Removed text from the passage that now reads" } else { "Now reads" };
            item(line_of(start), "", format!("{lead}:\n{}", quote(&paper.readable(&source[s..e]))))
        }
        Found::Superseded { id, file, start } => {
            let source = paper.source(&file);
            let line = source[..start].matches('\n').count() as u32 + 1;
            format!(
                "{}: % {file}:{line}\nRewritten again in the change for Comment {}, quoted there.",
                paper.place(&file, &source, line),
                escape(&id)
            )
        }
        Found::Scattered(start) => item(line_of(start), "", quote(&paper.readable(after))),
        Found::Partly { start, missing, sentences } => {
            let flag = format!(
                " \\todo{{{} of its {sentences} sentences are no longer in the revised text; restore them or update the response}}",
                missing.len()
            );
            item(line_of(start), &flag, format!("Missing:\n{}", quote(&paper.readable(&missing.join(" ")))))
        }
        Found::Gone => {
            let flag = " \\todo{this change is no longer in the revised text; update or remove it}";
            match hunk["line"].as_u64() {
                Some(line) => item(line as u32, flag, quote(&paper.readable(after))),
                None => format!("In {}{flag}:\n{}", escape(file), quote(&paper.readable(after))),
            }
        }
    }
}

/// Where an accepted edit is in the current source.
enum Found {
    /// Verbatim, starting at this byte.
    Exact(usize),
    /// Reworded since; this passage still shares most of its wording.
    Reworded(usize, usize),
    /// A later accepted edit (for comment `id`) rewrote the passage; that edit starts here.
    Superseded { id: String, file: String, start: usize },
    /// Every sentence is there, though no longer together; the first starts here.
    Scattered(usize),
    /// Some sentences are there (the first starts here) and these are gone.
    Partly { start: usize, missing: Vec<String>, sentences: usize },
    /// Nothing of it is left.
    Gone,
}

fn find_hunk(paper: &Paper, hunk: &Value) -> Found {
    let file = hunk["file"].as_str().unwrap_or_default();
    let before = hunk["before"].as_str().unwrap_or_default();
    let after = hunk["after"].as_str().unwrap_or_default();
    let near = hunk["line"].as_u64().map(|l| l as u32);
    let source = paper.source(file);

    if let Some((start, _)) = draft::locate(&source, after, near) {
        return Found::Exact(start);
    }
    let deletion = after.trim().is_empty();
    if let Some((start, end)) = find_passage(&source, if deletion { before } else { after }, near) {
        return Found::Reworded(start, end);
    }
    // Rewritten again by a later accepted edit (often for another comment).
    let normal = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
    let mine = normal(if deletion { before } else { after });
    let later = paper.accepted.iter().find(|(_, h)| {
        let b = normal(h["before"].as_str().unwrap_or_default());
        h != hunk && !mine.is_empty() && b.len() > mine.len() && b.contains(&mine)
    });
    if let Some((id, later)) = later {
        let file = later["file"].as_str().unwrap_or_default();
        let source = paper.source(file);
        let near = later["line"].as_u64().map(|l| l as u32);
        let after = later["after"].as_str().unwrap_or_default();
        if let Some((start, _)) = draft::locate(&source, after, near).or_else(|| find_passage(&source, after, near)) {
            return Found::Superseded { id: id.clone(), file: file.to_string(), start };
        }
    }
    // Part of it may still be there, sentence by sentence.
    let sentences = split_sentences(after);
    let found: Vec<Option<usize>> = sentences
        .iter()
        .map(|t| draft::locate(&source, t, near).or_else(|| find_passage(&source, t, near)).map(|(s, _)| s))
        .collect();
    let missing: Vec<String> = sentences.iter().zip(&found).filter(|(_, f)| f.is_none()).map(|(t, _)| t.to_string()).collect();
    match found.iter().flatten().next() {
        Some(&start) if missing.is_empty() => Found::Scattered(start),
        Some(&start) => Found::Partly { start, missing, sentences: sentences.len() },
        None => Found::Gone,
    }
}

/// What the Review tab's Check reports about an accepted edit that isn't in the text as accepted.
#[derive(serde::Serialize)]
pub struct EditProblem {
    pub card: String,
    pub file: String,
    pub line: Option<u32>,
    /// Sentences of the edit no longer in the text; all of it when `gone`.
    pub missing: Vec<String>,
    pub gone: bool,
}

/// Accepted edits that are partly or wholly gone from the text. `sources` holds the editor's
/// text for open files, so unsaved changes count; other files are read from disk. Edits
/// reworded since, or rewritten again by a later edit, are fine.
pub fn edit_problems(root: &Path, review: &Value, sources: HashMap<String, String>) -> Vec<EditProblem> {
    let mut paper = Paper::read(root, None);
    paper.sources.borrow_mut().extend(sources.into_iter().map(|(f, t)| (f, t.into())));
    paper.accepted = accepted_hunks(review);
    let mut problems = Vec::new();
    for (card, hunk) in &paper.accepted {
        let file = hunk["file"].as_str().unwrap_or_default();
        let (missing, gone, line) = match find_hunk(&paper, hunk) {
            // Where the rest of it is now, not where it was when drafted.
            Found::Partly { missing, start, .. } => (missing, false, Some(paper.source(file)[..start].matches('\n').count() as u32 + 1)),
            Found::Gone => (vec![hunk["after"].as_str().unwrap_or_default().to_string()], true, hunk["line"].as_u64().map(|l| l as u32)),
            _ => continue,
        };
        problems.push(EditProblem {
            card: card.clone(),
            file: file.to_string(),
            line,
            missing,
            gone,
        });
    }
    problems
}

fn accepted_hunks(review: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for card in review["cards"].as_array().into_iter().flatten() {
        for hunk in card["proposal"]["hunks"].as_array().into_iter().flatten().filter(|h| h["state"] == "accepted") {
            out.push((card["id"].as_str().unwrap_or_default().to_string(), hunk.clone()));
        }
    }
    out
}

/// `text` cut into sentences, keeping abbreviations like "e.g." inside.
fn split_sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        if ends_sentence(text, end) {
            out.push(text[start..end].trim());
            start = end;
        }
    }
    out.push(text[start..].trim());
    out.retain(|s| !s.is_empty());
    out
}

/// Whether a sentence ends at byte `i` (just past . ? or !, with whitespace after).
fn ends_sentence(text: &str, i: usize) -> bool {
    const ABBREVIATIONS: &[&str] = &["e.g.", "i.e.", "al.", "Fig.", "Eq.", "vs.", "cf.", "etc."];
    let before = &text[..i];
    before.ends_with(['.', '?', '!'])
        && !ABBREVIATIONS.iter().any(|a| before.ends_with(a))
        && text[i..].starts_with(char::is_whitespace)
}

fn quote(text: &str) -> String {
    if text.trim().is_empty() {
        String::new()
    } else {
        format!("\\begin{{quote}}\\small {}\\end{{quote}}", paragraphs(text))
    }
}

/// The paper as the reviewers read it: its source, and the numbers its last build gave to
/// sections, labels, citations and pages.
struct Paper {
    root: std::path::PathBuf,
    pdf: Option<std::path::PathBuf>,
    /// (heading command, number, title reduced to letters and digits) in the order typeset.
    sections: Vec<(String, String, String)>,
    labels: HashMap<String, (String, String)>,
    /// Every accepted hunk in the review, with its card's id.
    accepted: Vec<(String, Value)>,
    cites: HashMap<String, String>,
    /// taura's `\res{key}` values.
    results: HashMap<String, String>,
    sources: RefCell<HashMap<String, std::rc::Rc<str>>>,
}

impl Paper {
    fn read(root: &Path, pdf: Option<&Path>) -> Paper {
        let pdf = pdf.filter(|p| p.exists()).map(Path::to_path_buf);
        let aux = pdf.as_ref().and_then(|p| fs::read_to_string(p.with_extension("aux")).ok()).unwrap_or_default();
        let mut paper = Paper {
            root: root.to_path_buf(),
            pdf,
            sections: Vec::new(),
            labels: HashMap::new(),
            accepted: Vec::new(),
            cites: HashMap::new(),
            results: HashMap::new(),
            sources: RefCell::default(),
        };
        paper.read_aux(&aux);
        let files = project::open(root).map(|p| p.files).unwrap_or_default();
        for file in files.iter().filter(|f| f.ends_with(".tex")) {
            let text = paper.source(file);
            if text.contains("\\csname taura@") {
                paper.results.extend(taura_results(&text));
            }
        }
        paper
    }

    fn read_aux(&mut self, aux: &str) {
        for line in aux.lines() {
            if let Some(rest) = line.strip_prefix("\\@writefile{toc}{\\contentsline {") {
                // \contentsline {subsection}{\numberline {\mbox {III-B}}Dilated Convolutions}{3}…
                let Some((level, rest)) = rest.split_once('}') else { continue };
                let Some(entry) = braced(rest) else { continue };
                let Some(numbered) = entry.strip_prefix("\\numberline ") else { continue };
                let Some(number) = braced(numbered) else { continue };
                let title = &numbered[number.len() + 2..];
                self.sections.push((level.to_string(), clean_number(&number), letters(title)));
            } else if let Some(rest) = line.strip_prefix("\\newlabel{") {
                let Some((key, rest)) = rest.split_once('}') else { continue };
                let Some(fields) = braced(rest) else { continue };
                let Some(number) = braced(&fields) else { continue };
                let page = braced(&fields[number.len() + 2..]).unwrap_or_default();
                self.labels.insert(key.to_string(), (clean_number(&number), page));
            } else if let Some(rest) = line.strip_prefix("\\bibcite{") {
                let Some((key, rest)) = rest.split_once('}') else { continue };
                if let Some(number) = braced(rest) {
                    self.cites.insert(key.to_string(), number);
                }
            }
        }
    }

    fn source(&self, file: &str) -> std::rc::Rc<str> {
        self.sources
            .borrow_mut()
            .entry(file.to_string())
            .or_insert_with(|| {
                project::resolve(&self.root, file).ok().and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default().into()
            })
            .clone()
    }

    /// "In Section IV-A (\emph{Problem Formulation}), page 3", or "In the abstract, page 1".
    fn place(&self, file: &str, source: &str, line: u32) -> String {
        let part = match front_matter_at(source, line) {
            Some(name) => name.to_string(),
            None => match section_at(source, line) {
                Some((command, title)) => {
                    let key = letters(&title);
                    match self.sections.iter().find(|(level, _, t)| *level == command && *t == key) {
                        Some((_, number, _)) => format!("Section {} (\\emph{{{}}})", escape(number), self.readable(&title)),
                        None => format!("\\emph{{{}}}", self.readable(&title)),
                    }
                }
                None => String::new(),
            },
        };
        let page = self.page(file, line).map(|p| format!("page {p}"));
        match (part.is_empty(), page) {
            (false, Some(page)) => format!("In {part}, {page}"),
            (false, None) => format!("In {part}"),
            (true, Some(page)) => format!("On {page}"),
            (true, None) => format!("In {}", escape(file)),
        }
    }

    /// The page of the revised PDF where this source line is typeset.
    fn page(&self, file: &str, line: u32) -> Option<u32> {
        let pdf = self.pdf.as_ref()?;
        synctex::forward(&self.root, pdf, file, line, 0).ok()?.first().map(|b| b.page)
    }

    /// Source text as LaTeX the letter can typeset: maths and common formatting kept,
    /// `\res`, `\cite` and `\ref` replaced by what the paper prints, anything else shown
    /// literally so an unknown macro can't break the letter.
    /// `\ref`, `\eqref`, `\cite` and `\res` replaced by what the paper prints; the rest kept.
    fn numbers(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find('\\') {
            out.push_str(&rest[..at]);
            rest = &rest[at..];
            let name: String = rest[1..].chars().take_while(char::is_ascii_alphabetic).collect();
            let resolves = name.contains("cite") || name == "res" || ["ref", "autoref", "cref", "Cref", "eqref"].contains(&name.as_str());
            let after = rest[1 + name.len()..].trim_start_matches('*');
            match braced(after).filter(|_| resolves) {
                Some(arg) => {
                    let command = &rest[..rest.len() - after.len() + arg.len() + 2];
                    out.push_str(&self.readable(command));
                    rest = &after[arg.len() + 2..];
                }
                None => {
                    // Not one of ours: copy the backslash and the next character as they are.
                    let skip = 1 + rest[1..].chars().next().map_or(0, char::len_utf8);
                    out.push_str(&rest[..skip]);
                    rest = &rest[skip..];
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn readable(&self, source: &str) -> String {
        self.readable_depth(source, 0)
    }

    fn readable_depth(&self, s: &str, depth: u32) -> String {
        let mut out = String::with_capacity(s.len());
        let mut math = false;
        let mut open = 0u32;
        let mut i = 0;
        while let Some(c) = s[i..].chars().next() {
            i += c.len_utf8();
            match c {
                '%' => i += s[i..].find('\n').unwrap_or(s.len() - i),
                '\n' => out.push(' '),
                '$' => {
                    math = !math;
                    out.push('$');
                }
                '&' | '#' => {
                    out.push('\\');
                    out.push(c);
                }
                '_' if !math => out.push_str("\\_"),
                '^' if !math => out.push_str("\\textasciicircum{}"),
                '{' => {
                    open += 1;
                    out.push('{');
                }
                '}' if open > 0 => {
                    open -= 1;
                    out.push('}');
                }
                '}' => {}
                '\\' => {
                    let name: String = s[i..].chars().take_while(char::is_ascii_alphabetic).collect();
                    if name.is_empty() {
                        let Some(next) = s[i..].chars().next() else { break };
                        i += next.len_utf8();
                        match next {
                            '(' | ')' | '[' | ']' => {
                                math = !math;
                                out.push('$');
                            }
                            '\\' => out.push(' '),
                            c if "%&_#${} ,;!:-/@'`\"^~.=".contains(c) => {
                                out.push('\\');
                                out.push(c);
                            }
                            c => out.push(c),
                        }
                        continue;
                    }
                    i += name.len();
                    if s[i..].starts_with('*') {
                        i += 1;
                    }
                    let arg = |i: &mut usize| -> String {
                        let rest = s[*i..].trim_start();
                        *i = s.len() - rest.len();
                        while s[*i..].starts_with('[') {
                            *i += s[*i..].find(']').map_or(s.len() - *i, |e| e + 1);
                        }
                        match braced(&s[*i..]) {
                            Some(a) => {
                                *i += a.len() + 2;
                                a
                            }
                            None => String::new(),
                        }
                    };
                    match name.as_str() {
                        // Displayed maths becomes inline maths; other environments (itemize,
                        // figure) are dropped, their text kept.
                        "begin" | "end" => {
                            let env = arg(&mut i);
                            let display = MATH_ENVIRONMENTS.contains(&env.trim_end_matches('*'));
                            if display && (name == "begin") != math {
                                math = !math;
                                out.push_str(" $");
                            }
                        }
                        "item" => out.push(' '),
                        "nonumber" | "notag" | "noindent" | "centering" | "small" | "footnotesize" | "par" | "newline" => out.push(' '),
                        "label" => {
                            arg(&mut i);
                        }
                        "res" => {
                            let key = arg(&mut i);
                            match self.results.get(&key) {
                                Some(value) if depth < 4 => out.push_str(&self.readable_depth(value, depth + 1)),
                                _ => out.push_str(&format!("\\texttt{{{}}}", escape(&key))),
                            }
                        }
                        n if n.contains("cite") => {
                            let keys = arg(&mut i);
                            let numbers: Vec<String> = keys
                                .split(',')
                                .map(str::trim)
                                .filter(|k| !k.is_empty())
                                .map(|k| self.cites.get(k).cloned().unwrap_or_else(|| escape(k)))
                                .collect();
                            out.push_str(&format!("[{}]", numbers.join(", ")));
                        }
                        "ref" | "autoref" | "cref" | "Cref" | "eqref" | "pageref" => {
                            let key = arg(&mut i);
                            let number = self.labels.get(&key).map(|(n, p)| if name == "pageref" { p.clone() } else { n.clone() });
                            let number = number.map(|n| escape(&n)).unwrap_or_else(|| "??".into());
                            out.push_str(&if name == "eqref" { format!("({number})") } else { number });
                        }
                        // The colour or link is dropped; the text in the next group stays.
                        "textcolor" | "href" | "color" => {
                            arg(&mut i);
                        }
                        "url" => {
                            let url = arg(&mut i);
                            out.push_str(&format!("\\texttt{{{}}}", escape(&url)));
                        }
                        "bm" => out.push_str("\\boldsymbol"),
                        n if SAFE_COMMANDS.contains(&n) => {
                            out.push('\\');
                            out.push_str(n);
                            if s[i..].starts_with(|c: char| c.is_ascii_alphabetic()) {
                                out.push(' ');
                            }
                        }
                        // An unknown macro with an argument (\IEEEmembership{Fellow}): its text.
                        _ if s[i..].starts_with('{') => {}
                        n => out.push_str(&format!("\\texttt{{\\textbackslash{{}}{n}}}")),
                    }
                }
                c => match symbol(c) {
                    Some(latex) => out.push_str(latex),
                    None => out.push(c),
                },
            }
        }
        if math {
            out.push('$');
        }
        out.extend(std::iter::repeat_n('}', open as usize));
        out.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

const MATH_ENVIRONMENTS: &[&str] = &["equation", "align", "gather", "multline", "displaymath", "eqnarray", "math"];

/// Commands from LaTeX and amsmath that the letter can typeset as they are.
const SAFE_COMMANDS: &[&str] = &[
    "emph", "textbf", "textit", "texttt", "textsc", "textrm", "textsf", "textup", "textsl", "underline", "mbox", "text",
    "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "mathbb", "mathfrak", "boldsymbol", "operatorname",
    "ldots", "dots", "cdots", "vdots", "times", "cdot", "pm", "mp", "le", "leq", "ge", "geq", "ne", "neq", "approx",
    "sim", "simeq", "equiv", "propto", "to", "rightarrow", "leftarrow", "Rightarrow", "leftrightarrow", "mapsto",
    "infty", "sum", "prod", "int", "frac", "dfrac", "tfrac", "sqrt", "log", "ln", "exp", "min", "max", "arg", "sup",
    "inf", "lim", "in", "notin", "subset", "subseteq", "cup", "cap", "mid", "partial", "nabla", "top", "hat", "bar",
    "tilde", "vec", "dot", "ddot", "overline", "widehat", "widetilde", "left", "right", "big", "Big", "bigl", "bigr",
    "quad", "qquad", "textendash", "textemdash", "textdegree", "ell", "forall", "exists", "prime", "circ", "alpha",
    "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda",
    "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega", "Gamma", "Delta",
    "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega", "footnote", "ie", "eg",
];

/// `\expandafter\def\csname taura@KEY\endcsname{VALUE}` lines from taura's generated file.
fn taura_results(text: &str) -> HashMap<String, String> {
    let mut results = HashMap::new();
    for line in text.lines() {
        let Some(rest) = line.split_once("\\csname taura@").map(|(_, r)| r) else { continue };
        let Some((key, rest)) = rest.split_once("\\endcsname") else { continue };
        if let Some(value) = braced(rest.trim_start()) {
            results.insert(key.to_string(), value);
        }
    }
    results
}

/// "\mbox  {III-B}" → "III-B".
fn clean_number(number: &str) -> String {
    number.replace("\\mbox", "").replace(['{', '}'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lowercase letters and digits only, for matching a heading in the source to the .aux.
fn letters(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Byte spans of the whitespace-separated words of `text`.
fn words(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices() {
        match (c.is_whitespace(), start) {
            (true, Some(s)) => {
                spans.push((s, i));
                start = None;
            }
            (false, None) => start = Some(i),
            _ => {}
        }
    }
    if let Some(s) = start {
        spans.push((s, text.len()));
    }
    spans
}

/// The passage of `text` that shares the most three-word runs with `find`, when at least a
/// third of them survive; nearest to `near_line` on a tie.
fn find_passage(text: &str, find: &str, near_line: Option<u32>) -> Option<(usize, usize)> {
    const RUN: usize = 3;
    let (tw, fw) = (words(text), words(find));
    if fw.len() < RUN {
        return None;
    }
    let key = |src: &str, w: &[(usize, usize)]| w.iter().map(|&(s, e)| &src[s..e]).collect::<Vec<_>>().join(" ");
    let mut at: HashMap<String, Vec<usize>> = HashMap::new();
    for j in 0..=tw.len().saturating_sub(RUN) {
        if tw.len() >= RUN {
            at.entry(key(text, &tw[j..j + RUN])).or_default().push(j);
        }
    }
    let runs = fw.len() - RUN + 1;
    let mut hits: Vec<(usize, usize)> = Vec::new();
    for i in 0..runs {
        for &j in at.get(&key(find, &fw[i..i + RUN])).into_iter().flatten() {
            hits.push((j, i));
        }
    }
    hits.sort();
    // Slide a window a little longer than `find` over the hits; the one covering the most
    // distinct runs of `find` is the passage.
    let width = fw.len() + fw.len() / 2 + 10;
    let line_of = |j: usize| text[..tw[j].0].matches('\n').count() as u32 + 1;
    let mut best: Option<(usize, u32, usize, usize)> = None;
    let mut lo = 0;
    for hi in 0..hits.len() {
        while hits[hi].0 - hits[lo].0 > width {
            lo += 1;
        }
        let mut covered: Vec<usize> = hits[lo..=hi].iter().map(|h| h.1).collect();
        covered.sort();
        covered.dedup();
        let distance = near_line.map_or(0, |n| n.abs_diff(line_of(hits[lo].0)));
        let better = match best {
            None => true,
            Some((count, d, _, _)) => covered.len() > count || (covered.len() == count && distance < d),
        };
        if better {
            best = Some((covered.len(), distance, hits[lo].0, hits[hi].0));
        }
    }
    let (count, _, first, last) = best?;
    if count * 3 < runs || count < 2 {
        return None;
    }
    Some((tw[first].0, tw[last + RUN - 1].1))
}

/// Widens `start..end` to whole sentences (or the paragraph), unless that makes it long.
fn sentences_around(text: &str, start: usize, end: usize) -> (usize, usize) {
    let ends_sentence = |i: usize| ends_sentence(text, i);
    let mut s = start;
    while s > 0 && !ends_sentence(s) && !text[..s].ends_with("\n\n") {
        s = text[..s].char_indices().next_back().map_or(0, |(i, _)| i);
    }
    let mut e = end;
    while e < text.len() && !(e >= end && ends_sentence(e)) && !text[e..].starts_with("\n\n") {
        e += text[e..].chars().next().map_or(1, char::len_utf8);
    }
    let (s, e) = (s + text[s..].len() - text[s..].trim_start().len(), e);
    if e - s > (end - start) * 3 + 400 { (start, end) } else { (s, e.max(s)) }
}

/// Widens `start..end` so it doesn't cut through a `{…}` group or `$…$` maths, and takes in
/// the command a group belongs to (`\emph{…}`).
fn whole_groups(text: &str, start: usize, end: usize) -> (usize, usize) {
    // Depth and maths state before each byte.
    let mut state = Vec::with_capacity(text.len() + 1);
    let (mut depth, mut math, mut escaped) = (0i32, false, false);
    for c in text.bytes() {
        state.push((depth, math));
        match c {
            _ if escaped => escaped = false,
            b'\\' => escaped = true,
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b'$' => math = !math,
            _ => {}
        }
    }
    state.push((depth, math));
    let outside = |i: usize| state[i].0 <= 0 && !state[i].1;
    let (mut s, mut e) = (start, end);
    while s > 0 && !outside(s) {
        s -= 1;
    }
    while e < text.len() && !outside(e) {
        e += 1;
    }
    // Back over a command name (and star) right before the group.
    let head = text[..s].trim_end_matches('*');
    let name = head.len() - head.trim_end_matches(|c: char| c.is_ascii_alphabetic()).len();
    if name > 0 && head[..head.len() - name].ends_with('\\') {
        s = head.len() - name - 1;
    }
    while !text.is_char_boundary(s) {
        s -= 1;
    }
    while !text.is_char_boundary(e) {
        e += 1;
    }
    (s, e)
}

/// The words that differ between `before` and `after`, trimmed of the shared start and end,
/// so the letter quotes only the new or rewritten text.
#[cfg(test)]
fn changed_part<'a>(before: &'a str, after: &'a str) -> (&'a str, &'a str) {
    let ((bs, be), (as_, ae)) = changed_range(before, after);
    (&before[bs..be], &after[as_..ae])
}

/// Byte ranges of the changed words in `before` and in `after`, trimmed of whitespace.
fn changed_range(before: &str, after: &str) -> ((usize, usize), (usize, usize)) {
    let mut prefix = before.bytes().zip(after.bytes()).take_while(|(a, b)| a == b).count();
    let max_suffix = before.len().min(after.len()) - prefix;
    let mut suffix = before.bytes().rev().zip(after.bytes().rev()).take(max_suffix).take_while(|(a, b)| a == b).count();
    // Widen to whole words: each cut must fall between words in both strings.
    let between_words = |s: &str, at: usize| {
        s.is_char_boundary(at)
            && (at == 0
                || at == s.len()
                || s[..at].ends_with(char::is_whitespace)
                || s[at..].starts_with(|c: char| c.is_whitespace() || (c.is_ascii_punctuation() && c != '-')))
    };
    while prefix > 0 && !(between_words(before, prefix) && between_words(after, prefix)) {
        prefix -= 1;
    }
    while suffix > 0 && !(between_words(before, before.len() - suffix) && between_words(after, after.len() - suffix)) {
        suffix -= 1;
    }
    let trim = |s: &str, a: usize, b: usize| {
        let part = &s[a..b];
        let lead = part.len() - part.trim_start().len();
        (a + lead, a + lead + part.trim().len())
    };
    (trim(before, prefix, before.len() - suffix), trim(after, prefix, after.len() - suffix))
}

/// Which part of the front matter a line is in, when it comes before the first section.
fn front_matter_at(source: &str, line: u32) -> Option<&'static str> {
    const PARTS: &[(&str, &str)] = &[
        ("abstract", "the abstract"),
        ("IEEEImpStatement", "the impact statement"),
        ("IEEEkeywords", "the index terms"),
        ("keywords", "the keywords"),
    ];
    let mut part = None;
    for (n, text) in source.lines().take(line as usize).enumerate() {
        let t = text.trim_start();
        if t.starts_with("\\section") {
            return None;
        }
        let last = n + 1 == line as usize;
        for &(env, name) in PARTS {
            if t.contains(&format!("\\begin{{{env}}}")) {
                part = Some(name);
            }
            // An \end on the line asked about still counts as inside.
            if !last && t.contains(&format!("\\end{{{env}}}")) {
                part = None;
            }
        }
        if t.starts_with("\\title") || t.starts_with("\\author") {
            part = Some("the title and author list");
        } else if t.starts_with("\\maketitle") {
            part = None;
        }
    }
    part
}

/// The innermost heading enclosing a line: its command ("subsection") and title.
fn section_at(source: &str, line: u32) -> Option<(String, String)> {
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
    let depth = levels.iter().rposition(Option::is_some)?;
    Some((["section", "subsection", "subsubsection"][depth].to_string(), levels[depth].take()?))
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

/// Symbols pdflatex's utf8 input can't typeset on its own, common in comments copied from a PDF.
fn symbol(c: char) -> Option<&'static str> {
    Some(match c {
        '≥' => "\\ensuremath{\\geq}",
        '≤' => "\\ensuremath{\\leq}",
        '≠' => "\\ensuremath{\\neq}",
        '≈' => "\\ensuremath{\\approx}",
        '∼' => "\\ensuremath{\\sim}",
        '±' => "\\ensuremath{\\pm}",
        '×' => "\\ensuremath{\\times}",
        '·' => "\\ensuremath{\\cdot}",
        '−' => "\\ensuremath{-}",
        '→' => "\\ensuremath{\\rightarrow}",
        '←' => "\\ensuremath{\\leftarrow}",
        '∞' => "\\ensuremath{\\infty}",
        '∈' => "\\ensuremath{\\in}",
        '∑' => "\\ensuremath{\\sum}",
        '√' => "\\ensuremath{\\surd}",
        '°' => "\\ensuremath{^\\circ}",
        'µ' | 'μ' => "\\ensuremath{\\mu}",
        'α' => "\\ensuremath{\\alpha}",
        'β' => "\\ensuremath{\\beta}",
        'γ' => "\\ensuremath{\\gamma}",
        'δ' => "\\ensuremath{\\delta}",
        'ε' => "\\ensuremath{\\varepsilon}",
        'θ' => "\\ensuremath{\\theta}",
        'λ' => "\\ensuremath{\\lambda}",
        'π' => "\\ensuremath{\\pi}",
        'ρ' => "\\ensuremath{\\rho}",
        'σ' => "\\ensuremath{\\sigma}",
        'τ' => "\\ensuremath{\\tau}",
        'φ' => "\\ensuremath{\\phi}",
        'ω' => "\\ensuremath{\\omega}",
        'Δ' => "\\ensuremath{\\Delta}",
        'Σ' => "\\ensuremath{\\Sigma}",
        '\u{2028}' | '\u{00a0}' => " ",
        // Ligatures and invisible characters from PDF text.
        'ﬁ' => "fi",
        'ﬂ' => "fl",
        'ﬀ' => "ff",
        'ﬃ' => "ffi",
        '\u{200b}' | '\u{00ad}' | '\u{feff}' => "",
        _ => return None,
    })
}

/// Plain text (reviewer comments) → LaTeX that typesets it literally.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if let Some(latex) = symbol(c) {
            out.push_str(latex);
            continue;
        }
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
            _ => match symbol(c) {
                Some(latex) => out.push_str(latex),
                None => out.push(c),
            },
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
        assert_eq!(section_at(source, 4), Some(("subsection".into(), "Problem Formulation".into())));
        assert_eq!(section_at(source, 6), Some(("section".into(), "Results".into())));
        assert_eq!(paper_title("\\title{When Can It Be\nTrusted?\\thanks{x}}"), Some("When Can It Be Trusted?".into()));
    }

    #[test]
    fn quotes_only_the_changed_words() {
        let before = "equals mapping directly from A to C.";
        let after = "equals mapping directly from A to C. This holds for any warp.";
        assert_eq!(changed_part(before, after), ("", "This holds for any warp."));
        assert_eq!(changed_part("the fast method works", "the robust method works"), ("fast", "robust"));
        assert_eq!(changed_part("keep this. Drop that.", "keep this."), ("Drop that.", ""));
        assert_eq!(changed_part("per-RT profile", "per-retention-time profile"), ("per-RT", "per-retention-time"));
    }

    #[test]
    fn finds_reworded_passages() {
        let text = "Intro.\nWe pretrain it on synthetic chromatograms built from about 9,908 reference spectra of pure compounds; no fish samples are used.\nNext.";
        // Accepted as "…from about 9,500 public reference mass spectra and then fine-tune…", reworded since.
        let accepted = "we pretrain it on synthetic chromatograms built from about 9,500 public reference mass spectra; no fish samples are used.";
        let (s, e) = find_passage(text, accepted, Some(2)).unwrap();
        assert!(text[s..e].starts_with("pretrain it on") && text[s..e].ends_with("are used."), "{}", &text[s..e]);
        assert_eq!(sentences_around(text, s, e), (7, text.len() - 6));
        assert_eq!(find_passage(text, "an unrelated sentence that was later deleted entirely", None), None);
    }

    #[test]
    fn splits_sentences_and_keeps_abbreviations() {
        assert_eq!(split_sentences("We use PCA, e.g. on sums. It works! Done"), ["We use PCA, e.g. on sums.", "It works!", "Done"]);
    }

    #[test]
    fn quotes_never_cut_through_groups() {
        let after = "the \\emph{robust fast} method with $x_1 + y$ terms";
        let s = after.find("fast").unwrap();
        assert_eq!(whole_groups(after, s, s + 4), (4, 22));
        let m = after.find("y$").unwrap();
        assert_eq!(&after[whole_groups(after, m, m + 1).0..whole_groups(after, m, m + 1).1], "$x_1 + y$");
    }

    #[test]
    fn source_reads_as_typeset() {
        let mut paper = Paper::read(Path::new("/nonexistent"), None);
        paper.read_aux("\\newlabel{sec:method}{{\\mbox  {IV-B}}{3}{Method}{section.4}{}}\n\\bibcite{pardo2016}{1}\n\\@writefile{toc}{\\contentsline {subsection}{\\numberline {\\mbox  {IV-B}}Architecture}{3}{subsection.4.2}\\protected@file@percent }");
        paper.results.insert("pretraining/spectra".into(), "9{,}908".into());
        assert_eq!(paper.sections, [("subsection".to_string(), "IV-B".to_string(), "architecture".to_string())]);
        assert_eq!(
            paper.readable("About \\res{pretraining/spectra} spectra~\\cite{pardo2016} (Section~\\ref{sec:method})\\label{x}. 30\\% of \\IEEEmembership{Fellow} \\foo."),
            "About 9{,}908 spectra~[1] (Section~IV-B). 30\\% of {Fellow} \\texttt{\\textbackslash{}foo}."
        );
        assert_eq!(paper.readable("\\begin{equation}\\mathcal{L}_\\text{pre} = 1 \\end{equation}"), "$\\mathcal{L}_\\text{pre} = 1 $");
        assert_eq!(paper.readable("cut \\emph{off"), "cut \\emph{off}");
        assert_eq!(paper.numbers("See Section~\\ref{sec:method} and $\\alpha$."), "See Section~IV-B and $\\alpha$.");
        assert_eq!(escape("|r| ≥ 0.68"), "|r| \\ensuremath{\\geq} 0.68");
    }

    #[test]
    fn names_the_front_matter() {
        let source = "\\title{T}\n\\maketitle\n\\begin{abstract}\nWe show.\n\\end{abstract}\n\\begin{IEEEImpStatement}\nImpact.\n\\end{IEEEImpStatement}\n\\section{Intro}\nText.";
        assert_eq!(front_matter_at(source, 1), Some("the title and author list"));
        assert_eq!(front_matter_at(source, 4), Some("the abstract"));
        assert_eq!(front_matter_at(source, 8), Some("the impact statement"));
        assert_eq!(front_matter_at(source, 11), None);
    }

    #[test]
    fn orders_groups_editor_first() {
        let mut cards = [json!({"group":"R2","id":"R2.1"}), json!({"group":"R1","id":"R1.10"}), json!({"group":"AE","id":"AE.1"}), json!({"group":"R1","id":"R1.2"})];
        cards.sort_by_key(card_order);
        let ids: Vec<&str> = cards.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["AE.1", "R1.2", "R1.10", "R2.1"]);
    }
}
