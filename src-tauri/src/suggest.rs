//! Claude suggests edits to a passage the author selected. The edits come back as suggestions
//! in the editor, never written to the .tex until the author accepts each one.

use crate::claude;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;

const SYSTEM_PROMPT: &str = "\
You help an academic author edit a LaTeX paper. They selected a passage and told you what they \
want. Propose edits to that passage only, as small find/replace pairs.

Rules:
- Each `find` is copied verbatim from the selected passage: a word, phrase or sentence, long \
enough to be unique within it. `replace` is its replacement. Several small edits beat one big one.
- Keep the author's voice, spelling conventions (British or American, as they use) and LaTeX \
macros, citations, labels and math exactly as they are unless the instruction is about them.
- Never invent results, numbers, citations or references. Numbers come from macros such as \
\\res{...}; keep them as macros.
- `why` is a few words (\"shorter\", \"subject-verb agreement\").
- If nothing needs changing, return no edits and say so in `summary`.
- You may read files in the project for context. Do not modify anything.";

#[derive(Serialize)]
pub struct Edit {
    pub find: String,
    pub replace: String,
    pub why: String,
}

#[derive(Serialize)]
pub struct Suggestions {
    pub summary: String,
    pub edits: Vec<Edit>,
    pub cost_usd: f64,
}

pub fn suggest(root: &Path, file: &str, passage: &str, before: &str, after: &str, instruction: &str) -> Result<Suggestions, String> {
    let instruction = if instruction.trim().is_empty() { "Tighten and clarify; fix grammar and typos." } else { instruction.trim() };
    let prompt = format!(
        "File: {file}\nInstruction: {instruction}\n\nText just before the selection (context only, don't edit):\n{before}\n\n\
         <selection>\n{passage}\n</selection>\n\nText just after (context only):\n{after}\n"
    );
    let answer = claude::ask(root, &[], SYSTEM_PROMPT, &prompt, &schema())?;
    let edits = answer.output["edits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let field = |k: &str| e[k].as_str().unwrap_or("").to_string();
            let (find, replace) = (field("find"), field("replace"));
            (!find.is_empty() && find != replace).then(|| Edit { find, replace, why: field("why") })
        })
        .collect();
    Ok(Suggestions { summary: answer.output["summary"].as_str().unwrap_or("").to_string(), edits, cost_usd: answer.cost_usd })
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string" },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "find": { "type": "string" },
                        "replace": { "type": "string" },
                        "why": { "type": "string" }
                    },
                    "required": ["find", "replace", "why"]
                }
            }
        },
        "required": ["summary", "edits"]
    })
}
