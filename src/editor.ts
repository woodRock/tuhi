import { basicSetup } from "codemirror";
import { Decoration, DecorationSet, EditorView, GutterMarker, gutter, hoverTooltip, keymap } from "@codemirror/view";
import { Compartment, EditorSelection, EditorState, Extension, Transaction, TransactionSpec, RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { Diagnostic, forceLinting, lintGutter, linter } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Citations } from "./citations";
import { acceptSpec, marksExtension, marksField, setMarks, setSuggesting, suggestingField, type Mark } from "./marks";
import type { Marker } from "./provenance";

export interface EditorHooks {
  onSave(): void;
  onDirtyChange(): void;
  /** Cmd-click or Cmd-J: show this source position in the PDF. */
  onForwardSync(line: number, column: number): void;
  /** A provenance dot in the gutter was clicked. */
  onMarkerClick(marker: Marker, x: number, y: number): void;
  /** Suggestions or comments in `file` changed (added, accepted, moved by an edit). */
  onMarksChange(file: string): void;
  /** The cursor or selection moved into a suggestion or comment (null when it left one). */
  onMarkFocus(file: string, id: string | null): void;
}

export interface Problem {
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
  /** Offered as a Fix button: replaces the first `find` on the line. */
  fix?: { find: string; replace: string };
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeFor = (dark: boolean) => (dark ? oneDark : []);

// A brief highlight on the line a jump lands on, so the eye can find it.
const flashLine = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(flashLine)) {
        decorations =
          effect.value === null
            ? Decoration.none
            : Decoration.set([Decoration.line({ class: "cm-flash" }).range(effect.value)]);
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Provenance dots in their own gutter, kept in place as the text is edited.
class Dot extends GutterMarker {
  constructor(readonly marker: Marker) {
    super();
  }
  eq(other: Dot) {
    return other.marker.level === this.marker.level && other.marker.notes.join() === this.marker.notes.join();
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = `prov-dot prov-${this.marker.level}`;
    dot.title = this.marker.notes.join("\n");
    return dot;
  }
}

const setMarkers = StateEffect.define<Marker[]>();
const markerField = StateField.define<RangeSet<Dot>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    markers = markers.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setMarkers)) continue;
      const builder = new RangeSetBuilder<Dot>();
      for (const m of effect.value) {
        if (m.line >= 1 && m.line <= tr.state.doc.lines) {
          const from = tr.state.doc.line(m.line).from;
          builder.add(from, from, new Dot(m));
        }
      }
      markers = builder.finish();
    }
    return markers;
  },
});

/**
 * One CodeMirror view, with a separate EditorState per open file so each keeps its own
 * undo history and selection.
 */
export class Editor {
  private view: EditorView;
  private states = new Map<string, EditorState>();
  private saved = new Map<string, string>();
  private dirty = new Set<string>();
  private theme = new Compartment();
  private flashTimer = 0;
  /** Compile problems per file, shown alongside the citation checks. */
  private problems = new Map<string, Problem[]>();
  private suggesting = false;
  private focused: string | null = null;
  file: string | null = null;

  constructor(parent: HTMLElement, private hooks: EditorHooks, private citations: Citations) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true), this.theme.of(themeFor(darkQuery.matches))] }),
      dispatch: (tr, view) => {
        view.update([tr]);
        if (tr.docChanged && this.file) {
          const wasDirty = this.dirty.has(this.file);
          const isDirty = tr.state.doc.toString() !== this.saved.get(this.file);
          if (isDirty) this.dirty.add(this.file);
          else this.dirty.delete(this.file);
          if (wasDirty !== isDirty) this.hooks.onDirtyChange();
        }
        if (this.file && tr.startState.field(marksField, false) !== tr.state.field(marksField, false)) this.hooks.onMarksChange(this.file);
        if (this.file && (tr.selection || tr.docChanged)) {
          const head = tr.state.selection.main.head;
          const at = tr.state.field(marksField, false)?.find((m) => m.from <= head && head <= m.to);
          if ((at?.id ?? null) !== this.focused) {
            this.focused = at?.id ?? null;
            this.hooks.onMarkFocus(this.file, this.focused);
          }
        }
      },
    });
    darkQuery.addEventListener("change", (e) => this.setDark(e.matches));
  }

  private makeState(file: string, text: string): EditorState {
    const tex: Extension = file.endsWith(".tex")
      ? [
          EditorState.languageData.of(() => [{ autocomplete: this.citations.complete }]),
          hoverTooltip(this.citations.hover, { hoverTime: 350 }),
        ]
      : [];
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        StreamLanguage.define(stex),
        EditorView.lineWrapping,
        tex,
        lintGutter(),
        linter((view) => this.diagnostics(file, view), { delay: 400 }),
        markerField,
        gutter({
          class: "cm-provenance",
          markers: (view) => view.state.field(markerField),
          domEventHandlers: {
            mousedown: (view, block, event) => {
              let found: Dot | null = null;
              view.state.field(markerField).between(block.from, block.from, (_from, _to, dot) => {
                found = dot;
              });
              if (!found) return false;
              const e = event as MouseEvent;
              this.hooks.onMarkerClick((found as Dot).marker, e.clientX, e.clientY);
              return true;
            },
          },
        }),
        flashField,
        marksExtension,
        suggestingField.init(() => this.suggesting),
        this.theme.of(themeFor(darkQuery.matches)),
        keymap.of([
          indentWithTab,
          { key: "Mod-s", preventDefault: true, run: () => (this.hooks.onSave(), true) },
          { key: "Mod-j", preventDefault: true, run: (view) => (this.syncAt(view.state.selection.main.head), true) },
        ]),
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            view.dispatch({ selection: { anchor: pos } });
            this.syncAt(pos);
            return true;
          },
        }),
      ],
    });
  }

  /** Compile problems for the file plus, in .tex files, cited keys no .bib defines. */
  private diagnostics(file: string, view: EditorView): Diagnostic[] {
    const doc = view.state.doc;
    const out: Diagnostic[] = (this.problems.get(file) ?? [])
      .filter((p) => p.line >= 1 && p.line <= doc.lines)
      .map((p) => {
        const line = doc.line(p.line);
        const at = p.fix ? line.text.indexOf(p.fix.find) : -1;
        const from = at >= 0 ? line.from + at : line.from;
        const to = at >= 0 ? from + p.fix!.find.length : line.to;
        const fix = p.fix;
        const actions =
          fix && at >= 0
            ? [{ name: `Fix: ${fix.replace}`, apply: (v: EditorView, a: number, b: number) => v.dispatch({ changes: { from: a, to: b, insert: fix.replace } }) }]
            : undefined;
        return { from, to, severity: p.severity, message: p.message, actions };
      });
    if (file.endsWith(".tex")) out.push(...this.citations.lint(doc.toString()));
    return out;
  }

  /** Re-runs the checks, e.g. once the citation library has loaded. */
  relint() {
    if (this.file) forceLinting(this.view);
  }

  private syncAt(pos: number) {
    const line = this.view.state.doc.lineAt(pos);
    this.hooks.onForwardSync(line.number, pos - line.from + 1);
  }

  private setDark(dark: boolean) {
    const effect = this.theme.reconfigure(themeFor(dark));
    for (const [file, state] of this.states) {
      if (file !== this.file) this.states.set(file, state.update({ effects: effect }).state);
    }
    this.view.dispatch({ effects: effect });
  }

  /** Forgets every open file, e.g. when switching projects. */
  reset() {
    this.states.clear();
    this.problems.clear();
    this.saved.clear();
    this.dirty.clear();
    this.file = null;
    this.view.setState(
      EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true), this.theme.of(themeFor(darkQuery.matches))] }),
    );
  }

  has(file: string) {
    return this.states.has(file);
  }

  /** Adds a file read from disk. */
  load(file: string, text: string) {
    this.states.set(file, this.makeState(file, text));
    this.saved.set(file, text);
    this.dirty.delete(file);
  }

  show(file: string) {
    if (this.file) this.states.set(this.file, this.view.state);
    const state = this.states.get(file);
    if (!state) throw new Error(`${file} is not loaded`);
    this.file = file;
    this.view.setState(state);
    this.view.focus();
  }

  text(file: string): string {
    const state = file === this.file ? this.view.state : this.states.get(file);
    return state?.doc.toString() ?? "";
  }

  /** The current file and 1-based cursor line. */
  cursor(): { file: string; line: number } | null {
    if (!this.file) return null;
    const state = this.view.state;
    return { file: this.file, line: state.doc.lineAt(state.selection.main.head).number };
  }

  /**
   * Replaces `before` with `after` in a loaded file (shown or not), choosing the occurrence
   * nearest `nearLine`. Returns the line of the change, or null if `before` isn't there.
   */
  replace(file: string, before: string, after: string, nearLine: number): number | null {
    const state = file === this.file ? this.view.state : this.states.get(file);
    if (!state || !before) return null;
    const text = state.doc.toString();
    let best = -1;
    let bestDistance = Infinity;
    for (let i = text.indexOf(before); i !== -1; i = text.indexOf(before, i + 1)) {
      const distance = Math.abs(state.doc.lineAt(i).number - nearLine);
      if (distance < bestDistance) [best, bestDistance] = [i, distance];
    }
    if (best < 0) return null;
    const changes = { from: best, to: best + before.length, insert: after };
    if (file === this.file) {
      this.view.dispatch({ changes });
    } else {
      const next = state.update({ changes }).state;
      this.states.set(file, next);
      const wasDirty = this.dirty.has(file);
      if (next.doc.toString() !== this.saved.get(file)) this.dirty.add(file);
      else this.dirty.delete(file);
      if (wasDirty !== this.dirty.has(file)) this.hooks.onDirtyChange();
    }
    return state.doc.lineAt(best).number;
  }

  dirtyFiles(): string[] {
    return [...this.dirty];
  }

  markSaved(file: string, text: string) {
    this.saved.set(file, text);
    if (this.text(file) === text) this.dirty.delete(file);
  }

  /** Moves the cursor to a 1-based line and column, centres it and flashes the line. */
  goTo(line: number, column = 0) {
    const doc = this.view.state.doc;
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
    const pos = Math.min(target.from + Math.max(column - 1, 0), target.to);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashLine.of(target.from)],
    });
    this.view.focus();
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.view.dispatch({ effects: flashLine.of(null) }), 1200);
  }

  // Suggestions and comments

  private stateOf(file: string) {
    return file === this.file ? this.view.state : this.states.get(file);
  }

  /** Applies a transaction to a file, shown or not, keeping dirty tracking right. */
  private apply(file: string, spec: TransactionSpec) {
    if (file === this.file) {
      this.view.dispatch(spec);
      return;
    }
    const state = this.states.get(file);
    if (!state) return;
    const tr = state.update(spec);
    this.states.set(file, tr.state);
    if (tr.docChanged) {
      const wasDirty = this.dirty.has(file);
      if (tr.state.doc.toString() !== this.saved.get(file)) this.dirty.add(file);
      else this.dirty.delete(file);
      if (wasDirty !== this.dirty.has(file)) this.hooks.onDirtyChange();
    }
    this.hooks.onMarksChange(file);
  }

  marks(file: string): Mark[] {
    return this.stateOf(file)?.field(marksField, false) ?? [];
  }

  setMarks(file: string, marks: Mark[]) {
    // Not an undoable step: these come from disk.
    const state = this.stateOf(file);
    if (!state) return;
    const tr = state.update({ effects: setMarks.of(marks), annotations: Transaction.addToHistory.of(false) });
    if (file === this.file) this.view.update([tr]);
    else this.states.set(file, tr.state);
  }

  /** Adds marks, e.g. Claude's suggestions; undoable. */
  addMarks(file: string, marks: Mark[]) {
    this.apply(file, { effects: setMarks.of([...this.marks(file), ...marks]) });
  }

  /** Changes one mark (a reply, resolving a comment). */
  updateMark(file: string, id: string, change: Partial<Mark>) {
    this.apply(file, { effects: setMarks.of(this.marks(file).map((m) => (m.id === id ? { ...m, ...change } : m))) });
  }

  removeMark(file: string, id: string) {
    this.apply(file, { effects: setMarks.of(this.marks(file).filter((m) => m.id !== id)) });
  }

  /** Writes a suggestion into the text. */
  accept(file: string, id: string): boolean {
    const state = this.stateOf(file);
    const spec = state && acceptSpec(state, id);
    if (!spec) return false;
    this.apply(file, spec);
    return true;
  }

  isSuggesting() {
    return this.suggesting;
  }

  /** In suggesting mode typing makes suggestions instead of changing the text. */
  setSuggestingMode(on: boolean) {
    this.suggesting = on;
    const effect = setSuggesting.of(on);
    for (const [file, state] of this.states) {
      if (file !== this.file) this.states.set(file, state.update({ effects: effect }).state);
    }
    if (this.file) this.view.dispatch({ effects: effect });
  }

  /** The current selection with its text. */
  selection(): { file: string; from: number; to: number; text: string; line: number } | null {
    if (!this.file) return null;
    const { state } = this.view;
    const { from, to } = state.selection.main;
    return { file: this.file, from, to, text: state.sliceDoc(from, to), line: state.doc.lineAt(from).number };
  }

  /** Selects a range in the current file and scrolls to it. */
  select(from: number, to: number) {
    const max = this.view.state.doc.length;
    const range = EditorSelection.range(Math.min(from, max), Math.min(to, max));
    this.view.dispatch({ selection: range, effects: EditorView.scrollIntoView(range.from, { y: "center" }) });
    this.view.focus();
  }

  /** Shows provenance dots for the current file. */
  setMarkers(markers: Marker[]) {
    this.view.dispatch({ effects: setMarkers.of(markers) });
  }

  /** Shows compile problems for the current file in the gutter. */
  setProblems(problems: Problem[]) {
    if (!this.file) return;
    this.problems.set(this.file, problems);
    forceLinting(this.view);
  }
}
