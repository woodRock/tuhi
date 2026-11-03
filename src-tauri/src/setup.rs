//! First-run setup and new projects: which tools are installed (and installing the ones that
//! need no password), the ruru library, and creating a paper linked to ruru and taura.
//!
//! taura pairs `~/Desktop/<name>` (code) with `~/overleaf/<name>` (paper) by name, so a new
//! paper lives under the paper root and a code repo it pairs with must have the same name.

use crate::{project, tools};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
pub struct Tool {
    pub name: String,
    pub found: bool,
    pub version: Option<String>,
    /// tuhi can install it without a password.
    pub installable: bool,
    /// What it's for, and how to get it when tuhi can't install it.
    pub about: String,
    pub command: Option<String>,
}

#[derive(Serialize)]
pub struct Library {
    pub path: String,
    pub exists: bool,
}

#[derive(Serialize)]
pub struct Setup {
    pub tools: Vec<Tool>,
    pub library: Library,
    pub paper_root: String,
    pub code_root: String,
}

const RURU_SPEC: &str = "ruru[tui,pdf] @ git+https://github.com/woodRock/ruru";
const TAURA_SPEC: &str = "taura[tui] @ git+https://github.com/woodRock/taura";

fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

/// `~/…` for paths in the home folder, as ruru and taura write them.
fn contract(path: &Path) -> String {
    match path.strip_prefix(home()) {
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => path.display().to_string(),
    }
}

#[derive(Serialize, Debug)]
pub struct Roots {
    pub paper_root: String,
    pub code_root: String,
    /// Where each came from: "config", "env" or "default".
    pub paper_from: String,
    pub code_from: String,
    /// taura is installed, so the folders can be changed (`taura config`).
    pub taura: bool,
}

/// Where paper and code repos live. taura owns the setting (`taura config`), so tuhi and taura
/// in a terminal always agree; without taura, the defaults (or the environment) apply.
pub fn roots() -> Roots {
    let from_taura = tools::command("taura")
        .ok()
        .and_then(|mut cmd| cmd.args(["--json", "config"]).output().ok())
        .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok())
        .filter(|v| v.get("paper_root").is_some());
    let pick = |key: &str, var: &str, default: &str| -> (PathBuf, String) {
        if let Some(v) = from_taura.as_ref().and_then(|v| v.get(key)) {
            let path = v["path"].as_str().unwrap_or(default);
            return (expand(path), v["from"].as_str().unwrap_or("config").to_string());
        }
        match env::var(var) {
            Ok(p) if !p.is_empty() => (expand(&p), "env".into()),
            _ => (home().join(default), "default".into()),
        }
    };
    let (paper, paper_from) = pick("paper_root", "TAURA_PAPER_ROOT", "overleaf");
    let (code, code_from) = pick("code_root", "TAURA_CODE_ROOT", "Desktop");
    Roots { paper_root: contract(&paper), code_root: contract(&code), paper_from, code_from, taura: from_taura.is_some() }
}

/// Saves a root with `taura config` (None goes back to the default).
pub fn set_root(key: &str, folder: Option<&str>) -> Result<Roots, String> {
    let setting = match key {
        "paper_root" => "paper-root",
        "code_root" => "code-root",
        _ => return Err(format!("unknown setting {key}")),
    };
    let mut cmd = tools::command("taura").map_err(|_| "Install taura to change where repos live (tuhi ▸ Set Up Tools)".to_string())?;
    cmd.args(["--json", "config", setting]);
    match folder {
        Some(f) => cmd.arg(expand(f)),
        None => cmd.arg("--reset"),
    };
    let out = cmd.output().map_err(|e| e.to_string())?;
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
        if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
            return Err(error.to_string());
        }
    } else if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(roots())
}

pub fn paper_root() -> PathBuf {
    expand(&roots().paper_root)
}

pub fn code_root() -> PathBuf {
    expand(&roots().code_root)
}

fn run(cmd: &mut Command) -> Result<String, String> {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn version(name: &str, flag: &str) -> Option<String> {
    let out = run(tools::command(name).ok()?.arg(flag)).ok()?;
    out.lines().next().map(|l| l.trim().to_string())
}

pub fn status() -> Setup {
    let tool = |name: &str, bin: &str, flag: &str, installable: bool, about: &str, command: Option<&str>| {
        let found = tools::which(bin).is_some();
        Tool {
            name: name.into(),
            found,
            version: if found { version(bin, flag) } else { None },
            installable,
            about: about.into(),
            command: command.map(str::to_string),
        }
    };
    let roots = roots();
    let tex_bin = if tools::which("latexmk").is_some() { "latexmk" } else { "pdflatex" };
    Setup {
        tools: vec![
            tool("git", "git", "--version", false, "Versions, commits and Overleaf sync.", Some("xcode-select --install")),
            tool(
                "TeX",
                tex_bin,
                "--version",
                false,
                "Compiles the paper. BasicTeX is small; MacTeX has every package.",
                Some("brew install --cask basictex"),
            ),
            tool("latexdiff", "latexdiff", "--version", false, "Diff PDFs between versions.", Some("sudo tlmgr install latexdiff")),
            tool("uv", "uv", "--version", true, "Installs ruru and taura.", None),
            tool("ruru", "ruru", "-V", true, "Your literature library: citation completion, checks and claim checks.", None),
            tool("taura", "taura", "--version", true, "Provenance from the code repo: \\res numbers, figures and tables.", None),
            tool(
                "Claude Code",
                "claude",
                "--version",
                false,
                "Drafts review changes, suggests edits and checks claims.",
                Some("curl -fsSL https://claude.ai/install.sh | bash"),
            ),
        ],
        library: library(),
        paper_root: roots.paper_root,
        code_root: roots.code_root,
    }
}

/// The library ruru uses: $RURU_LIBRARY, else `library` in its config, else ~/papers.
fn library() -> Library {
    let config = env::var("RURU_CONFIG").map(|p| expand(&p)).unwrap_or_else(|_| {
        env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home().join(".config")).join("ruru/config.toml")
    });
    let configured = fs::read_to_string(config).ok().and_then(|text| {
        text.lines().find_map(|l| {
            let (key, value) = l.split_once('=')?;
            (key.trim() == "library").then(|| value.trim().trim_matches('"').to_string())
        })
    });
    let path = env::var("RURU_LIBRARY").ok().or(configured).map(|p| expand(&p)).unwrap_or_else(|| home().join("papers"));
    Library { exists: path.join("ruru.toml").is_file(), path: contract(&path) }
}

/// Installs uv, ruru or taura. Copies installed some other way (pipx, a checkout) are left alone.
pub fn install(name: &str) -> Result<String, String> {
    if tools::which(name).is_some() {
        return Ok(format!("{name} is already installed"));
    }
    match name {
        "uv" => run(Command::new("/bin/sh").args(["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]).env("PATH", tools::search_path())),
        "ruru" | "taura" => {
            let spec = if name == "ruru" { RURU_SPEC } else { TAURA_SPEC };
            run(tools::command("uv").map_err(|_| "Install uv first".to_string())?.args(["tool", "install", "--quiet", "--python", "3.11", spec]))
                .map_err(|e| format!("{name} didn't install: {e}"))
        }
        _ => Err(format!("tuhi can't install {name}")),
    }
    .map(|_| format!("Installed {name}"))
}

pub fn init_library(path: &str, email: &str) -> Result<String, String> {
    let mut cmd = tools::command("ruru")?;
    cmd.arg("init").arg(expand(path.trim()));
    if !email.trim().is_empty() {
        cmd.args(["--email", email.trim()]);
    }
    run(&mut cmd)?;
    Ok(format!("Created the library at {}", path.trim()))
}

/// Project names work as folder names and as ruru project names.
fn check_name(name: &str) -> Result<(), String> {
    let ok = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err("Use letters, digits, - and _ for the name, e.g. fish-gcms".into()) }
}

#[derive(Deserialize)]
pub struct NewPaper {
    pub name: String,
    /// "template" or "clone".
    pub source: String,
    pub url: Option<String>,
    /// "article" or "ieee".
    pub template: Option<String>,
    pub title: Option<String>,
    /// Add taura's preamble lines to the template.
    pub taura: bool,
}

/// Creates the paper folder under the paper root; returns its path.
pub fn create_paper(new: &NewPaper) -> Result<String, String> {
    check_name(&new.name)?;
    let root = paper_root();
    let dir = root.join(&new.name);
    if dir.exists() && fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(format!("{} already exists; open it instead, or pick another name", contract(&dir)));
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if new.source == "clone" {
        let url = new.url.as_deref().map(str::trim).filter(|u| !u.is_empty()).ok_or("Paste the project's git URL from Overleaf (Menu ▸ Git)")?;
        let _ = fs::remove_dir(&dir);
        run(tools::command("git")?.arg("clone").arg(url).arg(&dir)).map_err(|e| {
            if e.contains("Authentication") || e.contains("could not read Username") || e.contains("403") {
                format!(
                    "Overleaf wants a token. In Overleaf go to Account Settings ▸ Git integration and create one, then run this once in a terminal and paste the token as the password (the keychain remembers it):\n\ngit clone {url} {}\n\nThen open the folder with File ▸ Open Folder.",
                    contract(&dir)
                )
            } else {
                e
            }
        })?;
    } else {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let title = new.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&new.name);
        fs::write(dir.join("main.tex"), template(new.template.as_deref().unwrap_or("article"), title, new.taura)).map_err(|e| e.to_string())?;
        fs::write(dir.join("refs.bib"), "% References. ruru adds the papers you cite here (ruru cite).\n").map_err(|e| e.to_string())?;
        fs::write(dir.join(".gitignore"), "*.aux\n*.log\n*.out\n*.bbl\n*.blg\n*.fls\n*.fdb_latexmk\n*.synctex.gz\n*.toc\n.DS_Store\n").map_err(|e| e.to_string())?;
        let git = |args: &[&str]| run(tools::command("git")?.arg("-C").arg(&dir).args(args));
        git(&["init", "-q", "-b", "main"])?;
        git(&["add", "-A"])?;
        // Without a git identity the files are still there, just uncommitted.
        let _ = git(&["commit", "-q", "-m", &format!("Start {}", new.name)]);
    }
    Ok(dir.display().to_string())
}

fn template(kind: &str, title: &str, taura: bool) -> String {
    let title = title.replace(['{', '}', '\\'], "");
    let (class, author, abstract_env) = if kind == "ieee" {
        ("\\documentclass[journal]{IEEEtran}", "\\author{Your Name}", "\\begin{abstract}\nOne paragraph on the problem, the method and the result.\n\\end{abstract}\n\n\\begin{IEEEkeywords}\nkeyword, keyword\n\\end{IEEEkeywords}\n")
    } else {
        ("\\documentclass[11pt]{article}", "\\author{Your Name}\n\\date{}", "\\begin{abstract}\nOne paragraph on the problem, the method and the result.\n\\end{abstract}\n")
    };
    let provenance = if taura {
        "\n% taura: \\res{key} prints a result from the code repo's ledger. generated/ fills in on\n% the first `taura publish`; until then \\res shows ??.\n\\usepackage{booktabs}\n\\IfFileExists{generated/results.tex}{\\input{generated/results}}{\\providecommand{\\res}[1]{\\textbf{??}}}\n"
    } else {
        ""
    };
    format!(
        "{class}\n\n\\usepackage{{amsmath,amssymb}}\n\\usepackage{{graphicx}}\n\\usepackage[hidelinks]{{hyperref}}\n{provenance}\n\\title{{{title}}}\n{author}\n\n\\begin{{document}}\n\\maketitle\n\n{abstract_env}\n\\section{{Introduction}}\n\nStart writing here.\n\n\\bibliographystyle{{{style}}}\n\\bibliography{{refs}}\n\n\\end{{document}}\n",
        style = if kind == "ieee" { "IEEEtran" } else { "plain" },
    )
}

/// `ruru project add`: the paper's .bib (created if it has none) and main .tex.
pub fn link_ruru(name: &str, dir: &str) -> Result<String, String> {
    check_name(name)?;
    let dir = PathBuf::from(dir);
    let project = project::open(&dir)?;
    let main = project.main.ok_or("No file with \\documentclass in the folder")?;
    let bib = match project.files.iter().find(|f| f.ends_with(".bib")) {
        Some(bib) => bib.clone(),
        None => {
            fs::write(dir.join("refs.bib"), "").map_err(|e| e.to_string())?;
            "refs.bib".into()
        }
    };
    run(tools::command("ruru")?.args(["project", "add", name, "--path", &contract(&dir), "--bib", &bib, "--tex", &main]))?;
    Ok(format!("ruru project {name}: {bib} and {main}"))
}

#[derive(Serialize)]
pub struct Paired {
    pub code: String,
    /// What to add to the paper's preamble, from `taura init`.
    pub instructions: Option<String>,
}

/// Pairs the paper with a code repo for taura: `code` is an existing repo, or None to create
/// `<code root>/<paper's name>`. Then runs `taura init` there.
pub fn pair_taura(paper: &str, code: Option<&str>) -> Result<Paired, String> {
    let paper = PathBuf::from(paper);
    let name = paper.file_name().and_then(|n| n.to_str()).ok_or("The paper folder has no name")?.to_string();
    let roots = (paper_root(), code_root());
    if paper.parent() != Some(roots.0.as_path()) {
        return Err(format!("taura pairs papers in {}; this one is in {}", contract(&roots.0), contract(paper.parent().unwrap_or(&paper))));
    }
    let code = match code {
        Some(c) => {
            let c = expand(c);
            if c.parent() != Some(roots.1.as_path()) || c.file_name().and_then(|n| n.to_str()) != Some(name.as_str()) {
                return Err(format!(
                    "taura pairs {} with {} by name, so the code repo must be {}",
                    contract(&roots.1.join(&name)),
                    contract(&paper),
                    contract(&roots.1.join(&name))
                ));
            }
            if !c.is_dir() {
                return Err(format!("{} doesn't exist", contract(&c)));
            }
            c
        }
        None => {
            let c = roots.1.join(&name);
            if !c.exists() {
                fs::create_dir_all(&c).map_err(|e| e.to_string())?;
                run(tools::command("git")?.arg("-C").arg(&c).args(["init", "-q", "-b", "main"]))?;
            }
            c
        }
    };
    let out = run(tools::command("taura")?.args(["--json", "init", "-C"]).arg(&code))?;
    let value: serde_json::Value = serde_json::from_str(&out).map_err(|_| out.clone())?;
    if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
        return Err(error.to_string());
    }
    Ok(Paired { code: contract(&code), instructions: value.get("instructions").and_then(|i| i.as_str()).map(str::to_string) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_templates() {
        assert!(check_name("fish-gcms_2").is_ok());
        assert!(check_name("-x").is_err());
        assert!(check_name("a b").is_err());
        let t = template("article", "Fish {GC-MS}", true);
        assert!(t.contains("\\title{Fish GC-MS}"));
        assert!(t.contains("\\IfFileExists{generated/results.tex}"));
        assert!(!template("ieee", "T", false).contains("generated/results"));
    }

    /// A template paper in scratch roots, paired with a new code repo, as New Project does.
    #[test]
    #[ignore]
    fn new_project_with_taura() {
        let base = std::env::temp_dir().join(format!("tuhi-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        // SAFETY: tests that read these roots run in this process only.
        unsafe {
            env::set_var("TAURA_PAPER_ROOT", base.join("overleaf"));
            env::set_var("TAURA_CODE_ROOT", base.join("Desktop"));
        }
        let dir = create_paper(&NewPaper {
            name: "demo".into(),
            source: "template".into(),
            url: None,
            template: Some("article".into()),
            title: Some("Demo paper".into()),
            taura: true,
        })
        .unwrap();
        assert!(Path::new(&dir).join("main.tex").is_file());
        assert!(create_paper(&NewPaper { name: "demo".into(), source: "template".into(), url: None, template: None, title: None, taura: false }).is_err());
        let paired = pair_taura(&dir, None).unwrap();
        assert!(paired.code.ends_with("Desktop/demo"));
        assert!(base.join("Desktop/demo/AGENTS.md").is_file());
        assert!(base.join("overleaf/demo/generated").is_dir());
        // status exits 1 while there are findings (a new repo has a placeholder artifact).
        let status = run(tools::command("taura").unwrap().args(["--json", "status", "-C"]).arg(&dir)).unwrap_or_else(|e| e);
        assert!(status.contains("overleaf/demo") && status.contains("Desktop/demo"), "{status}");
        assert!(pair_taura(&dir, Some(&base.join("Desktop/other").display().to_string())).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    /// A scratch ruru library and config (never the real ones): init, then link a template paper.
    #[test]
    #[ignore]
    fn ruru_library_and_link() {
        let base = std::env::temp_dir().join(format!("tuhi-ruru-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // SAFETY: tests that read these run in this process only.
        unsafe {
            env::set_var("RURU_CONFIG", base.join("config.toml"));
            env::set_var("RURU_LIBRARY", base.join("papers"));
            env::set_var("TAURA_PAPER_ROOT", base.join("overleaf"));
        }
        assert!(!library().exists);
        init_library(&base.join("papers").display().to_string(), "test@example.com").unwrap();
        assert!(library().exists);
        let dir = create_paper(&NewPaper { name: "linked".into(), source: "template".into(), url: None, template: Some("ieee".into()), title: None, taura: false }).unwrap();
        println!("{}", link_ruru("linked", &dir).unwrap());
        let list = run(tools::command("ruru").unwrap().args(["project", "list", "--json"])).unwrap();
        assert!(list.contains("\"linked\"") && list.contains("refs.bib"), "{list}");
        assert!(link_ruru("linked", &dir).is_err(), "a second project of the same name is refused");
        let _ = fs::remove_dir_all(&base);
    }

    /// Moving the roots goes through `taura config`, in a scratch config file.
    #[test]
    #[ignore]
    fn roots_through_taura_config() {
        let base = std::env::temp_dir().join(format!("tuhi-roots-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("papers")).unwrap();
        // SAFETY: tests that read these run in this process only, one at a time.
        unsafe {
            env::set_var("TAURA_CONFIG", base.join("config.toml"));
            env::remove_var("TAURA_PAPER_ROOT");
            env::remove_var("TAURA_CODE_ROOT");
        }
        assert_eq!(roots().paper_from, "default");
        let moved = set_root("paper_root", Some(&base.join("papers").display().to_string())).unwrap();
        assert_eq!(moved.paper_from, "config");
        assert_eq!(paper_root(), base.join("papers").canonicalize().unwrap());
        assert!(set_root("code_root", Some("/nowhere/at/all")).unwrap_err().contains("not a folder"));
        assert_eq!(set_root("paper_root", None).unwrap().paper_from, "default");
        let _ = fs::remove_dir_all(&base);
    }
}
