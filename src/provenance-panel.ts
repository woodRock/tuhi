import type { TauraFinding, TauraReport } from "./api";

export interface ProvenanceHooks {
  jump(file: string, line: number): void;
  refresh(): Promise<void>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The Provenance tab: taura's view of the paper, read-only. */
export class ProvenancePanel {
  private body = el("div", "prov-body");

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
    const legend = el("span", "prov-legend");
    for (const [level, label] of [["ok", "traced"], ["stale", "changed since publish"], ["untracked", "no provenance"], ["warn", "flagged"]]) {
      legend.append(el("span", `prov-dot prov-${level}`), label);
    }
    bar.append(refresh, el("span", "spacer"), legend);
    container.append(bar, this.body);
    this.set(null, false);
  }

  /** `linked` false means taura has no code repo paired with this paper. */
  set(report: TauraReport | null, loading: boolean) {
    if (loading) {
      this.body.replaceChildren(el("p", "review-empty", "Asking taura…"));
      return;
    }
    if (!report) {
      this.body.replaceChildren(
        el("p", "review-empty", "This paper isn't paired with a code repo in taura, so there's no provenance to show."),
      );
      return;
    }
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
