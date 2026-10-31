import type { Mark } from "./marks";

/** One suggestion or comment as the panel shows it. */
export interface Entry {
  file: string;
  mark: Mark;
  /** The text the mark covers now. */
  text: string;
  line: number;
  /** Its text is gone from the file (changed outside tuhi), so it can't be shown in place. */
  lost: boolean;
}

export interface SuggestionsHooks {
  entries(): Entry[];
  /** The editor's selection, for a new comment or a request to Claude. */
  selection(): { file: string; text: string; line: number } | null;
  jump(entry: Entry): void;
  accept(entries: Entry[]): void;
  reject(entries: Entry[]): void;
  reply(entry: Entry, text: string): void;
  resolve(entry: Entry, resolved: boolean): void;
  comment(text: string): void;
  askClaude(instruction: string): Promise<void>;
  setSuggesting(on: boolean): void;
  suggesting(): boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const clip = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * The Suggestions tab: suggested edits (yours and Claude's) to accept or reject, and comment
 * threads anchored to text. Nothing here is in the .tex until a suggestion is accepted.
 */
export class SuggestionsPanel {
  private filter: "open" | "all" = "open";
  private focused: string | null = null;
  private bar = el("div", "review-bar");
  private composer = el("div", "sugg-composer");
  private counts = el("div", "review-counts");
  private list = el("div", "cards");
  private mode = el("button", "chip");

  constructor(
    container: HTMLElement,
    private hooks: SuggestionsHooks,
  ) {
    this.mode.title = "Suggesting: what you type becomes suggestions (⌘⇧E)";
    this.mode.addEventListener("click", () => {
      this.hooks.setSuggesting(!this.hooks.suggesting());
      this.render();
    });
    const filters = el("div", "filters");
    for (const [value, label] of [["open", "Open"], ["all", "All"]] as const) {
      const chip = el("button", "chip", label);
      chip.dataset.filter = value;
      chip.addEventListener("click", () => {
        this.filter = value;
        this.render();
      });
      filters.append(chip);
    }
    const acceptAll = el("button", "", "Accept all");
    acceptAll.addEventListener("click", () => this.hooks.accept(this.suggestions()));
    const rejectAll = el("button", "", "Reject all");
    rejectAll.addEventListener("click", () => {
      const all = this.suggestions();
      if (all.length && confirm(`Reject ${all.length} suggestion(s)?`)) this.hooks.reject(all);
    });
    this.bar.append(this.mode, filters, el("span", "spacer"), rejectAll, acceptAll);
    container.append(this.bar, this.composer, this.counts, this.list);
    this.closeComposer();
    this.render();
  }

  private suggestions() {
    return this.hooks.entries().filter((e) => e.mark.kind === "suggestion" && !e.lost);
  }

  /** Opens the box for a comment or a request to Claude about the current selection. */
  openComposer(intent: "comment" | "claude") {
    const sel = this.hooks.selection();
    if (!sel || !sel.text.trim()) {
      this.composer.replaceChildren(el("p", "claim-warning", "Select some text in the editor first."));
      this.composer.hidden = false;
      return;
    }
    const quote = el("blockquote", "card-quote", `${clip(sel.text, 220)}`);
    const where = el("div", "card-meta", `${sel.file}:${sel.line}`);
    const input = el("textarea");
    input.rows = 3;
    input.placeholder = intent === "comment" ? "Comment…" : "What should Claude do? (default: tighten and clarify, fix grammar)";
    const actions = el("div", "paste-actions");
    const cancel = el("button", "", "Cancel");
    cancel.addEventListener("click", () => this.closeComposer());
    const comment = el("button", intent === "comment" ? "primary" : "", "Comment");
    comment.addEventListener("click", () => {
      if (!input.value.trim()) return input.focus();
      this.hooks.comment(input.value.trim());
      this.closeComposer();
    });
    const claude = el("button", intent === "claude" ? "primary" : "", "Ask Claude");
    claude.title = "Claude suggests edits to the selection; you accept or reject each";
    claude.addEventListener("click", async () => {
      claude.disabled = comment.disabled = true;
      claude.textContent = "Claude is reading…";
      await this.hooks.askClaude(input.value);
      this.closeComposer();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (intent === "comment" ? comment : claude).click();
      if (e.key === "Escape") this.closeComposer();
    });
    actions.append(cancel, comment, claude);
    this.composer.replaceChildren(where, quote, input, actions);
    this.composer.hidden = false;
    input.focus();
  }

  private closeComposer() {
    this.composer.hidden = true;
    this.composer.replaceChildren();
  }

  /** Highlights the card for the mark under the editor's cursor. */
  focus(id: string | null) {
    this.focused = id;
    for (const card of this.list.querySelectorAll<HTMLElement>(".card")) {
      const on = card.dataset.mark === id;
      card.classList.toggle("focused", on);
      if (on) card.scrollIntoView({ block: "nearest" });
    }
  }

  render() {
    const suggesting = this.hooks.suggesting();
    this.mode.textContent = suggesting ? "✎ Suggesting" : "Editing";
    this.mode.classList.toggle("active", suggesting);
    this.mode.classList.toggle("suggesting", suggesting);
    for (const chip of this.bar.querySelectorAll<HTMLElement>(".filters .chip")) chip.classList.toggle("active", chip.dataset.filter === this.filter);

    const entries = this.hooks.entries();
    const suggestions = entries.filter((e) => e.mark.kind === "suggestion");
    const comments = entries.filter((e) => e.mark.kind === "comment");
    const open = comments.filter((e) => !e.mark.resolved);
    this.counts.textContent = `${suggestions.length} suggestion(s) · ${open.length} open comment(s)${comments.length > open.length ? ` · ${comments.length - open.length} resolved` : ""}`;

    const shown = entries
      .filter((e) => this.filter === "all" || !e.mark.resolved)
      .sort((a, b) => a.file.localeCompare(b.file) || a.mark.from - b.mark.from);
    if (!shown.length) {
      this.list.replaceChildren(
        el(
          "p",
          "review-empty",
          "No suggestions or comments. Turn on Suggesting to make edits others can accept, or select text and press ⌘⌥M to comment or ⌘⌥K to ask Claude.",
        ),
      );
      return;
    }
    this.list.replaceChildren(...shown.map((e) => (e.mark.kind === "suggestion" ? this.suggestion(e) : this.comment(e))));
    this.focus(this.focused);
  }

  private card(entry: Entry, className: string) {
    const card = el("div", `card ${className}${entry.lost ? " lost" : ""}`);
    card.dataset.mark = entry.mark.id;
    const head = el("div", "card-head");
    const where = el("button", "card-where", entry.line ? `${entry.file}:${entry.line}` : entry.file);
    where.disabled = entry.lost;
    where.addEventListener("click", () => this.hooks.jump(entry));
    head.append(where, el("span", "card-meta", `${entry.mark.author} · ${entry.mark.created}`), el("span", "spacer"));
    card.append(head);
    if (entry.lost) card.append(el("p", "claim-warning", "Its text has changed outside tuhi, so it can't be shown in place."));
    return { card, head };
  }

  private suggestion(entry: Entry): HTMLElement {
    const { mark, text } = entry;
    const { card } = this.card(entry, `sugg by-${mark.author}`);
    const body = el("p", "sugg-diff");
    if (text) body.append(el("del", "", clip(text)));
    if (text && mark.insert) body.append(" → ");
    if (mark.insert) body.append(el("ins", "", clip(mark.insert)));
    card.append(body);
    if (mark.note) card.append(el("div", "card-meta", mark.note));
    const actions = el("div", "hunk-actions");
    const reject = el("button", "", "Reject");
    reject.addEventListener("click", () => this.hooks.reject([entry]));
    const accept = el("button", "primary", "Accept");
    accept.disabled = entry.lost;
    accept.addEventListener("click", () => this.hooks.accept([entry]));
    actions.append(reject, accept);
    card.append(actions);
    return card;
  }

  private comment(entry: Entry): HTMLElement {
    const { mark, text } = entry;
    const { card, head } = this.card(entry, `comment${mark.resolved ? " resolved" : ""}`);
    const resolve = el("button", "claim-ask", mark.resolved ? "Reopen" : "Resolve");
    resolve.addEventListener("click", () => this.hooks.resolve(entry, !mark.resolved));
    head.append(resolve);
    if (text) card.append(el("blockquote", "card-quote", clip(text)));
    for (const message of mark.thread ?? []) {
      const row = el("div", "thread-message");
      row.append(el("span", "thread-author", message.author), el("span", "card-meta", message.date), el("p", "card-comment", message.text));
      card.append(row);
    }
    if (!mark.resolved) {
      const reply = el("input", "thread-reply");
      reply.placeholder = "Reply…";
      reply.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && reply.value.trim()) this.hooks.reply(entry, reply.value.trim());
      });
      card.append(reply);
    }
    return card;
  }
}
