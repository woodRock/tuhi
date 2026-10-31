mod claims;
mod claude;
mod compile;
mod draft;
mod latexdiff;
mod letter;
mod project;
mod review;
mod synctex;
mod ruru;
mod taura;
mod tools;

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn build_dir(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(compile::build_dir(&cache, root))
}

fn pdf_for(app: &AppHandle, root: &str, main: &str) -> Result<PathBuf, String> {
    let root = Path::new(root);
    Ok(compile::pdf_path(&build_dir(app, root)?, main))
}

#[tauri::command]
fn open_project(path: String) -> Result<project::Project, String> {
    project::open(Path::new(&path))
}

#[tauri::command]
fn read_text(root: String, file: String) -> Result<String, String> {
    let path = project::resolve(Path::new(&root), &file)?;
    fs::read_to_string(&path).map_err(|e| format!("{file}: {e}"))
}

#[tauri::command]
fn write_text(root: String, file: String, contents: String) -> Result<(), String> {
    let path = project::resolve(Path::new(&root), &file)?;
    fs::write(&path, contents).map_err(|e| format!("{file}: {e}"))
}

#[tauri::command]
async fn compile(app: AppHandle, root: String, main: String) -> Result<compile::CompileResult, String> {
    let root = PathBuf::from(root);
    let out = build_dir(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || compile::compile(&root, &main, &out))
        .await
        .map_err(|e| e.to_string())?
}

/// Sends the PDF as raw bytes rather than a JSON array of numbers.
#[tauri::command]
fn read_pdf(app: AppHandle, root: String, main: String) -> Result<tauri::ipc::Response, String> {
    let pdf = pdf_for(&app, &root, &main)?;
    let bytes = fs::read(&pdf).map_err(|e| format!("{}: {e}", pdf.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn synctex_forward(
    app: AppHandle,
    root: String,
    main: String,
    file: String,
    line: u32,
    column: u32,
) -> Result<Vec<synctex::PdfBox>, String> {
    let pdf = pdf_for(&app, &root, &main)?;
    tauri::async_runtime::spawn_blocking(move || synctex::forward(Path::new(&root), &pdf, &file, line, column))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn synctex_inverse(
    app: AppHandle,
    root: String,
    main: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<synctex::SourceLocation>, String> {
    let pdf = pdf_for(&app, &root, &main)?;
    tauri::async_runtime::spawn_blocking(move || synctex::inverse(Path::new(&root), &pdf, page, x, y))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_reviews(root: String) -> Result<Vec<serde_json::Value>, String> {
    review::list(Path::new(&root))
}

#[tauri::command]
fn save_review(root: String, review: serde_json::Value) -> Result<(), String> {
    review::save(Path::new(&root), &review)
}

#[tauri::command]
fn import_review_pdf(root: String, id: String, source: String) -> Result<String, String> {
    review::import_pdf(Path::new(&root), &id, Path::new(&source))
}

/// Any file inside the project as raw bytes, e.g. a reviewer's annotated PDF.
#[tauri::command]
fn read_bytes(root: String, file: String) -> Result<tauri::ipc::Response, String> {
    let path = project::resolve(Path::new(&root), &file)?;
    fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{file}: {e}"))
}

#[tauri::command]
fn split_comments(letter: String) -> Vec<review::PastedComment> {
    review::split_comments(&letter)
}

#[derive(serde::Deserialize)]
struct LocateQuery {
    quote: Option<String>,
    page: Option<u32>,
    x: Option<f64>,
    y: Option<f64>,
}

#[tauri::command]
async fn locate_comments(
    app: AppHandle,
    root: String,
    main: String,
    queries: Vec<LocateQuery>,
) -> Result<Vec<Option<review::Located>>, String> {
    let pdf = pdf_for(&app, &root, &main)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let files = project::open(&root)?.files;
        Ok(queries
            .iter()
            .map(|q| {
                let position = match (q.page, q.x, q.y) {
                    (Some(page), Some(x), Some(y)) => Some((page, x, y)),
                    _ => None,
                };
                review::locate(&root, &files, &pdf, q.quote.as_deref(), position)
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Asks Claude to draft a change for one review card. Slow: one Claude session per call.
#[tauri::command]
async fn draft_change(root: String, card: serde_json::Value) -> Result<draft::Proposal, String> {
    tauri::async_runtime::spawn_blocking(move || draft::draft(Path::new(&root), &card))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn write_letter(root: String, main: String, review: serde_json::Value) -> Result<String, String> {
    letter::write(Path::new(&root), &main, &review)
}

#[tauri::command]
fn git_revisions(root: String) -> Result<Vec<latexdiff::Revision>, String> {
    latexdiff::revisions(Path::new(&root))
}

#[tauri::command]
async fn make_diff(app: AppHandle, root: String, main: String, rev: String) -> Result<compile::CompileResult, String> {
    let root = PathBuf::from(root);
    let build = build_dir(&app, &root)?;
    let work = build.with_file_name(format!(
        "{}-diff",
        build.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    tauri::async_runtime::spawn_blocking(move || latexdiff::make(&root, &main, &rev, &work))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens a file in its default app, e.g. a generated PDF in Preview.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    } else {
        std::process::Command::new("xdg-open")
    };
    cmd.arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// taura's status, findings and pending publish changes; None if the paper isn't paired.
#[tauri::command]
async fn taura_report(root: String) -> Result<Option<taura::Report>, String> {
    tauri::async_runtime::spawn_blocking(move || taura::report(Path::new(&root)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn taura_trace(root: String, target: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || taura::trace(Path::new(&root), &target))
        .await
        .map_err(|e| e.to_string())?
}

/// The paper's bib entries and the ruru library, for citation completion and checks.
#[tauri::command]
async fn citation_library(root: String, files: Vec<String>) -> Result<ruru::Library, String> {
    tauri::async_runtime::spawn_blocking(move || ruru::library(Path::new(&root), &files))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ruru_show(key: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || ruru::show(&key)).await.map_err(|e| e.to_string())?
}

/// `ruru check` on the main file; None when ruru isn't installed.
#[tauri::command]
async fn ruru_check(root: String, main: String) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || ruru::check(Path::new(&root), &main))
        .await
        .map_err(|e| e.to_string())?
}

/// `ruru claims` for this folder's ruru project; None when it isn't one.
#[tauri::command]
async fn claims_list(root: String) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || claims::list(Path::new(&root)))
        .await
        .map_err(|e| e.to_string())?
}

/// Claude's proposed verdicts on the claims citing one key.
#[tauri::command]
async fn claims_judge(root: String, key: String, claims: Vec<String>) -> Result<claims::Judgement, String> {
    tauri::async_runtime::spawn_blocking(move || claims::judge(Path::new(&root), &key, &claims))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn claims_record(root: String, key: String, from: String, verdict: claims::Verdict) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || claims::record(Path::new(&root), &key, &from, &verdict))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            read_text,
            write_text,
            compile,
            read_pdf,
            synctex_forward,
            synctex_inverse,
            list_reviews,
            save_review,
            import_review_pdf,
            read_bytes,
            split_comments,
            locate_comments,
            draft_change,
            write_letter,
            git_revisions,
            make_diff,
            open_path,
            taura_report,
            taura_trace,
            citation_library,
            ruru_show,
            ruru_check,
            claims_list,
            claims_judge,
            claims_record,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end against a real paper: `TUHI_TEST_PROJECT=/path cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn compile_and_sync_real_project() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_PROJECT").expect("set TUHI_TEST_PROJECT"));
        let project = project::open(&root).unwrap();
        let root = PathBuf::from(&project.root);
        let main = project.main.expect("main file");
        let out = std::env::temp_dir().join("tuhi-test-build");

        let result = compile::compile(&root, &main, &out).unwrap();
        for issue in &result.issues {
            println!("{} {:?}:{:?} {}", issue.severity, issue.file, issue.line, issue.message);
        }
        println!("{} in {}ms, ok={}", result.engine, result.millis, result.ok);
        let pdf = PathBuf::from(result.pdf.expect("pdf"));

        let boxes = synctex::forward(&root, &pdf, &main, 40, 1).unwrap();
        println!("forward line 40 -> {} boxes, first {:?}", boxes.len(), boxes.first().map(|b| (b.page, b.x, b.y, b.width, b.height)));
        let first = boxes.first().expect("a box");
        let back = synctex::inverse(&root, &pdf, first.page, first.x + 5.0, first.y + first.height / 2.0)
            .unwrap()
            .expect("a source location");
        println!("inverse -> {}:{}", back.file, back.line);
        assert_eq!(back.file, main);

        // A sentence as PDF text extraction would give it, hyphenation and ligatures included.
        let quote = "By construction, the induced batch-to-batch transformations are cycle-consistent: mapping from batch A to batch B";
        let found = review::locate(&root, &project.files, &pdf, Some(quote), None).expect("located");
        println!("quote -> {}:{} {} {:.2}", found.file, found.line, found.method, found.score);
        assert_eq!(found.method, "text");
        let by_position = review::locate(&root, &project.files, &pdf, None, Some((first.page, first.x + 5.0, first.y + 5.0)));
        println!("position -> {:?}", by_position);
    }

    /// Letter and latexdiff on a git checkout with an edit applied:
    /// `TUHI_TEST_GIT_PROJECT=/path cargo test letter_and_diff -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn letter_and_diff_real_project() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_GIT_PROJECT").expect("set TUHI_TEST_GIT_PROJECT"));
        let after = "mapping from batch $A$ to batch $B$ and then to batch $C$ equals mapping directly from $A$ to $C$. This property holds for any fitted warps, including those distorted by corrupted anchors, so it is a structural guarantee rather than evidence of accuracy.";
        let review = serde_json::json!({
            "label": "Revision 1",
            "cards": [
                { "id": "R2.1", "group": "R2", "status": "accepted",
                  "quote": "By construction, the induced batch-to-batch transformations are cycle-consistent:",
                  "comment": "Is cycle consistency guaranteed under corrupted anchors? 100% sure?",
                  "response": "Yes, by construction; we now say it is not evidence of accuracy (Section I).",
                  "proposal": { "hunks": [{ "file": "TAI_template.tex", "line": 43, "before": "mapping from batch $A$ to batch $B$ and then to batch $C$ equals mapping directly from $A$ to $C$.", "after": after, "state": "accepted" }] } },
                { "id": "R1.1", "group": "R1", "status": "wontfix", "comment": "Add a GPU benchmark.", "reason": "Out of scope; runtime is under a second." },
                { "id": "R1.2", "group": "R1", "status": "open", "comment": "Typo in Fig_2." }
            ]
        });
        let rel = letter::write(&root, "TAI_template.tex", &review).unwrap();
        let out = std::env::temp_dir().join("tuhi-test-letter");
        let compiled = compile::compile(&root, &rel, &out).unwrap();
        println!("letter {rel}: ok={} pdf={:?} errors={:?}", compiled.ok, compiled.pdf,
            compiled.issues.iter().filter(|i| i.severity == "error").map(|i| &i.message).collect::<Vec<_>>());
        assert!(compiled.pdf.is_some());

        let revs = latexdiff::revisions(&root).unwrap();
        println!("HEAD {} {} [{}]", revs[0].rev, revs[0].subject, revs[0].refs);
        match latexdiff::make(&root, "TAI_template.tex", &revs[0].rev, &std::env::temp_dir().join("tuhi-test-diff")) {
            Ok(r) => println!("diff ok={} pdf={:?}", r.ok, r.pdf),
            Err(e) => println!("diff error: {e}"),
        }
    }

    /// `TUHI_TEST_TAURA_PAPER=~/overleaf/trust-align cargo test taura -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn taura_report_and_trace() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_TAURA_PAPER").expect("set TUHI_TEST_TAURA_PAPER"));
        let report = taura::report(&root).unwrap().expect("paired");
        println!("code {} · {} findings · {} changes", report.status["code"], report.findings.len(), report.changes.len());
        for a in &report.artifacts {
            println!("artifact {} {} {}", a.name, a.kind, a.output);
        }
        let trace = taura::trace(&root, "fig1/apex-minutes").unwrap();
        let text = trace.to_string();
        println!("trace {} bytes, has packages: {}", text.len(), text.contains("\"packages\""));
        assert!(!text.contains("\"packages\""));
        assert!(taura::report(&std::env::temp_dir()).unwrap().is_none());
    }

    #[test]
    fn parses_file_line_errors_and_warnings() {
        let log = "./paper.tex:12: Undefined control sequence.\nl.12 \\foo\n\
                   LaTeX Warning: Reference `fig:x' on page 3 undefined on input line 88.\n\
                   Overfull \\hbox (3.2pt too wide) in paragraph at lines 40--42\n";
        let issues = compile::parse_log(Path::new("/nonexistent"), log);
        assert_eq!(issues.len(), 3);
        assert_eq!(issues[0].severity, "error");
        assert_eq!(issues[0].line, Some(12));
        assert_eq!(issues[1].line, Some(88));
        assert_eq!(issues[2].line, Some(40));
    }

    /// `TUHI_TEST_RURU_PAPER=~/overleaf/trust-align cargo test ruru_library -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn ruru_library_and_check() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_RURU_PAPER").expect("set TUHI_TEST_RURU_PAPER"));
        let opened = project::open(&root).unwrap();
        let library = ruru::library(&root, &opened.files);
        println!("project {:?} · {} bib entries · {} papers", library.project, library.bib.len(), library.papers.len());
        assert!(!library.bib.is_empty());
        let first = &library.bib[0];
        println!("first: {} ({}:{}) {}", first.key, first.file, first.line, first.title);
        let report = ruru::check(&root, opened.main.as_deref().unwrap()).unwrap().unwrap();
        println!("cited {} · issues {}", report["cited"], report["issues"]);
        let key = &library.papers[0].key;
        assert_eq!(ruru::show(key).unwrap()["key"], key.as_str());
        assert!(ruru::show("--help").is_err());
    }

    /// Judges one real claim with Claude (a few cents) and records it in a copy of the library:
    /// `TUHI_TEST_CLAIMS_PAPER=~/overleaf/trust-align TUHI_RURU_LIBRARY=/tmp/papers-copy \
    ///  cargo test claims_judge -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn claims_judge_and_record() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_CLAIMS_PAPER").expect("set TUHI_TEST_CLAIMS_PAPER"));
        assert!(std::env::var("TUHI_RURU_LIBRARY").is_ok(), "set TUHI_RURU_LIBRARY to a copy of the library");
        let listed = claims::list(&root).unwrap().expect("a ruru project");
        // The first library paper with a PDF, and the claims citing it.
        let (key, recorded) = listed["claims"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["checks"].as_array().unwrap().iter().map(move |k| (c, k)))
            .find(|(_, k)| k["kind"] == "paper" && k["has_pdf"] == true && k["own"] == false)
            .map(|(c, k)| (k["key"].as_str().unwrap().to_string(), (c["id"].clone(), k["state"].clone())))
            .unwrap();
        println!("judging {key}; recorded so far: {recorded:?}");
        let judgement = claims::judge(&root, &key, &[]).unwrap();
        println!("from {} · ${:.3}", judgement.from, judgement.cost_usd);
        for v in &judgement.verdicts {
            println!("{} {} p.{} found={} quote={:?} note={:?}", v.claim, v.verdict, v.page, v.quote_found, v.quote, v.note);
        }
        assert!(!judgement.verdicts.is_empty());
        let first = &judgement.verdicts[0];
        println!("record: {:?}", claims::record(&root, &key, &judgement.from, first));
    }
}
