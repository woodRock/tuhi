import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";

/** App-wide preferences, kept in this machine's tuhi. Per-paper ones live in .tuhi/settings.json. */
export interface AppSettings {
  theme: "system" | "light" | "dark";
  fontSize: number;
  wrap: boolean;
  /** ⌘S compiles as well as saving. */
  compileOnSave: boolean;
  /** Underfull and overfull box warnings in Problems. */
  boxWarnings: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = { theme: "system", fontSize: 13, wrap: true, compileOnSave: true, boxWarnings: true };

export interface SettingsHooks {
  changed(settings: AppSettings): void;
  setupTools(): void;
  shortcuts(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The Settings view: appearance, editor, compiling, and where paper and code repos live. */
export class SettingsPanel {
  private folders = el("div", "settings-group");

  constructor(
    container: HTMLElement,
    private settings: AppSettings,
    private hooks: SettingsHooks,
  ) {
    const set = (change: Partial<AppSettings>) => {
      this.settings = { ...this.settings, ...change };
      this.hooks.changed(this.settings);
    };

    const theme = el("div", "segmented");
    for (const [value, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as const) {
      const b = el("button", value === settings.theme ? "on" : "", label);
      b.addEventListener("click", () => {
        theme.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        set({ theme: value });
      });
      theme.append(b);
    }

    const size = el("select", "settings-select");
    for (const n of [11, 12, 13, 14, 15, 16, 18, 20]) size.append(new Option(`${n} pt`, String(n), false, n === settings.fontSize));
    size.addEventListener("change", () => set({ fontSize: Number(size.value) }));

    const toggle = (key: "wrap" | "compileOnSave" | "boxWarnings") => {
      const box = el("input");
      box.type = "checkbox";
      box.checked = settings[key];
      box.addEventListener("change", () => set({ [key]: box.checked }));
      return box;
    };

    const tools = el("div", "settings-buttons");
    const setup = el("button", "", "Set Up Tools…");
    setup.addEventListener("click", () => this.hooks.setupTools());
    const keys = el("button", "", "Keyboard Shortcuts");
    keys.addEventListener("click", () => this.hooks.shortcuts());
    tools.append(setup, keys);

    container.append(
      group("Appearance", [row("Theme", theme)]),
      group("Editor", [row("Font size", size), row("Wrap long lines", toggle("wrap"))]),
      group("Compiling", [
        row("Compile when saving (⌘S)", toggle("compileOnSave"), "Off: ⌘S only saves; Compile (⌘B) builds the PDF."),
        row("Show underfull and overfull boxes", toggle("boxWarnings"), "TeX's spacing warnings in Problems. Checks still counts overfull lines."),
      ]),
      this.folders,
      group("Tools", [tools]),
    );
    void this.loadFolders();
  }

  async loadFolders() {
    const roots = await api.rootsGet().catch(() => null);
    const pick = (key: "paper_root" | "code_root", label: string, hint: string) => {
      if (!roots) return el("p", "settings-hint", "Couldn't read the folders.");
      const path = key === "paper_root" ? roots.paper_root : roots.code_root;
      const from = key === "paper_root" ? roots.paper_from : roots.code_from;
      const box = el("div", "settings-folder");
      const shown = el("code", "", path);
      const change = el("button", "", "Change…");
      const reset = el("button", "", "Default");
      change.disabled = reset.disabled = !roots.taura || from === "env";
      reset.hidden = from !== "config";
      const error = el("p", "setup-error");
      change.addEventListener("click", async () => {
        const folder = await open({ directory: true, title: label, defaultPath: path.replace(/^~/, "") || undefined });
        if (typeof folder !== "string") return;
        await api.rootsSet(key, folder).then(() => this.loadFolders(), (e) => (error.textContent = String(e)));
      });
      reset.addEventListener("click", () => void api.rootsSet(key, null).then(() => this.loadFolders(), (e) => (error.textContent = String(e))));
      box.append(shown, change, reset);
      const note = !roots.taura
        ? "Install taura to change it (tuhi ▸ Set Up Tools)."
        : from === "env"
          ? `Set by $${key === "paper_root" ? "TAURA_PAPER_ROOT" : "TAURA_CODE_ROOT"} in the environment.`
          : hint;
      return row(label, box, note, error);
    };
    this.folders.replaceChildren(
      el("h4", "view-heading", "Folders"),
      pick("paper_root", "Papers", "New projects go here. taura pairs each paper with the code repo of the same name."),
      pick("code_root", "Code repos", "Where taura looks for a paper's code repo."),
      el("p", "settings-hint", "Saved with taura config, so taura in a terminal uses the same folders."),
    );
  }
}

function group(title: string, rows: HTMLElement[]) {
  const box = el("div", "settings-group");
  box.append(el("h4", "view-heading", title), ...rows);
  return box;
}

function row(label: string, control: HTMLElement, hint?: string, extra?: HTMLElement) {
  const box = el("div", "settings-row");
  const head = el("label", "settings-row-head");
  head.append(el("span", "settings-label", label), control);
  box.append(head);
  if (hint) box.append(el("p", "settings-hint", hint));
  if (extra) box.append(extra);
  return box;
}
