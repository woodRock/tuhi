//! The macOS menu bar. Items send `menu` events with their id to the frontend, which owns the
//! actions; the frontend calls `set_menu_state` whenever what's enabled or checked changes, and
//! the menu is rebuilt from that state.

use serde::Deserialize;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// Labels for File ▸ Open Recent, most recent first; item ids are `recent:<index>`.
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub project: bool,
    /// A compiled PDF exists.
    #[serde(default)]
    pub pdf: bool,
    #[serde(default)]
    pub suggesting: bool,
    #[serde(default = "yes")]
    pub sidebar: bool,
    #[serde(default = "yes")]
    pub problems: bool,
}

fn yes() -> bool {
    true
}

/// Sidebar views in View, in the activity bar's order, with their shortcuts ⌘1…⌘8.
const VIEWS: &[(&str, &str)] = &[
    ("files", "Files and Outline"),
    ("search", "Search"),
    ("git", "Source Control"),
    ("review", "Review"),
    ("suggestions", "Suggestions"),
    ("checks", "Checks"),
    ("claims", "Claims"),
    ("provenance", "Provenance"),
];

pub fn build<R: Runtime>(app: &AppHandle<R>, state: &MenuState) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: Option<&str>, enabled: bool| {
        let mut b = MenuItemBuilder::with_id(id, text).enabled(enabled);
        if let Some(a) = accelerator {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let p = state.project;

    let app_menu = SubmenuBuilder::new(app, "tuhi")
        .about(None)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"), true)?)
        .item(&item("setup", "Set Up Tools…", None, true)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let mut recent = SubmenuBuilder::new(app, "Open Recent");
    for (i, label) in state.recent.iter().enumerate() {
        recent = recent.item(&item(&format!("recent:{i}"), label, None, true)?);
    }
    if !state.recent.is_empty() {
        recent = recent.separator();
    }
    let recent = recent.item(&item("recent-clear", "Clear Menu", None, !state.recent.is_empty())?).build()?;

    let export = SubmenuBuilder::new(app, "Export")
        .item(&item("export-pdf", "PDF…", Some("CmdOrCtrl+Shift+P"), p && state.pdf)?)
        .item(&item("export-source", "Source for Submission (.zip)…", None, p)?)
        .separator()
        .item(&item("export-letter", "Response Letter", None, p)?)
        .item(&item("export-diff", "Diff PDF…", None, p)?)
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-project", "New Project…", Some("CmdOrCtrl+Shift+N"), true)?)
        .item(&item("open", "Open Folder…", Some("CmdOrCtrl+O"), true)?)
        .item(&recent)
        .item(&item("quick-open", "Go to File…", Some("CmdOrCtrl+P"), p)?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"), p)?)
        .item(&item("refresh", "Reload from Disk", Some("CmdOrCtrl+Shift+R"), p)?)
        .separator()
        .item(&export)
        .separator()
        .item(&item("reveal", "Show in Finder", None, p)?)
        .item(&item("open-pdf", "Open PDF in Preview", None, p && state.pdf)?)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find…", Some("CmdOrCtrl+F"), p)?)
        .item(&item("search", "Search in Paper…", Some("CmdOrCtrl+Shift+F"), p)?)
        .separator()
        .item(&CheckMenuItemBuilder::with_id("suggesting", "Suggesting Mode").checked(state.suggesting).enabled(p).accelerator("CmdOrCtrl+Shift+E").build(app)?)
        .item(&item("comment", "Comment on Selection…", Some("CmdOrCtrl+Alt+M"), p)?)
        .item(&item("ask-claude", "Ask Claude about Selection…", Some("CmdOrCtrl+Alt+K"), p)?)
        .build()?;

    let mut view = SubmenuBuilder::new(app, "View")
        .item(&item("sidebar", if state.sidebar { "Hide Sidebar" } else { "Show Sidebar" }, Some("CmdOrCtrl+Ctrl+S"), true)?)
        .item(&item("problems", if state.problems { "Hide Problems" } else { "Show Problems" }, Some("CmdOrCtrl+Shift+M"), p)?)
        .separator();
    for (i, (id, label)) in VIEWS.iter().enumerate() {
        view = view.item(&item(&format!("view:{id}"), label, Some(&format!("CmdOrCtrl+{}", i + 1)), p)?);
    }
    let view = view
        .separator()
        .item(&item("sync", "Show Cursor in PDF", Some("CmdOrCtrl+J"), p && state.pdf)?)
        .separator()
        .fullscreen()
        .build()?;

    let paper = SubmenuBuilder::new(app, "Paper")
        .item(&item("compile", "Compile", Some("CmdOrCtrl+B"), p)?)
        .item(&item("checks", "Run Checks", None, p)?)
        .separator()
        .separator()
        .item(&item("link-project", "Link to ruru and taura…", None, p)?)
        .separator()
        .item(&item("git-commit", "Commit…", Some("CmdOrCtrl+Alt+C"), p)?)
        .item(&item("git-pull", "Pull", None, p)?)
        .item(&item("git-push", "Push", None, p)?)
        .separator()
        .item(&item("snapshot", "Take Snapshot…", None, p)?)
        .item(&item("compare", "Compare Versions…", None, p)?)
        .build()?;

    let review = SubmenuBuilder::new(app, "Review")
        .item(&item("review-import", "Import Reviewer PDF…", None, p)?)
        .item(&item("review-paste", "Paste Reviewer Comments…", None, p)?)
        .item(&item("review-new", "New Round", None, p)?)
        .separator()
        .item(&item("review-draft-all", "Draft All Open Comments", None, p)?)
        .item(&item("review-check", "Check What's Unresolved", None, p)?)
        .separator()
        .item(&item("review-letter", "Write Response Letter", None, p)?)
        .item(&item("review-diff", "Diff PDF for This Round", None, p)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().bring_all_to_front().build()?;
    let help = SubmenuBuilder::new(app, "Help").item(&item("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+Shift+/"), true)?).build()?;

    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &paper, &review, &window, &help]).build()
}

/// Sends every menu click to the frontend.
pub fn forward<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let _ = app.emit("menu", event.id().0.clone());
}
