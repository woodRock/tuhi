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
