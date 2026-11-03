export interface Segment {
  kind: "same" | "del" | "ins";
  text: string;
}

/** Word-level diff (longest common subsequence over words, spaces and punctuation). */
export function wordDiff(before: string, after: string): Segment[] {
  const a = tokens(before);
  const b = tokens(after);
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Segment[] = [];
  const push = (kind: Segment["kind"], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("del", a[i++]);
    } else {
      push("ins", b[j++]);
    }
  }
  while (i < a.length) push("del", a[i++]);
  while (j < b.length) push("ins", b[j++]);
  return out;
}

interface Edit {
  /** Tokens [from, to) of the base are replaced by `insert`. */
  from: number;
  to: number;
  insert: string[];
}

/** The edits that turn token list `a` into `b`. */
function edits(a: string[], b: string[]): Edit[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Edit[] = [];
  let open: Edit | null = null;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) out.push((open = { from: i, to: i, insert: [] }));
    if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) open.to = ++i;
    else open.insert.push(b[j++]);
  }
  return out;
}

/**
 * Applies both `base → ours` and `base → theirs` to `base`, word by word, or returns null when
 * the two change the same or neighbouring words.
 */
export function merge3(base: string, ours: string, theirs: string): string | null {
  const b = tokens(base);
  const mine = edits(b, tokens(ours));
  const yours = edits(b, tokens(theirs));
  for (const m of mine) for (const y of yours) if (m.from <= y.to && y.from <= m.to) return null;
  const all = [...mine, ...yours].sort((x, y) => y.from - x.from);
  for (const e of all) b.splice(e.from, e.to - e.from, ...e.insert);
  return b.join("");
}

/**
 * Applies the edit `before → after` to `text` where `before` has since been edited: finds the
 * passage by the start and end it still shares, then merges the two sets of changes word by word.
 * Returns the change to make, or null when the passage can't be found or the edits overlap.
 */
export function rebase(text: string, before: string, after: string, near: number): { from: number; to: number; insert: string } | null {
  const MIN = 12;
  const closest = (needle: string, from = 0, until = text.length) => {
    let best = -1;
    for (let i = text.indexOf(needle, from); i !== -1 && i + needle.length <= until; i = text.indexOf(needle, i + 1)) {
      if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
    }
    return best;
  };
  for (let n = Math.min(before.length, 80); n >= MIN; n--) {
    const start = closest(before.slice(0, n));
    if (start < 0) continue;
    const limit = start + before.length * 2 + 200;
    for (let m = Math.min(before.length - n, 80); m >= MIN; m--) {
      const tail = before.slice(-m);
      const at = closest(tail, start + n, limit);
      if (at < 0) continue;
      const end = at + m;
      const merged = merge3(before, text.slice(start, end), after);
      return merged === null ? null : { from: start, to: end, insert: merged };
    }
    return null;
  }
  return null;
}

function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}]+|./gsu) ?? [];
}
