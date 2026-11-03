import * as api from "./api";

export interface GitHooks {
  status(text: string, error?: boolean): void;
  /** Saves the editor's changes, so the commit has what's on screen. */
  saveAll(): Promise<void>;
  open(file: string): void;
  /** The number of changed files, for the activity bar's badge. */
  counted(changes: number): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const KIND: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "?": "New", U: "Conflict" };

/** Source control for the paper's repo: changed files, commit, pull and push. */
export class GitPanel {
  private root: string | null = null;
  private state: api.GitStatus | null = null;
  /** Files left out of the next commit; everything else is in. */
  private excluded = new Set<string>();
  private open = new Set<string>();
  private busy = false;
  private run = 0;

  private branch = el("div", "git-branch");
  private message = el("textarea", "git-message");
  private commitButton = el("button", "primary git-commit", "Commit");
  private pullButton = el("button", "", "Pull");
  private pushButton = el("button", "", "Push");
  private list = el("div", "git-files");
  private body = el("div", "git-body");

  constructor(
    container: HTMLElement,
    private hooks: GitHooks,
    versions: HTMLElement,
  ) {
    this.message.placeholder = "Commit message (⌘↩ to commit)";
    this.message.rows = 2;
    this.message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.commit();
      }
    });
    this.message.addEventListener("input", () => this.renderButtons());
    this.commitButton.addEventListener("click", () => void this.commit());
    this.pullButton.title = "Get commits from the remote (fast-forward only)";
    this.pushButton.title = "Send your commits to the remote";
    this.pullButton.addEventListener("click", () => void this.pull());
    this.pushButton.addEventListener("click", () => void this.push());
    const sync = el("div", "git-sync");
    sync.append(this.branch, el("span", "spacer"), this.pullButton, this.pushButton);
    const compose = el("div", "git-compose");
    compose.append(this.message, this.commitButton);
    const versionsHead = el("h4", "view-heading", "Snapshots and comparisons");
    this.body.append(sync, compose, this.list, versionsHead, versions);
    container.append(this.body);
    this.render();
  }

  async setProject(root: string | null) {
    this.root = root;
    this.state = null;
    this.excluded.clear();
    this.open.clear();
    this.message.value = "";
    await this.reload(false);
  }

  /** Reads the repo's status again; `fetch` first asks the remote what's new. */
  async reload(fetch: boolean) {
    const root = this.root;
    if (!root) return;
    const run = ++this.run;
    const state = await api.gitStatus(root, false).catch(() => null);
    if (run !== this.run || root !== this.root) return;
    this.state = state;
    this.render();
    if (fetch && state?.remote) {
      const fetched = await api.gitStatus(root, true).catch(() => null);
      if (run !== this.run || root !== this.root || !fetched) return;
      this.state = fetched;
      this.render();
    }
  }

  focusMessage() {
    this.message.focus();
  }

  private selected(): api.GitChange[] {
    return (this.state?.files ?? []).filter((f) => !this.excluded.has(f.path));
  }

  private async task(label: string, work: (root: string) => Promise<string>) {
    if (!this.root || this.busy) return;
    const root = this.root;
    this.busy = true;
    this.renderButtons();
    this.hooks.status(`${label}…`);
    try {
      const done = await work(root);
      this.hooks.status(done);
    } catch (error) {
      this.hooks.status(String(error), true);
    } finally {
      this.busy = false;
      await this.reload(false);
    }
  }

  async commit() {
    const files = this.selected();
    const message = this.message.value.trim();
    if (!message) return this.message.focus();
    if (!files.length) return;
    await this.task("Committing", async (root) => {
      await this.hooks.saveAll();
      const paths = files.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]));
      const hash = await api.gitCommit(root, message, paths);
      this.message.value = "";
      this.excluded.clear();
      return `Committed ${files.length} file${files.length === 1 ? "" : "s"} as ${hash}`;
    });
  }

  async pull() {
    await this.task("Pulling", async (root) => {
      const out = await api.gitPull(root);
      return out.includes("Already up to date") ? "Already up to date" : "Pulled the latest commits";
    });
  }

  async push() {
    await this.task("Pushing", async (root) => {
      await api.gitPush(root);
      return "Pushed";
    });
  }

  private renderButtons() {
    const s = this.state;
    const n = this.selected().length;
    this.commitButton.textContent = n ? `Commit ${n} file${n === 1 ? "" : "s"}` : "Commit";
    this.commitButton.disabled = this.busy || !n || !this.message.value.trim();
    this.pullButton.disabled = this.busy || !s?.remote;
    this.pushButton.disabled = this.busy || !s?.remote;
    this.pullButton.textContent = s?.behind ? `Pull ${s.behind}` : "Pull";
    this.pushButton.textContent = s?.ahead ? `Push ${s.ahead}` : "Push";
    this.pushButton.classList.toggle("primary", !!s?.ahead && !n);
  }

  private render() {
    const s = this.state;
    this.hooks.counted(s?.files.length ?? 0);
    if (!s?.repo) {
      this.branch.textContent = "";
      this.list.replaceChildren(el("p", "review-empty", this.root ? "This folder isn't a git repository." : "Open a paper to see its changes."));
      this.renderButtons();
      return;
    }
    const where = s.upstream ? `${s.branch} → ${s.upstream}` : s.remote ? `${s.branch} (not pushed yet)` : `${s.branch} (no remote)`;
    this.branch.textContent = where;
    this.branch.title = s.ahead || s.behind ? `${s.ahead} to push, ${s.behind} to pull` : "Up to date with the last fetch";
    if (!s.files.length) {
      this.list.replaceChildren(el("p", "review-empty", s.ahead ? `Nothing to commit. ${s.ahead} commit${s.ahead === 1 ? "" : "s"} to push.` : "Nothing to commit."));
    } else {
      const all = el("label", "git-all");
      const box = el("input");
      box.type = "checkbox";
      box.checked = this.excluded.size === 0;
      box.indeterminate = this.excluded.size > 0 && this.excluded.size < s.files.length;
      box.addEventListener("change", () => {
        if (box.checked) this.excluded.clear();
        else for (const f of s.files) this.excluded.add(f.path);
        this.render();
      });
      all.append(box, `Changes (${s.files.length})`);
      this.list.replaceChildren(all, ...s.files.map((f) => this.row(f)));
    }
    this.renderButtons();
  }

  private row(change: api.GitChange): HTMLElement {
    const row = el("div", "git-file");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !this.excluded.has(change.path);
    box.title = "Include in the next commit";
    box.addEventListener("change", () => {
      if (box.checked) this.excluded.delete(change.path);
      else this.excluded.add(change.path);
      this.render();
    });
    const name = el("button", "git-path");
    const slash = change.path.lastIndexOf("/");
    name.append(change.path.slice(slash + 1));
    if (slash > 0) name.append(el("small", "", change.path.slice(0, slash)));
    name.title = `${change.orig ? `${change.orig} → ` : ""}${change.path}: show the changes`;
    const kind = el("span", `git-kind kind-${change.kind === "?" ? "new" : change.kind}`, change.kind === "?" ? "N" : change.kind);
    kind.title = KIND[change.kind] ?? change.kind;
    const openButton = el("button", "git-open", "Open");
    openButton.disabled = change.kind === "D";
    openButton.addEventListener("click", () => this.hooks.open(change.path));
    const head = el("div", "git-file-head");
    head.append(box, name, openButton, kind);
    row.append(head);
    const showDiff = async () => {
      if (!this.root) return;
      const text = await api.gitDiff(this.root, change.path).catch((e) => String(e));
      row.querySelector(".git-diff")?.remove();
      if (this.open.has(change.path)) row.append(diffView(text));
    };
    name.addEventListener("click", () => {
      if (!this.open.delete(change.path)) this.open.add(change.path);
      void showDiff();
    });
    if (this.open.has(change.path)) void showDiff();
    return row;
  }
}

/** A unified diff as changed lines only, without git's headers. */
function diffView(text: string): HTMLElement {
  const box = el("div", "git-diff");
  const lines = text.split("\n");
  let shown = 0;
  for (const line of lines) {
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    if (shown++ > 400) {
      box.append(el("div", "git-line more", "…"));
      break;
    }
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
    box.append(el("div", `git-line ${kind}`, kind === "hunk" ? line.replace(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@.*/, "line $1") : line.slice(1) || " "));
  }
  if (!shown) box.append(el("div", "git-line same", text.includes("Binary") ? "Binary file changed" : "No text changes"));
  return box;
}
