import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { readAnnotations } from "./annotations";

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
    bar.append(this.select, importButton, pasteButton, newButton, el("span", "spacer"), filters);

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
      if (card.location && !(e.target as HTMLElement).closest("button, select, input")) {
        this.hooks.jump(card.location.file, card.location.line);
      }
    });
    return node;
  }
}
