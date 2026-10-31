# tuhi

A LaTeX editor for papers: CodeMirror 6 source on the left, PDF.js preview on the right,
SyncTeX jumping between them. Built with Tauri 2 (Rust backend, TypeScript frontend).

## Run

```bash
npm install
npm run tauri dev
```

## Using it

- **Open…** (⌘O) a paper folder, e.g. `~/overleaf/<name>`. The file with `\documentclass` is
  treated as the main file and compiled straight away. The last folder reopens on launch.
- **⌘S** saves every changed file and recompiles.
- **⌘-click** in the source shows that spot in the PDF; **⌘-click** in the PDF jumps to the source.
  **⌘J** shows the cursor's line in the PDF.
- Problems from the TeX log and BibTeX appear under the editor and in the gutter; click one to jump.

### Suggestions and comments

Like suggesting mode in Google Docs: nothing reaches the `.tex` until it's accepted.

- **Suggesting** (toolbar, or ⌘⇧E) turns what you type into suggestions: deleted text is
  struck through and new text shown in green, and the file itself doesn't change. Backspace takes
  back what you just typed; ⌘Z undoes suggestions too.
- **⌘⌥M** comments on the selected text. Comments are highlighted in the editor and threaded
  in the **Suggestions** tab, where you can reply and resolve them.
- **⌘⌥K** asks Claude to suggest edits to the selection, with an optional instruction ("cut
  to 100 words", "make the claim more cautious"). Each edit comes back as a separate suggestion
  (dashed outline) with a short reason, and macros, citations and numbers are left alone.
- The **Suggestions** tab lists every suggestion and comment: click one to jump to it, then
  **Accept** (writes it into the text; ⌘S to save) or **Reject**, or **Accept all**.

Suggestions and comments are stored in `.tuhi/suggestions.json` in the paper's repo, with the
text around each one, so they find their place again after the file changes elsewhere (an
Overleaf pull). One whose text is gone is listed but can't be accepted.

### Checks before you submit

The **Checks** tab runs after each compile (and when opened), on the text in the editor:

- **Checklist:** compiles cleanly; page count against the venue's limit (with or without the
  references, found from the PDF's References heading); anonymity for double-blind review
  (`\author`, `\thanks`, acknowledgements, GitHub links, `pdfauthor`, "our previous work");
  every `\ref` and citation resolves, no duplicate labels; unused labels; figures and tables
  with captions, labels and alt text; overfull lines; leftover TODOs, `\todo` and highlights.
  The page limit and double-blind switch are saved per paper in `.tuhi/settings.json`.
- **Consistency**, also shown in the editor and Problems with a Fix button where the fix is safe:
  - acronyms used before they're spelled out, spelled out twice, or never (headings, the
    abstract and floats don't count as first use; papers using an acronym package are skipped)
  - British and American spellings mixed (normalise/normalize, modelling/modeling, …) and
    compounds written both closed and open (dataset/data set)
  - te reo Māori words missing macrons (Maori → Māori, whanau → whānau, …); `M\=aori` counts
  - notation: a symbol bold with `\mathbf` here and `\bm` there, "Fig." and "Figure"
    mid-sentence, "e.g.," with and without the comma

Only files the main file reaches through `\input` and `\include` are checked.

**Explain** on a compile error in Problems gives a plain-English explanation of common errors
straight away. **Ask Claude** reads the log and source and proposes the fix, which **Apply fix**
makes in the editor (⌘S to save and recompile); about $0.05.

### Section budgets

The **Outline** tab lists the sections in reading order (following `\input`) with their words
and pages. Words count the text, including numbers, but not maths, tables or references; a
section's count includes its subsections. Pages come from where each heading lands in the last
PDF (SyncTeX), as fractions of a page. Set a word or page budget on any section, the abstract or
the whole paper, and a bar shows how close each is: amber within 10%, red over. Budgets are
saved in `.tuhi/settings.json`.

### Versions

The **Versions** tab keeps named snapshots such as "Submitted v1" or "Revision 1". A snapshot
records every file exactly as it is, saved or committed or not, as a git tag `tuhi/<name>`. It
doesn't commit to your branch or change the index or working tree, and the tag stays local
unless you push it with `--tags`. **Compare** any two versions, or one against the current text:
**Changes** lists the lines added and removed per file, and **Diff PDF** opens a latexdiff
PDF. Deleting a snapshot removes only its tag.

### Reviewer comments

The **Review** tab (next to PDF) tracks every reviewer comment to resolution.

- **Import PDF…** reads a reviewer's annotated PDF: highlights, strikeouts, sticky notes and
  their replies. Each becomes a card in the next reviewer group (R1, R2, …).
- **Paste comments…** splits a review letter into cards by numbered items, bullets or
  paragraphs; headings such as "Reviewer 2" set the group.
- Each card is linked to a source line by matching the quoted text against the `.tex` files,
  falling back to SyncTeX on the page position. "≈" marks a guess; **Move here** or
  **Place at cursor** re-links a card to the editor's line. Click a card to jump to it.
- Statuses are Open, Proposed, Accepted and Won't fix (with a reason for the response letter).

- **Draft change** asks Claude (through the `claude` CLI, so your Claude login) for the
  smallest edit that addresses the comment, plus a draft reply to the reviewer. **Draft all
  open** does every open card, two at a time. Claude can read the project but not change it,
  and is told not to invent results or citations; anything it needs from you appears under
  "Needs you". Each draft costs a few cents to a few tens of cents, shown on the card.
- Review the draft hunk by hunk: **Accept** applies it in the editor (⌘S to save), **Edit**
  lets you change the replacement first, **Reject** drops it, **Undo** reverses an accepted
  hunk. A card becomes Accepted once every hunk is decided and at least one was accepted.

- **Check** lists everything still unresolved: open or proposed comments, won't-fix without a
  reason, accepted cards with no reply or no accepted edit, accepted edits that have since
  disappeared from the source, and annotations in a reviewer's PDF that have no card.
- **Response letter** writes `response/<round>.tex` (editable, in the repo) from the replies
  and accepted edits, quoting each change with its section and line, compiles it and opens
  the PDF. Anything unresolved is marked in red.
- **Diff PDF** runs `latexdiff --flatten` between a git commit and the current text and opens
  the marked-up PDF. It defaults to the commit that was current when the round started,
  normally the submitted version. It works in a scratch copy, so the repo isn't touched.
  Needs `latexdiff` (`sudo tlmgr install latexdiff` on BasicTeX).

Reviews are saved in the paper's repo under `.tuhi/reviews/`, alongside a copy of each
annotated PDF.

### Provenance (taura)

For papers paired with a code repo in taura, a dot in the editor's left gutter marks every
`\res{}` number, figure and table:

- **green**: traces to a ledger entry
- **amber**: the result or artifact changed in the code repo since it was published, so
  `taura publish` would change it
- **red**: no provenance: an undefined `\res` key, a figure taura didn't generate, or a table
  typed by hand
- **amber ring**: taura flags the line, e.g. a typed number that matches a recorded result

Click a dot for where it came from: the ledger result, the script and commit that produced it,
the data, and when it was published (`taura trace`). The **Provenance** tab lists `taura check`
findings and what `taura publish` would change. tuhi only reads: it runs taura's CLI with
`--json` after each compile and never writes to the ledger.

### Citations (ruru)

- Inside `\cite{…}` (and `\citep`, `\textcite`, `\parencite`, …) completion offers the keys in
  the paper's `.bib` files first, then papers kept for this paper's ruru project, then the rest
  of your ruru library. Type part of a key, a title word or an author.
- Hover a cited key for its title, authors and where it's defined (click to jump to the `.bib`
  entry). For library papers the card also shows your notes, the abstract and agent notes
  (`ruru show`).
- A cited key that no `.bib` defines is underlined: amber if it's in your library (the card and
  message give the command that adds it, `ruru check PROJECT --fix`), red if it's nowhere.
- After each compile `ruru check` adds stale, duplicate and unused `.bib` entries to Problems.

tuhi only reads the library. Commands that change it or the `.bib` are shown for you to run.
Without ruru, completion, hover and the missing-key check still work from the `.bib` files.

### Claim check

The **Claims** tab lists every sentence that cites something (`ruru claims`), with ruru's
verdict on each cited paper: supported, partial, unsupported, not found, background, or
unchecked. **Needs attention** shows the unchecked, outdated and weak ones; weak ones also
appear under Problems at their line.

- **Check unchecked** asks Claude about every citation without a verdict, one call per cited
  paper (two at a time) covering every sentence citing it. Claude reads the paper's full text
  (from its PDF in the library, page by page), a cited draft's `.tex`, or software's README;
  without a PDF it judges from the abstract and says so. **Check again** re-judges one.
- Each verdict comes back as a proposal: the verdict, the paper's own words and page, and a
  note. A warning shows when the quote isn't word for word in the text Claude read.
- **Record** saves it with `ruru verdict … --by claude` (one commit in your library; ruru checks
  the quote against the PDF and refuses it if it isn't there). **Discard** drops it.
- Claims come from the saved files and reload after each compile. A check costs about
  $0.05–0.10 per cited paper, shown in the counts.

Build output goes to the app's cache folder, never into the paper's repo. Uses `latexmk` when
installed, otherwise runs the engine and BibTeX itself. `% !TEX program = xelatex` picks the engine.

## Layout

- `src-tauri/src/project.rs` — finding files and the main `.tex` file
- `src-tauri/src/compile.rs` — compile pipeline and log parsing
- `src-tauri/src/synctex.rs` — forward and inverse search via the `synctex` CLI
- `src/editor.ts`, `src/preview.ts`, `src/main.ts` — editor, PDF preview, wiring

## Tests

```bash
cd src-tauri && cargo test
TUHI_TEST_PROJECT=~/overleaf/trust-align cargo test -- --ignored --nocapture
TUHI_TEST_RURU_PAPER=~/overleaf/trust-align cargo test ruru_library -- --ignored --nocapture
TUHI_TEST_SUGGEST_PAPER=~/overleaf/trust-align cargo test suggests_edits -- --ignored --nocapture
TUHI_TEST_EXPLAIN_PAPER=~/overleaf/trust-align cargo test explains -- --ignored --nocapture
TUHI_TEST_GIT_PROJECT=~/overleaf/trust-align cargo test snapshot_and_diff -- --ignored --nocapture
# judges one claim with Claude and records it in a copy of the library
TUHI_TEST_CLAIMS_PAPER=~/overleaf/trust-align TUHI_RURU_LIBRARY=/tmp/papers-copy cargo test claims_judge -- --ignored --nocapture
```
