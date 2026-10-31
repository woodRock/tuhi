use crate::{project, tools};
use serde::Serialize;
use std::path::Path;

/// A box on a PDF page, in points from the page's top-left corner.
#[derive(Serialize, Default)]
pub struct PdfBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
pub struct SourceLocation {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

/// Source → PDF: where does this line end up?
pub fn forward(root: &Path, pdf: &Path, file: &str, line: u32, column: u32) -> Result<Vec<PdfBox>, String> {
    let input = project::resolve(root, file)?;
    let output = tools::command("synctex")?
        .current_dir(root)
        .arg("view")
        .arg("-i")
        .arg(format!("{line}:{column}:{}", input.display()))
        .arg("-o")
        .arg(pdf)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut boxes = Vec::new();
    let mut current: Option<PdfBox> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let number = value.trim().parse::<f64>().unwrap_or(0.0);
        match key {
            "Output" => {
                if let Some(b) = current.take() {
                    boxes.push(b);
                }
                current = Some(PdfBox::default());
            }
            "Page" => current.get_or_insert_default().page = number as u32,
            "h" => current.get_or_insert_default().x = number,
            "v" => current.get_or_insert_default().y = number,
            "W" => current.get_or_insert_default().width = number,
            "H" => current.get_or_insert_default().height = number,
            _ => {}
        }
    }
    boxes.extend(current);
    // v is the baseline; shift up by the box height to get the top edge.
    for b in &mut boxes {
        b.y -= b.height;
    }
    boxes.retain(|b| b.page > 0);
    Ok(boxes)
}

/// PDF → source: which line produced this point on the page?
pub fn inverse(root: &Path, pdf: &Path, page: u32, x: f64, y: f64) -> Result<Option<SourceLocation>, String> {
    let output = tools::command("synctex")?
        .current_dir(root)
        .arg("edit")
        .arg("-o")
        .arg(format!("{page}:{x}:{y}:{}", pdf.display()))
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut input = None;
    let mut line_number = 0;
    let mut column = 0;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Input:") {
            input = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Line:") {
            line_number = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("Column:") {
            // synctex reports -1 when it doesn't know the column.
            column = v.trim().parse::<i64>().unwrap_or(0).max(0) as u32;
        }
    }
    Ok(input
        .and_then(|i| project::relativize(root, &i))
        .filter(|_| line_number > 0)
        .map(|file| SourceLocation { file, line: line_number, column }))
}
