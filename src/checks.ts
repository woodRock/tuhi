// Pre-submission checks and consistency lint over the paper's .tex files. Pure functions: the
// input is each file's text, the output is findings with places and, where safe, a fix.

export type Severity = "error" | "warning" | "info";

export interface Finding {
  file: string;
  /** 1-based; 0 when the finding has no single place. */
  line: number;
  severity: Severity;
  /** Heading it's listed under, e.g. "Acronyms". */
  group: string;
  message: string;
  /** Replaces the first `find` on that line with `replace`. */
  fix?: { find: string; replace: string };
}

export type Status = "ok" | "warn" | "fail" | "info" | "off";

export interface CheckItem {
  title: string;
  status: Status;
  summary: string;
  findings: Finding[];
}

export interface Settings {
  /** Venue page limit; null when not set. */
  pageLimit: number | null;
  /** Whether the limit leaves out the references. */
  limitExcludesReferences: boolean;
  /** Double-blind review: the PDF must not identify the authors. */
  doubleBlind: boolean;
}

export const DEFAULT_SETTINGS: Settings = { pageLimit: null, limitExcludesReferences: false, doubleBlind: false };

// Reading order

export interface Segment {
  file: string;
  from: number;
  to: number;
  /** Where each enclosing file pulls this one in, outermost first. */
  via: { file: string; at: number }[];
}

const INPUT = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;

/**
 * The paper in reading order: stretches of each file, with \input and \include followed where
 * they appear. Files the main file never reaches (a response letter, old drafts) are left out.
 */
export function readingOrder(main: string, texts: Map<string, string>): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  const dir = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "");
  const mainDir = dir(main);
  const resolve = (name: string) => {
    const clean = name.trim().replace(/^\.\//, "");
    const candidates = [clean, `${clean}.tex`].flatMap((c) => [mainDir + c, c]);
    return candidates.find((c) => texts.has(c));
  };
  const walk = (file: string, via: Segment["via"]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = texts.get(file) ?? "";
    const code = stripComments(text);
    let at = 0;
    for (const m of code.matchAll(INPUT)) {
      const child = resolve(m[1]);
      if (!child) continue;
      out.push({ file, from: at, to: m.index!, via });
      walk(child, [...via, { file, at: m.index! }]);
      at = m.index! + m[0].length;
    }
    out.push({ file, from: at, to: text.length, via });
  };
  if (texts.has(main)) walk(main, []);
  return out;
}

// Masking: keep prose, blank out everything else, keeping offsets

/** Stands in for the letters of an accent command so a word like M\=aori stays one word. */
const FILL = "\u00ad";

// Commands whose arguments aren't prose.
const NON_PROSE = new Set(
  "label ref eqref cref Cref autoref pageref nameref vref cite citep citet citealp citeauthor citeyear parencite textcite autocite footcite nocite input include subfile includegraphics bibliography bibliographystyle addbibresource url href documentclass usepackage RequirePackage begin end res newcommand renewcommand providecommand DeclareMathOperator newenvironment renewenvironment def let hspace vspace setlength addtolength setcounter fontsize color textcolor definecolor pagecolor colorbox hypersetup graphicspath lstinputlisting bibitem resizebox scalebox rule raisebox".split(" "),
);
const MATH_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath|split|IEEEeqnarray|tikzpicture|verbatim|lstlisting|minted|comment)\*?$/;
const ACCENTS: Record<string, Record<string, string>> = {
  "=": { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", A: "Ā", E: "Ē", I: "Ī", O: "Ō", U: "Ū" },
  "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É" },
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù" },
  '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", A: "Ä", O: "Ö", U: "Ü" },
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û" },
  "~": { n: "ñ", a: "ã", o: "õ" },
};

export function stripComments(text: string): string {
  return text.replace(/(?<!\\)%.*$/gm, (c) => " ".repeat(c.length));
}

/**
 * The text with only prose left: comments, maths, command names and the arguments of
 * non-prose commands (labels, cites, file names) become spaces; accent commands become the
 * accented letter. Same length as the input, so offsets and lines still match.
 */
export function maskProse(text: string): string {
  const out = stripComments(text).split("");
  const n = out.length;
  const blank = (from: number, to: number) => {
    for (let i = from; i < Math.min(to, n); i++) if (out[i] !== "\n") out[i] = " ";
  };
  /** Index just past the group starting at `i` ({…} or […]). */
  const group = (i: number, open: string, close: string) => {
    let depth = 0;
    for (let j = i; j < n; j++) {
      if (out[j] === "\\") {
        j++;
        continue;
      }
      if (out[j] === open) depth++;
      else if (out[j] === close && --depth === 0) return j + 1;
    }
    return n;
  };
  const skipSpace = (i: number) => {
    while (i < n && (out[i] === " " || out[i] === "\t")) i++;
    return i;
  };

  let i = 0;
  while (i < n) {
    const c = out[i];
    if (c === "$") {
      const display = out[i + 1] === "$";
      const close = display ? "$$" : "$";
      let j = i + close.length;
      while (j < n && !(out[j] === "$" && out[j - 1] !== "\\" && (!display || out[j + 1] === "$"))) j++;
      blank(i, j + close.length);
      i = j + close.length;
      continue;
    }
    if (c !== "\\") {
      if (c === "{" || c === "}" || c === "~" || c === "&") out[i] = " ";
      i++;
      continue;
    }
    const next = out[i + 1] ?? "";
    if (next === "(" || next === "[") {
      const end = text.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ACCENTS[next]) {
      // \=a or \={a}: the letter, padded with fillers that count as part of the word.
      const braced = out[i + 2] === "{";
      const letter = out[braced ? i + 3 : i + 2];
      const accented = ACCENTS[next][letter];
      const end = braced ? i + 5 : i + 3;
      if (accented && (!braced || out[i + 4] === "}")) {
        out[i] = accented;
        for (let k = i + 1; k < end; k++) out[k] = FILL;
        i = end;
        continue;
      }
    }
    if (!/[A-Za-z@]/.test(next)) {
      // \\, \%, \&, \_ …: an escaped character or a break, not a word.
      out[i] = " ";
      if (next !== "\n" && i + 1 < n) out[i + 1] = " ";
      i += 2;
      continue;
    }
    let j = i + 1;
    while (j < n && /[A-Za-z@]/.test(out[j])) j++;
    const name = text.slice(i + 1, j);
    if (out[j] === "*") j++;
    blank(i, j);
    if (name === "csname") {
      // \csname taura@map-error/k5\endcsname: a macro name, not words.
      const end = text.indexOf("\\endcsname", j);
      const stop = end === -1 ? n : end + "\\endcsname".length;
      blank(j, stop);
      i = stop;
      continue;
    }
    if (name === "begin" || name === "end") {
      const k = skipSpace(j);
      if (out[k] === "{") {
        const close = group(k, "{", "}");
        const env = text.slice(k + 1, close - 1).trim();
        blank(k, close);
        if (name === "begin" && MATH_ENVS.test(env)) {
          const end = text.indexOf(`\\end{${env}}`, close);
          const stop = end === -1 ? n : end + `\\end{${env}}`.length;
          blank(close, stop);
          i = stop;
          continue;
        }
        i = close;
        continue;
      }
    }
    if (NON_PROSE.has(name)) {
      let k = skipSpace(j);
      // Optional arguments, then the mandatory ones (two for href, newcommand and friends).
      let mandatory = ["href", "newcommand", "renewcommand", "providecommand", "textcolor", "colorbox", "definecolor", "setcounter", "setlength", "addtolength", "newenvironment"].includes(name) ? (name === "href" || name === "textcolor" || name === "colorbox" ? 1 : 2) : 1;
      if (name === "definecolor") mandatory = 3;
      while (k < n && (out[k] === "[" || out[k] === "{")) {
        if (out[k] === "{" && mandatory === 0) break;
        const close = out[k] === "[" ? group(k, "[", "]") : group(k, "{", "}");
        if (out[k] === "{") mandatory--;
        blank(k, close);
        k = skipSpace(close);
      }
      i = k;
      continue;
    }
    i = j;
  }
  return out.join("");
}

// Helpers

// Words, keeping hyphenated compounds together.
const WORD = /[\p{L}\u00ad]+(?:-[\p{L}\u00ad]+)*/gu;
const lineStarts = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
};
const lineAt = (starts: number[], offset: number) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};
const matchCase = (like: string, word: string) =>
  like === like.toUpperCase() && like.length > 1
    ? word.toUpperCase()
    : like[0] === like[0].toUpperCase()
      ? word[0].toUpperCase() + word.slice(1)
      : word;

/** A file's text, masked prose and line table, built once per check run. */
interface Doc {
  file: string;
  text: string;
  prose: string;
  starts: number[];
}

interface Hit {
  doc: Doc;
  at: number;
  /** Position in reading order, for "before" and "after". */
  order: number;
  raw: string;
}

function place(doc: Doc, at: number) {
  return { file: doc.file, line: lineAt(doc.starts, at) };
}

/** Each segment's words in reading order. */
function* words(docs: Map<string, Doc>, order: Segment[]) {
  let index = 0;
  for (const seg of order) {
    const doc = docs.get(seg.file)!;
    WORD.lastIndex = seg.from;
    for (let m = WORD.exec(doc.prose); m && m.index < seg.to; m = WORD.exec(doc.prose)) {
      yield { doc, at: m.index, order: index++, word: m[0].replaceAll(FILL, ""), raw: doc.text.slice(m.index, m.index + m[0].length) };
    }
  }
}

// Consistency lint

/** Run every consistency check. */
export function lint(main: string, texts: Map<string, string>): Finding[] {
  const order = readingOrder(main, texts);
  const docs = new Map<string, Doc>();
  for (const seg of order) {
    if (docs.has(seg.file)) continue;
    const text = texts.get(seg.file) ?? "";
    docs.set(seg.file, { file: seg.file, text, prose: maskProse(text), starts: lineStarts(text) });
  }
  return [...acronyms(docs, order), ...spelling(docs, order), ...macrons(docs, order), ...notation(docs, order)];
}

const KNOWN = new Set("PDF URL URLs HTML CSV JSON API CPU GPU RAM ID OK TV DNA RNA USA UK EU IEEE ACM ISO SI CC BY TODO FIXME TBD XXX NB".split(" "));
const ROMAN = /^[IVXLCDM]+$/;
const ACRONYM = /(?<![\p{L}\d\-\/])([A-Z][A-Z0-9]*(?:[-\/][A-Z0-9]+)*)(s?)(?![\p{L}\d])/gu;
// Where an acronym's use doesn't count as first use: headings, the abstract and keywords
// (which define their own), and floats (which move).
const HEADINGS = /\\(?:title|section|subsection|subsubsection|paragraph|chapter|caption|IEEEkeywords|keywords)\*?\s*(?:\[[^\]]*\])?\{|\\begin\{(?:abstract|IEEEkeywords|keywords|figure\*?|table\*?)\}/g;

function acronyms(docs: Map<string, Doc>, order: Segment[]): Finding[] {
  const all = [...docs.values()].map((d) => d.text).join("\n");
  // Papers that use an acronym package let it handle first use.
  if (/\\(newacronym|DeclareAcronym|acro\s*\{|acrodef)/.test(all)) return [];

  // Ranges whose acronyms don't count as uses: headings, the abstract, keywords.
  const quiet = new Map<string, [number, number][]>();
  for (const doc of docs.values()) {
    const ranges: [number, number][] = [];
    for (const m of doc.text.matchAll(HEADINGS)) {
      const start = m.index! + m[0].length;
      if (m[0].startsWith("\\begin")) {
        const env = m[0].slice(7, -1).replace("*", "\\*");
        const close = new RegExp(`\\\\end\\{${env}\\}`, "g");
        close.lastIndex = start;
        const end = close.exec(doc.text)?.index ?? -1;
        ranges.push([start, end === -1 ? doc.text.length : end]);
      } else {
        let depth = 1;
        let j = start;
        for (; j < doc.text.length && depth; j++) depth += doc.text[j] === "{" ? 1 : doc.text[j] === "}" ? -1 : 0;
        ranges.push([start, j]);
      }
    }
    quiet.set(doc.file, ranges);
  }
  const inRange = (file: string, at: number) => quiet.get(file)?.some(([a, b]) => a <= at && at < b) ?? false;
  // Quiet if it's in such a range, or in a file \input from inside one (a table's body).
  const isQuiet = (doc: Doc, at: number, seg?: Segment) => inRange(doc.file, at) || (seg?.via.some((v) => inRange(v.file, v.at)) ?? false);

  const uses = new Map<string, (Hit & { seg: Segment })[]>();
  const defs = new Map<string, (Hit & { seg: Segment })[]>();
  let index = 0;
  for (const seg of order) {
    const doc = docs.get(seg.file)!;
    const slice = doc.prose.slice(seg.from, seg.to);
    for (const m of slice.matchAll(ACRONYM)) {
      const name = m[1];
      const at = seg.from + m.index!;
      if ((name.match(/[A-Z]/g) ?? []).length < 2 || ROMAN.test(name) || KNOWN.has(name) || name.length > 8) continue;
      const hit = { doc, at, order: index++, raw: name, seg };
      // "(ABC)" right after words is a definition.
      const before = doc.prose.slice(Math.max(0, at - 2), at);
      const after = doc.prose.slice(at + m[0].length, at + m[0].length + 2);
      if (/\(\s?$/.test(before) && /^\s?\)/.test(after) && /\p{L}/u.test(doc.prose.slice(Math.max(0, at - 30), at - 1))) {
        defs.set(name, [...(defs.get(name) ?? []), hit]);
      } else if (!isQuiet(doc, at, seg)) {
        uses.set(name, [...(uses.get(name) ?? []), hit]);
      }
    }
  }

  const out: Finding[] = [];
  const names = new Set([...uses.keys(), ...defs.keys()]);
  for (const name of names) {
    const used = uses.get(name) ?? [];
    // Definitions in the abstract don't count: the body defines them again.
    const bodyDefs = (defs.get(name) ?? []).filter((d) => !isQuiet(d.doc, d.at, d.seg));
    const firstDef = bodyDefs[0];
    if (!firstDef) {
      if (used.length && (defs.get(name) ?? []).length) {
        const where = place(defs.get(name)![0].doc, defs.get(name)![0].at);
        out.push({ ...place(used[0].doc, used[0].at), severity: "info", group: "Acronyms", message: `${name} is spelled out only in the abstract, a heading or a float (${where.file}:${where.line}), not in the text` });
      } else if (used.length) {
        out.push({ ...place(used[0].doc, used[0].at), severity: "info", group: "Acronyms", message: `${name} is never spelled out (used ${used.length}×)` });
      }
      continue;
    }
    if (firstDef && used.length && used[0].order < firstDef.order) {
      const where = place(firstDef.doc, firstDef.at);
      out.push({ ...place(used[0].doc, used[0].at), severity: "warning", group: "Acronyms", message: `${name} is used before it's defined (${where.file}:${where.line})` });
    }
    for (const again of bodyDefs.slice(1)) {
      const first = place(firstDef.doc, firstDef.at);
      out.push({ ...place(again.doc, again.at), severity: "info", group: "Acronyms", message: `${name} is defined again (first at ${first.file}:${first.line})` });
    }
    if (firstDef && !used.some((u) => u.order > firstDef.order)) {
      out.push({ ...place(firstDef.doc, firstDef.at), severity: "info", group: "Acronyms", message: `${name} is defined but never used again: spell it out instead` });
    }
  }
  return out;
}

// British and American spellings of the same word; -ise/-ize and -yse/-yze are found by rule.
const PAIRS: [string, string][] = [
  ["color", "colour"], ["colors", "colours"], ["behavior", "behaviour"], ["behaviors", "behaviours"], ["favor", "favour"],
  ["neighbor", "neighbour"], ["neighbors", "neighbours"], ["neighboring", "neighbouring"], ["center", "centre"],
  ["centers", "centres"], ["centered", "centred"], ["fiber", "fibre"], ["fibers", "fibres"], ["gray", "grey"],
  ["modeling", "modelling"], ["modeled", "modelled"], ["labeled", "labelled"], ["labeling", "labelling"],
  ["traveled", "travelled"], ["signaling", "signalling"], ["canceled", "cancelled"], ["catalog", "catalogue"],
  ["artifact", "artefact"], ["artifacts", "artefacts"], ["toward", "towards"], ["aluminum", "aluminium"],
  ["acknowledgment", "acknowledgement"], ["acknowledgments", "acknowledgements"], ["judgment", "judgement"],
];

function spelling(docs: Map<string, Doc>, order: Segment[]): Finding[] {
  type Seen = { doc: Doc; at: number; raw: string; order: number };
  const seen = new Map<string, Seen[]>();
  const bigrams = new Map<string, Seen[]>();
  let prev: { doc: Doc; at: number; word: string; end: number } | null = null;
  for (const w of words(docs, order)) {
    const key = w.word.toLowerCase();
    seen.set(key, [...(seen.get(key) ?? []), w]);
    if (prev && prev.doc === w.doc && /^[ \t]+$/.test(w.doc.prose.slice(prev.end, w.at)) && w.doc.text.slice(prev.end, w.at) === " ") {
      const pair = `${prev.word.toLowerCase()} ${key}`;
      bigrams.set(pair, [...(bigrams.get(pair) ?? []), { doc: w.doc, at: prev.at, raw: w.doc.text.slice(prev.at, w.at + w.raw.length), order: w.order }]);
    }
    prev = { doc: w.doc, at: w.at, word: w.word, end: w.at + w.raw.length };
  }

  // Pairs of spellings found in this paper.
  const variants: [string, string][] = [...PAIRS];
  for (const word of seen.keys()) {
    const z = /^(\p{L}{3,})(iz|yz)(e|es|ed|ing|ation|ations|er|ers|able)$/u.exec(word);
    if (z) variants.push([word, `${z[1]}${z[2] === "iz" ? "is" : "ys"}${z[3]}`]);
  }

  const out: Finding[] = [];
  const report = (forms: string[], hits: Map<string, Seen[]>, group: string, severity: Severity) => {
    const present = forms.filter((f) => hits.get(f)?.length);
    if (present.length < 2) return;
    // The form used most (first used, on a tie) is the one to keep.
    const ranked = present.sort((a, b) => hits.get(b)!.length - hits.get(a)!.length || hits.get(a)![0].order - hits.get(b)![0].order);
    const keep = ranked[0];
    const counts = ranked.map((f) => `"${f}" ${hits.get(f)!.length}×`).join(", ");
    for (const form of ranked.slice(1)) {
      for (const hit of hits.get(form)!.slice(0, 5)) {
        out.push({
          ...place(hit.doc, hit.at),
          severity,
          group,
          message: `Mixed spellings: ${counts}. Use "${keep}" throughout`,
          fix: keep.includes(" ") || hit.raw.includes("\n") ? undefined : { find: hit.raw, replace: matchCase(hit.raw, keep) },
        });
      }
    }
  };
  const done = new Set<string>();
  for (const [a, b] of variants) {
    const id = [a, b].sort().join("|");
    if (done.has(id)) continue;
    done.add(id);
    report([a, b], seen, "Spelling", "warning");
  }
  // Compounds written closed and open: "finetuning" and "fine-tuning" or "fine tuning". Hyphenated
  // against spaced alone ("retention-time shifts", "the retention time") is usually grammar.
  for (const word of seen.keys()) {
    const parts = word.split("-");
    if (parts.length !== 2 || parts.some((p) => p.length < 2) || !seen.get(parts.join(""))?.length) continue;
    const forms = [word, parts.join(""), parts.join(" ")];
    const hits = new Map([...forms.slice(0, 2).map((f) => [f, seen.get(f) ?? []] as const), [forms[2], bigrams.get(forms[2]) ?? []]]);
    report(forms, hits, "Spelling", "info");
  }
  return out;
}

// Te reo Māori words that take macrons, keyed by how they look without them.
const MACRONS: Record<string, string> = Object.fromEntries(
  ["Māori", "mātauranga", "whānau", "Pākehā", "hapū", "rūnanga", "kōrero", "wānanga", "Tāmaki", "Ngāti", "Ngāi", "kaumātua", "tūpuna", "tīpuna", "rāhui", "pōwhiri", "kāinga", "mōteatea", "tūrangawaewae", "kōhanga", "Tūhoe", "Rūaumoko", "Tāne", "Rēhua"].map((w) => [
    w.normalize("NFD").replace(/\u0304/g, "").toLowerCase(),
    w,
  ]),
);

function macrons(docs: Map<string, Doc>, order: Segment[]): Finding[] {
  const out: Finding[] = [];
  for (const w of words(docs, order)) {
    // Each part of a compound such as Maori-led.
    let offset = 0;
    for (const part of w.raw.split("-")) {
      const word = part.replace(/\\=\{?([A-Za-z])\}?/g, "$1\u0304").normalize("NFC");
      const right = MACRONS[word.toLowerCase()];
      if (right) {
        const fixed = word === word.toUpperCase() && word.length > 1 ? right.toUpperCase() : word[0] === word[0].toUpperCase() ? right[0].toUpperCase() + right.slice(1) : right.toLowerCase();
        out.push({ ...place(w.doc, w.at + offset), severity: "warning", group: "Te reo Māori", message: `"${word}" is spelt "${fixed}" in te reo Māori`, fix: { find: part, replace: fixed } });
      }
      offset += part.length + 1;
    }
  }
  return out;
}

function notation(docs: Map<string, Doc>, order: Segment[]): Finding[] {
  const out: Finding[] = [];
  const code = [...new Set(order.map((s) => s.file))].map((f) => docs.get(f)!).map((doc) => ({ doc, code: stripComments(doc.text) }));

  // Bold symbols written with different commands: \mathbf{x} here, \bm{x} there.
  const bold = new Map<string, Map<string, { doc: Doc; at: number; raw: string }[]>>();
  for (const { doc, code: text } of code) {
    for (const m of text.matchAll(/\\(mathbf|bm|boldsymbol|vec|mathbold)\s*\{\s*(\\?[A-Za-z]+)\s*\}/g)) {
      const forms = bold.get(m[2]) ?? new Map();
      forms.set(m[1], [...(forms.get(m[1]) ?? []), { doc, at: m.index!, raw: m[0] }]);
      bold.set(m[2], forms);
    }
  }
  for (const [symbol, forms] of bold) {
    if (forms.size < 2) continue;
    const ranked = [...forms].sort((a, b) => b[1].length - a[1].length);
    const [keep] = ranked[0];
    for (const [command, hits] of ranked.slice(1)) {
      for (const hit of hits.slice(0, 5)) {
        out.push({
          ...place(hit.doc, hit.at),
          severity: "info",
          group: "Notation",
          message: `${symbol} is written \\${command}{${symbol}} here but \\${keep}{${symbol}} elsewhere`,
          fix: { find: hit.raw, replace: `\\${keep}{${symbol}}` },
        });
      }
    }
  }

  // Reference words: "Fig." here, "Figure" there (sentence starts are allowed to differ).
  const refWords: [string, RegExp][] = [
    ["figure", /\b(Fig\.|Figure)(?=~|\s*\\ref)/g],
    ["equation", /\b(Eq\.|Eqn\.|Equation)(?=~|\s*\\(?:eq)?ref)/g],
    ["section", /\b(Sec\.|Section)(?=~|\s*\\ref)/g],
  ];
  for (const [what, pattern] of refWords) {
    const forms = new Map<string, { doc: Doc; at: number; raw: string }[]>();
    for (const { doc, code: text } of code) {
      for (const m of text.matchAll(pattern)) {
        const before = text.slice(Math.max(0, m.index! - 3), m.index!);
        if (/(^|[.!?]\s+|\n\s*)$/.test(before) || m.index === 0) continue;
        forms.set(m[1], [...(forms.get(m[1]) ?? []), { doc, at: m.index!, raw: m[1] }]);
      }
    }
    if (forms.size < 2) continue;
    const ranked = [...forms].sort((a, b) => b[1].length - a[1].length);
    const [keep] = ranked[0];
    for (const [form, hits] of ranked.slice(1)) {
      for (const hit of hits.slice(0, 5)) {
        out.push({ ...place(hit.doc, hit.at), severity: "info", group: "Notation", message: `"${form}" here but "${keep}" for other ${what} references mid-sentence`, fix: { find: hit.raw, replace: keep } });
      }
    }
  }

  // "e.g.," against "e.g." (and i.e.).
  for (const abbr of ["e.g.", "i.e."]) {
    const comma: { doc: Doc; at: number }[] = [];
    const bare: { doc: Doc; at: number }[] = [];
    for (const { doc } of code) {
      const prose = doc.text;
      for (let i = prose.indexOf(abbr); i !== -1; i = prose.indexOf(abbr, i + 1)) {
        (prose[i + abbr.length] === "," ? comma : bare).push({ doc, at: i });
      }
    }
    if (!comma.length || !bare.length) continue;
    const [keepComma, odd] = comma.length >= bare.length ? [true, bare] : [false, comma];
    for (const hit of odd.slice(0, 5)) {
      out.push({
        ...place(hit.doc, hit.at),
        severity: "info",
        group: "Notation",
        message: `"${abbr}" is followed by a comma ${keepComma ? comma.length : bare.length}× elsewhere and ${keepComma ? "not" : "is"} here`,
        fix: keepComma ? { find: abbr, replace: `${abbr},` } : { find: `${abbr},`, replace: abbr },
      });
    }
  }
  return out;
}

// The pre-submission checklist

export interface PaperFacts {
  main: string;
  texts: Map<string, string>;
  settings: Settings;
  /** From the last compile; null when there's no PDF. */
  pages: number | null;
  referencesPage: number | null;
  issues: { severity: Severity; file: string | null; line: number | null; message: string }[];
  /** Consistency findings, summarised as the last item. */
  lint: Finding[];
}

const REF_COMMANDS = /\\(?:ref|eqref|autoref|pageref|nameref|cref|Cref|vref|Vref|cpageref|Cpageref|labelcref)\*?\s*\{([^}]+)\}/g;

export function checklist(facts: PaperFacts): CheckItem[] {
  const { main, texts, settings, issues } = facts;
  const order = readingOrder(main, texts);
  const files = [...new Set(order.map((s) => s.file))];
  const docs = files.map((file) => {
    const text = texts.get(file) ?? "";
    return { file, text, code: stripComments(text), starts: lineStarts(text) };
  });
  const at = (doc: (typeof docs)[number], offset: number) => ({ file: doc.file, line: lineAt(doc.starts, offset) });
  const items: CheckItem[] = [];

  // Compile
  const errors = issues.filter((i) => i.severity === "error");
  items.push({
    title: "Compiles cleanly",
    status: errors.length ? "fail" : "ok",
    summary: errors.length ? `${errors.length} error(s) in the last compile` : "No errors in the last compile",
    findings: errors.map((e) => ({ file: e.file ?? main, line: e.line ?? 0, severity: "error", group: "Compile", message: e.message })),
  });

  // Page limit
  if (settings.pageLimit && facts.pages) {
    const counted = settings.limitExcludesReferences && facts.referencesPage ? facts.referencesPage : facts.pages;
    const over = counted > settings.pageLimit;
    const refs = facts.referencesPage ? ` (references start on p. ${facts.referencesPage})` : "";
    items.push({
      title: "Page limit",
      status: over ? "fail" : "ok",
      summary: `${facts.pages} page(s)${refs}; ${settings.limitExcludesReferences ? "before the references" : "in all"} ${counted} of ${settings.pageLimit}`,
      findings: [],
    });
  } else {
    items.push({ title: "Page limit", status: "off", summary: settings.pageLimit ? "Compile to count pages" : "Set the venue's page limit below", findings: [] });
  }

  // Double-blind
  if (settings.doubleBlind) {
    const found: Finding[] = [];
    const flag = (doc: (typeof docs)[number], offset: number, message: string) => found.push({ ...at(doc, offset), severity: "warning", group: "Anonymity", message });
    for (const doc of docs) {
      for (const m of doc.code.matchAll(/\\(author|IEEEauthorblockN|IEEEauthorblockA|affil|affiliation|email)\s*(?:\[[^\]]*\])?\{([^}]*)/g)) {
        if (!/anonym/i.test(m[2]) && m[2].trim()) flag(doc, m.index!, `\\${m[1]} names someone: "${m[2].trim().slice(0, 60)}"`);
      }
      for (const m of doc.code.matchAll(/\\thanks\{/g)) flag(doc, m.index!, "\\thanks can identify the authors or their funding");
      for (const m of doc.code.matchAll(/\\section\*?\{\s*Acknowledge?ments?\s*\}|\\begin\{acks\}/gi)) flag(doc, m.index!, "Acknowledgements usually identify the authors: remove them for review");
      for (const m of doc.code.matchAll(/github\.com\/[\w-]+|gitlab\.com\/[\w-]+|osf\.io\/\w+/gi)) flag(doc, m.index!, `A link that may identify you: ${m[0]}`);
      for (const m of doc.code.matchAll(/pdfauthor\s*=\s*\{?[^,}]+/g)) flag(doc, m.index!, "PDF metadata names the author (hypersetup pdfauthor)");
      for (const m of doc.code.matchAll(/\b(our|my) (previous|prior|earlier|recent) (work|paper|study|studies)\b/gi)) flag(doc, m.index!, `"${m[0]}" reveals that the cited work is yours: cite it in the third person`);
    }
    items.push({ title: "Anonymous for double-blind review", status: found.length ? "warn" : "ok", summary: found.length ? `${found.length} thing(s) may identify the authors` : "Nothing found that names the authors", findings: found });
  } else {
    items.push({ title: "Anonymous for double-blind review", status: "off", summary: "Not a double-blind venue (change below)", findings: [] });
  }

  // Labels and references
  const labels = new Map<string, { file: string; line: number }[]>();
  const refs = new Map<string, { file: string; line: number }[]>();
  for (const doc of docs) {
    for (const m of doc.code.matchAll(/\\label\s*\{([^}]+)\}/g)) labels.set(m[1].trim(), [...(labels.get(m[1].trim()) ?? []), at(doc, m.index!)]);
    for (const m of doc.code.matchAll(REF_COMMANDS)) {
      for (const key of m[1].split(",").map((k) => k.trim()).filter(Boolean)) refs.set(key, [...(refs.get(key) ?? []), at(doc, m.index!)]);
    }
  }
  const refProblems: Finding[] = [];
  for (const [key, places] of refs) {
    if (!labels.has(key)) refProblems.push({ ...places[0], severity: "error", group: "References", message: `\\ref{${key}} has no matching \\label` });
  }
  for (const [key, places] of labels) {
    if (places.length > 1) refProblems.push({ ...places[1], severity: "error", group: "References", message: `\\label{${key}} is defined ${places.length} times` });
  }
  const undefinedCites = issues.filter((i) => /Citation .* undefined|There were undefined citations/i.test(i.message));
  for (const i of undefinedCites.filter((i) => /Citation/.test(i.message))) {
    refProblems.push({ file: i.file ?? main, line: i.line ?? 0, severity: "error", group: "References", message: i.message });
  }
  items.push({
    title: "References and citations resolve",
    status: refProblems.length ? "fail" : "ok",
    summary: refProblems.length ? `${refProblems.length} broken reference(s) or citation(s)` : `${refs.size} reference(s) and every citation resolve`,
    findings: refProblems,
  });
  const unused = [...labels].filter(([key]) => !refs.has(key));
  items.push({
    title: "Unused labels",
    status: unused.length ? "info" : "ok",
    summary: unused.length ? `${unused.length} label(s) never referenced` : "Every label is referenced",
    findings: unused.map(([key, places]) => ({ ...places[0], severity: "info", group: "References", message: `\\label{${key}} is never referenced` })),
  });

  // Figures and tables
  const floats: Finding[] = [];
  let noAlt = 0;
  for (const doc of docs) {
    for (const m of doc.code.matchAll(/\\begin\{(figure|table)(\*?)\}/g)) {
      const endAt = doc.code.indexOf(`\\end{${m[1]}${m[2]}}`, m.index!);
      const body = doc.code.slice(m.index!, endAt === -1 ? undefined : endAt);
      if (!/\\caption/.test(body)) floats.push({ ...at(doc, m.index!), severity: "warning", group: "Figures and tables", message: `A ${m[1]} with no caption` });
      else if (!/\\label/.test(body)) floats.push({ ...at(doc, m.index!), severity: "info", group: "Figures and tables", message: `A ${m[1]} with no label, so the text can't refer to it` });
      for (const g of body.matchAll(/\\includegraphics\s*(\[[^\]]*\])?/g)) {
        if (!/\balt\s*=/.test(g[1] ?? "") && !/\\Description/.test(body)) {
          noAlt++;
          floats.push({ ...at(doc, m.index! + g.index!), severity: "info", group: "Figures and tables", message: "Figure has no alt text (\\includegraphics[alt={…}], or \\Description for ACM)" });
        }
      }
    }
  }
  const missingCaptions = floats.filter((f) => f.severity === "warning").length;
  items.push({
    title: "Figures and tables have captions and alt text",
    status: missingCaptions ? "warn" : noAlt ? "info" : "ok",
    summary: [missingCaptions && `${missingCaptions} without a caption`, noAlt && `${noAlt} image(s) without alt text`].filter(Boolean).join(", ") || "Every float has a caption and alt text",
    findings: floats,
  });

  // Overfull boxes
  const overfull = issues.filter((i) => i.message.startsWith("Overfull"));
  const widest = overfull.map((i) => Number(/\(([\d.]+)pt too wide\)/.exec(i.message)?.[1] ?? 0)).reduce((a, b) => Math.max(a, b), 0);
  items.push({
    title: "No overfull lines",
    status: overfull.length ? "warn" : "ok",
    summary: overfull.length ? `${overfull.length} overfull box(es), widest ${widest}pt` : "No text sticks out into the margin",
    findings: overfull.map((i) => ({ file: i.file ?? main, line: i.line ?? 0, severity: "warning", group: "Layout", message: i.message })),
  });

  // Leftovers
  const leftovers: Finding[] = [];
  for (const doc of docs) {
    // The preamble defines \todo and friends; only their uses count.
    const body = doc.file === main ? Math.max(0, doc.code.indexOf("\\begin{document}")) : 0;
    const pattern = /\\todo\b|\\hl\{|\\textcolor\{red\}|\\red\{|\\(?:hilight|highlight)\{|\b(TODO|FIXME|XXX|TBD)\b/g;
    for (const m of doc.code.matchAll(pattern)) if (m.index! >= body) leftovers.push({ ...at(doc, m.index!), severity: "warning", group: "Leftovers", message: `${m[0].replace("{", "")} left in the text` });
  }
  items.push({ title: "No leftover notes", status: leftovers.length ? "warn" : "ok", summary: leftovers.length ? `${leftovers.length} TODO, \\todo or highlight(s)` : "No TODOs or highlights", findings: leftovers });

  // Consistency
  const warnings = facts.lint.filter((f) => f.severity !== "info").length;
  items.push({
    title: "Consistent spelling, acronyms and notation",
    status: warnings ? "warn" : facts.lint.length ? "info" : "ok",
    summary: facts.lint.length ? `${facts.lint.length} finding(s), ${warnings} worth fixing (listed below)` : "Nothing found",
    findings: [],
  });
  return items;
}
