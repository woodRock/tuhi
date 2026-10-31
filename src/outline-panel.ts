import type { Budget } from "./checks";
import type { Outline, Section } from "./outline";

export interface OutlineHooks {
  jump(file: string, line: number): void;
  setBudget(key: string, budget: Budget): void;
  refresh(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmt = (n: number) => n.toLocaleString("en");
const pages = (p: number | undefined) => (p === undefined ? "" : p < 0.95 ? `${(p * 100).toFixed(0)}% p` : `${p.toFixed(1)} pp`);

/** The Outline tab: each section's words and pages against the budget set for it. */
export class OutlinePanel {
  private list = el("div", "cards");
  private outline: Outline | null = null;
  private budgets: Record<string, Budget> = {};
  private totalPages: number | null = null;
  private note = el("div", "review-counts");

  constructor(
    container: HTMLElement,
    private hooks: OutlineHooks,
  ) {
    const bar = el("div", "review-bar");
    const refresh = el("button", "", "Recount");
    refresh.title = "Count again (also after each compile and save)";
    refresh.addEventListener("click", () => this.hooks.refresh());
    bar.append(el("span", "card-meta", "Section budgets"), el("span", "spacer"), refresh);
    container.append(bar, this.note, this.list);
    this.render();
  }

  set(outline: Outline | null, budgets: Record<string, Budget>, totalPages: number | null) {
    this.outline = outline;
    this.budgets = budgets;
    this.totalPages = totalPages;
    this.render();
  }

  private render() {
    if (!this.outline?.sections.length) {
      this.note.textContent = "";
      this.list.replaceChildren(el("p", "review-empty", this.outline ? "No sections found." : "Open a paper to see its sections."));
      return;
    }
    const measured = this.outline.sections.some((s) => s.pages !== undefined);
    this.note.textContent = `Words in the text, not counting tables, maths or references.${measured ? " Pages measured in the last PDF." : " Compile to measure pages."}`;
    const total: Section = {
      level: -1,
      title: "Whole paper",
      key: "@total",
      file: "",
      line: 0,
      own: this.outline.total,
      words: this.outline.total,
      pages: this.totalPages ?? undefined,
    };
    this.list.replaceChildren(this.row(total), ...this.outline.sections.map((s) => this.row(s)));
  }

  private row(section: Section): HTMLElement {
    const budget = this.budgets[section.key] ?? {};
    const row = el("div", `outline-row level-${Math.max(0, section.level)}${section.level === -1 ? " outline-total" : ""}`);
    const title = el("button", "outline-title", section.title);
    title.disabled = !section.file;
    title.addEventListener("click", () => this.hooks.jump(section.file, section.line));
    const counts = el("span", "outline-counts", [`${fmt(section.words)} w`, pages(section.pages)].filter(Boolean).join(" · "));

    const input = (unit: "words" | "pages") => {
      const box = el("input", "outline-budget");
      box.type = "number";
      box.min = "0";
      box.step = unit === "pages" ? "0.5" : "50";
      box.placeholder = unit === "words" ? "words" : "pages";
      box.title = `Budget in ${unit}`;
      box.value = budget[unit] ? String(budget[unit]) : "";
      box.addEventListener("change", () => {
        const value = Number(box.value);
        this.hooks.setBudget(section.key, { ...budget, [unit]: value > 0 ? value : null });
      });
      return box;
    };
    // Abstracts are limited in words, never pages.
    const inputs = el("span", "outline-inputs");
    inputs.append(input("words"));
    if (section.key !== "@abstract") inputs.append(input("pages"));

    const head = el("div", "outline-head");
    head.append(title, counts, inputs);
    row.append(head);
    for (const [unit, have] of [["words", section.words], ["pages", section.pages]] as const) {
      const target = budget[unit];
      if (!target || have === undefined) continue;
      const ratio = have / target;
      const bar = el("div", `outline-bar ${ratio > 1 ? "over" : ratio > 0.9 ? "near" : "under"}`);
      const fill = el("div", "outline-fill");
      fill.style.width = `${Math.min(100, ratio * 100)}%`;
      const left = target - have;
      bar.title = unit === "words" ? `${fmt(have)} of ${fmt(target)} words` : `${have.toFixed(1)} of ${target} pages`;
      bar.append(fill);
      const amount = unit === "words" ? fmt(Math.round(Math.abs(left))) : Math.abs(left).toFixed(1);
      const noun = amount === "1" ? unit.slice(0, -1) : unit;
      const label = el("span", "outline-left", `${amount} ${noun} ${left >= 0 ? "left" : "over"}`);
      const line = el("div", "outline-progress");
      line.append(bar, label);
      row.append(line);
    }
    return row;
  }
}
