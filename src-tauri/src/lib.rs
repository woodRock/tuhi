mod claims;
mod claude;
mod compile;
mod draft;
mod explain;
mod git;
mod latexdiff;
mod letter;
mod menu;
mod project;
mod review;
mod setup;
mod snapshots;
mod suggest;
mod synctex;
mod ruru;
mod taura;
mod tools;
mod watch;

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
    // For sidecar files such as .tuhi/suggestions.json.
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{file}: {e}"))?;
    }
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
fn write_letter(app: AppHandle, root: String, main: String, review: serde_json::Value) -> Result<String, String> {
    let pdf = pdf_for(&app, &root, &main)?;
    letter::write(Path::new(&root), &main, &review, Some(&pdf))
}

#[tauri::command]
fn review_edit_problems(root: String, review: serde_json::Value, sources: std::collections::HashMap<String, String>) -> Vec<letter::EditProblem> {
    letter::edit_problems(Path::new(&root), &review, sources)
}

#[tauri::command]
fn git_revisions(root: String) -> Result<Vec<latexdiff::Revision>, String> {
    latexdiff::revisions(Path::new(&root))
}

#[tauri::command]
async fn make_diff(
    app: AppHandle,
    root: String,
    main: String,
    rev: String,
    new_rev: Option<String>,
) -> Result<compile::CompileResult, String> {
    let root = PathBuf::from(root);
    let build = build_dir(&app, &root)?;
    let work = build.with_file_name(format!(
        "{}-diff",
        build.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    tauri::async_runtime::spawn_blocking(move || latexdiff::make(&root, &main, &rev, new_rev.as_deref(), &work))
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

#[tauri::command]
async fn git_status(root: String, fetch: bool) -> Result<git::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        if fetch {
            git::fetch(root);
        }
        git::status(root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn git_diff(root: String, path: String) -> Result<String, String> {
    git::diff(Path::new(&root), &path)
}

#[tauri::command]
async fn git_commit(root: String, message: String, paths: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::commit(Path::new(&root), &message, &paths)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_pull(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::pull(Path::new(&root))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_push(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::push(Path::new(&root))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn setup_status() -> Result<setup::Setup, String> {
    tauri::async_runtime::spawn_blocking(setup::status).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn setup_install(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || setup::install(&name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn setup_init_library(path: String, email: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || setup::init_library(&path, &email)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn new_paper(paper: setup::NewPaper) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || setup::create_paper(&paper)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn link_ruru(name: String, dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || setup::link_ruru(&name, &dir)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pair_taura(paper: String, code: Option<String>) -> Result<setup::Paired, String> {
    tauri::async_runtime::spawn_blocking(move || setup::pair_taura(&paper, code.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn roots_get() -> Result<setup::Roots, String> {
    tauri::async_runtime::spawn_blocking(setup::roots).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn roots_set(key: String, folder: Option<String>) -> Result<setup::Roots, String> {
    tauri::async_runtime::spawn_blocking(move || setup::set_root(&key, folder.as_deref())).await.map_err(|e| e.to_string())?
}

/// Rebuilds the menu bar for what's open, enabled and checked.
#[tauri::command]
fn set_menu_state(app: AppHandle, state: menu::MenuState) -> Result<(), String> {
    let menu = menu::build(&app, &state).map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}

/// Copies the last compiled PDF to `to`.
#[tauri::command]
fn export_pdf(app: AppHandle, root: String, main: String, to: String) -> Result<(), String> {
    let pdf = pdf_for(&app, &root, &main)?;
    fs::copy(&pdf, &to).map(|_| ()).map_err(|e| format!("{}: {e}", pdf.display()))
}

/// Zips the paper's sources for a journal or arXiv: everything but git, tuhi's own files and
/// TeX's build output, plus the compiled .bbl so the bibliography builds without BibTeX.
#[tauri::command]
fn export_source(app: AppHandle, root: String, main: String, to: String) -> Result<usize, String> {
    let root = Path::new(&root);
    let mut files = Vec::new();
    collect_sources(root, root, &mut files);
    // The paper's own PDF, if Overleaf or an earlier build left one in the folder.
    let own_pdf = Path::new(&main).with_extension("pdf").to_string_lossy().into_owned();
    files.retain(|f| *f != own_pdf);
    let _ = fs::remove_file(&to);
    let bbl = pdf_for(&app, &root.to_string_lossy(), &main)?.with_extension("bbl");
    let bbl_name = Path::new(&main).with_extension("bbl").to_string_lossy().into_owned();
    // A .bbl already in the folder wins over the build's copy.
    let add_bbl = bbl.exists() && !files.contains(&bbl_name);
    let zip = |dir: &Path, list: &[String]| -> Result<(), String> {
        use std::io::Write;
        let mut child = std::process::Command::new("zip")
            .args(["-q", &to, "-@"])
            .current_dir(dir)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("zip: {e}"))?;
        child.stdin.take().unwrap().write_all(list.join("\n").as_bytes()).map_err(|e| e.to_string())?;
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() { Ok(()) } else { Err(format!("zip failed ({status})")) }
    };
    zip(root, &files)?;
    if add_bbl {
        let staging = std::env::temp_dir().join(format!("tuhi-bbl-{}", std::process::id()));
        let staged = staging.join(&bbl_name);
        fs::create_dir_all(staged.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::copy(&bbl, &staged).map_err(|e| e.to_string())?;
        let result = zip(&staging, &[bbl_name]);
        let _ = fs::remove_dir_all(&staging);
        result?;
    }
    Ok(files.len() + add_bbl as usize)
}

fn collect_sources(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_sources(root, &path, out);
        } else if let Some(rel) = watch::relevant(root, &path) {
            if !rel.starts_with(".tuhi/") && !rel.starts_with("response/") && !rel.ends_with(".DS_Store") {
                out.push(rel);
            }
        }
    }
    out.sort();
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

/// Claude's suggested edits to a selected passage.
#[tauri::command]
async fn suggest_edits(
    root: String,
    file: String,
    passage: String,
    before: String,
    after: String,
    instruction: String,
) -> Result<suggest::Suggestions, String> {
    tauri::async_runtime::spawn_blocking(move || suggest::suggest(Path::new(&root), &file, &passage, &before, &after, &instruction))
        .await
        .map_err(|e| e.to_string())?
}

/// Claude's plain-English explanation of a compile error, with a fix when it can find one.
#[tauri::command]
async fn explain_error(
    root: String,
    message: String,
    file: Option<String>,
    line: Option<u32>,
    log: String,
) -> Result<explain::Explanation, String> {
    tauri::async_runtime::spawn_blocking(move || explain::explain(Path::new(&root), &message, file.as_deref(), line, &log))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn snapshots_list(root: String) -> Result<Vec<snapshots::Snapshot>, String> {
    snapshots::list(Path::new(&root))
}

/// Records the files as they are now under a name, without committing to the branch.
#[tauri::command]
async fn snapshot_create(root: String, name: String) -> Result<snapshots::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshots::create(Path::new(&root), &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn snapshot_delete(root: String, id: String) -> Result<(), String> {
    snapshots::delete(Path::new(&root), &id)
}

/// Lines changed per file between two revisions (`new` None: the current files).
#[tauri::command]
async fn version_changes(root: String, old: String, new: Option<String>) -> Result<Vec<snapshots::FileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || snapshots::changes(Path::new(&root), &old, new.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Watches the paper folder and sends `project-changed` events for edits made outside tuhi.
#[tauri::command]
fn watch_project(app: AppHandle, state: tauri::State<watch::State>, root: String) -> Result<(), String> {
    watch::watch(app, &state, Path::new(&root))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::State::default())
        .setup(|app| {
            let menu = menu::build(app.handle(), &menu::MenuState { sidebar: true, problems: true, ..Default::default() })?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(menu::forward)
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
            review_edit_problems,
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
            suggest_edits,
            explain_error,
            snapshots_list,
            snapshot_create,
            snapshot_delete,
            version_changes,
            watch_project,
            set_menu_state,
            export_pdf,
            export_source,
            git_status,
            git_diff,
            git_commit,
            git_pull,
            git_push,
            setup_status,
            setup_install,
            setup_init_library,
            new_paper,
            link_ruru,
            pair_taura,
            roots_get,
            roots_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submission_zip_leaves_out_build_and_tuhi_files() {
        let dir = std::env::temp_dir().join(format!("tuhi-sources-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for f in ["main.tex", "refs.bib", "figs/a.pdf", "main.aux", ".tuhi/settings.json", ".git/HEAD", "response/revision-1.tex"] {
            let path = dir.join(f);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        let root = dir.canonicalize().unwrap();
        let mut files = Vec::new();
        collect_sources(&root, &root, &mut files);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(files, ["figs/a.pdf", "main.tex", "refs.bib"]);
    }

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
    /// Writes the letter for a real review in a copy of its paper, compiled first so the
    /// letter has section and page numbers, and prints every change's location.
    #[test]
    #[ignore]
    fn letter_for_real_review() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_LETTER_PAPER").expect("set TUHI_TEST_LETTER_PAPER to a copy"));
        let main = project::open(&root).unwrap().main.unwrap();
        let reviews = review::list(&root).unwrap();
        let review = reviews.last().expect("no review");
        let out = std::env::temp_dir().join("tuhi-test-letter-paper");
        let built = compile::compile(&root, &main, &out).unwrap();
        let pdf = PathBuf::from(built.pdf.expect("paper didn't compile"));
        let rel = letter::write(&root, &main, review, Some(&pdf)).unwrap();
        let text = fs::read_to_string(root.join(&rel)).unwrap();
        for line in text.lines().filter(|l| l.starts_with("\\item")) {
            println!("{line}");
        }
        let compiled = compile::compile(&root, &rel, &std::env::temp_dir().join("tuhi-test-letter")).unwrap();
        println!("no longer in the text: {}", text.matches("no longer in the revised text").count());
        for p in letter::edit_problems(&root, review, Default::default()) {
            println!("check: {} {}:{:?} gone={} missing={:?}", p.card, p.file, p.line, p.gone, p.missing);
        }
        assert!(compiled.ok, "{}", compiled.log.lines().filter(|l| l.starts_with('!') || l.starts_with("l.")).collect::<Vec<_>>().join("\n"));
    }

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
        let rel = letter::write(&root, "TAI_template.tex", &review, None).unwrap();
        let out = std::env::temp_dir().join("tuhi-test-letter");
        let compiled = compile::compile(&root, &rel, &out).unwrap();
        println!("letter {rel}: ok={} pdf={:?} errors={:?}", compiled.ok, compiled.pdf,
            compiled.issues.iter().filter(|i| i.severity == "error").map(|i| &i.message).collect::<Vec<_>>());
        assert!(compiled.pdf.is_some());

        let revs = latexdiff::revisions(&root).unwrap();
        println!("HEAD {} {} [{}]", revs[0].rev, revs[0].subject, revs[0].refs);
        match latexdiff::make(&root, "TAI_template.tex", &revs[0].rev, None, &std::env::temp_dir().join("tuhi-test-diff")) {
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

    /// `TUHI_TEST_SUGGEST_PAPER=~/overleaf/trust-align cargo test suggests_edits -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn suggests_edits_for_a_real_passage() {
        let root = PathBuf::from(std::env::var("TUHI_TEST_SUGGEST_PAPER").expect("set TUHI_TEST_SUGGEST_PAPER"));
        let main = project::open(&root).unwrap().main.unwrap();
        let text = fs::read_to_string(root.join(&main)).unwrap();
        // The first long prose paragraph line.
        let passage = text.lines().find(|l| l.len() > 300 && !l.trim_start().starts_with(['%', '\\'])).unwrap();
        let result = suggest::suggest(&root, &main, passage, "", "", "Tighten this; cut redundant words.").unwrap();
        println!("{} · ${:.3}", result.summary, result.cost_usd);
        for e in &result.edits {
            println!("- {:?} -> {:?} ({}) found={}", e.find, e.replace, e.why, passage.contains(&e.find));
        }
        assert!(result.edits.iter().all(|e| passage.contains(&e.find)));
    }

    /// Breaks a copy of a paper, compiles it and asks Claude to explain the error:
    /// `TUHI_TEST_EXPLAIN_PAPER=~/overleaf/trust-align cargo test explains -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn explains_a_real_compile_error() {
        let source = PathBuf::from(std::env::var("TUHI_TEST_EXPLAIN_PAPER").expect("set TUHI_TEST_EXPLAIN_PAPER"));
        let root = std::env::temp_dir().join("tuhi-explain-test");
        let _ = fs::remove_dir_all(&root);
        latexdiff::copy_tree(&source, &root).unwrap();
        let main = project::open(&root).unwrap().main.unwrap();
        let text = fs::read_to_string(root.join(&main)).unwrap();
        // A typo in a command name inside the first long paragraph.
        let line = text.lines().position(|l| l.len() > 300 && l.contains("\\cite")).unwrap();
        let broken: Vec<String> = text.lines().enumerate().map(|(i, l)| if i == line { l.replacen("\\cite", "\\ctie", 1) } else { l.to_string() }).collect();
        fs::write(root.join(&main), broken.join("\n")).unwrap();

        let out = std::env::temp_dir().join("tuhi-explain-build");
        let result = compile::compile(&root, &main, &out).unwrap();
        let error = result.issues.iter().find(|i| i.severity == "error").expect("an error");
        println!("error: {:?} at {:?}:{:?}", error.message, error.file, error.line);
        let explained = explain::explain(&root, &error.message, error.file.as_deref(), error.line, &result.log).unwrap();
        println!("{} (${:.3})", explained.explanation, explained.cost_usd);
        let fix = explained.fix.expect("a fix");
        println!("{}:{} {:?} -> {:?}", fix.file, fix.line, fix.before, fix.after);
        assert!(fix.before.contains("\\ctie") && fix.after.contains("\\cite"));
    }

    /// Snapshots a clone of a real paper and diffs two versions with latexdiff:
    /// `TUHI_TEST_GIT_PROJECT=~/overleaf/trust-align cargo test snapshot_and_diff -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn snapshot_and_diff_real_project() {
        let source = PathBuf::from(std::env::var("TUHI_TEST_GIT_PROJECT").expect("set TUHI_TEST_GIT_PROJECT"));
        let root = std::env::temp_dir().join("tuhi-snapshot-test");
        let _ = fs::remove_dir_all(&root);
        let cloned = std::process::Command::new("git").args(["clone", "-q"]).arg(&source).arg(&root).status().unwrap();
        assert!(cloned.success());
        let main = project::open(&root).unwrap().main.unwrap();
        let head = |root: &Path| String::from_utf8(std::process::Command::new("git").arg("-C").arg(root).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap();
        let before = head(&root);

        let submitted = snapshots::create(&root, "Submitted v1").unwrap();
        let text = fs::read_to_string(root.join(&main)).unwrap();
        let edited = text.replacen("\\section{Conclusion}", "\\section{Conclusion}\nThis sentence was added after submission.", 1);
        assert_ne!(edited, text);
        fs::write(root.join(&main), edited).unwrap();
        let revised = snapshots::create(&root, "Revision 1").unwrap();
        assert_eq!(head(&root), before, "snapshots must not move HEAD");
        println!("{:?}", snapshots::list(&root).unwrap().iter().map(|s| (&s.id, &s.name, &s.commit)).collect::<Vec<_>>());

        let changes = snapshots::changes(&root, &format!("tuhi/{}", submitted.id), Some(&format!("tuhi/{}", revised.id))).unwrap();
        println!("changes: {:?}", changes.iter().map(|c| (&c.file, c.added, c.removed)).collect::<Vec<_>>());
        assert_eq!(changes.len(), 1);

        let work = std::env::temp_dir().join("tuhi-snapshot-diff");
        let result = latexdiff::make(&root, &main, &format!("tuhi/{}", submitted.id), Some(&format!("tuhi/{}", revised.id)), &work).unwrap();
        println!("diff pdf: {:?} ({} errors)", result.pdf, result.issues.iter().filter(|i| i.severity == "error").count());
        assert!(result.pdf.is_some());
    }
}
