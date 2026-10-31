# tuhi

A LaTeX editor for papers: CodeMirror 6 source on the left, PDF.js preview on the right,
SyncTeX jumping between them. Built with Tauri 2 (Rust backend, TypeScript frontend).

## Run

```bash
npm install
npm run tauri dev
```

## Using it

- **Open…** (⌘O) a paper folder, e.g. `~/overleaf/<name>`. The file with `\documentclass` is
  treated as the main file and compiled straight away. The last folder reopens on launch.
- **⌘S** saves every changed file and recompiles.
- **⌘-click** in the source shows that spot in the PDF; **⌘-click** in the PDF jumps to the source.
  **⌘J** shows the cursor's line in the PDF.
- Problems from the TeX log and BibTeX appear under the editor and in the gutter; click one to jump.

Build output goes to the app's cache folder, never into the paper's repo. Uses `latexmk` when
installed, otherwise runs the engine and BibTeX itself. `% !TEX program = xelatex` picks the engine.

## Layout

- `src-tauri/src/project.rs` — finding files and the main `.tex` file
- `src-tauri/src/compile.rs` — compile pipeline and log parsing
- `src-tauri/src/synctex.rs` — forward and inverse search via the `synctex` CLI
- `src/editor.ts`, `src/preview.ts`, `src/main.ts` — editor, PDF preview, wiring

## Tests

```bash
cd src-tauri && cargo test
TUHI_TEST_PROJECT=~/overleaf/trust-align cargo test -- --ignored --nocapture
```
