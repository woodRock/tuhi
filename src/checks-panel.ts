import type { CheckItem, Finding, Settings } from "./checks";

export interface ChecksHooks {
  jump(file: string, line: number): void;
  fix(findings: Finding[]): void;
  saveSettings(settings: Settings): void;
  rerun(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const ICON: Record<string, string> = { ok: "✓", warn: "!", fail: "✕", info: "·", off: "–" };

/** The Checks tab: the pre-submission checklist, then consistency findings with fixes. */
export class ChecksPanel {
  private settingsRow = el("div", "checks-settings");
  private list = el("div", "cards");
  private open = new Set<string>();
  private items: CheckItem[] = [];
  private lint: Finding[] = [];
  private showInfo = false;

  constructor(
    container: HTMLElement,
    private hooks: ChecksHooks,
  ) {
    const bar = el("div", "review-bar");
    const rerun = el("button", "", "Run checks");
    rerun.title = "Check again (also runs after each compile)";
    rerun.addEventListener("click", () => this.hooks.rerun());
    bar.append(el("span", "card-meta", "Before you submit"), el("span", "spacer"), rerun);
    container.append(bar, this.settingsRow, this.list);
  }

  setSettings(settings: Settings) {
    const limit = el("input", "checks-limit");
    limit.type = "number";
    limit.min = "1";
    limit.placeholder = "none";
    limit.value = settings.pageLimit ? String(settings.pageLimit) : "";
    const excludes = el("input");
    excludes.type = "checkbox";
    excludes.checked = settings.limitExcludesReferences;
    const blind = el("input");
    blind.type = "checkbox";
    blind.checked = settings.doubleBlind;
    const save = () =>
      this.hooks.saveSettings({
        pageLimit: Number(limit.value) > 0 ? Math.round(Number(limit.value)) : null,
        limitExcludesReferences: excludes.checked,
        doubleBlind: blind.checked,
      });
    limit.addEventListener("change", save);
    excludes.addEventListener("change", save);
    blind.addEventListener("change", save);
    const label = (text: string, input: HTMLElement, after = false) => {
      const l = el("label");
      if (after) l.append(input, ` ${text}`);
      else l.append(`${text} `, input);
      return l;
    };
    this.settingsRow.replaceChildren(label("Page limit", limit), label("not counting references", excludes, true), label("Double-blind", blind, true));
  }

  set(items: CheckItem[], lint: Finding[]) {
    this.items = items;
    this.lint = lint;
    this.render();
  }

  private render() {
    const parts: HTMLElement[] = [];
    for (const item of this.items) parts.push(this.item(item));

    const shown = this.lint.filter((f) => this.showInfo || f.severity !== "info");
    const heading = el("h3", "group-heading", `Consistency · ${this.lint.length} finding(s)`);
    const toggle = el("button", "chip", this.showInfo ? "Hide suggestions" : `Show all (${this.lint.length - this.lint.filter((f) => f.severity !== "info").length} minor)`);
    toggle.addEventListener("click", () => {
      this.showInfo = !this.showInfo;
      this.render();
    });
    const head = el("div", "checks-lint-head");
    head.append(heading, el("span", "spacer"), toggle);
    parts.push(head);
    if (!shown.length) parts.push(el("p", "prov-clean", this.lint.length ? "Only minor suggestions." : "Spelling, acronyms, notation and te reo Māori all consistent."));
    const groups = new Map<string, Finding[]>();
    for (const f of shown) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
    for (const [group, findings] of groups) {
      const box = el("div", "card checks-group");
      const top = el("div", "card-head");
      top.append(el("span", "card-id", group), el("span", "card-meta", `${findings.length}`), el("span", "spacer"));
      const fixable = findings.filter((f) => f.fix);
      if (fixable.length > 1) {
        const all = el("button", "claim-ask", `Fix all ${fixable.length}`);
        all.addEventListener("click", () => this.hooks.fix(fixable));
        top.append(all);
      }
      box.append(top);
      for (const f of findings) box.append(this.finding(f));
      parts.push(box);
    }
    this.list.replaceChildren(...parts);
  }

  private item(item: CheckItem): HTMLElement {
    const card = el("div", `card check check-${item.status}`);
    const head = el("div", "card-head");
    head.append(el("span", `check-icon check-${item.status}`, ICON[item.status]), el("span", "card-id", item.title));
    card.append(head, el("div", "card-meta check-summary", item.summary));
    if (item.findings.length) {
      const expanded = this.open.has(item.title);
      const more = el("button", "card-place", expanded ? "Hide" : `Show ${item.findings.length}`);
      more.addEventListener("click", () => {
        if (expanded) this.open.delete(item.title);
        else this.open.add(item.title);
        this.render();
      });
      head.append(el("span", "spacer"), more);
      if (expanded) for (const f of item.findings.slice(0, 100)) card.append(this.finding(f));
    }
    return card;
  }

  private finding(f: Finding): HTMLElement {
    const row = el("div", `check-finding sev-${f.severity}`);
    const where = el("button", "card-where", f.line ? `${f.file}:${f.line}` : f.file);
    where.disabled = !f.line;
    where.addEventListener("click", () => this.hooks.jump(f.file, f.line));
    row.append(where, el("span", "check-message", f.message));
    if (f.fix) {
      const fix = el("button", "claim-ask", "Fix");
      fix.title = `Replace "${f.fix.find}" with "${f.fix.replace}"`;
      fix.addEventListener("click", () => this.hooks.fix([f]));
      row.append(fix);
    }
    return row;
  }
}
