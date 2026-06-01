import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
// tesseract.js ships as CommonJS (`export = Tesseract`); a namespace import is
// the interop-safe way to reach both its functions and its types under
// verbatimModuleSyntax + bundler resolution.
import * as Tesseract from "tesseract.js";

/**
 * A laid-out line recovered by OCR, in page-point coordinates (top-left origin)
 * — structurally identical to the text-layer `Line` in heuristic.ts so it can
 * flow straight into the same column/paragraph layout.
 */
export type OcrLine = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  size: number;
  text: string;
};

// One worker is created on first use and reused for every scanned page in a
// document (spinning one up downloads ~10MB of wasm + English model from the
// tesseract.js CDN, so we never want to do it per page). Terminated when the
// reflow finishes.
let workerPromise: Promise<Tesseract.Worker> | null = null;

function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) workerPromise = Tesseract.createWorker("eng");
  return workerPromise;
}

/** Tear down the OCR worker and free its memory. Safe to call when unused. */
export async function terminateOcrWorker(): Promise<void> {
  const pending = workerPromise;
  if (!pending) return;
  workerPromise = null;
  try {
    (await pending).terminate();
  } catch {
    /* worker already gone — non-fatal */
  }
}

/**
 * Render a page to a canvas at OCR-friendly resolution and recognise it with
 * Tesseract. Returns line boxes scaled back into page points so the rest of the
 * pipeline (column detection, paragraph grouping, running-head removal) treats
 * them exactly like real text-layer lines.
 */
export async function ocrPage(page: PDFPageProxy): Promise<OcrLine[]> {
  // Tesseract wants ~200+ DPI to read body text reliably. PDF user space is
  // 72 DPI, so render at ~2.5×, capped so huge pages don't blow up memory.
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(2, 1600 / base.width));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  // Paint an opaque white backdrop — a transparent canvas reads as black to the
  // binariser and the page comes back blank.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;

  const worker = await getWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true });

  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const ln of para.lines) {
        const text = ln.text.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const { x0, y0, x1, y1 } = ln.bbox;
        lines.push({
          top: y0 / scale,
          bottom: y1 / scale,
          left: x0 / scale,
          right: x1 / scale,
          // bbox height ≈ glyph height — drives heading detection downstream.
          size: (y1 - y0) / scale,
          text,
        });
      }
    }
  }
  return lines;
}
