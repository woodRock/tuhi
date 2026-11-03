import * as api from "./api";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A modal sheet; Escape or clicking outside closes it unless `busy()` says not to. */
function sheet(title: string, busy: () => boolean = () => false) {
  const backdrop = el("div", "sheet-backdrop");
  const box = el("div", "sheet setup-sheet");
  box.setAttribute("role", "dialog");
  box.append(el("h2", "", title));
  backdrop.append(box);
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy()) close();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop && !busy()) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  return { box, close };
}

const field = (label: string, input: HTMLElement, hint?: HTMLElement | string) => {
  const row = el("label", "setup-field");
  row.append(el("span", "setup-label", label), input);
  if (hint) row.append(typeof hint === "string" ? el("small", "setup-hint", hint) : hint);
  return row;
};

const input = (placeholder: string, value = "") => {
  const i = el("input", "setup-input");
  i.placeholder = placeholder;
  i.value = value;
  i.spellcheck = false;
  return i;
};

const check = (label: string, on: boolean) => {
  const row = el("label", "setup-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = on;
  const text = el("span", "", label);
  row.append(box, text);
  return { row, box, text };
};

function copyable(command: string) {
  const row = el("div", "setup-command");
  const code = el("code", "", command);
  const copy = el("button", "", "Copy");
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(command).catch(() => {});
    copy.textContent = "Copied";
  });
  row.append(code, copy);
  return row;
}

// First-run setup

/** Which tools are installed, installing uv, ruru and taura, and the ruru library. */
export function showSetup(done: () => void) {
  let busy = false;
  const { box, close } = sheet("Set up tuhi", () => busy);
  box.classList.add("wide");
  box.append(el("p", "setup-lead", "tuhi works with just TeX. These add the rest: install what you'd like, now or later from tuhi ▸ Set Up Tools."));
  const body = el("div", "setup-tools");
  const foot = el("div", "setup-foot");
  const again = el("button", "", "Check again");
  const finish = el("button", "primary", "Done");
  foot.append(again, el("span", "spacer"), finish);
  box.append(body, foot);

  const render = async () => {
    body.replaceChildren(el("p", "setup-hint", "Checking…"));
    const status = await api.setupStatus().catch((e) => {
      body.replaceChildren(el("p", "setup-error", String(e)));
      return null;
    });
    if (!status) return;
    const uv = status.tools.find((t) => t.name === "uv")?.found ?? false;
    const rows = status.tools.map((tool) => {
      const row = el("div", `setup-tool ${tool.found ? "found" : "missing"}`);
      const head = el("div", "setup-tool-head");
      head.append(el("span", "setup-mark", tool.found ? "✓" : "–"), el("strong", "", tool.name));
      if (tool.version) head.append(el("small", "setup-version", tool.version));
      head.append(el("span", "spacer"));
      if (!tool.found && tool.installable) {
        const install = el("button", "primary", "Install");
        const needsUv = tool.name !== "uv" && !uv;
        install.disabled = needsUv;
        if (needsUv) install.title = "Install uv first";
        install.addEventListener("click", async () => {
          busy = true;
          install.disabled = true;
          install.textContent = "Installing…";
          try {
            await api.setupInstall(tool.name);
            await render();
          } catch (error) {
            install.textContent = "Install";
            install.disabled = false;
            row.append(el("p", "setup-error", String(error)));
          } finally {
            busy = false;
          }
        });
        head.append(install);
      }
      row.append(head, el("p", "setup-about", tool.about));
      if (!tool.found && !tool.installable && tool.command) row.append(copyable(tool.command));
      if (tool.name === "ruru" && tool.found) row.append(library(status.library));
      return row;
    });
    body.replaceChildren(...rows);
  };

  const library = (lib: api.SetupStatus["library"]) => {
    const box = el("div", "setup-library");
    if (lib.exists) {
      box.append(el("p", "setup-about", `Library: ${lib.path}`));
      return box;
    }
    const path = input("~/papers", lib.path);
    const email = input("you@example.org");
    email.type = "email";
    const create = el("button", "primary", "Create library");
    const error = el("p", "setup-error");
    create.addEventListener("click", async () => {
      busy = true;
      create.disabled = true;
      try {
        await api.setupInitLibrary(path.value || lib.path, email.value);
        await render();
      } catch (e) {
        error.textContent = String(e);
        create.disabled = false;
      } finally {
        busy = false;
      }
    });
    box.append(
      el("p", "setup-about", "ruru needs a library: a git folder of your papers."),
      field("Folder", path),
      field("Email", email, "For the OpenAlex and Crossref polite pools when looking papers up."),
      create,
      error,
    );
    return box;
  };

  again.addEventListener("click", () => void render());
  finish.addEventListener("click", () => {
    if (busy) return;
    close();
    done();
  });
  void render();
}

// New project, or linking an open one

export interface ProjectHooks {
  open(path: string): Promise<void>;
}

export interface Current {
  root: string;
  name: string;
  /** The ruru project this folder already belongs to. */
  ruru: string | null;
  /** taura already pairs it with a code repo. */
  taura: boolean;
}

/**
 * New Project creates a paper (from a template or an Overleaf clone) under the paper root and
 * links it; with `current`, links that open paper instead.
 */
export function showNewProject(hooks: ProjectHooks, current: Current | null = null) {
  let busy = false;
  const { box, close } = sheet(current ? `Link ${current.name}` : "New project", () => busy);
  box.classList.add("wide");
  const form = el("div", "setup-form");
  const steps = el("ul", "setup-steps");
  const foot = el("div", "setup-foot");
  const cancel = el("button", "", "Cancel");
  const go = el("button", "primary", current ? "Link" : "Create");
  foot.append(cancel, el("span", "spacer"), go);
  box.append(form, steps, foot);
  cancel.addEventListener("click", () => !busy && close());

  const name = input("e.g. fish-gcms", current?.name ?? "");
  const where = el("small", "setup-hint");
  const title = input("Title of the paper");
  const source = el("div", "segmented");
  const fromTemplate = el("button", "on", "Template");
  const fromOverleaf = el("button", "", "Clone from Overleaf");
  source.append(fromTemplate, fromOverleaf);
  const template = el("select", "setup-input");
  template.append(new Option("Article", "article"), new Option("IEEE journal (IEEEtran)", "ieee"));
  const url = input("https://git.overleaf.com/…");
  const ruru = check("Link to ruru", !current?.ruru);
  const taura = check("Pair with taura", !current?.taura);
  const ruruNote = el("small", "setup-hint");
  const tauraNote = el("small", "setup-hint");
  const templateRows = [field("Title", title), field("Template", template)];
  const cloneRow = field("Git URL", url, "In Overleaf: Menu ▸ Git. The first clone may need a token; tuhi says how if so.");

  let status: api.SetupStatus | null = null;
  let clone = false;
  const slug = () => name.value.trim();
  const refresh = () => {
    const root = status?.paper_root ?? "~/overleaf";
    const code = status?.code_root ?? "~/Desktop";
    const n = slug() || "<name>";
    where.textContent = current ? current.root : `Saved in ${root}/${n}`;
    for (const r of templateRows) r.hidden = clone;
    cloneRow.hidden = !clone;
    fromTemplate.classList.toggle("on", !clone);
    fromOverleaf.classList.toggle("on", clone);
    const hasRuru = status?.tools.find((t) => t.name === "ruru")?.found;
    const hasTaura = status?.tools.find((t) => t.name === "taura")?.found;
    ruru.box.disabled = !hasRuru || !status?.library.exists || !!current?.ruru;
    taura.box.disabled = !hasTaura || !!current?.taura;
    if (ruru.box.disabled) ruru.box.checked = false;
    if (taura.box.disabled) taura.box.checked = false;
    ruruNote.textContent = current?.ruru
      ? `Already ruru project ${current.ruru}.`
      : !hasRuru
        ? "ruru isn't installed (tuhi ▸ Set Up Tools)."
        : !status?.library.exists
          ? "Create a ruru library first (tuhi ▸ Set Up Tools)."
          : `Citation completion and checks from your library: ruru project ${n}, with the paper's .bib.`;
    tauraNote.textContent = current?.taura
      ? "Already paired with a code repo."
      : !hasTaura
        ? "taura isn't installed (tuhi ▸ Set Up Tools)."
        : `Pairs with the code repo ${code}/${n} (created if it doesn't exist) and runs taura init there.`;
  };
  fromTemplate.addEventListener("click", () => ((clone = false), refresh()));
  fromOverleaf.addEventListener("click", () => ((clone = true), refresh()));
  name.addEventListener("input", refresh);

  if (current) {
    name.disabled = true;
    form.append(field("Name", name, where));
  } else {
    form.append(field("Name", name, where), field("Start from", source), ...templateRows, cloneRow);
  }
  const links = el("div", "setup-links");
  links.append(ruru.row, ruruNote, taura.row, tauraNote);
  form.append(links);
  refresh();
  void api.setupStatus().then((s) => {
    status = s;
    refresh();
  });
  if (!current) setTimeout(() => name.focus());

  const step = (label: string) => {
    const li = el("li", "setup-step running", label);
    steps.append(li);
    return {
      ok: (detail?: string) => {
        li.className = "setup-step ok";
        if (detail) li.append(el("small", "", detail));
      },
      fail: (error: unknown) => {
        li.className = "setup-step failed";
        li.append(el("pre", "setup-error", String(error)));
      },
    };
  };

  go.addEventListener("click", async () => {
    if (busy) return;
    if (!slug()) return name.focus();
    busy = true;
    go.disabled = cancel.disabled = true;
    form.classList.add("locked");
    steps.replaceChildren();
    let dir = current?.root ?? "";
    let snippet: string | null = null;
    let failed = false;
    try {
      if (!current) {
        const s = step(clone ? "Cloning from Overleaf" : "Creating the paper");
        try {
          dir = await api.newPaper({
            name: slug(),
            source: clone ? "clone" : "template",
            url: url.value,
            template: template.value as "article" | "ieee",
            title: title.value,
            taura: taura.box.checked,
          });
          s.ok(dir);
        } catch (e) {
          s.fail(e);
          return;
        }
      }
      if (ruru.box.checked) {
        const s = step("Linking to ruru");
        await api.linkRuru(slug(), dir).then(s.ok, (e) => ((failed = true), s.fail(e)));
      }
      if (taura.box.checked) {
        const s = step("Pairing with taura");
        await api.pairTaura(dir, null).then(
          (paired) => {
            s.ok(`Code repo ${paired.code}`);
            // A template already has taura's lines; a cloned or existing paper needs them added.
            if (clone || current) snippet = paired.instructions;
          },
          (e) => ((failed = true), s.fail(e)),
        );
      }
      if (snippet) {
        const li = el("li", "setup-step note");
        li.append(el("span", "", "Add to the paper's preamble:"), el("pre", "setup-snippet", snippet));
        steps.append(li);
      }
      cancel.textContent = "Close";
      cancel.disabled = false;
      const open = el("button", "primary", current ? "Done" : "Open project");
      go.replaceWith(open);
      open.addEventListener("click", async () => {
        close();
        await hooks.open(dir);
      });
      if (!failed && !snippet) open.focus();
    } finally {
      busy = false;
      if (!dir) {
        go.disabled = cancel.disabled = false;
        form.classList.remove("locked");
      }
    }
  });
}
