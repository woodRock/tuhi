export interface SearchHooks {
  /** Every text file in the paper: the editor's text where open (saved or not), else the disk. */
  texts(): Promise<Map<string, string>>;
  /** Opens the file and selects `from`–`to`. */
  open(file: string, from: number, to: number): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const LIMIT = 1000;
const BINARY = /\.(pdf|png|jpe?g|eps|gif|svg|zip|gz)$/i;

interface Hit {
  line: number;
  from: number;
  to: number;
  text: string;
  /** Where the match sits within `text`. */
  start: number;
  end: number;
}

/** Search across the paper's files, including unsaved edits. */
export class SearchPanel {
  private input = el("input", "search-input");
  private matchCase = el("button", "search-toggle", "Aa");
  private regex = el("button", "search-toggle", ".*");
  private summary = el("div", "search-summary");
  private results = el("div", "search-results");
  private run = 0;
  private timer = 0;

  constructor(
    container: HTMLElement,
    private hooks: SearchHooks,
  ) {
    this.input.type = "search";
    this.input.placeholder = "Search the paper";
    this.input.spellcheck = false;
    this.matchCase.title = "Match case";
    this.regex.title = "Regular expression";
    for (const toggle of [this.matchCase, this.regex]) {
      toggle.addEventListener("click", () => {
        toggle.classList.toggle("on");
        void this.search();
      });
    }
    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.search(), 200);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.results.querySelector<HTMLElement>(".search-hit")?.click();
    });
    const bar = el("div", "search-bar");
    bar.append(this.input, this.matchCase, this.regex);
    container.append(bar, this.summary, this.results);
  }

  focus(text?: string) {
    if (text) {
      this.input.value = text;
      void this.search();
    }
    this.input.focus();
    this.input.select();
  }

  /** Runs the current search again, e.g. after the files changed. */
  async search() {
    const run = ++this.run;
    const query = this.input.value;
    if (!query) {
      this.summary.textContent = "";
      this.results.replaceChildren();
      return;
    }
    let pattern: RegExp;
    try {
      const source = this.regex.classList.contains("on") ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(source, this.matchCase.classList.contains("on") ? "g" : "gi");
    } catch {
      this.summary.textContent = "Not a valid regular expression";
      this.results.replaceChildren();
      return;
    }
    const texts = await this.hooks.texts();
    if (run !== this.run) return;
    const groups: HTMLElement[] = [];
    let total = 0;
    let files = 0;
    for (const [file, text] of [...texts].sort(([a], [b]) => a.localeCompare(b))) {
      if (BINARY.test(file) || total >= LIMIT) continue;
      const hits = find(text, pattern, LIMIT - total);
      if (!hits.length) continue;
      total += hits.length;
      files++;
      groups.push(this.group(file, hits));
    }
    this.summary.textContent = total
      ? `${total >= LIMIT ? `${LIMIT}+` : total} result${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`
      : "No results";
    this.results.replaceChildren(...groups);
  }

  private group(file: string, hits: Hit[]): HTMLElement {
    const box = el("div", "search-group");
    const head = el("button", "search-file");
    head.append(el("span", "search-file-name", file), el("span", "count", String(hits.length)));
    head.addEventListener("click", () => box.classList.toggle("folded"));
    box.append(head);
    for (const hit of hits) {
      const row = el("button", "search-hit");
      row.title = `${file}:${hit.line}`;
      const line = el("span", "search-line", String(hit.line));
      const text = el("span", "search-text");
      text.append(hit.text.slice(0, hit.start), el("mark", "", hit.text.slice(hit.start, hit.end)), hit.text.slice(hit.end));
      row.append(line, text);
      row.addEventListener("click", () => this.hooks.open(file, hit.from, hit.to));
      box.append(row);
    }
    return box;
  }
}

function find(text: string, pattern: RegExp, limit: number): Hit[] {
  const hits: Hit[] = [];
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m && hits.length < limit; m = pattern.exec(text)) {
    if (m[0] === "") {
      pattern.lastIndex++;
      continue;
    }
    for (let i = text.indexOf("\n", scanned); i !== -1 && i < m.index; i = text.indexOf("\n", i + 1)) {
      line++;
      lineStart = i + 1;
    }
    scanned = m.index;
    let lineEnd = text.indexOf("\n", m.index);
    if (lineEnd === -1) lineEnd = text.length;
    // Long lines are cut to show the match with a little context either side.
    let cut = Math.max(lineStart, m.index - 16);
    while (cut < m.index && /\s/.test(text[cut])) cut++;
    const shown = text.slice(cut, Math.min(lineEnd, m.index + m[0].length + 120));
    const lead = cut > lineStart ? "…" : "";
    const start = lead.length + m.index - cut;
    hits.push({ line, from: m.index, to: m.index + m[0].length, text: lead + shown.trimEnd(), start, end: Math.min(start + m[0].length, lead.length + shown.length) });
  }
  return hits;
}
