import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { checklist, DEFAULT_SETTINGS, lint, type Finding, type Settings } from "./checks";
import { ChecksPanel } from "./checks-panel";
import { Citations } from "./citations";
import { explain } from "./explain";
import { ClaimsPanel } from "./claims-panel";
import { Editor } from "./editor";
import { newId, reanchor, withContext, type Mark } from "./marks";
import { outline } from "./outline";
import { OutlinePanel } from "./outline-panel";
import { VersionsPanel } from "./versions-panel";
import { SuggestionsPanel, type Entry } from "./suggestions-panel";
import { Preview } from "./preview";
import { ReviewPanel } from "./review";
import { markersFor, renderTrace, type Marker } from "./provenance";
import { ProvenancePanel } from "./provenance-panel";

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
  tabProvenance: $("tab-provenance"),
  provenance: $("provenance"),
  tabClaims: $("tab-claims"),
  claims: $("claims"),
  tabSuggestions: $("tab-suggestions"),
  suggestions: $("suggestions"),
  suggestionCount: $("suggestion-count"),
  suggesting: $<HTMLButtonElement>("suggesting"),
  tabChecks: $("tab-checks"),
  checks: $("checks"),
  checkCount: $("check-count"),
  tabOutline: $("tab-outline"),
  outline: $("outline"),
  tabVersions: $("tab-versions"),
  versions: $("versions"),
};

const LAST_PROJECT = "tuhi.lastProject";

let project: api.Project | null = null;
let issues: api.Issue[] = [];
/** From the last compile; `issues` adds ruru's citation check to these. */
let compileIssues: api.Issue[] = [];
let compileLog = "";
let citeIssues: api.Issue[] = [];
/** Citations whose verdict says the cited paper doesn't (fully) back the sentence. */
let claimIssues: api.Issue[] = [];
/** Consistency lint: spelling, acronyms, notation, macrons. */
let lintIssues: api.Issue[] = [];
let compiling = false;
let compileQueued = false;
/** taura's report for the open paper; null when it isn't paired with a code repo. */
let taura: api.TauraReport | null = null;

const citations = new Citations({
  show: (key) => api.ruruShow(key),
  jump: (file, line) => void openFile(file, line).catch(report),
});

const editor = new Editor($("editor"), {
  onSave: () => void saveAndCompile(),
  onDirtyChange: () => (ui.dirty.hidden = editor.dirtyFiles().length === 0),
  onForwardSync: (line, column) => void forwardSync(line, column),
  onMarkerClick: (marker, x, y) => void showProvenance(marker, x, y),
  onMarksChange: () => marksChanged(),
  onMarkFocus: (_file, id) => suggestionsPanel.focus(id),
}, citations);

const preview = new Preview($("preview"), (page, x, y) => void inverseSync(page, x, y));

const reviewPanel = new ReviewPanel(ui.review, {
  jump: (file, line) => void openFile(file, line).catch(report),
  cursor: () => editor.cursor(),
  status: (text, error) => setStatus(text, error),
  applyEdit: async (file, before, after, line) => {
    if (!project) return null;
    await ensureLoaded(file);
    const changed = editor.replace(file, before, after, line);
    if (changed !== null) await openFile(file, changed);
    return changed;
  },
  sourceText: async (file) => (editor.has(file) ? editor.text(file) : project ? api.readText(project.root, file) : ""),
  saveAll: async () => {
    if (!(await saveDirty())) throw new Error("Couldn't save your changes");
  },
  refreshFiles: async () => {
    if (!project) return;
    const fresh = await api.openProject(project.root);
    project.files = fresh.files;
    ui.file.replaceChildren(...project.files.map((f) => new Option(f, f)));
    if (editor.file) ui.file.value = editor.file;
  },
});

const claimsPanel = new ClaimsPanel(ui.claims, {
  jump: (file, line) => void openFile(fromMainDir(file), line).catch(report),
  status: (text, error) => setStatus(text, error),
  changed: (doc) => {
    claimIssues = doc ? weakClaims(doc) : [];
    showIssues(compileIssues, compileLog);
  },
});

const provenancePanel = new ProvenancePanel(ui.provenance, {
  jump: (file, line) => void openFile(file, line).catch(report),
  refresh: () => refreshProvenance(),
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
  if (sidecarTimer) {
    clearTimeout(sidecarTimer);
    sidecarTimer = 0;
    await saveSidecar();
  }
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
  citations.set(null, "");
  citeIssues = [];
  claimIssues = [];
  lintIssues = [];
  showIssues([], "");

  await loadSidecar(project.root);
  await loadSettings(project.root);
  void versionsPanel.setProject(project.root);
  await reviewPanel.setProject(project.root, project.main);
  taura = null;
  void refreshProvenance();
  void refreshCitations(false);
  void claimsPanel.setProject(project.root);
  renderSuggestions();

  const first = project.main ?? project.files.find((f) => f.endsWith(".tex")) ?? project.files[0];
  if (first) await openFile(first);
  if (project.main) await runCompile();
  else setStatus("No file with \\documentclass found", true);
}

async function openFile(file: string, line?: number, column?: number) {
  if (!project) return;
  await ensureLoaded(file);
  if (editor.file !== file) editor.show(file);
  ui.file.value = file;
  showProblemsInEditor();
  updateMarkers();
  if (line) editor.goTo(line, column);
}

/** Loads a file into the editor with its suggestions and comments. */
async function ensureLoaded(file: string) {
  if (!project || editor.has(file)) return;
  const text = await api.readText(project.root, file);
  if (editor.has(file)) return;
  editor.load(file, text);
  const stored = sidecar.files[file] ?? [];
  if (stored.length) {
    const { placed, lost } = reanchor(text, stored);
    editor.setMarks(file, placed);
    lostMarks.set(file, stored.filter((s) => lost.some((m) => m.id === s.id)));
    renderSuggestions();
  }
}

// Suggestions and comments (.tuhi/suggestions.json)

const SIDECAR = ".tuhi/suggestions.json";
type Stored = Mark & { quote: string; before: string };
let sidecar: { version: 1; files: Record<string, Stored[]> } = { version: 1, files: {} };
/** Marks whose text vanished from a loaded file; kept so nothing is silently dropped. */
const lostMarks = new Map<string, Stored[]>();
let sidecarTimer = 0;

async function loadSidecar(root: string) {
  sidecar = { version: 1, files: {} };
  lostMarks.clear();
  try {
    const parsed = JSON.parse(await api.readText(root, SIDECAR));
    if (parsed && typeof parsed.files === "object") sidecar = { version: 1, files: parsed.files };
  } catch {}
}

function marksChanged() {
  renderSuggestions();
  clearTimeout(sidecarTimer);
  sidecarTimer = window.setTimeout(() => {
    sidecarTimer = 0;
    void saveSidecar();
  }, 800);
}

async function saveSidecar() {
  if (!project) return;
  const files: Record<string, Stored[]> = {};
  const names = new Set([...Object.keys(sidecar.files), ...project.files.filter((f) => editor.has(f))]);
  for (const file of names) {
    const entries = editor.has(file)
      ? [...editor.marks(file).map((m) => withContext(editor.text(file), m)), ...(lostMarks.get(file) ?? [])]
      : (sidecar.files[file] ?? []);
    if (entries.length) files[file] = entries;
  }
  const had = Object.keys(sidecar.files).length > 0;
  sidecar = { version: 1, files };
  if (!had && !Object.keys(files).length) return;
  await api.writeText(project.root, SIDECAR, JSON.stringify(sidecar, null, 2) + "\n").catch(report);
}

function suggestionEntries(): Entry[] {
  if (!project) return [];
  const out: Entry[] = [];
  const names = new Set([...Object.keys(sidecar.files), ...project.files.filter((f) => editor.has(f))]);
  for (const file of names) {
    if (editor.has(file)) {
      const text = editor.text(file);
      for (const mark of editor.marks(file)) {
        out.push({ file, mark, text: text.slice(mark.from, mark.to), line: text.slice(0, mark.from).split("\n").length, lost: false });
      }
      for (const { quote, before: _before, ...mark } of lostMarks.get(file) ?? []) out.push({ file, mark, text: quote, line: 0, lost: true });
    } else {
      // Not opened yet: show what was stored; opening the file places them.
      for (const { quote, before: _before, ...mark } of sidecar.files[file] ?? []) {
        out.push({ file, mark, text: quote, line: 0, lost: false });
      }
    }
  }
  return out;
}

function renderSuggestions() {
  suggestionsPanel.render();
  const entries = suggestionEntries();
  const open = entries.filter((e) => e.mark.kind === "suggestion" || !e.mark.resolved).length;
  ui.suggestionCount.textContent = open ? String(open) : "";
}

function setSuggesting(on: boolean) {
  editor.setSuggestingMode(on);
  ui.suggesting.textContent = on ? "✎ Suggesting" : "Editing";
  ui.suggesting.classList.toggle("on", on);
  suggestionsPanel.render();
  setStatus(on ? "Suggesting: your edits become suggestions" : "Editing: your edits change the text");
}

/** Makes sure a file is open in the editor (so its marks are live) before acting on them. */
async function withFile(entry: Entry, act: () => void) {
  await ensureLoaded(entry.file);
  act();
}

const suggestionsPanel = new SuggestionsPanel(ui.suggestions, {
  entries: () => suggestionEntries(),
  selection: () => editor.selection(),
  jump: (entry) =>
    void withFile(entry, async () => {
      await openFile(entry.file);
      const mark = editor.marks(entry.file).find((m) => m.id === entry.mark.id);
      if (mark) editor.select(mark.from, mark.to);
    }).catch(report),
  accept: (entries) => {
    for (const entry of entries) void withFile(entry, () => editor.accept(entry.file, entry.mark.id));
    if (entries.length > 1) setStatus(`Accepted ${entries.length} suggestions · ⌘S to save`);
  },
  reject: (entries) => {
    for (const entry of entries) {
      if (entry.lost) {
        lostMarks.set(entry.file, (lostMarks.get(entry.file) ?? []).filter((m) => m.id !== entry.mark.id));
        marksChanged();
      } else void withFile(entry, () => editor.removeMark(entry.file, entry.mark.id));
    }
  },
  reply: (entry, text) =>
    void withFile(entry, () =>
      editor.updateMark(entry.file, entry.mark.id, { thread: [...(entry.mark.thread ?? []), { author: "you", text, date: stamp() }] }),
    ),
  resolve: (entry, resolved) => void withFile(entry, () => editor.updateMark(entry.file, entry.mark.id, { resolved })),
  comment: (text) => {
    const sel = editor.selection();
    if (!sel || sel.from === sel.to) return;
    const created = stamp();
    editor.addMarks(sel.file, [
      { id: newId(), kind: "comment", from: sel.from, to: sel.to, insert: "", author: "you", created, thread: [{ author: "you", text, date: created }] },
    ]);
  },
  askClaude: (instruction) => askClaude(instruction),
  setSuggesting: (on) => setSuggesting(on),
  suggesting: () => editor.isSuggesting(),
});

const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

/** Claude suggests edits to the selection; each becomes a suggestion to accept or reject. */
async function askClaude(instruction: string) {
  const sel = editor.selection();
  if (!project || !sel || !sel.text.trim()) return;
  const root = project.root;
  setStatus("Claude is reading the selection…");
  try {
    const text = editor.text(sel.file);
    const result = await api.suggestEdits(root, sel.file, sel.text, text.slice(Math.max(0, sel.from - 1500), sel.from), text.slice(sel.to, sel.to + 800), instruction);
    if (project?.root !== root) return;
    // The text may have moved while Claude worked: find the passage again, nearest first.
    const now = editor.text(sel.file);
    let start = -1;
    for (let i = now.indexOf(sel.text); i !== -1; i = now.indexOf(sel.text, i + 1)) {
      if (start === -1 || Math.abs(i - sel.from) < Math.abs(start - sel.from)) start = i;
    }
    if (start === -1) throw new Error("The selected text changed while Claude was reading it");
    const taken = editor.marks(sel.file).filter((m) => m.kind === "suggestion");
    const marks: Mark[] = [];
    let missed = 0;
    for (const edit of result.edits) {
      const at = sel.text.indexOf(edit.find);
      const from = start + at;
      const to = from + edit.find.length;
      const clash = [...taken, ...marks].some((m) => m.from < to && m.to > from);
      if (at === -1 || clash) {
        missed++;
        continue;
      }
      marks.push({ id: newId(), kind: "suggestion", from, to, insert: edit.replace, author: "claude", created: stamp(), note: edit.why });
    }
    if (marks.length) editor.addMarks(sel.file, marks);
    showSide("suggestions");
    const cost = ` · $${result.cost_usd.toFixed(2)}`;
    setStatus(
      marks.length
        ? `Claude suggested ${marks.length} edit(s)${missed ? ` (${missed} didn't match the text)` : ""}${cost}`
        : `${result.summary || "Claude suggested no edits"}${cost}`,
    );
  } catch (error) {
    report(error);
  }
}

// Checks (.tuhi/settings.json)

const SETTINGS = ".tuhi/settings.json";
let settings: Settings = { ...DEFAULT_SETTINGS };
let checksRun = 0;

async function loadSettings(root: string) {
  settings = { ...DEFAULT_SETTINGS };
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await api.readText(root, SETTINGS)) };
  } catch {}
  checksPanel.setSettings(settings);
}

const checksPanel = new ChecksPanel(ui.checks, {
  jump: (file, line) => void openFile(file, line).catch(report),
  fix: (findings) => void applyFixes(findings),
  saveSettings: (next) => {
    settings = next;
    if (project) void api.writeText(project.root, SETTINGS, JSON.stringify(settings, null, 2) + "\n").catch(report);
    void runChecks();
    if (!ui.outline.hidden) void refreshOutline(true);
  },
  rerun: () => void runChecks(),
});

/** Runs the checklist and consistency lint over the editor's text (saved or not). */
async function runChecks() {
  if (!project?.main) return;
  const { root, main, files } = project;
  const run = ++checksRun;
  const texts = new Map<string, string>();
  await Promise.all(
    files
      .filter((f) => f.endsWith(".tex"))
      .map(async (f) => texts.set(f, editor.has(f) ? editor.text(f) : await api.readText(root, f).catch(() => "")))
  );
  const found = lint(main, texts);
  const items = checklist({
    main,
    texts,
    settings,
    pages: preview.pageCount(),
    referencesPage: await preview.referencesPage().catch(() => null),
    issues: compileIssues,
    lint: found,
  });
  if (run !== checksRun || project?.root !== root) return;
  checksPanel.set(items, found);
  const failing = items.filter((i) => i.status === "fail" || i.status === "warn").length;
  ui.checkCount.textContent = failing ? String(failing) : "";
  lintIssues = found
    .filter((f) => f.severity !== "info" || f.fix)
    .map((f) => ({ severity: f.severity === "error" ? "warning" : f.severity, file: f.file, line: f.line, message: `${f.group}: ${f.message}`, fix: f.fix }));
  showIssues(compileIssues, compileLog);
}

// Outline and section budgets

let outlineRun = 0;

const outlinePanel = new OutlinePanel(ui.outline, {
  jump: (file, line) => void openFile(file, line).catch(report),
  setBudget: (key, budget) => {
    const budgets = { ...settings.budgets };
    if (budget.words || budget.pages) budgets[key] = budget;
    else delete budgets[key];
    settings = { ...settings, budgets };
    if (project) void api.writeText(project.root, SETTINGS, JSON.stringify(settings, null, 2) + "\n").catch(report);
    void refreshOutline(false);
  },
  refresh: () => void refreshOutline(true),
});

/** Counts words per section; with `measure`, also each section's pages in the last PDF (SyncTeX). */
async function refreshOutline(measure: boolean) {
  if (!project?.main) return;
  const { root, main, files } = project;
  const run = ++outlineRun;
  const texts = new Map<string, string>();
  await Promise.all(
    files
      .filter((f) => f.endsWith(".tex"))
      .map(async (f) => texts.set(f, editor.has(f) ? editor.text(f) : await api.readText(root, f).catch(() => ""))),
  );
  const result = outline(main, texts);
  const total = preview.pageCount();
  const height = measure ? await preview.pageHeight() : null;
  if (height && total) {
    // Where each heading starts in the PDF, as a page number with a fraction.
    const at = async (file: string, line: number) => {
      for (const l of [line, line + 1]) {
        const boxes = await api.synctexForward(root, main, file, l, 1).catch(() => []);
        if (boxes.length) return boxes[0].page - 1 + Math.max(0, boxes[0].y) / height;
      }
      return null;
    };
    const starts: (number | null)[] = [];
    for (const s of result.sections) starts.push(await at(s.file, s.line));
    const end = result.end ? ((await at(result.end.file, result.end.line)) ?? total) : total;
    result.sections.forEach((s, i) => {
      const start = starts[i];
      if (start === null) return;
      // Ends where the next section at the same or a higher level starts.
      let j = i + 1;
      while (j < result.sections.length && result.sections[j].level > s.level && s.level > 0) j++;
      const next = j < result.sections.length ? starts[j] : end;
      if (next !== null && next >= start) s.pages = next - start;
    });
    lastPages = new Map(result.sections.map((s) => [`${s.file}:${s.title}`, s.pages]));
  } else {
    // Without a fresh measurement, keep the last one.
    for (const s of result.sections) s.pages = lastPages.get(`${s.file}:${s.title}`);
  }
  if (run !== outlineRun || project?.root !== root) return;
  outlinePanel.set(result, settings.budgets, total);
}
let lastPages = new Map<string, number | undefined>();

/** Applies lint fixes in the editor (⌘S to save), then checks again. */
async function applyFixes(findings: Finding[]) {
  let applied = 0;
  // Bottom of each file first, so earlier fixes don't move later lines.
  for (const f of [...findings].sort((a, b) => a.file.localeCompare(b.file) || b.line - a.line)) {
    if (!f.fix) continue;
    await ensureLoaded(f.file);
    if (editor.replace(f.file, f.fix.find, f.fix.replace, f.line) !== null) applied++;
  }
  if (findings.length === 1 && findings[0].line) await openFile(findings[0].file, findings[0].line);
  setStatus(`Fixed ${applied} of ${findings.length} · ⌘S to save`, applied < findings.length);
  await runChecks();
}

// Versions

const versionsPanel = new VersionsPanel(ui.versions, {
  status: (text, error) => setStatus(text, error),
  saveAll: async () => {
    if (!(await saveDirty())) throw new Error("Couldn't save your changes");
  },
  diff: async (oldRev, newRev) => {
    if (!project?.main) return;
    setStatus(`Running latexdiff ${oldRev} → ${newRev ?? "current text"}…`);
    try {
      const result = await api.makeDiff(project.root, project.main, oldRev, newRev);
      if (!result.pdf) {
        const error = result.issues.find((i) => i.severity === "error");
        throw new Error(`The diff didn't compile${error ? `: ${error.message}` : ""}`);
      }
      await api.openPath(result.pdf);
      setStatus("Diff PDF opened");
    } catch (error) {
      report(error);
    }
  },
});

// Compile errors explained

function explainRow(issue: api.Issue): HTMLElement {
  const box = document.createElement("div");
  box.className = "explain";
  const known = explain(issue.message);
  if (known) {
    const p = document.createElement("p");
    p.textContent = known;
    box.append(p);
  }
  const ask = document.createElement("button");
  ask.textContent = known ? "Ask Claude for the fix" : "Ask Claude what's wrong";
  ask.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!project) return;
    ask.disabled = true;
    ask.textContent = "Claude is reading the log…";
    try {
      const file = issue.file ?? (issue.line ? project.main : null);
      const result = await api.explainError(project.root, issue.message, file, issue.line, compileLog);
      const p = document.createElement("p");
      p.textContent = `${result.explanation} ($${result.cost_usd.toFixed(2)})`;
      ask.replaceWith(p);
      if (result.fix) {
        const fix = result.fix;
        const diff = document.createElement("pre");
        diff.className = "explain-fix";
        diff.textContent = `${fix.file}:${fix.line}\n− ${fix.before}\n+ ${fix.after}`;
        const apply = document.createElement("button");
        apply.className = "primary";
        apply.textContent = "Apply fix";
        apply.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await ensureLoaded(fix.file);
          const line = editor.replace(fix.file, fix.before, fix.after, fix.line);
          if (line === null) return setStatus("The source changed; the fix no longer matches", true);
          await openFile(fix.file, line);
          apply.disabled = true;
          apply.textContent = "Applied · ⌘S to save and compile";
        });
        box.append(diff, apply);
      }
    } catch (error) {
      ask.disabled = false;
      ask.textContent = "Ask Claude again";
      report(error);
    }
  });
  box.append(ask);
  box.addEventListener("click", (e) => e.stopPropagation());
  return box;
}

// Compiling

async function saveDirty(): Promise<boolean> {
  if (!project) return false;
  try {
    for (const file of editor.dirtyFiles()) {
      const text = editor.text(file);
      await api.writeText(project.root, file, text);
      editor.markSaved(file, text);
    }
    ui.dirty.hidden = true;
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

async function saveAndCompile() {
  if (await saveDirty()) await runCompile();
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
    void refreshProvenance();
    void refreshCitations(true);
    void claimsPanel.reload();
    void runChecks();
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

// Provenance (taura)

let provenanceRun = 0;

async function refreshProvenance() {
  if (!project) return;
  const root = project.root;
  const run = ++provenanceRun;
  if (!taura) provenancePanel.set(null, true);
  const next = await api.tauraReport(root).catch(() => null);
  if (run !== provenanceRun || project?.root !== root) return;
  taura = next;
  provenancePanel.set(taura, false);
  updateMarkers();
}

function updateMarkers() {
  if (!editor.file) return;
  editor.setMarkers(taura && editor.file.endsWith(".tex") ? markersFor(editor.file, editor.text(editor.file), taura) : []);
}

const popover = document.createElement("div");
popover.className = "popover";
popover.hidden = true;
document.body.append(popover);
document.addEventListener("mousedown", (e) => {
  if (!popover.hidden && !popover.contains(e.target as Node)) popover.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") popover.hidden = true;
});

async function showProvenance(marker: Marker, x: number, y: number) {
  if (!project) return;
  const notes = document.createElement("ul");
  notes.className = "popover-notes";
  for (const note of marker.notes) {
    const li = document.createElement("li");
    li.textContent = note;
    notes.append(li);
  }
  popover.replaceChildren(notes);
  popover.style.left = `${Math.min(x + 12, window.innerWidth - 440)}px`;
  popover.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
  popover.hidden = false;
  const root = project.root;
  for (const target of marker.targets.slice(0, 4)) {
    const trace = await api.tauraTrace(root, target).catch((e) => ({ items: [{ kind: "error", key: String(e) }] }));
    if (popover.hidden) return;
    popover.append(renderTrace(trace));
  }
}

// Citations (the .bib and ruru)

let citationRun = 0;

/** Reloads the .bib entries and ruru library; after a compile also runs `ruru check`. */
async function refreshCitations(check: boolean) {
  if (!project) return;
  const { root, main, files } = project;
  const run = ++citationRun;
  const [library, report] = await Promise.all([
    api.citationLibrary(root, files).catch(() => null),
    check && main ? api.ruruCheck(root, main).catch(() => null) : Promise.resolve(undefined),
  ]);
  if (run !== citationRun || project?.root !== root) return;
  citations.set(library, main ? `${root}/${main}` : root);
  editor.relint();
  if (report !== undefined) {
    citeIssues = report && library ? checkIssues(report, library) : [];
    showIssues(compileIssues, compileLog);
  }
}

/**
 * `ruru check` findings for the Problems panel. Missing keys are left to the editor, which
 * marks them where they're cited; these are the bib-side ones.
 */
function checkIssues(report: api.RuruCheck, library: api.CitationLibrary): api.Issue[] {
  const entry = (key: string) => library.bib.find((e) => e.key === key);
  const at = (key: string, severity: api.Issue["severity"], message: string): api.Issue => {
    const e = entry(key);
    return { severity, file: e?.file ?? null, line: e?.line ?? null, message };
  };
  const fix = citations.fixCommand();
  const { issues: found } = report;
  return [
    ...(found.stale ?? []).map((k) => at(k, "warning", `${k}: the .bib entry differs from your ruru library. To regenerate it: ${fix}`)),
    ...(found.duplicates ?? []).map((keys) => at(keys[0], "warning", `${keys.join(" and ")} are the same paper under two keys`)),
    ...(found.unused ?? []).map((k) => at(k, "info", `${k} is in ruru's part of the .bib but never cited`)),
    ...report.warnings.map((w): api.Issue => ({ severity: "info", file: null, line: null, message: `ruru: ${w}` })),
  ];
}

// Claims (ruru verdicts)

/** ruru gives claim files relative to the main file's folder. */
function fromMainDir(file: string) {
  const dir = project?.main?.includes("/") ? project.main.slice(0, project.main.lastIndexOf("/") + 1) : "";
  return dir + file;
}

function weakClaims(doc: api.ClaimsDocument): api.Issue[] {
  const out: api.Issue[] = [];
  for (const claim of doc.claims) {
    for (const check of claim.checks) {
      if (!["partial", "unsupported", "not-found"].includes(check.state)) continue;
      const note = check.verdict?.note ? `: ${check.verdict.note}` : "";
      out.push({
        severity: "warning",
        file: fromMainDir(claim.file),
        line: claim.line,
        message: `Claim check: ${check.key} is ${check.state.replace("-", " ")}${note}`,
      });
    }
  }
  return out;
}

// Problems panel

function showIssues(next: api.Issue[], log: string) {
  compileIssues = next;
  compileLog = log;
  issues = [...next, ...citeIssues, ...claimIssues, ...lintIssues];
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
      if (issue.severity === "error" && !issue.message.startsWith("BibTeX") && compileIssues.includes(issue)) {
        const why = document.createElement("button");
        why.className = "problem-action";
        why.textContent = "Explain";
        why.addEventListener("click", (e) => {
          e.stopPropagation();
          const open = li.querySelector(".explain");
          if (open) open.remove();
          else li.append(explainRow(issue));
        });
        li.append(why);
      }
      if (issue.fix && issue.file && issue.line) {
        const fix = document.createElement("button");
        fix.className = "problem-action";
        fix.textContent = `Fix: ${issue.fix.replace}`;
        fix.addEventListener("click", (e) => {
          e.stopPropagation();
          void applyFixes([{ file: issue.file!, line: issue.line!, severity: issue.severity, group: "", message: issue.message, fix: issue.fix }]);
        });
        li.append(fix);
      }
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
      .map((i) => ({ line: i.line!, severity: i.severity, message: i.message, fix: i.fix })),
  );
}

function selectTab(log: boolean) {
  ui.tabProblems.classList.toggle("active", !log);
  ui.tabLog.classList.toggle("active", log);
  ui.problemList.hidden = log;
  ui.log.hidden = !log;
  ui.problems.classList.remove("collapsed");
}

type Side = "pdf" | "review" | "provenance" | "claims" | "suggestions" | "checks" | "outline" | "versions";

function showSide(side: Side) {
  ui.tabPdf.classList.toggle("active", side === "pdf");
  ui.tabReview.classList.toggle("active", side === "review");
  ui.tabProvenance.classList.toggle("active", side === "provenance");
  ui.preview.hidden = side !== "pdf";
  ui.review.hidden = side !== "review";
  ui.provenance.hidden = side !== "provenance";
  ui.tabClaims.classList.toggle("active", side === "claims");
  ui.claims.hidden = side !== "claims";
  ui.tabSuggestions.classList.toggle("active", side === "suggestions");
  ui.suggestions.hidden = side !== "suggestions";
  ui.tabChecks.classList.toggle("active", side === "checks");
  ui.checks.hidden = side !== "checks";
  ui.tabOutline.classList.toggle("active", side === "outline");
  ui.outline.hidden = side !== "outline";
  ui.tabVersions.classList.toggle("active", side === "versions");
  ui.versions.hidden = side !== "versions";
}

// Wiring

ui.tabPdf.addEventListener("click", () => showSide("pdf"));
ui.tabReview.addEventListener("click", () => showSide("review"));
ui.tabProvenance.addEventListener("click", () => showSide("provenance"));
ui.tabClaims.addEventListener("click", () => showSide("claims"));
ui.tabSuggestions.addEventListener("click", () => showSide("suggestions"));
ui.tabOutline.addEventListener("click", () => {
  showSide("outline");
  void refreshOutline(true);
});
ui.tabVersions.addEventListener("click", () => {
  showSide("versions");
  void versionsPanel.reload();
});
ui.tabChecks.addEventListener("click", () => {
  showSide("checks");
  void runChecks();
});
ui.suggesting.addEventListener("click", () => setSuggesting(!editor.isSuggesting()));
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
  if (mod && event.shiftKey && event.key.toLowerCase() === "e") {
    event.preventDefault();
    setSuggesting(!editor.isSuggesting());
  } else if (mod && event.altKey && (event.code === "KeyM" || event.code === "KeyK")) {
    // ⌥ changes event.key on macOS, so match the physical key.
    event.preventDefault();
    showSide("suggestions");
    suggestionsPanel.openComposer(event.code === "KeyM" ? "comment" : "claude");
  } else if (mod && event.key === "o") {
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
