import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { readAnnotations } from "./annotations";
import { wordDiff } from "./diff";

export type Status = "open" | "proposed" | "accepted" | "wontfix";

export interface Card {
  /** "R1.3": group and position within it. */
  id: string;
  group: string;
  source: "pdf" | "text";
  /** Annotation type for PDF comments ("Highlight", "StrikeOut", "Text"…), "Comment" for pasted ones. */
  kind: string;
  /** Root-relative path of the reviewer's PDF this came from. */
  pdf?: string;
  page?: number;
  x?: number;
  y?: number;
  quote?: string;
  comment: string;
  author?: string;
  location: api.Located | null;
  status: Status;
  /** Why a comment won't be addressed; goes into the response letter. */
  reason?: string;
  /** Claude's draft: edits to review hunk by hunk. */
  proposal?: api.Proposal;
  /** The reply to the reviewer, starting from Claude's draft. */
  response?: string;
}

/** One round of revision: every reviewer's comments for one resubmission. */
export interface Review {
  id: string;
  label: string;
  created: string;
  cards: Card[];
}

export interface ReviewHooks {
  jump(file: string, line: number): void;
  /** The editor's current file and line, for placing a comment by hand. */
  cursor(): { file: string; line: number } | null;
  status(text: string, error?: boolean): void;
  /** Replaces `before` with `after` in the editor; returns the line changed, or null if not found. */
  applyEdit(file: string, before: string, after: string, line: number): Promise<number | null>;
}

const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  proposed: "Proposed",
  accepted: "Accepted",
  wontfix: "Won't fix",
};

type Filter = "all" | "open" | "done";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The Review tab: imports reviewer comments and tracks each one to resolution. */
export class ReviewPanel {
  private root: string | null = null;
  private main: string | null = null;
  private reviews: Review[] = [];
  private review: Review | null = null;
  private filter: Filter = "all";
  private saveTimer = 0;
  /** Cards with a Claude session running. */
  private drafting = new Set<Card>();

  private select = el("select");
  private counts = el("span", "review-counts");
  private pasteBox = el("div", "paste-box");
  private pasteText = el("textarea");
  private list = el("div", "cards");

  constructor(
    container: HTMLElement,
    private hooks: ReviewHooks,
  ) {
    const bar = el("div", "review-bar");
    const importButton = el("button", "", "Import PDF…");
    importButton.title = "Import a reviewer's annotated PDF";
    const pasteButton = el("button", "", "Paste comments…");
    pasteButton.title = "Paste the text of a review letter";
    const newButton = el("button", "", "New round");
    const draftAllButton = el("button", "", "Draft all open");
    draftAllButton.title = "Ask Claude to draft a change for every open comment without one";
    const filters = el("div", "filters");
    for (const f of ["all", "open", "done"] as Filter[]) {
      const b = el("button", f === this.filter ? "chip active" : "chip", f === "all" ? "All" : f === "open" ? "To do" : "Done");
      b.addEventListener("click", () => {
        this.filter = f;
        filters.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
        this.render();
      });
      filters.append(b);
    }
    bar.append(this.select, importButton, pasteButton, newButton, draftAllButton, el("span", "spacer"), filters);

    this.pasteText.placeholder =
      "Paste the reviewers' comments. Numbered items, bullets or paragraphs each become a comment; headings like “Reviewer 2” group them.";
    const add = el("button", "primary", "Add comments");
    const cancel = el("button", "", "Cancel");
    const actions = el("div", "paste-actions");
    actions.append(cancel, add);
    this.pasteBox.append(this.pasteText, actions);
    this.pasteBox.hidden = true;

    container.append(bar, this.counts, this.pasteBox, this.list);

    this.select.addEventListener("change", () => {
      this.review = this.reviews.find((r) => r.id === this.select.value) ?? null;
      this.render();
    });
    importButton.addEventListener("click", () => void this.importPdf().catch((e) => this.hooks.status(String(e), true)));
    pasteButton.addEventListener("click", () => {
      this.pasteBox.hidden = false;
      this.pasteText.focus();
    });
    cancel.addEventListener("click", () => (this.pasteBox.hidden = true));
    add.addEventListener("click", () => void this.addPasted().catch((e) => this.hooks.status(String(e), true)));
    draftAllButton.addEventListener("click", () => void this.draftAll());
    newButton.addEventListener("click", () => {
      if (!this.root) return;
      this.review = this.newReview();
      this.reviews.push(this.review);
      this.save();
      this.render();
    });
    this.render();
  }

  async setProject(root: string, main: string | null) {
    this.root = root;
    this.main = main;
    this.reviews = await api.listReviews<Review>(root);
    this.review = this.reviews.at(-1) ?? null;
    this.render();
  }

  private newReview(): Review {
    const n = this.reviews.length + 1;
    return { id: `revision-${n}-${Date.now().toString(36)}`, label: `Revision ${n}`, created: new Date().toISOString(), cards: [] };
  }

  private current(): Review {
    if (!this.review) {
      this.review = this.newReview();
      this.reviews.push(this.review);
    }
    return this.review;
  }

  /** The next free reviewer group, e.g. "R3" when R1 and R2 exist. */
  private nextGroup(review: Review): string {
    const used = new Set(review.cards.map((c) => c.group));
    let n = 1;
    while (used.has(`R${n}`)) n++;
    return `R${n}`;
  }

  private addCards(review: Review, cards: Omit<Card, "id">[]) {
    for (const card of cards) {
      const n = review.cards.filter((c) => c.group === card.group).length + 1;
      review.cards.push({ ...card, id: `${card.group}.${n}` });
    }
  }

  private async importPdf() {
    if (!this.root) return;
    const source = await open({ title: "Import a reviewer's annotated PDF", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof source !== "string") return;
    const review = this.current();
    const group = this.nextGroup(review);
    this.hooks.status("Reading annotations…");
    const pdf = await api.importReviewPdf(this.root, `${review.id}-${group}`, source);
    const marks = await readAnnotations(await api.readBytes(this.root, pdf));
    if (!marks.length) {
      this.hooks.status("No comments found in that PDF. If it's scanned or handwritten, paste the comments instead.", true);
      return;
    }
    const locations = await this.locate(marks.map((m) => ({ quote: m.quote, page: m.page, x: m.x, y: m.y })));
    this.addCards(
      review,
      marks.map((m, i) => ({
        group,
        source: "pdf" as const,
        kind: m.kind,
        pdf,
        page: m.page,
        x: m.x,
        y: m.y,
        quote: m.quote,
        comment: m.comment,
        author: m.author,
        location: locations[i],
        status: "open" as const,
      })),
    );
    this.finishImport(review, marks.length, locations);
  }

  private async addPasted() {
    if (!this.root) return;
    const letter = this.pasteText.value;
    const comments = await api.splitComments(letter);
    if (!comments.length) return;
    const review = this.current();
    const fallback = this.nextGroup(review);
    const locations = await this.locate(comments.map((c) => ({ quote: c.quote })));
    this.addCards(
      review,
      comments.map((c, i) => ({
        group: c.group ?? fallback,
        source: "text" as const,
        kind: "Comment",
        quote: c.quote ?? undefined,
        comment: c.text,
        location: locations[i],
        status: "open" as const,
      })),
    );
    this.pasteText.value = "";
    this.pasteBox.hidden = true;
    this.finishImport(review, comments.length, locations);
  }

  private async locate(queries: api.LocateQuery[]) {
    if (!this.root || !this.main) return queries.map(() => null);
    return api.locateComments(this.root, this.main, queries);
  }

  private finishImport(review: Review, count: number, locations: (api.Located | null)[]) {
    const placed = locations.filter(Boolean).length;
    this.hooks.status(`Added ${count} comment${count === 1 ? "" : "s"}, ${placed} placed in the source`);
    this.review = review;
    this.save();
    this.render();
  }

  private async draft(card: Card) {
    if (!this.root || this.drafting.has(card)) return;
    const root = this.root;
    this.drafting.add(card);
    this.render();
    try {
      const { proposal: _old, response: _reply, ...context } = card;
      card.proposal = await api.draftChange(root, context);
      card.response = card.proposal.response;
      if (card.status === "open") card.status = "proposed";
      this.hooks.status(`Drafted ${card.id} ($${card.proposal.cost_usd.toFixed(2)})`);
    } catch (error) {
      this.hooks.status(`${card.id}: ${error}`, true);
    } finally {
      this.drafting.delete(card);
      this.save();
      this.render();
    }
  }

  /** Drafts every open card without a proposal, two Claude sessions at a time. */
  private async draftAll() {
    const queue = this.review?.cards.filter((c) => c.status === "open" && !c.proposal) ?? [];
    if (!queue.length) {
      this.hooks.status("No open comments need a draft");
      return;
    }
    const worker = async () => {
      for (let card = queue.shift(); card; card = queue.shift()) await this.draft(card);
    };
    await Promise.all([worker(), worker()]);
  }

  /** Accepting applies the hunk in the editor; undoing an accepted hunk reverses it. */
  private async decide(card: Card, hunk: api.Hunk, decision: "accept" | "reject" | "undo") {
    if (decision === "accept") {
      const line = await this.hooks.applyEdit(hunk.file, hunk.before, hunk.after, hunk.line);
      if (line === null) {
        hunk.state = "stale";
        this.hooks.status(`${card.id}: the text this edit replaces has changed. Redraft the comment.`, true);
      } else {
        hunk.state = "accepted";
        hunk.line = line;
      }
    } else if (decision === "reject") {
      hunk.state = "rejected";
    } else {
      if (hunk.state === "accepted") {
        const line = await this.hooks.applyEdit(hunk.file, hunk.after, hunk.before, hunk.line);
        if (line === null) {
          this.hooks.status(`${card.id}: couldn't find the accepted text to undo; it has been edited since.`, true);
          return;
        }
      }
      hunk.state = "pending";
    }
    this.updateStatus(card);
    this.save();
    this.render();
  }

  /** A card is accepted once every hunk is decided and at least one was accepted. */
  private updateStatus(card: Card) {
    const hunks = card.proposal?.hunks ?? [];
    if (card.status === "wontfix" || !hunks.length) return;
    if (hunks.some((h) => h.state === "pending" || h.state === "stale")) card.status = "proposed";
    else if (hunks.some((h) => h.state === "accepted")) card.status = "accepted";
    else card.status = "open";
  }

  private save() {
    const root = this.root;
    const review = this.review;
    if (!root || !review) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      api.saveReview(root, review).catch((e) => this.hooks.status(`Couldn't save review: ${e}`, true));
    }, 300);
  }

  private render() {
    this.select.replaceChildren(...this.reviews.map((r) => new Option(r.label, r.id, false, r === this.review)));
    this.select.hidden = this.reviews.length === 0;

    const cards = this.review?.cards ?? [];
    const tally = (s: Status) => cards.filter((c) => c.status === s).length;
    this.counts.textContent = cards.length
      ? (["open", "proposed", "accepted", "wontfix"] as Status[]).map((s) => `${tally(s)} ${STATUS_LABELS[s].toLowerCase()}`).join(" · ")
      : "";

    if (!this.root) {
      this.list.replaceChildren(el("p", "review-empty", "Open a paper first."));
      return;
    }
    if (!cards.length) {
      this.list.replaceChildren(
        el("p", "review-empty", "Import a reviewer's annotated PDF, or paste the comments from a review letter."),
      );
      return;
    }

    const visible = cards.filter((c) =>
      this.filter === "all" ? true : this.filter === "open" ? c.status === "open" || c.status === "proposed" : c.status === "accepted" || c.status === "wontfix",
    );
    const groups = [...new Set(visible.map((c) => c.group))];
    this.list.replaceChildren(
      ...groups.flatMap((group) => {
        const inGroup = visible.filter((c) => c.group === group);
        const heading = el("h3", "group-heading", `${group} · ${inGroup.length}`);
        return [heading, ...inGroup.map((c) => this.renderCard(c))];
      }),
    );
  }

  private renderCard(card: Card): HTMLElement {
    const node = el("article", `card status-${card.status}`);
    const head = el("div", "card-head");
    head.append(el("span", "card-id", card.id));
    const meta = [card.kind !== "Comment" ? card.kind : "", card.page ? `p. ${card.page}` : "", card.author ?? ""].filter(Boolean);
    if (meta.length) head.append(el("span", "card-meta", meta.join(" · ")));
    head.append(el("span", "spacer"));

    if (card.location) {
      const where = el("button", "card-where", `${card.location.file}:${card.location.line}`);
      where.title = {
        text: `Found the quoted text (${Math.round(card.location.score * 100)}% of words)`,
        position: "Placed by page position; check it's the right spot",
        manual: "Placed by hand",
      }[card.location.method];
      if (card.location.method === "position" || card.location.score < 0.85) where.classList.add("approx");
      where.addEventListener("click", () => this.hooks.jump(card.location!.file, card.location!.line));
      head.append(where);
    }
    const place = el("button", "card-place", card.location ? "Move here" : "Place at cursor");
    place.title = "Link this comment to the editor's current line";
    place.addEventListener("click", () => {
      const cursor = this.hooks.cursor();
      if (!cursor) return;
      card.location = { file: cursor.file, line: cursor.line, method: "manual", score: 1 };
      this.save();
      this.render();
    });
    head.append(place);

    const status = el("select", "card-status");
    for (const s of Object.keys(STATUS_LABELS) as Status[]) status.append(new Option(STATUS_LABELS[s], s, false, s === card.status));
    status.addEventListener("change", () => {
      card.status = status.value as Status;
      this.save();
      this.render();
    });
    head.append(status);
    node.append(head);

    if (card.quote) node.append(el("blockquote", "card-quote", card.quote));
    node.append(el("p", "card-comment", card.comment));

    if (card.proposal) node.append(this.renderProposal(card, card.proposal));
    else if (card.status === "open" || card.status === "proposed") {
      const draft = el("button", "card-draft", this.drafting.has(card) ? "Drafting…" : "Draft change");
      draft.disabled = this.drafting.has(card);
      draft.title = "Ask Claude to draft an edit and a reply for this comment";
      draft.addEventListener("click", () => void this.draft(card));
      node.append(draft);
    }

    if (card.status === "wontfix") {
      const reason = el("input", "card-reason");
      reason.placeholder = "Why not? This goes in the response letter.";
      reason.value = card.reason ?? "";
      reason.addEventListener("input", () => {
        card.reason = reason.value;
        this.save();
      });
      node.append(reason);
    }

    node.addEventListener("click", (e) => {
      if (card.location && !(e.target as HTMLElement).closest("button, select, input, textarea, .proposal")) {
        this.hooks.jump(card.location.file, card.location.line);
      }
    });
    return node;
  }

  private renderProposal(card: Card, proposal: api.Proposal): HTMLElement {
    const box = el("div", "proposal");
    box.append(el("p", "proposal-summary", proposal.summary));
    if (proposal.author_input.trim()) {
      const needs = el("p", "proposal-needs");
      needs.append(el("strong", "", "Needs you: "), proposal.author_input);
      box.append(needs);
    }

    for (const hunk of proposal.hunks) {
      const node = el("div", `hunk hunk-${hunk.state}`);
      const head = el("div", "hunk-head");
      const where = el("button", "card-where", `${hunk.file}:${hunk.line}`);
      where.addEventListener("click", () => this.hooks.jump(hunk.file, hunk.line));
      head.append(where, el("span", "hunk-why", hunk.why));
      node.append(head);

      const diff = el("div", "hunk-diff");
      for (const seg of wordDiff(hunk.before, hunk.after)) {
        diff.append(seg.kind === "same" ? document.createTextNode(seg.text) : el(seg.kind, "", seg.text));
      }
      node.append(diff);

      const actions = el("div", "hunk-actions");
      const button = (label: string, run: () => void, className = "") => {
        const b = el("button", className, label);
        b.addEventListener("click", run);
        actions.append(b);
      };
      if (hunk.state === "pending") {
        button("Accept", () => void this.decide(card, hunk, "accept"), "primary");
        button("Edit", () => {
          const editor = el("textarea", "hunk-edit");
          editor.value = hunk.after;
          const save = el("button", "primary", "Save");
          save.addEventListener("click", () => {
            hunk.after = editor.value;
            this.save();
            this.render();
          });
          actions.replaceChildren(save);
          diff.replaceWith(editor);
          editor.focus();
        });
        button("Reject", () => void this.decide(card, hunk, "reject"));
      } else {
        const label = { accepted: "Accepted", rejected: "Rejected", stale: "Out of date" }[hunk.state];
        actions.append(el("span", "hunk-state", label));
        button(hunk.state === "accepted" ? "Undo" : "Reopen", () => void this.decide(card, hunk, "undo"));
      }
      node.append(actions);
      box.append(node);
    }

    if (proposal.unmatched.length) {
      const details = el("details", "proposal-unmatched");
      details.append(el("summary", "", `${proposal.unmatched.length} suggested edit(s) didn't match the source`));
      for (const u of proposal.unmatched) details.append(el("pre", "", u));
      box.append(details);
    }

    const reply = el("textarea", "proposal-reply");
    reply.placeholder = "Reply to the reviewer";
    reply.value = card.response ?? proposal.response;
    reply.addEventListener("input", () => {
      card.response = reply.value;
      this.save();
    });
    const replyLabel = el("label", "proposal-label", "Reply to reviewer");
    box.append(replyLabel, reply);

    const foot = el("div", "proposal-foot");
    foot.append(el("span", "proposal-cost", `Drafted by Claude · $${proposal.cost_usd.toFixed(2)}`), el("span", "spacer"));
    const redraft = el("button", "", this.drafting.has(card) ? "Drafting…" : "Redraft");
    redraft.disabled = this.drafting.has(card) || proposal.hunks.some((h) => h.state === "accepted");
    redraft.title = redraft.disabled ? "Undo accepted edits before redrafting" : "Ask Claude again";
    redraft.addEventListener("click", () => void this.draft(card));
    foot.append(redraft);
    box.append(foot);
    return box;
  }
}
