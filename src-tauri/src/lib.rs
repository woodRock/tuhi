mod compile;
mod project;
mod review;
mod synctex;
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
}
