import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

/** A reviewer's mark on a PDF page, with the position in points from the top-left. */
export interface PdfComment {
  kind: string;
  page: number;
  x: number;
  y: number;
  /** The text under a highlight, strikeout or underline. */
  quote?: string;
  comment: string;
  author?: string;
}

// Annotation types that are part of the document rather than a reviewer's mark.
const NOT_COMMENTS = new Set(["Link", "Popup", "Widget", "FileAttachment", "Sound", "Movie", "Screen"]);

// What a mark means when the reviewer left no words with it.
const IMPLIED: Record<string, string> = {
  StrikeOut: "Delete this.",
  Caret: "Insert something here.",
  Ink: "Handwritten mark; read the reviewer's PDF.",
};

/** Reads highlights, sticky notes, strikeouts and replies from an annotated PDF. */
export async function readAnnotations(bytes: ArrayBuffer): Promise<PdfComment[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const doc = await task.promise;
    const comments: PdfComment[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const top = page.view[3];
      let items: TextItem[] | null = null;
      const byRef = new Map<string, PdfComment>();
      const replies: { to: string; text: string; author?: string }[] = [];
      // Marks made as one, like Acrobat's "replace text": a strikeout grouped with a caret.
      const grouped: { to: string; text: string; comment: PdfComment }[] = [];

      for (const a of await page.getAnnotations()) {
        if (NOT_COMMENTS.has(a.subtype)) continue;
        const text: string = a.contentsObj?.str?.trim() ?? "";
        const author: string | undefined = a.titleObj?.str?.trim() || undefined;
        const group = a.inReplyTo && a.replyType === "Group";
        if (a.inReplyTo && !group) {
          if (text) replies.push({ to: a.inReplyTo, text, author });
          continue;
        }
        let quote: string | undefined;
        if (a.quadPoints?.length) {
          items ??= (await page.getTextContent()).items.filter((i): i is TextItem => "str" in i && i.str !== "");
          quote = textInQuads(items, a.quadPoints) || undefined;
        }
        if (!text && !quote && !IMPLIED[a.subtype]) continue;
        const [x1, y1, x2, y2] = a.rect as number[];
        const comment: PdfComment = {
          kind: a.subtype,
          page: n,
          x: (x1 + x2) / 2,
          y: top - (y1 + y2) / 2,
          quote,
          comment: text || IMPLIED[a.subtype] || "",
          author,
        };
        if (group) {
          grouped.push({ to: a.inReplyTo, text, comment });
          continue;
        }
        comments.push(comment);
        byRef.set(a.id, comment);
      }
      for (const { to, text, comment } of grouped) {
        const parent = byRef.get(to);
        if (!parent) {
          comments.push(comment);
        } else if (comment.kind === "StrikeOut" && parent.kind === "Caret") {
          // Both halves carry the new wording; the strikeout says what it replaces.
          Object.assign(parent, {
            kind: text ? "Replace" : "StrikeOut",
            x: comment.x,
            y: comment.y,
            quote: comment.quote,
            comment: text ? `Replace with "${text}"` : IMPLIED.StrikeOut,
          });
        } else {
          parent.quote ??= comment.quote;
          if (text && text !== parent.comment) parent.comment += `\n\n${text}`;
        }
      }
      for (const reply of replies) {
        const parent = byRef.get(reply.to);
        if (parent) parent.comment += `\n\nReply${reply.author ? ` (${reply.author})` : ""}: ${reply.text}`;
      }
    }
    return comments;
  } finally {
    void task.destroy();
  }
}

/** The page text covered by a highlight's quads, in reading order. */
function textInQuads(items: TextItem[], quads: ArrayLike<number>): string {
  const parts: string[] = [];
  for (let q = 0; q + 8 <= quads.length; q += 8) {
    const xs = [quads[q], quads[q + 2], quads[q + 4], quads[q + 6]];
    const ys = [quads[q + 1], quads[q + 3], quads[q + 5], quads[q + 7]];
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pieces: { x: number; text: string }[] = [];
    for (const item of items) {
      const [, , , , x, baseline] = item.transform;
      const middle = baseline + item.height / 2;
      if (middle < minY || middle > maxY || x > maxX || x + item.width < minX) continue;
      // Highlights often cover part of a text run; slice it in proportion to the overlap.
      const length = item.str.length;
      const start = item.width > 0 ? Math.round(((Math.max(minX, x) - x) / item.width) * length) : 0;
      const end = item.width > 0 ? Math.round(((Math.min(maxX, x + item.width) - x) / item.width) * length) : length;
      pieces.push({ x, text: item.str.slice(start, end) });
    }
    pieces.sort((a, b) => a.x - b.x);
    parts.push(pieces.map((p) => p.text).join(""));
  }
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/(\p{L})- (\p{Ll})/gu, "$1$2") // re-join words hyphenated across lines
    .trim();
}
