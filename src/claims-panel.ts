import * as api from "./api";
import type { Claim, ClaimCheck, ClaimsDocument, Judgement, ProposedVerdict } from "./api";

export interface ClaimsHooks {
  /** `file` is relative to the main .tex file's folder, as ruru gives it. */
  jump(file: string, line: number): void;
  status(text: string, error?: boolean): void;
  /** Called after the claims reload, so the editor can show problem claims. */
  changed(doc: ClaimsDocument | null): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** States that need a look: no verdict yet, or one that says the citation is weak. */
const ATTENTION = new Set(["unchecked", "outdated", "partial", "unsupported", "not-found"]);
const STATE_LABEL: Record<string, string> = {
  supported: "supported",
  partial: "partial",
  unsupported: "unsupported",
  "not-found": "not found",
  background: "background",
  unchecked: "unchecked",
  outdated: "outdated",
};

interface Proposal {
  verdict: ProposedVerdict;
  from: string;
  error?: string;
}

/**
 * The Claims tab: every sentence that cites something, with ruru's verdict per cited key.
 * Claude proposes verdicts from the cited paper's text; the author records the ones they accept.
 */
export class ClaimsPanel {
  private root: string | null = null;
  private doc: ClaimsDocument | null = null;
  private loading = false;
  private filter: "attention" | "all" = "attention";
  private proposals = new Map<string, Proposal>();
  private busy = new Set<string>();
  private spent = 0;
  private bar = el("div", "review-bar");
  private counts = el("div", "review-counts");
  private list = el("div", "cards");
  private checkAll = el("button", "", "Check unchecked");
  private recordAll = el("button", "", "Record all");

  constructor(
    container: HTMLElement,
    private hooks: ClaimsHooks,
  ) {
    const filters = el("div", "filters");
    for (const [value, label] of [["attention", "Needs attention"], ["all", "All"]] as const) {
      const chip = el("button", "chip", label);
      chip.dataset.filter = value;
      chip.addEventListener("click", () => {
        this.filter = value;
        this.render();
      });
      filters.append(chip);
    }
    this.checkAll.title = "Ask Claude about every unchecked or outdated citation, one cited paper at a time";
    this.checkAll.addEventListener("click", () => void this.checkUnchecked());
    this.recordAll.title = "Record every proposed verdict in ruru";
    this.recordAll.addEventListener("click", () => void this.recordEvery());
    const refresh = el("button", "", "Refresh");
    refresh.title = "Read the claims again (from the saved files)";
    refresh.addEventListener("click", () => void this.reload());
    this.bar.append(filters, el("span", "spacer"), this.recordAll, this.checkAll, refresh);
    container.append(this.bar, this.counts, this.list);
    this.render();
  }

  async setProject(root: string | null) {
    this.root = root;
    this.doc = null;
    this.proposals.clear();
    this.busy.clear();
    this.spent = 0;
    await this.reload();
  }

  async reload() {
    const root = this.root;
    if (!root) return this.render();
    this.loading = true;
    this.render();
    const doc = await api.claimsList(root).catch((e) => {
      this.hooks.status(String(e), true);
      return null;
    });
    if (root !== this.root) return;
    this.doc = doc;
    this.loading = false;
    this.render();
    this.hooks.changed(doc);
  }

  // Claude

  private async checkUnchecked() {
    if (!this.doc) return;
    const byKey = new Map<string, string[]>();
    for (const claim of this.doc.claims) {
      for (const check of claim.checks) {
        if ((check.state === "unchecked" || check.state === "outdated") && check.kind && !this.proposals.has(id(claim, check.key))) {
          byKey.set(check.key, [...(byKey.get(check.key) ?? []), claim.id]);
        }
      }
    }
    if (!byKey.size) {
      this.hooks.status("Every citation has a verdict");
      return;
    }
    // One call per cited paper, two at a time.
    const queue = [...byKey];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.judge(next[0], next[1]);
    };
    await Promise.all([worker(), worker()]);
  }

  private async judge(key: string, claims: string[]) {
    if (!this.root || this.busy.has(key)) return;
    const root = this.root;
    this.busy.add(key);
    this.render();
    this.hooks.status(`Claude is reading ${key}…`);
    try {
      const judgement: Judgement = await api.claimsJudge(root, key, claims);
      if (root !== this.root) return;
      this.spent += judgement.cost_usd;
      for (const verdict of judgement.verdicts) {
        this.proposals.set(`${verdict.claim}|${key}`, { verdict, from: judgement.from });
      }
      this.hooks.status(`${key}: ${judgement.verdicts.length} verdict(s) to review · $${judgement.cost_usd.toFixed(2)}`);
    } catch (error) {
      this.hooks.status(`${key}: ${error}`, true);
    } finally {
      this.busy.delete(key);
      this.render();
    }
  }

  private async record(claimId: string, key: string): Promise<boolean> {
    const proposal = this.proposals.get(`${claimId}|${key}`);
    if (!this.root || !proposal) return false;
    try {
      await api.claimsRecord(this.root, key, proposal.from, proposal.verdict);
      this.proposals.delete(`${claimId}|${key}`);
      return true;
    } catch (error) {
      proposal.error = String(error);
      return false;
    }
  }

  private async recordEvery() {
    let recorded = 0;
    for (const key of [...this.proposals.keys()]) {
      const [claim, cited] = key.split("|");
      if (await this.record(claim, cited)) recorded++;
    }
    const failed = this.proposals.size;
    this.hooks.status(`Recorded ${recorded} verdict(s) in ruru${failed ? ` · ${failed} refused` : ""}`, failed > 0);
    await this.reload();
  }

  // Rendering

  private render() {
    for (const chip of this.bar.querySelectorAll<HTMLElement>(".chip")) chip.classList.toggle("active", chip.dataset.filter === this.filter);
    this.recordAll.hidden = this.proposals.size === 0;
    this.recordAll.textContent = `Record all (${this.proposals.size})`;
    this.checkAll.disabled = !this.doc || this.busy.size > 0;
    this.checkAll.textContent = this.busy.size ? `Checking ${[...this.busy].join(", ")}…` : "Check unchecked";

    if (!this.doc) {
      this.counts.textContent = "";
      this.list.replaceChildren(
        el(
          "p",
          "review-empty",
          this.loading ? "Asking ruru…" : this.root ? "This folder isn't a ruru project, so there are no claims to check." : "",
        ),
      );
      return;
    }

    const states = new Map<string, number>();
    for (const claim of this.doc.claims) for (const c of claim.checks) states.set(c.state, (states.get(c.state) ?? 0) + 1);
    const parts = [`${this.doc.claims.length} claims`, ...[...states].map(([s, n]) => `${n} ${STATE_LABEL[s] ?? s}`)];
    if (this.doc.stale.length) parts.push(`${this.doc.stale.length} verdict(s) on reworded sentences`);
    if (this.spent) parts.push(`$${this.spent.toFixed(2)} spent`);
    this.counts.textContent = parts.join(" · ");

    const shown = this.doc.claims.filter(
      (c) => this.filter === "all" || c.checks.some((k) => ATTENTION.has(k.state) || this.proposals.has(id(c, k.key))),
    );
    if (!shown.length) {
      this.list.replaceChildren(el("p", "review-empty", "Every citation has a verdict, and none is weak."));
      return;
    }
    this.list.replaceChildren(...shown.map((claim) => this.card(claim)));
  }

  private card(claim: Claim): HTMLElement {
    const worst = claim.checks.some((k) => ["partial", "unsupported", "not-found"].includes(k.state))
      ? "weak"
      : claim.checks.some((k) => k.state === "unchecked" || k.state === "outdated")
        ? "open"
        : "ok";
    const card = el("div", `card claim claim-${worst}`);
    const head = el("div", "card-head");
    const where = el("button", "card-where", `${claim.file}:${claim.line}`);
    where.addEventListener("click", () => this.hooks.jump(claim.file, claim.line));
    head.append(where, el("span", "spacer"), el("span", "card-meta", claim.id));
    card.append(head, sentence(claim.text));
    for (const check of claim.checks) card.append(this.check(claim, check));
    return card;
  }

  private check(claim: Claim, check: ClaimCheck): HTMLElement {
    const row = el("div", "claim-check");
    const head = el("div", "claim-check-head");
    head.append(el("span", "claim-key", check.key), el("span", `claim-state state-${check.state}`, STATE_LABEL[check.state] ?? check.state));
    if (check.own) head.append(el("span", "card-meta", "own work"));
    head.append(el("span", "spacer"));
    if (check.kind) {
      const busy = this.busy.has(check.key);
      const again = el("button", "claim-ask", busy ? "Reading…" : check.state === "unchecked" ? "Check" : "Check again");
      again.disabled = busy;
      again.title = `Ask Claude whether ${check.key} supports this sentence`;
      again.addEventListener("click", () => void this.judge(check.key, [claim.id]));
      head.append(again);
    } else {
      head.append(el("span", "card-meta", "not in your library"));
    }
    row.append(head);
    if (check.title) row.append(el("div", "card-meta", check.title));

    const v = check.verdict;
    if (v) {
      if (v.quote) row.append(el("blockquote", "card-quote", `${v.quote}${v.page ? ` (p. ${v.page})` : ""}`));
      if (v.note) row.append(el("p", "claim-note", v.note));
      row.append(el("div", "card-meta", `${v.by ?? "?"} · ${v.date} · from ${v.source}`));
    }

    const proposal = this.proposals.get(id(claim, check.key));
    if (proposal) row.append(this.proposal(claim, check, proposal));
    return row;
  }

  private proposal(claim: Claim, check: ClaimCheck, proposal: Proposal): HTMLElement {
    const { verdict } = proposal;
    const box = el("div", "claim-proposal");
    const head = el("div", "claim-check-head");
    head.append(el("span", "card-meta", "Claude proposes"), el("span", `claim-state state-${verdict.verdict}`, STATE_LABEL[verdict.verdict] ?? verdict.verdict));
    head.append(el("span", "card-meta", `from ${proposal.from}`));
    box.append(head);
    if (verdict.quote) {
      box.append(el("blockquote", "card-quote", `${verdict.quote}${verdict.page ? ` (p. ${verdict.page})` : ""}`));
      if (!verdict.quote_found) box.append(el("p", "claim-warning", "This quote isn't word for word in the text Claude read, so ruru may refuse it."));
    }
    if (verdict.note) box.append(el("p", "claim-note", verdict.note));
    if (proposal.error) box.append(el("p", "claim-warning", proposal.error));

    const actions = el("div", "hunk-actions");
    const record = el("button", "primary", "Record");
    record.title = "Save this verdict in ruru (ruru verdict … --by claude)";
    record.addEventListener("click", async () => {
      record.disabled = true;
      if (await this.record(claim.id, check.key)) {
        this.hooks.status(`Recorded ${check.key}: ${verdict.verdict}`);
        await this.reload();
      } else this.render();
    });
    const discard = el("button", "", "Discard");
    discard.addEventListener("click", () => {
      this.proposals.delete(id(claim, check.key));
      this.render();
    });
    actions.append(discard, record);
    box.append(actions);
    return box;
  }
}

const id = (claim: Claim, key: string) => `${claim.id}|${key}`;

/** The sentence with its [@key] cites set apart. */
function sentence(text: string): HTMLElement {
  const p = el("p", "card-comment claim-text");
  for (const part of text.split(/(\[@[^\]]+\])/)) {
    p.append(part.startsWith("[@") ? el("span", "claim-cite", part) : document.createTextNode(part));
  }
  return p;
}
