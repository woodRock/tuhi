// The legacy build polyfills newer JS (e.g. Map.getOrInsertComputed) that WebKit on macOS 15 lacks.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PdfBox } from "./api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PAGE_GAP = 12;
const SIDE_PADDING = 16;

/**
 * Renders every page of the PDF to a canvas, fitted to the pane's width. Cmd-click on a page
 * reports the position in PDF points (origin top-left), which is what `synctex edit` expects.
 */
export class Preview {
  private task: pdfjs.PDFDocumentLoadingTask | null = null;
  private doc: pdfjs.PDFDocumentProxy | null = null;
  private pages: { el: HTMLElement; scale: number }[] = [];
  private generation = 0;
  /** Width of the latest render, finished or in progress. */
  private targetWidth = 0;
  private rendering: Promise<void> = Promise.resolve();

  constructor(
    private container: HTMLElement,
    private onInverseSync: (page: number, x: number, y: number) => void,
  ) {
    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (this.doc && Math.abs(this.container.clientWidth - this.targetWidth) > 4) void this.render();
      }, 150);
    }).observe(container);
  }

  async load(bytes: ArrayBuffer) {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    const doc = await task.promise;
    const old = this.task;
    this.task = task;
    this.doc = doc;
    void this.render();
    // A resize can supersede the render started here; wait for whichever finishes last.
    let current: Promise<void>;
    do {
      current = this.rendering;
      await current;
    } while (current !== this.rendering);
    void old?.destroy();
  }

  private render(): Promise<void> {
    this.rendering = this.renderPages();
    return this.rendering;
  }

  /** Renders off-screen and swaps in when finished, keeping the scroll position. */
  private async renderPages() {
    const doc = this.doc;
    if (!doc) return;
    const generation = ++this.generation;
    const width = this.container.clientWidth;
    this.targetWidth = width;
    const fitWidth = width - SIDE_PADDING * 2;
    const dpr = window.devicePixelRatio || 1;

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-pages";
    const pages: { el: HTMLElement; scale: number }[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (generation !== this.generation) return;
      const scale = fitWidth / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale: scale * dpr });

      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(n);
      el.style.width = `${viewport.width / dpr}px`;
      el.style.height = `${viewport.height / dpr}px`;
      el.style.marginBottom = `${PAGE_GAP}px`;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      el.append(canvas);
      el.addEventListener("click", (event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        const rect = el.getBoundingClientRect();
        this.onInverseSync(n, (event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale);
      });
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      if (generation !== this.generation) return;
      wrapper.append(el);
      pages.push({ el, scale });
    }

    const scrollRatio = this.container.scrollTop / Math.max(this.container.scrollHeight, 1);
    this.container.replaceChildren(wrapper);
    this.container.scrollTop = scrollRatio * this.container.scrollHeight;
    this.pages = pages;
  }

  /** Draws the SyncTeX boxes for a source line and scrolls the first one into view. */
  highlight(boxes: PdfBox[]) {
    this.container.querySelectorAll(".sync-mark").forEach((el) => el.remove());
    let first: HTMLElement | null = null;
    for (const box of boxes) {
      const page = this.pages[box.page - 1];
      if (!page) continue;
      const mark = document.createElement("div");
      mark.className = "sync-mark";
      mark.style.left = `${box.x * page.scale - 2}px`;
      mark.style.top = `${box.y * page.scale - 2}px`;
      mark.style.width = `${box.width * page.scale + 4}px`;
      mark.style.height = `${box.height * page.scale + 4}px`;
      page.el.append(mark);
      first ??= mark;
      mark.addEventListener("animationend", () => mark.remove());
    }
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  clear() {
    this.generation++;
    void this.task?.destroy();
    this.task = null;
    this.doc = null;
    this.pages = [];
    this.container.replaceChildren();
  }
}
