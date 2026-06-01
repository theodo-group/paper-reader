import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { pdfjsLib } from "./types";
import { ocrPage, terminateOcrWorker } from "./ocr";
import type {
  Block,
  Progress,
  ReflowBackend,
  ReflowPage,
  TextBlock,
} from "./types";

/** A laid-out text line collected from the PDF. */
type Line = {
  top: number; // distance from top of page (PDF points)
  bottom: number;
  left: number;
  right: number;
  size: number; // glyph height
  text: string;
};

/** A geometric box in page-point coordinates (top-left origin). */
type Box = { left: number; top: number; width: number; height: number };

/** A figure rasterised from the page, positioned in page-point coordinates. */
type PlacedImage = Box & {
  bitmapWidth: number;
  bitmapHeight: number;
  url: string;
};

type RawPage = {
  number: number;
  lines: Line[];
  images: PlacedImage[];
  pageWidth: number;
  pageHeight: number;
  /** True when the page has no usable text layer and must be OCR'd. */
  scanned?: boolean;
  /**
   * True when the page carried a full-page backdrop image (a scanned page behind
   * an OCR text layer). Gates caption-anchored figure detection so it never runs
   * on ordinary vector PDFs.
   */
  backdrop?: boolean;
};

/**
 * Local, heuristic-only backend. Walks the text layer and operator list of each
 * page, applies a battery of filters to discard symbol-font gibberish, sidebar
 * UI, running heads, and text painted on top of figures, then rebuilds reading
 * order into paragraphs and figure crops.
 *
 * Works well on most digital papers but has known limits — see README.
 */
export class HeuristicBackend implements ReflowBackend {
  readonly name = "heuristic" as const;

  async reflow(data: ArrayBuffer, onProgress?: Progress): Promise<ReflowPage[]> {
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const raws: RawPage[] = [];

    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const raw = await extractPage(page, n);
        if (raw.scanned) {
          // No real text layer (a scanned/image-only page). Recover the text by
          // OCR'ing the rendered page. This is slow — surface it in the phase
          // label so the reader knows why — and reuses one worker per document.
          // OCR bypasses collectLines, so apply the same cleaning here: collapse
          // glyph-spacing, drop gibberish (OCR of a diagram/table grid) and bare
          // page numbers, so a noisy scan doesn't dump garbage into the prose.
          onProgress?.(n - 1, doc.numPages, "Reading scanned pages (OCR)…");
          raw.lines = (await ocrPage(page))
            .map((l) => ({ ...l, text: collapseLetterSpacing(l.text) }))
            .filter((l) => l.text.trim().length > 0)
            .filter((l) => !isGibberish(l.text))
            .filter((l) => !isBarePageNumber(l.text));
        }
        raws.push(raw);
        onProgress?.(n, doc.numPages);
        page.cleanup();
      }
    } finally {
      await terminateOcrWorker();
    }

    const running = findRunningLines(raws);
    return joinAcrossPageBreaks(raws.map((r) => layoutPage(r, running)));
  }
}

// ---------------------------------------------------------------------------
// Per-page extraction: images first (so we know where to suppress text), then
// text, then crop bitmaps.
// ---------------------------------------------------------------------------

async function extractPage(page: PDFPageProxy, n: number): Promise<RawPage> {
  const viewport = page.getViewport({ scale: 1 });
  const pageHeight = viewport.height;
  const pageWidth = viewport.width;

  // PDF user-space coordinates don't necessarily start at (0, 0): the page's
  // mediabox/cropbox can be offset (e.g. Annual Reviews ships pages whose
  // viewBox is [40.97, 67.97, 571.97, 724.97]). pdf.js gives us the page's
  // viewBox via `page.view = [x0, y0, x1, y1]`; everything we read from the
  // operator-list CTM is in that user space, so we need to translate by
  // (view[0], view[3] - pageHeight) to land in the same top-left viewport
  // space we render into for the bitmap crop. Without this, image boxes are
  // shifted ~41pt right and ~68pt up vs. the rendered figure.
  const view = page.view ?? [0, 0, pageWidth, pageHeight];
  const offsetX = view[0];
  const offsetY = view[3] - pageHeight;
  // The page's NATIVE (unrotated) dimensions, from the mediabox. On a rotated
  // page (e.g. the landscape data tables here ship as a 648×432 mediabox with
  // /Rotate 270) these differ from the rendered viewport's pageWidth/pageHeight
  // (which are post-rotation). The bitmap crop renders the page UNROTATED (so a
  // sideways-printed table comes out upright and uncut), so its boxes must be
  // clamped to these native dimensions, not the rotated viewport's.
  const nativeWidth = view[2] - view[0];
  const nativeHeight = view[3] - view[1];

  const rawBoxes = await collectImageBoxes(page, pageHeight);
  const merged = mergeImageBoxes(rawBoxes);

  // A near-page-sized image is a scanned-page *backdrop*, not a figure. Many
  // scanned papers ship the page bitmap behind an invisible OCR text layer
  // (e.g. the MIT Hackman/Oldham scan). Treating it as a figure is doubly
  // wrong: it suppresses every text line whose center lands on it (i.e. all of
  // them) AND re-emits the whole page as one giant "figure". Split such boxes
  // off so they neither suppress text nor get cropped — the embedded text layer
  // then reads normally.
  const backdrop = merged.some((b) => isPageBackdrop(b, pageWidth, pageHeight));
  const figureBoxes = merged.filter((b) => !isPageBackdrop(b, pageWidth, pageHeight));

  const { lines, textChars } = await collectLines(page, pageHeight, figureBoxes);

  // No usable text layer at all → a true scan that needs OCR. Judge this from
  // `textChars` (the page's text volume BEFORE figure suppression), NOT from the
  // suppressed `lines`: a landscape data table whose text all sits inside its
  // image box leaves `lines` empty but still HAS a perfectly good text layer —
  // OCR'ing it would re-render the table into garbage instead of cropping it.
  if (isScanned(textChars, merged, pageWidth, pageHeight)) {
    return { number: n, lines: [], images: [], pageWidth, pageHeight, scanned: true, backdrop };
  }

  // On a *scanned* page (one that carried a full-page backdrop we just dropped),
  // real figures and tables are baked INTO that backdrop, so the vector
  // image-box path above finds nothing for them. Recover them by their caption:
  // a clean "FIG. 1." / "TABLE 2" line anchors a box over the adjacent artwork.
  // This runs only when a backdrop was present, so ordinary vector PDFs — whose
  // figures already come through figureBoxes — are completely unaffected.
  const captionBoxes = backdrop ? detectScannedFigures(lines, pageWidth, pageHeight) : [];

  // Suppress text whose center falls inside a caption-anchored figure box (the
  // gibberish diagram/table labels) — same rule collectLines applies to vector
  // figure boxes, but applied here because these boxes are derived FROM the
  // lines. The caption line itself sits just outside the box (we stop the box
  // one point short of it) so it survives as clean text. IMPORTANT: figure
  // detection must see the raw lines (the gibberish cluster is what sizes the
  // figure band), so the content-based gibberish filter runs AFTER this, on the
  // survivors — it mops up any garbled labels outside a detected figure box
  // (e.g. on a page where caption detection failed).
  const deFigured = captionBoxes.length > 0
    ? lines.filter((l) => !insideAnyBox((l.left + l.right) / 2, (l.top + l.bottom) / 2, captionBoxes))
    : lines;
  const suppressed = deFigured.filter((l) => !isGibberish(l.text));

  // Pad each figure box for the BITMAP CROP only — vector labels/axis ticks
  // often protrude just outside the raw bitmap. Use the *unpadded* boxes for
  // text suppression so we don't accidentally clip body lines that sit right
  // next to a figure (which would manifest as truncated left edges). Padding is
  // asymmetric: figure labels protrude horizontally far more than vertically.
  //
  // The boxes from collectImageBoxes (and detectScannedFigures) are in the same
  // "pageHeight-flipped, raw ctm.x" space that collectLines uses (so
  // text-suppression matches). The shift by (-offsetX, offsetY) lands them in
  // the UNROTATED page render's coordinate system (top-left origin, native
  // mediabox dimensions) — which is what rasteriseImages renders into — so we
  // clamp the pad against the native dimensions, not the rotated viewport's.
  const cropBoxes = [...figureBoxes, ...captionBoxes]
    .map((b) => shiftBox(b, -offsetX, offsetY))
    .map((b) => padBox(b, 30, 12, nativeWidth, nativeHeight));

  const placed = cropBoxes.length > 0 ? await rasteriseImages(page, cropBoxes) : [];
  // The PlacedImage left/top is used downstream for reading-order alignment
  // with text lines, which still live in the un-shifted coordinate space.
  // Translate back so figures land next to their captions, not above them.
  const images = placed.map((p) => ({
    ...p,
    left: p.left + offsetX,
    top: p.top - offsetY,
  }));

  return { number: n, lines: suppressed, images, pageWidth, pageHeight, backdrop };
}

/**
 * A box that covers nearly the whole page is a scanned-page backdrop, not a
 * figure. Require both dimensions to be near-page-sized so we don't mistake a
 * genuinely wide-but-short banner figure for a backdrop.
 */
function isPageBackdrop(b: Box, pageWidth: number, pageHeight: number): boolean {
  return b.width >= pageWidth * 0.9 && b.height >= pageHeight * 0.9;
}

/**
 * Matches a figure/table caption label. Anchored at the start of the line OR
 * just after a period: in a scanned page the OCR caption number ("FIG. 1.")
 * frequently sorts AFTER its title on the same baseline and merges as
 * "...work motivation.FIG. 1.", so a strictly start-anchored test misses it.
 * Capture group 1 is the keyword, used to decide which side the artwork is on.
 */
const CAPTION_RE =
  /(?:^|\.)\s*(fig(?:ure)?|table|plate|chart|exhibit|scheme)\.?\s*\.?\s*\d/i;

/**
 * Caption-anchored figure/table detection for SCANNED pages. Real figures are
 * baked into the dropped page backdrop, so we can't find them in the image
 * operator list — but their captions survive cleanly in the OCR text layer.
 * For each caption we project a box over the adjacent artwork:
 *
 *  - "FIG."/"FIGURE"/"CHART"/etc. are captioned BELOW the artwork, so we walk
 *    UPWARD from the caption; "TABLE" is captioned ABOVE its data, so we walk
 *    DOWNWARD. The box is the contiguous run of NON-body lines adjacent to the
 *    caption — i.e. the gibberish diagram labels / table cells — stopping at the
 *    first regular body-text line, a large whitespace gap, or the page margin.
 *  - Horizontally the box spans the body text column (min left … max right of
 *    body lines), which is where single-column scanned artwork lives.
 *
 * Returned boxes are in the same flipped/raw-ctm space as `lines`, so they slot
 * straight into both text suppression and the existing crop pipeline. Kept
 * conservative (min size gates, margin clamp) so prose-only pages never yield a
 * box and we never crop blank margin.
 */
function detectScannedFigures(lines: Line[], pageWidth: number, pageHeight: number): Box[] {
  // Body size = the most common rounded line size, WEIGHTED BY CHARACTERS so a
  // table-heavy page doesn't elect the small table font as "body" (prose lines
  // are long; table cells are short fragments). Mirrors groupIntoBlocks' notion
  // of body size, refined for this mixed-content case.
  const counts = new Map<number, number>();
  for (const l of lines) {
    const s = Math.round(l.size);
    counts.set(s, (counts.get(s) ?? 0) + l.text.length);
  }
  let bodySize = 10;
  let best = -1;
  for (const [s, c] of counts) if (c > best) ((best = c), (bodySize = s));

  const bodyLines = lines.filter((l) => Math.round(l.size) === bodySize);
  if (bodyLines.length < 3) return []; // not enough prose to anchor a column
  const colLeft = Math.min(...bodyLines.map((l) => l.left));
  const colRight = Math.max(...bodyLines.map((l) => l.right));
  const colWidth = colRight - colLeft;

  // A "prose" line: a full-width body PARAGRAPH line. Body size AND starting near
  // the column's left margin AND reaching most of the way across the column AND
  // carrying a sentence's worth of characters. The width/length gates are what
  // make this robust on a SCANNED TABLE PAGE whose cells share the body font
  // (e.g. page 27 of the Hackman/Oldham scan, ~one 9pt size everywhere): a cell
  // like "Growth need strength" starts at the margin and is body-size — so the
  // old size+left "isBody" test wrongly counted it as prose, collapsing the
  // table band to a tiny box and leaking every other cell — but it only spans a
  // third of the column, so it is correctly NOT prose. Real paragraph lines, the
  // table FOOTNOTE prose, and ordinary prose pages still register as prose.
  const isProse = (l: Line): boolean =>
    Math.round(l.size) === bodySize &&
    l.left <= colLeft + pageWidth * 0.06 &&
    l.right >= colLeft + colWidth * 0.7 &&
    l.text.length >= 40;

  const margin = pageHeight * 0.08; // running-head / page-margin band

  const out: Box[] = [];
  for (const cap of lines) {
    const m = CAPTION_RE.exec(cap.text);
    if (!m) continue;
    const kw = m[1].toLowerCase();
    // Figures are captioned below their artwork; tables above their data.
    const artworkAbove = !kw.startsWith("table");

    let top: number;
    let bottom: number;
    if (artworkAbove) {
      bottom = cap.top - 1;
      let lo = cap.top;
      const band = lines
        .filter((l) => l.bottom <= cap.top + 0.5 && !isProse(l))
        .sort((a, b) => b.top - a.top); // nearest the caption first
      for (const l of band) {
        if (l.top < margin) break; // don't swallow the running head
        const proseBetween = lines.some(
          (b) => isProse(b) && b.top < lo && b.bottom > l.bottom + 2
        );
        if (proseBetween) break; // a body paragraph separates this line from the box
        if (lo - l.bottom > bodySize * 4) break; // large whitespace gap → stop
        lo = Math.min(lo, l.top);
      }
      top = Math.max(margin, lo - 4);
    } else {
      // TABLE: the data grid sits BELOW the caption. First skip the table's
      // TITLE — the contiguous run of full-width centered lines right after the
      // caption ("RELATIONSHIPS AMONG JOB DIMENSIONS…") — which we keep as
      // readable text above the cropped grid. Key off WIDTH, not font size: on a
      // one-font page (page 21) the title shares the body size, so a size test
      // misses it and it then blocks the grid walk below as if it were body
      // prose, collapsing the box. Grid cells are short, so they're never
      // mistaken for a title line; the contiguous-after-caption run stops at the
      // first short cell.
      const isWide = (l: Line) => l.right - l.left >= colWidth * 0.6;
      let gridTop = cap.bottom;
      const titleBand = lines
        .filter((l) => l.top >= cap.bottom - 0.5 && isWide(l))
        .sort((a, b) => a.top - b.top);
      for (const l of titleBand) {
        if (l.top - gridTop > bodySize * 2) break; // gap → past the title, into the grid
        gridTop = Math.max(gridTop, l.bottom);
      }
      top = gridTop + 1;
      let lo = gridTop;
      const band = lines
        .filter((l) => l.top >= gridTop - 0.5 && !isProse(l))
        .sort((a, b) => a.top - b.top); // nearest the caption first
      for (const l of band) {
        // Stop at body prose BELOW the grid (the footnote / next paragraph). The
        // title is already above `gridTop`, so it can't trigger this.
        const proseBetween = lines.some(
          (b) => isProse(b) && b.bottom > lo && b.top < l.top - 2
        );
        if (proseBetween) break;
        if (l.top - lo > bodySize * 4) break;
        lo = Math.max(lo, l.bottom);
      }
      bottom = Math.min(pageHeight - margin, lo + 4);
    }

    const height = bottom - top;
    const width = colRight - colLeft;
    // Conservative gates: a real figure/table band is several lines tall and
    // spans a meaningful slice of the page. Rejects stray inline references and
    // captions with no adjacent artwork (so we never crop blank margin).
    if (height < bodySize * 3 || width < pageWidth * 0.2) continue;
    out.push({ left: colLeft, top, width, height });
  }
  return out;
}

/**
 * Heuristic test for a scanned/image-only page with NO usable text layer: a
 * large image covers most of the page yet (even after ignoring that backdrop)
 * almost no text was recovered. Such pages yield blank output from the
 * text-layer path and need OCR instead. Kept conservative so real text pages —
 * even sparse ones like a title page — are never sent down the (slow) OCR path:
 * we require a near-page image to be present, not merely an absence of text.
 */
function isScanned(textChars: number, imageBoxes: Box[], pageWidth: number, pageHeight: number): boolean {
  const pageArea = pageWidth * pageHeight;
  const bigImage = imageBoxes.some((b) => b.width * b.height > pageArea * 0.4);
  if (bigImage && textChars < 100) return true;
  // Effectively no text but some imagery present — still worth OCR'ing.
  if (textChars < 20 && imageBoxes.length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Image extraction. Walk the operator list to find every image-paint site and
// its current transformation matrix, then merge nearby boxes aggressively —
// scientific figures are typically emitted as a flock of adjacent tiles plus a
// vector overlay, and the previous tight-overlap merge left them as stripes.
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

async function collectImageBoxes(page: PDFPageProxy, pageHeight: number): Promise<Box[]> {
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const boxes: Box[] = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case OPS.transform:
        ctm = pdfjsLib.Util.transform(ctm, args as Matrix) as Matrix;
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintInlineImageXObject: {
        const w = Math.abs(ctm[0]);
        const h = Math.abs(ctm[3]);
        // Keep small tiles too — they often combine into a real figure once merged.
        if (w < 16 || h < 16) break;
        boxes.push({ left: ctm[4], top: pageHeight - (ctm[5] + h), width: w, height: h });
        break;
      }
      default:
        break;
    }
  }
  return boxes;
}

/**
 * Merge any two boxes within `joinGap` points of each other on both axes. This
 * collapses tiled figures into a single rectangle. Iterates until stable so
 * three-tile and four-tile figures join transitively.
 */
function mergeImageBoxes(boxes: Box[]): Box[] {
  if (boxes.length === 0) return [];
  const joinGap = 36; // ≈ ½ inch — generous, intentionally
  const result: Box[] = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        const hTouch = !(a.left + a.width + joinGap < b.left || b.left + b.width + joinGap < a.left);
        const vTouch = !(a.top + a.height + joinGap < b.top || b.top + b.height + joinGap < a.top);
        if (hTouch && vTouch) {
          const left = Math.min(a.left, b.left);
          const top = Math.min(a.top, b.top);
          const right = Math.max(a.left + a.width, b.left + b.width);
          const bottom = Math.max(a.top + a.height, b.top + b.height);
          result[i] = { left, top, width: right - left, height: bottom - top };
          result.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  // Drop anything still tiny after merging — almost always decorative rules.
  return result.filter((b) => b.width >= 60 && b.height >= 60);
}

function shiftBox(b: Box, dx: number, dy: number): Box {
  return { left: b.left + dx, top: b.top + dy, width: b.width, height: b.height };
}

function padBox(b: Box, padX: number, padY: number, pageW: number, pageH: number): Box {
  const left = Math.max(0, b.left - padX);
  const top = Math.max(0, b.top - padY);
  const right = Math.min(pageW, b.left + b.width + padX);
  const bottom = Math.min(pageH, b.top + b.height + padY);
  return { left, top, width: right - left, height: bottom - top };
}

async function rasteriseImages(page: PDFPageProxy, boxes: Box[]): Promise<PlacedImage[]> {
  // Render the whole page once at 2× and crop — captures vector overlays that a
  // raw image-XObject decode would miss. Render in the page's NATIVE orientation
  // (rotation: 0): the crop boxes are computed in unrotated user space, and a
  // table printed sideways on a rotated page then comes out upright and fully
  // captured rather than rotated and clipped to a corner.
  const scale = 2;
  const viewport = page.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  await page.render({ canvasContext: ctx, viewport }).promise;

  const out: PlacedImage[] = [];
  for (const b of boxes) {
    const sx = Math.max(0, Math.floor(b.left * scale));
    const sy = Math.max(0, Math.floor(b.top * scale));
    const sw = Math.min(canvas.width - sx, Math.ceil(b.width * scale));
    const sh = Math.min(canvas.height - sy, Math.ceil(b.height * scale));
    if (sw < 96 || sh < 96) continue;
    const crop = document.createElement("canvas");
    crop.width = sw;
    crop.height = sh;
    const cctx = crop.getContext("2d");
    if (!cctx) continue;
    cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    out.push({
      left: b.left,
      top: b.top,
      width: b.width,
      height: b.height,
      bitmapWidth: sw,
      bitmapHeight: sh,
      url: crop.toDataURL("image/png"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text extraction. Pulls horizontal text items, but with three big filters
// applied BEFORE line assembly:
//
// 1. Drop pdf.js accessibility placeholders ("[Image #1]") — these are emitted
//    as text items by some PDFs and otherwise leak into the prose.
// 2. Blacklist symbol-encoded fonts at the source. Annual Reviews sidebar
//    widgets render text like "t%PXOMPBEDJUBUJPOT" using a custom font whose
//    glyph encoding doesn't decode back to ASCII. Tagging the *font* catches
//    every such fragment cleanly — far more reliable than per-token cleaning.
// 3. Suppress text whose center sits inside any figure box. Without this, axis
//    labels and panel titles inside a chart ("Workplace context", "Work
//    behaviors") get yanked into the surrounding paragraphs.
// ---------------------------------------------------------------------------

/** Lines plus the page's pre-suppression text volume (for scanned detection). */
type CollectedLines = { lines: Line[]; textChars: number };

async function collectLines(
  page: PDFPageProxy,
  pageHeight: number,
  imageBoxes: Box[]
): Promise<CollectedLines> {
  const content = await page.getTextContent();

  const badFonts = profileSymbolFonts(content.items);

  type Frag = {
    top: number;
    bottom: number;
    left: number;
    right: number;
    size: number;
    str: string;
  };
  const frags: Frag[] = [];
  // Total real text on the page BEFORE figure suppression — used to judge
  // whether the page has a usable text layer at all (see RawLines.textChars).
  let textChars = 0;

  for (const item of content.items) {
    if (!("str" in item)) continue;
    const it = item as TextItem;
    if (!it.str || !it.str.trim()) continue;
    if (badFonts.has(it.fontName)) continue;
    if (isImagePlaceholder(it.str)) continue;

    const t = it.transform; // [a, b, c, d, e, f]
    // Skip rotated text — page-edge watermarks ("Downloaded from www.annualreviews.org")
    // run vertically and otherwise get spliced into real sentences.
    const angle = Math.atan2(t[1], t[0]);
    const horizontal = Math.abs(angle) < 0.2 || Math.abs(Math.abs(angle) - Math.PI) < 0.2;
    if (!horizontal) continue;

    textChars += it.str.replace(/\s/g, "").length;

    const size = Math.hypot(t[2], t[3]) || it.height || 1;
    const x = t[4];
    const yBottom = t[5];
    const top = pageHeight - yBottom - size;
    const bottom = top + size;
    const right = x + it.width;

    // Suppress text painted on top of a figure.
    const cx = (x + right) / 2;
    const cy = (top + bottom) / 2;
    if (insideAnyBox(cx, cy, imageBoxes)) continue;

    frags.push({ top, bottom, left: x, right, size, str: it.str });
  }

  // Merge fragments on the same baseline into lines.
  frags.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Line[] = [];
  for (const f of frags) {
    const last = lines[lines.length - 1];
    const sameLine =
      last &&
      Math.abs(f.top - last.top) < Math.max(f.size, last.size) * 0.6 &&
      // Conservative gap: anything wider than ~2.5× the glyph height is almost
      // certainly two distinct elements (e.g. body text + right-margin sidebar
      // that happen to share a baseline). The old 6× threshold glued them.
      f.left - last.right < last.size * 2.5;
    if (sameLine) {
      // The inter-word gap metric is unreliable on this PDF's OCR'd and
      // interlinear-gloss fonts — gloss words ("personally", "cares about")
      // sit at large NEGATIVE gaps, so a gap>threshold test drops the space and
      // glues words ("performedpersonally"). Key off the boundary characters
      // instead: insert a space whenever the previous fragment ends and the next
      // begins with a word-forming character, UNLESS it's a hyphenation
      // continuation or a side already carries explicit whitespace. This only
      // affects the BOUNDARY between two fragments — intra-fragment glyph-spaced
      // runs ("e x p e r i e n c e", "2 5 0 - 2 7 9") live inside one f.str and
      // are never touched.
      const prevCh = last.text.slice(-1);
      const nextCh = f.str.slice(0, 1);
      const boundaryGlued = !/\s$/.test(last.text) && !/^\s/.test(f.str);
      const hyphenContinuation = /[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(f.str);
      const wordlike = /[\w).,;:!?%&'"\]’”©]/.test(prevCh) && /[\w(\[$&'"‘“]/.test(nextCh);
      const needsSpace = boundaryGlued && wordlike && !hyphenContinuation;
      last.text += (needsSpace ? " " : "") + f.str;
      last.right = Math.max(last.right, f.right);
      last.top = Math.min(last.top, f.top);
      last.bottom = Math.max(last.bottom, f.bottom);
      last.size = Math.max(last.size, f.size);
    } else {
      lines.push({
        top: f.top,
        bottom: f.bottom,
        left: f.left,
        right: f.right,
        size: f.size,
        text: f.str,
      });
    }
  }

  const cleaned = lines
    .map((l) => ({
      ...l,
      text: collapseLetterSpacing(stripImagePlaceholders(l.text).replace(/\s+/g, " ").trim()),
    }))
    .filter((l) => l.text.length > 0)
    .filter((l) => !isImagePlaceholder(l.text))
    .filter((l) => !isBarePageNumber(l.text));
  return { lines: cleaned, textChars };
}

/**
 * Collapse pdf.js's per-glyph spacing ("e x p e r i e n c e", "o f", "j o b",
 * "2 5 0 - 2 7 9") back into single tokens. Only MAXIMAL runs of >=2 single-char
 * alphanumeric tokens are merged, so a lone single-letter word survives ("is a
 * model" stays "is a model", not "is amodel"). Runs of multiple genuine
 * single-letter words ("a I") effectively never occur in English prose, so this
 * is safe on real text while fixing the OCR text layer's exploded words. Shared
 * with isGibberish so the two stay consistent.
 */
function collapseLetterSpacing(text: string): string {
  return text.replace(/\b([A-Za-z0-9])(?: ([A-Za-z0-9]))+\b/g, (m) =>
    m.replace(/ /g, "")
  );
}

/**
 * Remove accessibility-style placeholders such as "[Image #2]", "[Figure 1]",
 * "[ Image ]", "(image: 3)", "〔Image#3〕" — anything that looks like a
 * bracket-wrapped image/figure tag. Permissive about brackets, whitespace,
 * separator characters, and trailing numbers so we catch the multi-fragment
 * merge case ("[Image" + " #2" + "]") regardless of internal spacing.
 */
function stripImagePlaceholders(text: string): string {
  return text.replace(
    /[\[\(\{〔【]\s*(?:image|figure|img|picture|pic)\b[^\]\)\}〕】\n]{0,24}[\]\)\}〕】]/gi,
    ""
  );
}

/**
 * Identify fonts whose decoded text is implausibly vowel-starved or non-ASCII —
 * the signature of custom-encoded symbol fonts used for icon/UI runs. Returns
 * the set of fontNames to drop entirely.
 */
function profileSymbolFonts(items: ReadonlyArray<unknown>): Set<string> {
  const byFont = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const it = item as TextItem;
    if (!it.str) continue;
    byFont.set(it.fontName, (byFont.get(it.fontName) ?? "") + it.str);
  }
  const bad = new Set<string>();
  for (const [font, text] of byFont) {
    const letters = text.replace(/[^A-Za-z]/g, "");
    if (letters.length < 20) continue;
    const vowels = (letters.match(/[aeiouyAEIOUY]/g) ?? []).length;
    // English averages ~38% vowels; <18% indicates the encoding is broken.
    if (vowels / letters.length < 0.18) {
      bad.add(font);
      continue;
    }
    // Or: mostly non-ASCII printable — also a symbol encoding tell.
    const ascii = text.replace(/[^\x20-\x7e]/g, "").length;
    if (text.length >= 20 && ascii / text.length < 0.4) bad.add(font);
  }
  return bad;
}

/**
 * Identifies pdf.js accessibility placeholders that stand alone on a line —
 * both the bracketed form ("[Image #3]", "[ Figure 1 ]", "〔Image#2〕") and the
 * bareword form ("Image #3", "Figure 2") that some structured-PDF code paths
 * emit. Used per-fragment (catches single-item placeholders before line
 * assembly) AND post-merge (catches multi-fragment placeholders that survive
 * stripImagePlaceholders, e.g. when the open-bracket gets dropped earlier).
 */
function isImagePlaceholder(s: string): boolean {
  const trimmed = s.trim();
  if (
    /^[\[\(\{〔【]\s*(?:image|figure|img|picture|pic)\b[^\]\)\}〕】\n]{0,24}[\]\)\}〕】]$/i.test(
      trimmed
    )
  ) {
    return true;
  }
  // Bareword form — only fire when this is the *entire* string, otherwise we
  // would eat legitimate caption text like "Figure 1 shows three subgroups".
  return /^(?:image|figure)\s*#?\s*\d{1,3}$/i.test(trimmed);
}

function isBarePageNumber(text: string): boolean {
  return /^[·•∙.\s]*\d{1,4}[·•∙.\s]*$/.test(text.trim());
}

/**
 * Content-based detector for OCR gibberish leaking out of figures and scanned
 * data tables — the "I OORE", "~,{ EMPLOYEE GROWTH~%~", ".64**", "2 E% 88 H x
 * =] | i 5 wv" debris an imperfect embedded text layer paints over diagrams.
 *
 * This is a *pure content* classifier (no geometry, no scanned-page gate) so it
 * is safe to run on every page: it is tuned to fire only on figure/table salad
 * and to leave real prose, headings, captions, citations, grant numbers, and
 * even pdf.js's per-glyph-spaced words ("M O T I V A T I O N", "2 5 0 - 2 7 9")
 * untouched. Signals are OR'd; each is calibrated so legitimate text never trips
 * it. Validated against the MIT Hackman & Oldham (1976) scan: it suppresses the
 * FIG. 1 region and the correlation tables while keeping the full reference list
 * (which is dense with "Author & Author" citations) and table legends.
 *
 * The deliberate residual blind spot is a short, symbol-free, vowel-bearing
 * letter fragment like "Jos" — indistinguishable from a real name/word by
 * content alone, so we leave it to the existing in-figure-box suppression.
 */
function isGibberish(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;

  // Collapse pdf.js's per-glyph spacing ("M O T I V A T I O N", "2 5 0 - 2 7 9")
  // so a real word that was exploded into 1-char tokens reads as one token and
  // doesn't look like a swarm of stray characters below.
  const collapsed = collapseLetterSpacing(t);
  const nonSpace = collapsed.replace(/\s/g, "");
  if (nonSpace.length === 0) return false;

  // A figure-OCR symbol GLUED between two alphanumerics with no surrounding
  // spaces ("PSYCHOLOGICAL>WORK", "PerformanceL~Experienced", "Work|Work") is a
  // near-certain diagram tell. Legitimate uses of these symbols are always
  // space-separated ("R ~ .09", "n = 658", "p < .05"), so this never fires on
  // real math/stats prose. One occurrence is enough.
  if (/[A-Za-z0-9][~|{}°<>=*\\^][A-Za-z0-9]/.test(collapsed)) return true;

  // Free-standing "strong" symbols. The pipe class (| { } ° \ ^) does not occur
  // in real text, so a single one condemns the line. The tilde is weaker — pdf.js
  // emits it for a misread ≈ / ² inside real prose ("all correlations ~ .09",
  // "Increase in R ~ by adding") — so require two of them, or a short line.
  if ((nonSpace.match(/[|{}°\\^]/g) ?? []).length >= 1) return true;
  const tilde = (nonSpace.match(/~/g) ?? []).length;
  if (tilde >= 2 || (tilde >= 1 && nonSpace.length <= 12)) return true;

  // Doubled comma/semicolon or 4+-dot runs never occur in real prose
  // ("Significance.,,J", ",u, .... ,,"). NB: "e.g.," / "i.e.," yield only ".,"
  // (a single mixed pair), not ",,", so academic abbreviations are safe.
  if (/[,;]\s*[,;]|\.{4,}/.test(collapsed)) return true;

  const tokens = collapsed.split(/\s+/).filter(Boolean);

  // Very low alphabetic content on a non-trivial line that ISN'T a plain number
  // or citation. A bare math operator (= < >) on such a line ("5 = .2", "α = .05")
  // marks a stray table cell, so let it bypass the all-digits guard that protects
  // "(1976)" / "250-279".
  const lettersAll = nonSpace.replace(/[^A-Za-z]/g, "").length;
  const digits = nonSpace.replace(/[^0-9]/g, "").length;
  const mathOp = /[=<>]/.test(nonSpace);
  if (
    nonSpace.length >= 4 &&
    lettersAll / nonSpace.length < 0.25 &&
    (mathOp || digits / nonSpace.length < 0.5)
  ) {
    return true;
  }

  // Stray-letter swarm: many single LETTER tokens that aren't valid standalone
  // words ("a", "I", "A") indicate scattered diagram-label fragments. Only
  // letters count — stray operators like the four "=" in "n = 658. EM = …; ER = …"
  // are legitimate table legends, not gibberish.
  const stray = tokens.filter(
    (tok) => /^[A-Za-z]$/.test(tok) && !/^[aAI]$/.test(tok)
  ).length;
  if (tokens.length >= 5 && stray / tokens.length >= 0.35) return true;

  // Word-shape analysis. Split each token into letter-chunks (on non-letters)
  // and count two structural tells of merged/garbled OCR.
  const chunks: string[] = [];
  let caseGlue = 0; // lower→Upper fusions mid-token: "InternalExperienced", "OOREJosI"
  let startDouble = 0; // word starting with a doubled capital: "OORE"
  for (const tok of tokens) {
    if (/[a-z][A-Z]/.test(tok)) caseGlue += (tok.match(/[a-z][A-Z]/g) ?? []).length;
    for (const c of tok.split(/[^A-Za-z]+/)) {
      if (c.length >= 2) chunks.push(c);
      // Real words never start with a doubled capital — EXCEPT Roman numerals
      // (II, III, MM), so skip pure-Roman tokens to protect "World War II".
      if (/^([A-Z])\1/.test(c) && !/^[IVXLCDM]+$/.test(c)) startDouble++;
    }
  }
  // Two case-fusions = merged figure labels. Hyphens/spaces keep real compounds
  // ("Self-Determination", "McGraw-Hill") split, so they register zero.
  if (caseGlue >= 2) return true;
  if (startDouble >= 1) return true;

  // Letter-salad: a line whose alphabetic words are mostly NOT English-word-shaped.
  // Require several words (so a short heading/name can't trip it) and a strict
  // majority of junk (> 0.5, so a 50/50 header like "Low GNS High GNS" survives).
  if (chunks.length >= 3) {
    const junk = chunks.filter((w) => !looksWordlike(w)).length;
    if (junk / chunks.length > 0.5) return true;
  } else if (chunks.length >= 1) {
    // Short line carried by one or two tokens: drop only if every chunk is junk.
    if (chunks.every((w) => !looksWordlike(w))) return true;
  }

  return false;
}

/**
 * Heuristic "does this letters-only chunk look like a plausible English or
 * proper-noun word?". Dictionary-free: rejects vowel-less salad ("STRENGTHJ"),
 * impossible consonant runs, and triple-letter mashes, while accepting normal
 * words (including "strength" — a 4-consonant cluster is allowed, 5+ is not).
 */
function looksWordlike(w: string): boolean {
  const L = w.toLowerCase();
  const n = L.length;
  if (n <= 2) return true; // too short to judge ("et", "al", "de", "of")
  if (!/[aeiouy]/.test(L)) return false; // no vowel at all
  if (/[^aeiouy]{5,}/.test(L)) return false; // 5+ consonants in a row
  if (/(.)\1\1/.test(L)) return false; // 3 identical letters in a row
  return true;
}

function insideAnyBox(x: number, y: number, boxes: Box[]): boolean {
  for (const b of boxes) {
    if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Running heads / feet detection.
// ---------------------------------------------------------------------------

/**
 * Normalise a line for cross-page comparison. Strips digits, punctuation, AND
 * whitespace — different pages of the same running footer can come out as
 * "· · 20 Deci Olafsen Ryan" on one page and "· ·22DeciOlafsenRyan" on the next
 * (depending on how tightly the PDF kerned the name fragments), and we want
 * them to collapse to the same key.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\d·•∙.,;:()&]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Lines that recur across many pages are running heads/feet. Three paths:
 *  - In the edge band (top/bottom 20%): flagged at a low threshold (30%). The
 *    band is intentionally generous — some journal layouts (Annual Reviews)
 *    park their running footer ~83% down the page, inside the printable area
 *    rather than the margin proper. A 15% band misses these by one percent.
 *  - Anywhere on the page: flagged at a high threshold (50%).
 *  - Anchored: the same normalized text appears at nearly the same y-position
 *    on ≥30% of pages. This catches running elements regardless of which band
 *    they sit in — their hallmark is *positional* consistency, not edge
 *    proximity, and real body paragraphs never repeat verbatim at a fixed y.
 */
function findRunningLines(raws: RawPage[]): Set<string> {
  if (raws.length < 3) return new Set();
  const edge = new Map<string, Set<number>>();
  const any = new Map<string, Set<number>>();
  const positions = new Map<string, number[]>();
  for (const r of raws) {
    const band = r.pageHeight * 0.2;
    for (const l of r.lines) {
      const key = normalize(l.text);
      if (key.length < 3) continue;
      addPage(any, key, r.number);
      if (l.top < band || l.top > r.pageHeight - band) addPage(edge, key, r.number);
      let ys = positions.get(key);
      if (!ys) positions.set(key, (ys = []));
      ys.push(l.top);
    }
  }
  const edgeT = Math.max(2, Math.floor(raws.length * 0.3));
  const anyT = Math.max(3, Math.floor(raws.length * 0.5));
  const anchorT = Math.max(2, Math.floor(raws.length * 0.3));
  const running = new Set<string>();
  for (const [k, p] of edge) if (p.size >= edgeT) running.add(k);
  for (const [k, p] of any) if (p.size >= anyT) running.add(k);
  // Anchored detection: ≥ anchorT occurrences whose y-positions cluster within
  // ~6pt (≈ half a line of body text).
  for (const [k, ys] of positions) {
    if (ys.length < anchorT) continue;
    const sorted = [...ys].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let near = 0;
    for (const y of ys) if (Math.abs(y - median) < 6) near++;
    if (near >= anchorT) running.add(k);
  }
  return running;
}

function addPage(map: Map<string, Set<number>>, key: string, page: number) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(page);
}

// ---------------------------------------------------------------------------
// Layout: columns, reading order, paragraph/heading grouping.
// ---------------------------------------------------------------------------

function detectColumns(lines: Line[], pageWidth: number): number {
  if (lines.length < 10) return 1;
  const mid = pageWidth / 2;
  let left = 0;
  let right = 0;
  let crossing = 0;
  for (const l of lines) {
    if (l.right < mid - pageWidth * 0.02) left++;
    else if (l.left > mid - pageWidth * 0.02) right++;
    else crossing++;
  }
  const sided = left + right;
  if (left > sided * 0.25 && right > sided * 0.25 && crossing < lines.length * 0.35) {
    return 2;
  }
  return 1;
}

type Positioned =
  | (Line & { _kind: "line" })
  | (PlacedImage & { _kind: "image" });

function tagLine(l: Line): Positioned {
  return { ...l, _kind: "line" };
}

function tagImage(p: PlacedImage): Positioned {
  return { ...p, _kind: "image" };
}

function orderByColumns(items: Positioned[], columns: number, pageWidth: number): Positioned[] {
  if (columns === 1) {
    return [...items].sort((a, b) => a.top - b.top || a.left - b.left);
  }
  // Wide figures (spanning >60% of the page) act as horizontal cuts that
  // partition the page into bands. Inside each band we use normal two-column
  // reading order; the figure itself appears between bands at its true
  // vertical position. Without this, wide figures fall to the bottom of the
  // page and lose their relationship to the surrounding paragraphs.
  const wide = items
    .filter((i): i is PositionedImage => i._kind === "image" && i.width > pageWidth * 0.6)
    .sort((a, b) => a.top - b.top);
  const wideSet = new Set<Positioned>(wide);
  if (wide.length === 0) return order2Col(items, pageWidth);

  const result: Positioned[] = [];
  let bandTop = -Infinity;
  for (const fig of wide) {
    const bandBottom = fig.top;
    const inBand = items.filter(
      (i) => !wideSet.has(i) && midY(i) >= bandTop && midY(i) < bandBottom
    );
    result.push(...order2Col(inBand, pageWidth));
    result.push(fig);
    bandTop = fig.top + fig.height;
  }
  const tail = items.filter((i) => !wideSet.has(i) && midY(i) >= bandTop);
  result.push(...order2Col(tail, pageWidth));
  return result;
}

type PositionedImage = PlacedImage & { _kind: "image" };

function order2Col(items: Positioned[], pageWidth: number): Positioned[] {
  const mid = pageWidth / 2;
  const col0: Positioned[] = [];
  const col1: Positioned[] = [];
  for (const i of items) (centerX(i) < mid ? col0 : col1).push(i);
  col0.sort((a, b) => a.top - b.top || a.left - b.left);
  col1.sort((a, b) => a.top - b.top || a.left - b.left);
  return [...col0, ...col1];
}

function centerX(i: Positioned): number {
  if (i._kind === "image") return i.left + i.width / 2;
  return (i.left + i.right) / 2;
}

function midY(i: Positioned): number {
  if (i._kind === "image") return i.top + i.height / 2;
  return (i.top + i.bottom) / 2;
}

function groupIntoBlocks(ordered: Positioned[], allLines: Line[], pageWidth: number): Block[] {
  // Body text size = the most common rounded line size, WEIGHTED BY CHARACTERS
  // and counting only full-column-width lines — mirrors detectScannedFigures.
  // A table-heavy page (page 21 of the MIT Hackman scan: ~21 body lines at 10pt
  // vs ~94 table cells at 8pt) would otherwise elect the small table font as
  // "body" by line count, then flag the real 10pt prose as headings. The table's
  // short cells fail the width gate; its longer title/footnote prose survives but
  // is outweighed by the genuinely-wrapping body paragraph.
  const counts = new Map<number, number>();
  for (const l of allLines) {
    if (l.right - l.left < pageWidth * 0.5) continue;
    const s = Math.round(l.size);
    counts.set(s, (counts.get(s) ?? 0) + l.text.length);
  }
  let bodySize = 10;
  let best = -1;
  for (const [s, c] of counts) if (c > best) ((best = c), (bodySize = s));

  const blocks: Block[] = [];
  let para: { text: string; size: number; prevTop: number } | null = null;

  // A heading is bigger than body type AND short — a real section heading is a
  // few words, never a wrapping paragraph. The length gate is essential on
  // scanned pages: OCR gives body prose a jittery size, so a long paragraph can
  // come out a point or two larger than the elected body size and would
  // otherwise be rendered as a giant bold heading (e.g. "positive aspects of
  // jobs that can be altered…"). Long lines stay body regardless of size.
  const HEADING_MAX_CHARS = 60;
  const looksHeading = (size: number, text: string) =>
    size >= bodySize + 1.5 && text.trim().length < HEADING_MAX_CHARS;

  const flush = () => {
    if (para) {
      const level: TextBlock["level"] = looksHeading(para.size, para.text) ? "h" : "p";
      blocks.push({ kind: "text", text: para.text.trim(), level });
      para = null;
    }
  };

  for (const item of ordered) {
    if (item._kind === "image") {
      flush();
      blocks.push({ kind: "image", url: item.url, width: item.bitmapWidth, height: item.bitmapHeight });
      continue;
    }
    const line = item;
    const isHeading = looksHeading(line.size, line.text);
    const lineHeight = line.size * 1.6;
    const bigGap = para ? line.top - para.prevTop > lineHeight * 1.4 : false;

    if (!para || isHeading || bigGap) {
      flush();
      para = { text: line.text, size: line.size, prevTop: line.top };
    } else {
      if (para.text.endsWith("-")) para.text = para.text.slice(0, -1) + line.text;
      else para.text += " " + line.text;
      para.prevTop = line.top;
      para.size = Math.max(para.size, line.size);
    }
  }
  flush();
  return blocks;
}

function layoutPage(r: RawPage, running: Set<string>): ReflowPage {
  const filtered = r.lines.filter((l) => !running.has(normalize(l.text)));
  const columns = detectColumns(filtered, r.pageWidth);
  const positioned: Positioned[] = [
    ...filtered.map(tagLine),
    ...r.images.map(tagImage),
  ];
  const ordered = orderByColumns(positioned, columns, r.pageWidth);
  const blocks = groupIntoBlocks(ordered, filtered, r.pageWidth);
  return { number: r.number, blocks };
}

/**
 * A sentence that runs off the bottom of one page and continues at the top of
 * the next is grouped into two separate paragraphs, because each page is laid
 * out independently. Stitch them back together with a conservative post-pass:
 * when a page's LAST block is a paragraph that does NOT end in sentence-ending
 * punctuation, and the next non-empty page's FIRST block is also a paragraph,
 * merge the continuation into the first block. De-hyphenate across the break if
 * it ends with a hyphen, otherwise insert a space. Only paragraphs ("p") are
 * eligible on both sides, so we never fold a continuation into a heading.
 */
function joinAcrossPageBreaks(pages: ReflowPage[]): ReflowPage[] {
  const endsSentence = /[.!?:;"”’]\s*$/;
  for (let i = 0; i < pages.length - 1; i++) {
    const cur = pages[i].blocks;
    let j = i + 1;
    while (j < pages.length && pages[j].blocks.length === 0) j++;
    if (j >= pages.length) break;
    const next = pages[j].blocks;
    const prev = cur[cur.length - 1];
    const head = next[0];
    if (!prev || !head) continue;
    if (prev.kind !== "text" || head.kind !== "text") continue;
    if (prev.level !== "p" || head.level !== "p") continue;
    if (endsSentence.test(prev.text)) continue;
    prev.text = prev.text.endsWith("-")
      ? prev.text.slice(0, -1) + head.text
      : prev.text + " " + head.text;
    next.shift();
  }
  return pages;
}
