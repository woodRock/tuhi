import { lineAt, lineStarts, maskProse, readingOrder, stripComments } from "./checks";

export interface Section {
  /** 0 for the abstract, 1 section, 2 subsection, 3 subsubsection. */
  level: number;
  title: string;
  /** Budgets are kept under this: the title, or "@abstract". */
  key: string;
  file: string;
  line: number;
  /** Words in this section's own text, before its first subsection. */
  own: number;
  /** Words including its subsections. */
  words: number;
  /** Filled in from the PDF afterwards. */
  pages?: number;
}

export interface Outline {
  sections: Section[];
  /** Words in the abstract and all sections (not the title block or references). */
  total: number;
  /** Where the references start, for measuring the last section's pages. */
  end: { file: string; line: number } | null;
}

// Words as a word count would see them: numbers count, hyphenated compounds are one word.
const COUNTED = /[\p{L}\p{N}­]+(?:[-'’][\p{L}\p{N}­]+)*/gu;
const HEADING = /\\(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\{/g;
const LEVEL: Record<string, number> = { section: 1, subsection: 2, subsubsection: 3 };

/** The paper's sections in reading order with their word counts. */
export function outline(main: string, texts: Map<string, string>): Outline {
  const order = readingOrder(main, texts);
  const prose = new Map<string, string>();
  const code = new Map<string, string>();
  // Tables don't count towards word budgets: blank them out, and skip files \input inside one.
  const tables = new Map<string, [number, number][]>();
  for (const seg of order) {
    if (prose.has(seg.file)) continue;
    const text = texts.get(seg.file) ?? "";
    const stripped = stripComments(text);
    const ranges: [number, number][] = [];
    for (const m of stripped.matchAll(/\\begin\{(table\*?)\}/g)) {
      const end = stripped.indexOf(`\\end{${m[1]}}`, m.index!);
      ranges.push([m.index!, end === -1 ? stripped.length : end]);
    }
    let masked = maskProse(text);
    for (const [a, b] of ranges) masked = masked.slice(0, a) + masked.slice(a, b).replace(/[^\n]/g, " ") + masked.slice(b);
    tables.set(seg.file, ranges);
    prose.set(seg.file, masked);
    code.set(seg.file, stripped);
  }
  const inTable = (file: string, at: number) => tables.get(file)?.some(([a, b]) => a <= at && at < b) ?? false;

  // Every boundary in reading order: headings, the abstract, the end of the body.
  type Mark = { kind: "heading" | "abstract" | "abstract-end" | "end"; level: number; title: string; file: string; at: number; bodyAt: number };
  const marks: (Mark & { order: number })[] = [];
  let index = 0;
  for (const seg of order) {
    const c = code.get(seg.file)!.slice(seg.from, seg.to);
    const found: Mark[] = [];
    for (const m of c.matchAll(HEADING)) {
      const start = seg.from + m.index! + m[0].length;
      let depth = 1;
      let j = start;
      const full = code.get(seg.file)!;
      for (; j < full.length && depth; j++) depth += full[j] === "{" ? 1 : full[j] === "}" ? -1 : 0;
      const title = prose.get(seg.file)!.slice(start, j - 1).replaceAll("­", "").replace(/\s+/g, " ").trim();
      found.push({ kind: "heading", level: LEVEL[m[1]], title: title || "(untitled)", file: seg.file, at: seg.from + m.index!, bodyAt: j });
    }
    for (const m of c.matchAll(/\\begin\{abstract\}|\\end\{abstract\}|\\bibliography\{|\\printbibliography|\\begin\{thebibliography\}|\\appendices\b|\\end\{document\}/g)) {
      const at = seg.from + m.index!;
      const kind = m[0] === "\\begin{abstract}" ? "abstract" : m[0] === "\\end{abstract}" ? "abstract-end" : "end";
      if (kind === "end" && m[0] === "\\appendices") continue;
      found.push({ kind, level: 0, title: "Abstract", file: seg.file, at, bodyAt: at + m[0].length });
    }
    found.sort((a, b) => a.at - b.at);
    for (const f of found) marks.push({ ...f, order: index++ });
  }

  // Words between consecutive marks, walking the segments in order.
  const countBetween = (from: { file: string; at: number; seg: number }, to: { file: string; at: number; seg: number } | null) => {
    let n = 0;
    for (let s = from.seg; s < order.length && (!to || s <= to.seg); s++) {
      const seg = order[s];
      if (seg.via.some((v) => inTable(v.file, v.at))) continue;
      const a = s === from.seg ? Math.max(seg.from, from.at) : seg.from;
      const b = to && s === to.seg ? Math.min(seg.to, to.at) : seg.to;
      if (b > a) n += (prose.get(seg.file)!.slice(a, b).match(COUNTED) ?? []).length;
    }
    return n;
  };
  const segOf = (file: string, at: number) => order.findIndex((s) => s.file === file && s.from <= at && at <= s.to);

  const sections: Section[] = [];
  let end: Outline["end"] = null;
  const starts = new Map([...texts].map(([f, t]) => [f, lineStarts(t)] as const));
  for (const [k, mark] of marks.entries()) {
    if (mark.kind === "end") {
      end ??= { file: mark.file, line: lineAt(starts.get(mark.file)!, mark.at) };
      break;
    }
    if (mark.kind === "abstract-end") continue;
    const next = marks[k + 1];
    const own = countBetween({ file: mark.file, at: mark.bodyAt, seg: segOf(mark.file, mark.bodyAt) }, next ? { file: next.file, at: next.at, seg: segOf(next.file, next.at) } : null);
    sections.push({
      level: mark.level,
      title: mark.title,
      key: mark.kind === "abstract" ? "@abstract" : mark.title,
      file: mark.file,
      line: lineAt(starts.get(mark.file)!, mark.at),
      own,
      words: own,
    });
  }
  // A section's words include its subsections'.
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (s.level === 0) continue;
    for (let j = i + 1; j < sections.length && sections[j].level > s.level; j++) if (sections[j].level === s.level + 1) s.words += sections[j].words;
  }
  const total = sections.filter((s) => s.level <= 1).reduce((n, s) => n + s.words, 0);
  return { sections, total, end };
}
