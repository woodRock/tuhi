import type { TauraFinding, TauraReport } from "./api";
import type { Marker } from "./provenance";

export interface ProvenanceHooks {
  jump(file: string, line: number): void;
  refresh(): Promise<void>;
  /** The gutter markers of every .tex file, in reading order. */
  markers(report: TauraReport): Promise<{ file: string; markers: Marker[] }[]>;
}

type Filter = "attention" | "all";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The Provenance tab: taura's view of the paper, read-only. */
export class ProvenancePanel {
  private body = el("div", "prov-body");
  private filter: Filter = "attention";
  private filters = el("div", "filters");
  private report: TauraReport | null = null;
  private run = 0;

  constructor(
    container: HTMLElement,
    private hooks: ProvenanceHooks,
  ) {
    const bar = el("div", "review-bar");
    const refresh = el("button", "", "Refresh");
    refresh.title = "Run taura check and diff again";
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      await this.hooks.refresh().finally(() => (refresh.disabled = false));
    });
    const legend = el("div", "prov-legend");
    for (const [level, label] of [["ok", "traced"], ["stale", "changed since publish"], ["untracked", "no provenance"], ["warn", "flagged"]]) {
      legend.append(el("span", `prov-dot prov-${level}`), label);
    }
    for (const [value, label] of [["attention", "Needs attention"], ["all", "All"]] as const) {
      const chip = el("button", value === this.filter ? "chip active" : "chip", label);
      chip.dataset.filter = value;
      chip.addEventListener("click", () => {
        this.filter = value;
        for (const c of this.filters.querySelectorAll<HTMLElement>(".chip")) c.classList.toggle("active", c === chip);
        if (this.report) void this.render(this.report);
      });
      this.filters.append(chip);
    }
    this.filters.hidden = true;
    bar.append(refresh, el("span", "spacer"), this.filters);
    container.append(bar, legend, this.body);
    this.set(null, false);
  }

  /** `linked` false means taura has no code repo paired with this paper. */
  set(report: TauraReport | null, loading: boolean, error?: string) {
    this.report = null;
    this.filters.hidden = true;
    if (loading) {
      this.body.replaceChildren(el("p", "review-empty", "Asking taura…"));
      return;
    }
    if (error) {
      this.body.replaceChildren(el("p", "review-empty", "taura didn't answer:"), el("pre", "prov-error", error));
      return;
    }
    if (!report) {
      this.body.replaceChildren(
        el("p", "review-empty", "This paper isn't paired with a code repo in taura, so there's no provenance to show."),
      );
      return;
    }
    this.report = report;
    this.filters.hidden = false;
    void this.render(report);
  }

  private async render(report: TauraReport) {
    const run = ++this.run;
    const s = report.status;
    const summary = el("dl", "trace-rows prov-summary");
    const rows: [string, string][] = [
      ["Code repo", String(s.code ?? "")],
      ["Last publish", String(s.last_publish ?? "never").slice(0, 16).replace("T", " ")],
      ["From commit", String(s.published_commit ?? "").slice(0, 7)],
      ["Artifacts", String(report.artifacts.length)],
    ];
    for (const [k, v] of rows) summary.append(el("dt", "", k), el("dd", "", v));

    const parts: HTMLElement[] = [summary];
    if (this.filter === "all") {
      const files = await this.hooks.markers(report);
      if (run !== this.run) return;
      parts.push(...this.everything(files));
      this.body.replaceChildren(...parts);
      return;
    }
    const errors = report.findings.filter((f) => f.severity === "error").length;
    parts.push(
      el(
        "h3",
        "group-heading",
        report.findings.length ? `Findings · ${errors} error(s), ${report.findings.length - errors} warning(s)` : "Findings",
      ),
    );
    if (!report.findings.length) parts.push(el("p", "prov-clean", "taura check: no findings. Every number and figure traces to the ledger."));
    for (const f of report.findings) parts.push(this.finding(f));

    parts.push(el("h3", "group-heading", "Publishing now would change"));
    if (!report.changes.length) parts.push(el("p", "prov-clean", "Nothing: the paper matches the code repo's ledger."));
    else {
      const list = el("ul", "prov-changes");
      for (const c of report.changes) list.append(el("li", "", c.text));
      parts.push(list, el("p", "prov-hint", "Run `taura publish` in the code repo to bring these into the paper."));
    }
    this.body.replaceChildren(...parts);
  }

  /** Every \\res number, figure and table taura knows about, by file, with its state. */
  private everything(files: { file: string; markers: Marker[] }[]): HTMLElement[] {
    const all = files.flatMap((f) => f.markers);
    const count = (level: Marker["level"]) => all.filter((m) => m.level === level).length;
    const tally = [
      [count("ok"), "traced"],
      [count("stale"), "changed since publish"],
      [count("untracked"), "no provenance"],
      [count("warn"), "flagged"],
    ]
      .filter(([n]) => n)
      .map(([n, label]) => `${n} ${label}`)
      .join(" · ");
    const parts: HTMLElement[] = [el("h3", "group-heading", all.length ? `In the paper · ${tally}` : "In the paper")];
    if (!all.length) parts.push(el("p", "prov-clean", "No \\res numbers, figures or tables in the paper yet."));
    for (const { file, markers } of files) {
      if (!markers.length) continue;
      parts.push(el("h4", "prov-file", file));
      const list = el("ul", "prov-items");
      for (const m of markers) {
        const li = el("li", "prov-item");
        const row = el("button", "prov-item-row");
        row.title = m.notes.join("\n");
        row.append(el("span", `prov-dot prov-${m.level}`), el("span", "prov-line", String(m.line)), el("span", "prov-note", m.notes[0] ?? ""));
        if (m.notes.length > 1) row.append(el("span", "count", `+${m.notes.length - 1}`));
        row.addEventListener("click", () => this.hooks.jump(file, m.line));
        li.append(row);
        list.append(li);
      }
      parts.push(list);
    }
    return parts;
  }

  private finding(f: TauraFinding): HTMLElement {
    const node = el("article", `card prov-finding sev-${f.severity}`);
    const head = el("div", "card-head");
    head.append(el("span", "card-id", f.id), el("span", "card-meta", f.repo));
    head.append(el("span", "spacer"));
    const at = f.repo === "paper" ? /^(.+):(\d+)$/.exec(f.location) : null;
    if (at) {
      const where = el("button", "card-where", f.location);
      where.addEventListener("click", () => this.hooks.jump(at[1], Number(at[2])));
      head.append(where);
    } else {
      head.append(el("span", "card-meta", f.location));
    }
    node.append(head, el("p", "card-comment", f.message), el("p", "prov-fix", `Fix: ${f.fix}`));
    return node;
  }
}
