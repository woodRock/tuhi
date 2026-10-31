import { basicSetup } from "codemirror";
import { Decoration, DecorationSet, EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";

export interface EditorHooks {
  onSave(): void;
  onDirtyChange(): void;
  /** Cmd-click or Cmd-J: show this source position in the PDF. */
  onForwardSync(line: number, column: number): void;
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
  file: string | null = null;

  constructor(parent: HTMLElement, private hooks: EditorHooks) {
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
      },
    });
    darkQuery.addEventListener("change", (e) => this.setDark(e.matches));
  }

  private makeState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        StreamLanguage.define(stex),
        EditorView.lineWrapping,
        lintGutter(),
        flashField,
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
    this.states.set(file, this.makeState(text));
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

  /** Shows compile problems for the current file in the gutter. */
  setProblems(problems: { line: number; severity: "error" | "warning" | "info"; message: string }[]) {
    const doc = this.view.state.doc;
    const diagnostics: Diagnostic[] = problems
      .filter((p) => p.line >= 1 && p.line <= doc.lines)
      .map((p) => {
        const line = doc.line(p.line);
        return { from: line.from, to: line.to, severity: p.severity, message: p.message };
      });
    this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
  }
}
