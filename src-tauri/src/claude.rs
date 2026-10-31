//! One lean, read-only `claude -p` call with a JSON-schema answer, on the user's Claude login.

use crate::tools;
use serde_json::Value;
use std::path::Path;

pub struct Answer {
    /// The reply, shaped by the schema.
    pub output: Value,
    pub cost_usd: f64,
}

/// Runs Claude in `cwd` with read-only tools. `dirs` are extra folders it may read.
pub fn ask(cwd: &Path, dirs: &[&Path], system: &str, prompt: &str, schema: &Value) -> Result<Answer, String> {
    let mut command = tools::command("claude")?;
    command
        .current_dir(cwd)
        .arg("-p")
        .arg(prompt)
        .args(["--system-prompt", system])
        // A lean session: no user plugins, hooks or MCP servers, read-only tools.
        .args(["--setting-sources", "project", "--strict-mcp-config", "--tools", "Read,Grep,Glob"])
        .args(["--output-format", "json", "--no-session-persistence"])
        .arg("--json-schema")
        .arg(schema.to_string());
    for dir in dirs {
        command.arg("--add-dir").arg(dir);
    }
    let output = command.output().map_err(|e| format!("couldn't run claude: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let reply: Value = serde_json::from_str(&stdout).map_err(|_| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("claude failed: {}", if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() })
    })?;
    if reply["is_error"].as_bool().unwrap_or(false) {
        return Err(format!("claude: {}", reply["result"].as_str().unwrap_or("unknown error")));
    }
    let output = reply["structured_output"].clone();
    if !output.is_object() {
        return Err("claude returned no answer".into());
    }
    Ok(Answer { output, cost_usd: reply["total_cost_usd"].as_f64().unwrap_or(0.0) })
}
