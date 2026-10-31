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

export const gitRevisions = (root: string) => invoke<Revision[]>("git_revisions", { root });

/** latexdiff of `rev` against the working tree, compiled to PDF. */
export const makeDiff = (root: string, main: string, rev: string) => invoke<CompileResult>("make_diff", { root, main, rev });

export const openPath = (path: string) => invoke<void>("open_path", { path });
