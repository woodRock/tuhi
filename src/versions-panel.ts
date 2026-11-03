import * as api from "./api";

export interface VersionsHooks {
  status(text: string, error?: boolean): void;
  /** Saves the editor's changes, so "Current" means what's on screen. */
  saveAll(): Promise<void>;
  /** Builds and opens a latexdiff PDF; `newRev` null compares with the current files. */
  diff(oldRev: string, newRev: string | null): Promise<void>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const CURRENT = "";

/**
 * The Versions tab: named snapshots of the paper (git tags that leave the branch alone), and a
 * comparison of any two versions as changed lines per file or a latexdiff PDF.
 */
export class VersionsPanel {
  private root: string | null = null;
  private snapshots: api.Snapshot[] = [];
  private commits: api.Revision[] = [];
  private list = el("div", "versions-list");
  private from = el("select");
  private to = el("select");
  private result = el("div", "versions-result");
  private name = el("input", "versions-name");
  private body = el("div", "cards");

  constructor(
    container: HTMLElement,
    private hooks: VersionsHooks,
  ) {
    const bar = el("div", "review-bar");
    const name = this.name;
    name.placeholder = "Name, e.g. Submitted v1";
    const take = el("button", "primary", "Take snapshot");
    take.title = "Record every file as it is now under this name (a git tag; your branch and history don't change)";
    const snap = async () => {
      if (!this.root || !name.value.trim()) return name.focus();
      take.disabled = true;
      try {
        await this.hooks.saveAll();
        const snapshot = await api.snapshotCreate(this.root, name.value.trim());
        name.value = "";
        this.hooks.status(`Snapshot "${snapshot.name}" saved as tag tuhi/${snapshot.id}`);
        await this.reload();
      } catch (error) {
        this.hooks.status(String(error), true);
      } finally {
        take.disabled = false;
      }
    };
    take.addEventListener("click", () => void snap());
    name.addEventListener("keydown", (e) => e.key === "Enter" && void snap());
    bar.append(name, take);

    const compare = el("div", "versions-compare");
    const changes = el("button", "", "Changes");
    changes.title = "Lines added and removed in each file";
    changes.addEventListener("click", () => void this.showChanges());
    const pdf = el("button", "", "Diff PDF");
    pdf.title = "A PDF with deletions struck out and additions underlined (latexdiff)";
    pdf.addEventListener("click", async () => {
      if (!this.from.value) return;
      pdf.disabled = true;
      try {
        if (this.to.value === CURRENT) await this.hooks.saveAll();
        await this.hooks.diff(this.from.value, this.to.value || null);
      } finally {
        pdf.disabled = false;
      }
    });
    compare.append(el("span", "card-meta", "Compare"), this.from, el("span", "card-meta", "with"), this.to, changes, pdf);
    this.body.append(el("h3", "group-heading", "Snapshots"), this.list, el("h3", "group-heading", "Compare versions"), compare, this.result);
    container.append(bar, this.body);
  }

  focusName() {
    this.name.focus();
  }

  focusCompare() {
    this.from.scrollIntoView({ block: "center" });
    this.from.focus();
  }

  async setProject(root: string | null) {
    this.root = root;
    this.result.replaceChildren();
    await this.reload();
  }

  async reload() {
    const root = this.root;
    if (!root) return;
    const [snapshots, commits] = await Promise.all([api.snapshotsList(root).catch(() => null), api.gitRevisions(root).catch(() => [])]);
    if (root !== this.root) return;
    if (!snapshots) {
      this.list.replaceChildren(el("p", "review-empty", "This folder isn't a git repository, so there are no versions to keep."));
      return;
    }
    this.snapshots = snapshots;
    this.commits = commits;
    this.render();
  }

  private render() {
    this.list.replaceChildren(
      ...(this.snapshots.length
        ? this.snapshots.map((s) => this.snapshot(s))
        : [el("p", "prov-clean", "No snapshots yet. Take one when you submit, so you can compare against it later.")]),
    );
    const option = (value: string, label: string) => new Option(label, value);
    const versions = [
      ...this.snapshots.map((s) => option(`tuhi/${s.id}`, `${s.name} (${s.date})`)),
      ...this.commits.map((c) => option(c.rev, `${c.date} ${c.subject.slice(0, 48)}${c.refs ? ` [${c.refs}]` : ""}`)),
    ];
    const keepFrom = this.from.value;
    const keepTo = this.to.value;
    this.from.replaceChildren(...versions.map((o) => o.cloneNode(true) as HTMLOptionElement));
    this.to.replaceChildren(option(CURRENT, "the current text"), ...versions);
    if (keepFrom) this.from.value = keepFrom;
    this.to.value = keepTo;
  }

  private snapshot(s: api.Snapshot): HTMLElement {
    const row = el("div", "card versions-snapshot");
    const head = el("div", "card-head");
    head.append(el("span", "card-id", s.name), el("span", "spacer"));
    const compare = el("button", "claim-ask", "Compare with now");
    compare.addEventListener("click", () => {
      this.from.value = `tuhi/${s.id}`;
      this.to.value = CURRENT;
      void this.showChanges();
    });
    const remove = el("button", "claim-ask", "Delete");
    remove.addEventListener("click", async () => {
      if (!this.root || !confirm(`Delete the snapshot "${s.name}"? Its tag is removed; the files in your folder aren't touched.`)) return;
      try {
        await api.snapshotDelete(this.root, s.id);
        await this.reload();
      } catch (error) {
        this.hooks.status(String(error), true);
      }
    });
    head.append(compare, remove);
    row.append(head, el("div", "card-meta", `${s.date} · ${s.commit} · tag tuhi/${s.id}`));
    return row;
  }

  private async showChanges() {
    if (!this.root || !this.from.value) return;
    const to = this.to.value || null;
    this.result.replaceChildren(el("p", "card-meta", "Comparing…"));
    try {
      if (!to) await this.hooks.saveAll();
      const changes = await api.versionChanges(this.root, this.from.value, to);
      const label = (value: string | null) => (value === null ? "the current text" : (this.from.querySelector(`option[value="${CSS.escape(value)}"]`)?.textContent ?? value));
      const heading = el("div", "card-meta", `${label(this.from.value)} → ${label(to)}`);
      if (!changes.length) {
        this.result.replaceChildren(heading, el("p", "prov-clean", "No differences."));
        return;
      }
      const added = changes.reduce((n, c) => n + (c.added ?? 0), 0);
      const removed = changes.reduce((n, c) => n + (c.removed ?? 0), 0);
      const table = el("div", "versions-files");
      for (const c of changes) {
        const row = el("div", "versions-file");
        row.append(
          el("span", "versions-path", c.file),
          c.added === null ? el("span", "card-meta", "binary") : el("span", "versions-add", `+${c.added}`),
          c.removed === null ? el("span") : el("span", "versions-del", `−${c.removed}`),
        );
        table.append(row);
      }
      this.result.replaceChildren(heading, el("div", "card-meta", `${changes.length} file(s), +${added} −${removed} lines`), table);
    } catch (error) {
      this.result.replaceChildren(el("p", "claim-warning", String(error)));
    }
  }
}
