import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView, Tooltip } from "@codemirror/view";
import type { BibEntry, CitationLibrary, RuruPaper } from "./api";

/** A key inside a \cite-like command, with its document offsets. */
export interface CiteKey {
  key: string;
  from: number;
  to: number;
}

// \cite, \citep, \citet, \parencite, \textcite, \autocite, \nocite, … with up to two optional
// arguments, then the key list. \citestyle and friends take no keys.
const CITE = /\\([A-Za-z]*cite[A-Za-z]*)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
const NOT_CITES = new Set(["citestyle", "citeindexfalse", "citeindextrue"]);

/** Every cited key in `text`, skipping comments. */
export function citedKeys(text: string): CiteKey[] {
  const out: CiteKey[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const comment = raw.search(/(?<!\\)%/);
    const line = comment === -1 ? raw : raw.slice(0, comment);
    for (const m of line.matchAll(CITE)) {
      if (NOT_CITES.has(m[1])) continue;
      let at = offset + m.index! + m[0].length - 1 - m[2].length;
      for (const part of m[2].split(",")) {
        const key = part.trim();
        const from = at + part.indexOf(key);
        if (key && key !== "*") out.push({ key, from, to: from + key.length });
        at += part.length + 1;
      }
    }
    offset += raw.length + 1;
  }
  return out;
}

/** Keys defined by \bibitem in a hand-written thebibliography. */
const bibitems = (text: string) => new Set([...text.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((m) => m[1].trim()));

const surname = (name: string) => (name.includes(",") ? name.split(",")[0] : name.split(/\s+/).at(-1) ?? name).trim();

function authorsShort(authors: string[]): string {
  if (!authors.length) return "";
  const first = surname(authors[0]);
  return authors.length === 1 ? first : authors.length === 2 ? `${first} & ${surname(authors[1])}` : `${first} et al.`;
}

const bibAuthors = (author: string) => author.split(/\s+and\s+/i).filter(Boolean);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface CitationHooks {
  /** `ruru show KEY --json`. */
  show(key: string): Promise<Record<string, any>>;
  jump(file: string, line: number): void;
}

/**
 * What the paper can cite: its .bib entries and, when ruru is installed, the library.
 * Completion, hover and the missing-key lint all read from here.
 */
export class Citations {
  private bib = new Map<string, BibEntry>();
  private papers = new Map<string, RuruPaper>();
  private shown = new Map<string, Promise<Record<string, any>>>();
  private ruru = false;
  private project: string | null = null;
  /** What `ruru check` takes for this paper: the project name, or the main file's path. */
  private target = "";

  constructor(private hooks: CitationHooks) {}

  set(library: CitationLibrary | null, mainPath: string) {
    this.bib = new Map((library?.bib ?? []).map((e) => [e.key, e]));
    this.papers = new Map((library?.papers ?? []).map((p) => [p.key, p]));
    this.ruru = library?.ruru ?? false;
    this.project = library?.project ?? null;
    this.target = this.project ?? `'${mainPath}'`;
    this.shown.clear();
  }

  /** The command that adds cited library papers to the bib. tuhi shows it; you run it. */
  fixCommand() {
    return `ruru check ${this.target} --fix`;
  }

  // Completion

  complete = (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = /\\([A-Za-z]*cite[A-Za-z]*)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)$/.exec(before);
    if (!m || NOT_CITES.has(m[1])) return null;
    const fragment = m[2].split(",").at(-1)!.trimStart();
    const query = fragment.toLowerCase();
    const options: (Completion & { rank: number })[] = [];
    const seen = new Set<string>();
    const add = (key: string, title: string, authors: string[], year: string, section: string, order: number) => {
      if (seen.has(key)) return;
      seen.add(key);
      const k = key.toLowerCase();
      const rank = !query || k.startsWith(query) ? 0 : k.includes(query) ? 1 : `${title} ${authors.join(" ")}`.toLowerCase().includes(query) ? 2 : -1;
      if (rank < 0) return;
      options.push({
        label: key,
        detail: [authorsShort(authors), year].filter(Boolean).join(" "),
        info: () => this.card(key, false),
        section: { name: section, rank: order },
        rank: order * 10 + rank,
      });
    };
    for (const e of this.bib.values()) add(e.key, e.title, bibAuthors(e.author), e.year, "In the .bib", 0);
    const papers = [...this.papers.values()];
    for (const p of papers.filter((p) => p.in_project)) add(p.key, p.title, p.authors, String(p.year ?? ""), `Kept for ${this.project}`, 1);
    for (const p of papers) add(p.key, p.title, p.authors, String(p.year ?? ""), "ruru library", 2);
    if (!options.length) return null;
    options.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    return { from: context.pos - fragment.length, options: options.slice(0, 80), filter: false };
  };

  // Hover

  hover = (view: EditorView, pos: number): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    const hit = citedKeys(line.text).find((c) => c.from + line.from <= pos && pos <= c.to + line.from);
    if (!hit) return null;
    return {
      pos: line.from + hit.from,
      end: line.from + hit.to,
      above: true,
      create: () => ({ dom: this.card(hit.key, true) }),
    };
  };

  /** A card for one key: title, authors, where it's defined, and ruru's abstract and notes. */
  private card(key: string, full: boolean): HTMLElement {
    const box = el("div", "cite-card");
    const entry = this.bib.get(key);
    const paper = this.papers.get(key);
    const title = paper?.title || entry?.title;
    box.append(el("div", "cite-key", key));
    if (title) box.append(el("div", "cite-title", title));
    const authors = paper?.authors.length ? paper.authors : bibAuthors(entry?.author ?? "");
    const byline = [authors.slice(0, 4).join(", ") + (authors.length > 4 ? ", …" : ""), paper?.year ?? entry?.year, paper?.venue]
      .filter(Boolean)
      .join(" · ");
    if (byline) box.append(el("div", "cite-meta", byline));
    if (paper) {
      const tags = [paper.status, paper.in_project ? `kept for ${this.project}` : "", ...paper.tags.map((t) => `#${t}`)];
      box.append(el("div", "cite-meta", tags.filter(Boolean).join("  ")));
    }

    if (entry) {
      const where = el("a", "cite-where", `${entry.file}:${entry.line}`);
      where.href = "#";
      where.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.hooks.jump(entry.file, entry.line);
      });
      box.append(where);
    } else if (paper) {
      box.append(this.advice("Not in the .bib yet. It's in your library; this adds every cited one:", this.fixCommand()));
    } else {
      box.append(
        this.advice(
          this.ruru ? "Not in any .bib file or your ruru library. Find it, then add it by DOI or arXiv id:" : "Not in any .bib file.",
          this.ruru ? `ruru find "${key}"` : "",
        ),
      );
    }

    if (full && paper) {
      const more = el("div", "cite-more");
      box.append(more);
      if (!this.shown.has(key)) this.shown.set(key, this.hooks.show(key));
      this.shown.get(key)!.then(
        (shown) => {
          const section = (label: string, text: unknown, limit: number) => {
            if (typeof text !== "string" || !text.trim()) return;
            const t = text.trim();
            more.append(el("div", "cite-label", label), el("p", "cite-text", t.length > limit ? `${t.slice(0, limit)}…` : t));
          };
          section("Your notes", shown.notes, 600);
          section("Abstract", shown.abstract, 700);
          section("Agent notes", shown.agent_notes, 400);
          if (shown.has_pdf === false) more.append(el("div", "cite-meta", "No PDF in the library"));
        },
        (error) => more.append(el("div", "cite-meta", String(error))),
      );
    }
    return box;
  }

  private advice(text: string, command: string): HTMLElement {
    const box = el("div", "cite-advice", text);
    if (command) {
      const row = el("div", "cite-command");
      const code = el("code", "", command);
      const copy = el("button", "", "Copy");
      copy.addEventListener("mousedown", (e) => {
        e.preventDefault();
        void navigator.clipboard.writeText(command).then(() => (copy.textContent = "Copied"));
      });
      row.append(code, copy);
      box.append(row);
    }
    return box;
  }

  // Lint

  /** Cited keys that no .bib file defines, as editor diagnostics. */
  lint(text: string): Diagnostic[] {
    // Without a .bib or a library there's nothing to check against (e.g. a paper with no references yet).
    if (!this.bib.size && !this.papers.size) return [];
    const local = bibitems(text);
    return citedKeys(text)
      .filter((c) => !this.bib.has(c.key) && !local.has(c.key))
      .map((c) => {
        const inLibrary = this.papers.has(c.key);
        return {
          from: c.from,
          to: c.to,
          severity: inLibrary ? "warning" : "error",
          source: "citations",
          message: inLibrary
            ? `${c.key} is in your ruru library but not in the .bib yet. To add it: ${this.fixCommand()}`
            : `${c.key} isn't in any .bib file${this.ruru ? " or your ruru library" : ""}.`,
        };
      });
  }
}
