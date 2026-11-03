import { invoke } from "@tauri-apps/api/core";

export interface Project {
  root: string;
  name: string;
  main: string | null;
  files: string[];
}

export interface Issue {
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
  /** Consistency lint only: replaces the first `find` on the line. */
  fix?: { find: string; replace: string };
}

export interface CompileResult {
  ok: boolean;
  pdf: string | null;
  engine: string;
  millis: number;
  issues: Issue[];
  log: string;
}

/** A box on a PDF page, in points from the top-left corner. */
export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export const openProject = (path: string) => invoke<Project>("open_project", { path });

export const watchProject = (root: string) => invoke<void>("watch_project", { root });
export const readText = (root: string, file: string) => invoke<string>("read_text", { root, file });

export const writeText = (root: string, file: string, contents: string) =>
  invoke<void>("write_text", { root, file, contents });

export const compile = (root: string, main: string) => invoke<CompileResult>("compile", { root, main });

export const readPdf = (root: string, main: string) => invoke<ArrayBuffer>("read_pdf", { root, main });

export const synctexForward = (root: string, main: string, file: string, line: number, column: number) =>
  invoke<PdfBox[]>("synctex_forward", { root, main, file, line, column });

export const synctexInverse = (root: string, main: string, page: number, x: number, y: number) =>
  invoke<SourceLocation | null>("synctex_inverse", { root, main, page, x, y });

export interface PastedComment {
  group: string | null;
  text: string;
  quote: string | null;
}

export interface Located {
  file: string;
  line: number;
  /**
   * "text" when the quote was found in the source, "position" when only SyncTeX placed it,
   * "manual" when placed by hand.
   */
  method: "text" | "position" | "manual";
  score: number;
}

export interface LocateQuery {
  quote?: string | null;
  page?: number;
  x?: number;
  y?: number;
}

export const listReviews = <T>(root: string) => invoke<T[]>("list_reviews", { root });

export const saveReview = (root: string, review: unknown) => invoke<void>("save_review", { root, review });

export const importReviewPdf = (root: string, id: string, source: string) =>
  invoke<string>("import_review_pdf", { root, id, source });

export const readBytes = (root: string, file: string) => invoke<ArrayBuffer>("read_bytes", { root, file });

export const splitComments = (letter: string) => invoke<PastedComment[]>("split_comments", { letter });

export const locateComments = (root: string, main: string, queries: LocateQuery[]) =>
  invoke<(Located | null)[]>("locate_comments", { root, main, queries });

export interface Hunk {
  file: string;
  /** 1-based line where `before` started when drafted. */
  line: number;
  before: string;
  after: string;
  why: string;
  state: "pending" | "accepted" | "rejected" | "stale";
}

export interface Proposal {
  summary: string;
  hunks: Hunk[];
  /** Edits Claude suggested whose text wasn't found in the source. */
  unmatched: string[];
  response: string;
  author_input: string;
  cost_usd: number;
}

/** Runs one Claude session for the card; takes tens of seconds. */
export const draftChange = (root: string, card: unknown) => invoke<Proposal>("draft_change", { root, card });

export interface Revision {
  rev: string;
  date: string;
  subject: string;
  refs: string;
}

/** Writes response/<round>.tex and returns its root-relative path. */
export const writeLetter = (root: string, main: string, review: unknown) =>
  invoke<string>("write_letter", { root, main, review });

export interface EditProblem {
  card: string;
  file: string;
  line: number | null;
  /** Sentences of the edit no longer in the text; all of it when `gone`. */
  missing: string[];
  gone: boolean;
}

/** Accepted edits partly or wholly gone from the text; reworded or rewritten-again ones are fine. */
export const reviewEditProblems = (root: string, review: unknown, sources: Record<string, string>) =>
  invoke<EditProblem[]>("review_edit_problems", { root, review, sources });

export const gitRevisions = (root: string) => invoke<Revision[]>("git_revisions", { root });

/** latexdiff of `rev` against the working tree, compiled to PDF. */
/** latexdiff from `rev` to `newRev`, or to the current files when that's omitted. */
export const makeDiff = (root: string, main: string, rev: string, newRev: string | null = null) =>
  invoke<CompileResult>("make_diff", { root, main, rev, newRev });

export const openPath = (path: string) => invoke<void>("open_path", { path });

export interface TauraFinding {
  id: string;
  severity: "error" | "warn";
  repo: "paper" | "code";
  /** "file.tex:LINE" for paper findings; an artifact or ledger path for code findings. */
  location: string;
  message: string;
  fix: string;
}

export interface TauraChange {
  artifact: string;
  change: string;
  /** e.g. "\res{mba/f1/mean}" or "row MBA col F1". */
  what: string;
  old: string | null;
  new: string | null;
  text: string;
}

export interface TauraArtifact {
  name: string;
  kind: string;
  output: string;
}

export interface TauraReport {
  status: { code?: string; last_publish?: string; published_commit?: string; [k: string]: unknown };
  findings: TauraFinding[];
  changes: TauraChange[];
  artifacts: TauraArtifact[];
}

/** null when taura isn't installed or the paper has no paired code repo. */
export const tauraReport = (root: string) => invoke<TauraReport | null>("taura_report", { root });

/** `taura trace` for a \res key, an artifact name or file.tex:LINE. */
export const tauraTrace = (root: string, target: string) => invoke<Record<string, any>>("taura_trace", { root, target });

export interface BibEntry {
  key: string;
  /** Root-relative .bib file. */
  file: string;
  line: number;
  title: string;
  author: string;
  year: string;
}

export interface RuruPaper {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  status: string;
  tags: string[];
  /** Kept for this paper's ruru project. */
  in_project: boolean;
}

export interface CitationLibrary {
  bib: BibEntry[];
  /** Whether ruru is installed. */
  ruru: boolean;
  /** The ruru project this folder belongs to. */
  project: string | null;
  papers: RuruPaper[];
}

/** `ruru check --json`; see ruru's docs/json.md. */
export interface RuruCheck {
  project: string | null;
  bib: string | null;
  cited: number;
  issues: {
    missing?: { key: string; in_library: boolean }[];
    unused?: string[];
    kept_unused?: string[];
    stale?: string[];
    duplicates?: string[][];
  };
  warnings: string[];
}

export const citationLibrary = (root: string, files: string[]) => invoke<CitationLibrary>("citation_library", { root, files });

/** `ruru show KEY --json`: the paper with abstract, notes and agent_notes. */
export const ruruShow = (key: string) => invoke<Record<string, any>>("ruru_show", { key });

/** null when ruru isn't installed. */
export const ruruCheck = (root: string, main: string) => invoke<RuruCheck | null>("ruru_check", { root, main });

export type ClaimState = "supported" | "partial" | "unsupported" | "not-found" | "background" | "unchecked" | "outdated";

/** One cited key in a claim, from `ruru claims --json`. */
export interface ClaimCheck {
  key: string;
  title: string | null;
  in_library: boolean;
  has_pdf: boolean;
  own: boolean;
  /** paper | draft | software, or null when ruru knows nothing about the key. */
  kind: "paper" | "draft" | "software" | null;
  state: ClaimState;
  verdict: { verdict: string; source: string; page: string | null; quote: string | null; note: string | null; by: string | null; date: string } | null;
}

export interface Claim {
  id: string;
  /** Relative to the main .tex file's folder. */
  file: string;
  line: number;
  keys: string[];
  /** The sentence, with cites written [@key]. */
  text: string;
  checks: ClaimCheck[];
}

export interface ClaimsDocument {
  project: string;
  claims: Claim[];
  /** Verdicts on sentences that have since been reworded. */
  stale: unknown[];
}

export interface ProposedVerdict {
  claim: string;
  verdict: string;
  page: string;
  quote: string;
  note: string;
  /** The quote is in the text Claude read; ruru refuses quotes it can't find in the PDF. */
  quote_found: boolean;
}

export interface Judgement {
  key: string;
  /** pdf | abstract | draft | software: what the verdicts rest on. */
  from: string;
  verdicts: ProposedVerdict[];
  cost_usd: number;
}

/** null when the folder isn't a ruru project. */
export const claimsList = (root: string) => invoke<ClaimsDocument | null>("claims_list", { root });

/** Claude's verdicts on the claims citing `key` (all of them when `claims` is empty). */
export const claimsJudge = (root: string, key: string, claims: string[]) => invoke<Judgement>("claims_judge", { root, key, claims });

/** `ruru verdict … --by claude`: one commit in the library. */
export const claimsRecord = (root: string, key: string, from: string, verdict: ProposedVerdict) =>
  invoke<string>("claims_record", { root, key, from, verdict });

export interface SuggestedEdit {
  /** Verbatim text from the selected passage. */
  find: string;
  replace: string;
  why: string;
}

/** Claude's edits to a selected passage; `before`/`after` are context it mustn't edit. */
export const suggestEdits = (root: string, file: string, passage: string, before: string, after: string, instruction: string) =>
  invoke<{ summary: string; edits: SuggestedEdit[]; cost_usd: number }>("suggest_edits", { root, file, passage, before, after, instruction });

export interface ErrorExplanation {
  explanation: string;
  /** A source edit that fixes it; `before` is the exact text it replaces. */
  fix: { file: string; line: number; before: string; after: string } | null;
  cost_usd: number;
}

export const explainError = (root: string, message: string, file: string | null, line: number | null, log: string) =>
  invoke<ErrorExplanation>("explain_error", { root, message, file, line, log });

export interface Snapshot {
  /** The tag is `tuhi/<id>`. */
  id: string;
  name: string;
  date: string;
  commit: string;
}

export interface FileChange {
  file: string;
  /** null for binary files. */
  added: number | null;
  removed: number | null;
}

export const snapshotsList = (root: string) => invoke<Snapshot[]>("snapshots_list", { root });
export const snapshotCreate = (root: string, name: string) => invoke<Snapshot>("snapshot_create", { root, name });
export const snapshotDelete = (root: string, id: string) => invoke<void>("snapshot_delete", { root, id });
/** `newRev` null: compare with the current files. */
export const versionChanges = (root: string, old: string, newRev: string | null) =>
  invoke<FileChange[]>("version_changes", { root, old, new: newRev });

export interface MenuState {
  /** Labels for File ▸ Open Recent; clicking one sends `recent:<index>`. */
  recent: string[];
  project: boolean;
  pdf: boolean;
  suggesting: boolean;
  sidebar: boolean;
  problems: boolean;
}

export const setMenuState = (state: MenuState) => invoke<void>("set_menu_state", { state });

/** Copies the last compiled PDF to `to`. */
export const exportPdf = (root: string, main: string, to: string) => invoke<void>("export_pdf", { root, main, to });

/** Zips the sources and compiled .bbl for submission; returns how many files went in. */
export const exportSource = (root: string, main: string, to: string) => invoke<number>("export_source", { root, main, to });

export interface GitChange {
  path: string;
  /** The old path of a rename. */
  orig: string | null;
  /** M modified, A added, D deleted, R renamed, ? new, U conflicted. */
  kind: string;
}

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote: boolean;
  files: GitChange[];
}

/** `fetch` first asks the remote what's new (slow; failures are ignored). */
export const gitStatus = (root: string, fetch: boolean) => invoke<GitStatus>("git_status", { root, fetch });
export const gitDiff = (root: string, path: string) => invoke<string>("git_diff", { root, path });
/** Commits exactly `paths`; returns the new commit's short hash. */
export const gitCommit = (root: string, message: string, paths: string[]) => invoke<string>("git_commit", { root, message, paths });
export const gitPull = (root: string) => invoke<string>("git_pull", { root });
export const gitPush = (root: string) => invoke<string>("git_push", { root });

export interface SetupTool {
  name: string;
  found: boolean;
  version: string | null;
  /** tuhi can install it without a password. */
  installable: boolean;
  about: string;
  /** How to install it in a terminal, when tuhi can't. */
  command: string | null;
}

export interface SetupStatus {
  tools: SetupTool[];
  library: { path: string; exists: boolean };
  paper_root: string;
  code_root: string;
}

export interface NewPaper {
  name: string;
  source: "template" | "clone";
  url?: string;
  template?: "article" | "ieee";
  title?: string;
  /** Add taura's preamble lines to the template. */
  taura: boolean;
}

export const setupStatus = () => invoke<SetupStatus>("setup_status");
export const setupInstall = (name: string) => invoke<string>("setup_install", { name });
export const setupInitLibrary = (path: string, email: string) => invoke<string>("setup_init_library", { path, email });
/** Creates the paper under the paper root; returns its folder. */
export const newPaper = (paper: NewPaper) => invoke<string>("new_paper", { paper });
export const linkRuru = (name: string, dir: string) => invoke<string>("link_ruru", { name, dir });
/** `code` null pairs with (creating if needed) the code repo of the same name. */
export const pairTaura = (paper: string, code: string | null) => invoke<{ code: string; instructions: string | null }>("pair_taura", { paper, code });

export interface Roots {
  paper_root: string;
  code_root: string;
  /** "config" (set with taura config), "env" or "default". */
  paper_from: string;
  code_from: string;
  /** taura is installed, so the folders can be changed. */
  taura: boolean;
}

export const rootsGet = () => invoke<Roots>("roots_get");
/** `folder` null goes back to the default. */
export const rootsSet = (key: "paper_root" | "code_root", folder: string | null) => invoke<Roots>("roots_set", { key, folder });
