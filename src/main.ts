import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { Editor } from "./editor";
import { Preview } from "./preview";
import { ReviewPanel } from "./review";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  open: $<HTMLButtonElement>("open"),
  projectName: $("project-name"),
  file: $<HTMLSelectElement>("file"),
  dirty: $("dirty"),
  status: $("status"),
  compile: $<HTMLButtonElement>("compile"),
  workspace: $("workspace"),
  empty: $("empty"),
  problems: $("problems"),
  problemList: $<HTMLUListElement>("problem-list"),
  problemCount: $("problem-count"),
  log: $("log"),
  tabProblems: $("tab-problems"),
  tabLog: $("tab-log"),
  problemsToggle: $("problems-toggle"),
  divider: $("divider"),
  tabPdf: $("tab-pdf"),
  tabReview: $("tab-review"),
  preview: $("preview"),
  review: $("review"),
};

const LAST_PROJECT = "tuhi.lastProject";

let project: api.Project | null = null;
let issues: api.Issue[] = [];
let compiling = false;
let compileQueued = false;

const editor = new Editor($("editor"), {
  onSave: () => void saveAndCompile(),
  onDirtyChange: () => (ui.dirty.hidden = editor.dirtyFiles().length === 0),
  onForwardSync: (line, column) => void forwardSync(line, column),
});

const preview = new Preview($("preview"), (page, x, y) => void inverseSync(page, x, y));

const reviewPanel = new ReviewPanel(ui.review, {
  jump: (file, line) => void openFile(file, line).catch(report),
  cursor: () => editor.cursor(),
  status: (text, error) => setStatus(text, error),
});

function setStatus(text: string, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", error);
}

function report(error: unknown) {
  setStatus(String(error), true);
  console.error(error);
}

// Projects

async function chooseProject() {
  const path = await open({ directory: true, title: "Open a paper folder" });
  if (typeof path === "string") await loadProject(path);
}

async function loadProject(path: string) {
  if (editor.dirtyFiles().length && !confirm("Discard unsaved changes?")) return;
  project = await api.openProject(path);
  try {
    localStorage.setItem(LAST_PROJECT, project.root);
  } catch {}
  document.title = `${project.name} — tuhi`;
  ui.projectName.textContent = project.name;
  ui.file.replaceChildren(...project.files.map((f) => new Option(f, f)));
  ui.file.disabled = false;
  ui.compile.disabled = !project.main;
  ui.empty.hidden = true;
  editor.reset();
  preview.clear();
  showIssues([], "");

  await reviewPanel.setProject(project.root, project.main);

  const first = project.main ?? project.files.find((f) => f.endsWith(".tex")) ?? project.files[0];
  if (first) await openFile(first);
  if (project.main) await runCompile();
  else setStatus("No file with \\documentclass found", true);
}

async function openFile(file: string, line?: number, column?: number) {
  if (!project) return;
  if (!editor.has(file)) editor.load(file, await api.readText(project.root, file));
  if (editor.file !== file) editor.show(file);
  ui.file.value = file;
  showProblemsInEditor();
  if (line) editor.goTo(line, column);
}

// Compiling

async function saveAndCompile() {
  if (!project) return;
  try {
    for (const file of editor.dirtyFiles()) {
      const text = editor.text(file);
      await api.writeText(project.root, file, text);
      editor.markSaved(file, text);
    }
    ui.dirty.hidden = true;
  } catch (error) {
    report(error);
    return;
  }
  await runCompile();
}

async function runCompile() {
  if (!project?.main) return;
  // A save during a compile queues one more run rather than starting a second process.
  if (compiling) {
    compileQueued = true;
    return;
  }
  compiling = true;
  ui.compile.disabled = true;
  setStatus("Compiling…");
  const { root, main } = project;
  try {
    const result = await api.compile(root, main);
    if (project?.root !== root) return;
    if (result.pdf) await preview.load(await api.readPdf(root, main));
    showIssues(result.issues, result.log);
    const errors = result.issues.filter((i) => i.severity === "error").length;
    const seconds = (result.millis / 1000).toFixed(1);
    if (errors) setStatus(`${errors} error${errors > 1 ? "s" : ""} · ${seconds}s`, true);
    else if (!result.pdf) setStatus("No PDF produced", true);
    else setStatus(`${result.engine} · ${seconds}s`);
  } catch (error) {
    report(error);
  } finally {
    compiling = false;
    ui.compile.disabled = !project?.main;
    if (compileQueued) {
      compileQueued = false;
      void runCompile();
    }
  }
}

// SyncTeX

async function forwardSync(line: number, column: number) {
  if (!project?.main || !editor.file) return;
  try {
    const boxes = await api.synctexForward(project.root, project.main, editor.file, line, column);
    if (boxes.length) preview.highlight(boxes);
    else setStatus("Nothing in the PDF for that line");
  } catch (error) {
    report(error);
  }
}

async function inverseSync(page: number, x: number, y: number) {
  if (!project?.main) return;
  try {
    const location = await api.synctexInverse(project.root, project.main, page, x, y);
    if (location) await openFile(location.file, location.line, location.column);
    else setStatus("No source found for that spot");
  } catch (error) {
    report(error);
  }
}

// Problems panel

function showIssues(next: api.Issue[], log: string) {
  issues = next;
  ui.log.textContent = log;
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  ui.problemCount.textContent = issues.length ? `${errors} · ${warnings}` : "";

  // Errors first, then warnings, then box badness.
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  ui.problemList.replaceChildren(
    ...sorted.map((issue) => {
      const li = document.createElement("li");
      li.className = issue.severity;
      const sev = document.createElement("span");
      sev.className = "sev";
      sev.textContent = issue.severity === "error" ? "✕" : issue.severity === "warning" ? "!" : "·";
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = issue.file ? `${issue.file}:${issue.line ?? ""}` : issue.line ? `line ${issue.line}` : "";
      const message = document.createElement("span");
      message.textContent = issue.message;
      li.append(sev, where, message);
      // Warnings without a file usually come from the main file.
      const file = issue.file ?? (issue.line ? project?.main : null);
      if (file && issue.line) {
        li.classList.add("linked");
        li.addEventListener("click", () => void openFile(file, issue.line!));
      }
      return li;
    }),
  );
  if (!issues.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = log ? "No problems." : "";
    ui.problemList.append(li);
  }
  showProblemsInEditor();
}

function showProblemsInEditor() {
  if (!editor.file) return;
  const file = editor.file;
  editor.setProblems(
    issues
      .filter((i) => i.line && (i.file === file || (!i.file && i.severity !== "info" && file === project?.main)))
      .map((i) => ({ line: i.line!, severity: i.severity, message: i.message })),
  );
}

function selectTab(log: boolean) {
  ui.tabProblems.classList.toggle("active", !log);
  ui.tabLog.classList.toggle("active", log);
  ui.problemList.hidden = log;
  ui.log.hidden = !log;
  ui.problems.classList.remove("collapsed");
}

function showSide(review: boolean) {
  ui.tabPdf.classList.toggle("active", !review);
  ui.tabReview.classList.toggle("active", review);
  ui.preview.hidden = review;
  ui.review.hidden = !review;
}

// Wiring

ui.tabPdf.addEventListener("click", () => showSide(false));
ui.tabReview.addEventListener("click", () => showSide(true));
ui.open.addEventListener("click", () => void chooseProject().catch(report));
ui.compile.addEventListener("click", () => void saveAndCompile());
ui.file.addEventListener("change", () => void openFile(ui.file.value).catch(report));
ui.tabProblems.addEventListener("click", () => selectTab(false));
ui.tabLog.addEventListener("click", () => selectTab(true));
ui.problemsToggle.addEventListener("click", () => {
  const collapsed = ui.problems.classList.toggle("collapsed");
  ui.problemsToggle.textContent = collapsed ? "▴" : "▾";
});

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key === "o") {
    event.preventDefault();
    void chooseProject().catch(report);
  } else if (mod && event.key === "s") {
    // The editor handles this when focused; this catches it everywhere else.
    event.preventDefault();
    void saveAndCompile();
  }
});

ui.divider.addEventListener("pointerdown", (event) => {
  ui.divider.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const rect = ui.workspace.getBoundingClientRect();
    const percent = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
    ui.workspace.style.setProperty("--source-width", `${percent}%`);
  };
  ui.divider.addEventListener("pointermove", move);
  ui.divider.addEventListener("pointerup", () => ui.divider.removeEventListener("pointermove", move), { once: true });
});

let lastProject: string | null = null;
try {
  lastProject = localStorage.getItem(LAST_PROJECT);
} catch {}
if (lastProject) void loadProject(lastProject).catch(report);
