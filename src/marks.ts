import { invertedEffects } from "@codemirror/commands";
import { Annotation, ChangeDesc, EditorSelection, EditorState, Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/**
 * A suggested edit or a comment thread, anchored to a range of one file. Neither touches the
 * .tex: a suggestion is only written when accepted. Stored in `.tuhi/suggestions.json`.
 */
export interface Mark {
  id: string;
  kind: "suggestion" | "comment";
  /** The range the suggestion replaces or the comment is about; equal for a pure insertion. */
  from: number;
  to: number;
  /** Suggestions: the replacement text ("" deletes the range). */
  insert: string;
  /** "you" or "claude". */
  author: string;
  created: string;
  /** Why Claude suggested it. */
  note?: string;
  /** Comments: the thread, first entry is the comment itself. */
  thread?: { author: string; text: string; date: string }[];
  resolved?: boolean;
}

/** Moves marks through an edit; a suggestion whose text was deleted outright is dropped. */
export function mapMarks(marks: Mark[], changes: ChangeDesc): Mark[] {
  if (!marks.length) return marks;
  const next = marks
    .map((m) => {
      const from = changes.mapPos(m.from, m.from === m.to ? -1 : 1);
      const to = Math.max(from, changes.mapPos(m.to, -1));
      return from === m.from && to === m.to ? m : { ...m, from, to };
    })
    .filter((m) => m.kind === "comment" || m.from < m.to || m.insert);
  return next.length === marks.length && next.every((m, i) => m === marks[i]) ? marks : next;
}

/** Replaces a file's marks. Positions refer to the document after the transaction's changes. */
export const setMarks = StateEffect.define<Mark[]>({ map: mapMarks });
/** Marks a transaction the suggesting filter must let through (accepting a suggestion). */
export const direct = Annotation.define<boolean>();
export const setSuggesting = StateEffect.define<boolean>();

export const suggestingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggesting)) value = e.value;
    return value;
  },
});

export const marksField = StateField.define<Mark[]>({
  create: () => [],
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return tr.docChanged ? mapMarks(marks, tr.changes) : marks;
  },
});

class Inserted extends WidgetType {
  constructor(readonly mark: Mark) {
    super();
  }
  eq(other: Inserted) {
    return other.mark.insert === this.mark.insert && other.mark.author === this.mark.author && other.mark.id === this.mark.id;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-sugg-ins by-${this.mark.author}`;
    span.textContent = this.mark.insert;
    span.dataset.mark = this.mark.id;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

const decorations = EditorView.decorations.compute([marksField], (state) => {
  const ranges = [];
  for (const m of state.field(marksField)) {
    if (m.kind === "comment") {
      if (!m.resolved && m.from < m.to) ranges.push(Decoration.mark({ class: "cm-comment", attributes: { "data-mark": m.id } }).range(m.from, m.to));
      continue;
    }
    if (m.from < m.to) ranges.push(Decoration.mark({ class: `cm-sugg-del by-${m.author}`, attributes: { "data-mark": m.id } }).range(m.from, m.to));
    // side -1: the inserted text sits before the cursor, so typing continues after it.
    if (m.insert) ranges.push(Decoration.widget({ widget: new Inserted(m), side: -1 }).range(m.to));
  }
  return Decoration.set(ranges, true) as DecorationSet;
});

const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");
export const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * In suggesting mode, what one change does to the marks instead of the text. Positions are in
 * the unchanged document. Returns the new marks and where the cursor goes.
 */
export function suggest(
  marks: Mark[],
  change: { from: number; to: number; text: string },
  backward: boolean,
  author = "you",
): { marks: Mark[]; cursor: number } {
  const { from, to, text } = change;
  const mine = (m: Mark) => m.kind === "suggestion" && m.author === author;
  const out = marks.slice();
  const replace = (old: Mark, next: Mark) => out.splice(out.indexOf(old), 1, next);

  if (from === to) {
    // Typing: extend a suggestion that ends here, or start one.
    const at = out.find((m) => mine(m) && m.to === from);
    if (at) {
      replace(at, { ...at, insert: at.insert + text });
      return { marks: out, cursor: from };
    }
    // Typing just after backspacing over text replaces it, as in Docs: the new text goes
    // after the struck-through text and the cursor follows it.
    const struck = out.find((m) => mine(m) && m.from === from && m.from < m.to && !m.insert);
    if (struck) {
      replace(struck, { ...struck, insert: text });
      return { marks: out, cursor: struck.to };
    }
    out.push({ id: newId(), kind: "suggestion", from, to, insert: text, author, created: now() });
    return { marks: out, cursor: from };
  }

  if (!text) {
    // Backspace right after inserted text takes back what was typed.
    const typed = backward ? out.find((m) => mine(m) && m.to === to && m.insert) : undefined;
    if (typed) {
      const insert = typed.insert.slice(0, Math.max(0, typed.insert.length - (to - from)));
      if (insert || typed.from < typed.to) replace(typed, { ...typed, insert });
      else out.splice(out.indexOf(typed), 1);
      return { marks: out, cursor: to };
    }
  }

  // Deleting or replacing: strike through the range, merging with suggestions it touches.
  const touching = out.filter((m) => mine(m) && m.from <= to && m.to >= from);
  const merged: Mark = {
    id: touching[0]?.id ?? newId(),
    kind: "suggestion",
    from: Math.min(from, ...touching.map((m) => m.from)),
    to: Math.max(to, ...touching.map((m) => m.to)),
    insert: touching.map((m) => m.insert).join("") + text,
    author,
    created: touching[0]?.created ?? now(),
  };
  const rest = out.filter((m) => !touching.includes(m));
  rest.push(merged);
  return { marks: rest, cursor: text ? merged.to : backward ? from : to };
}

// Typing in suggesting mode becomes suggestions; the document itself doesn't change.
const suggestFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.startState.field(suggestingField) || tr.annotation(direct)) return tr;
  if (!(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
  let marks = tr.startState.field(marksField);
  let cursor = tr.startState.selection.main.head;
  const backward = !tr.isUserEvent("delete.forward");
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const result = suggest(marks, { from: fromA, to: toA, text: inserted.toString() }, backward);
    marks = result.marks;
    cursor = result.cursor;
  });
  return { effects: setMarks.of(marks), selection: EditorSelection.cursor(cursor), scrollIntoView: true, userEvent: "input.suggest" };
});

// So ⌘Z takes back suggestions, which change no text.
const undoMarks = invertedEffects.of((tr) => {
  const effects = [];
  for (const e of tr.effects) if (e.is(setMarks)) effects.push(setMarks.of(tr.startState.field(marksField)));
  return effects;
});

const theme = EditorView.baseTheme({
  ".cm-sugg-del": { textDecoration: "line-through", textDecorationColor: "#c2402d", color: "#c2402d", backgroundColor: "rgba(194, 64, 45, 0.08)" },
  ".cm-sugg-ins": { color: "#2f6f5e", textDecoration: "underline", backgroundColor: "rgba(47, 111, 94, 0.1)" },
  ".cm-sugg-ins.by-claude, .cm-sugg-del.by-claude": { outline: "1px dashed rgba(91, 141, 239, 0.6)" },
  ".cm-comment": { backgroundColor: "rgba(255, 196, 0, 0.28)", borderBottom: "2px solid rgba(255, 196, 0, 0.8)" },
  "&dark .cm-sugg-ins": { color: "#7fd1b9" },
  "&dark .cm-sugg-del": { color: "#e06c5a" },
});

export const marksExtension: Extension = [marksField, suggestingField, suggestFilter, undoMarks, decorations, theme];

/** The transaction spec that accepts a suggestion: writes it into the text and drops it. */
export function acceptSpec(state: EditorState, id: string) {
  const marks = state.field(marksField);
  const m = marks.find((x) => x.id === id);
  if (!m) return null;
  const changes = state.changes({ from: m.from, to: m.to, insert: m.insert });
  return {
    changes,
    effects: setMarks.of(mapMarks(marks.filter((x) => x.id !== id), changes)),
    annotations: [direct.of(true), Transaction.userEvent.of("input.accept")],
  };
}

/** Puts marks back on a file's text: each kept where its text still is, or near where it was. */
export function reanchor(text: string, stored: (Mark & { quote: string; before: string })[]): { placed: Mark[]; lost: Mark[] } {
  const placed: Mark[] = [];
  const lost: Mark[] = [];
  for (const { quote, before, ...m } of stored) {
    if (text.slice(m.from, m.to) === quote && text.slice(Math.max(0, m.from - before.length), m.from) === before) {
      placed.push(m);
      continue;
    }
    // The text moved (an Overleaf pull, an edit outside tuhi): find it again, nearest first.
    const needle = quote || before;
    let best = -1;
    for (let i = needle ? text.indexOf(needle) : -1; i !== -1; i = text.indexOf(needle, i + 1)) {
      if (best === -1 || Math.abs(i - m.from) < Math.abs(best - m.from)) best = i;
    }
    if (best === -1) lost.push(m);
    else {
      const from = quote ? best : best + before.length;
      placed.push({ ...m, from, to: from + quote.length });
    }
  }
  return { placed, lost };
}

/** What `reanchor` needs to find a mark again later. */
export function withContext(text: string, m: Mark) {
  return { ...m, quote: text.slice(m.from, m.to), before: text.slice(Math.max(0, m.from - 40), m.from) };
}
