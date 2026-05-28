import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { pdfjsLib } from "./types";
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

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      raws.push(await extractPage(page, n));
      onProgress?.(n, doc.numPages);
      page.cleanup();
    }

    const running = findRunningLines(raws);
    return raws.map((r) => layoutPage(r, running));
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

  const rawBoxes = await collectImageBoxes(page, pageHeight);
  const merged = mergeImageBoxes(rawBoxes);
  // Pad each figure box for the BITMAP CROP only — vector labels/axis ticks
  // often protrude just outside the raw bitmap. Use the *unpadded* merged
  // boxes for text suppression so we don't accidentally clip body lines that
  // sit right next to a figure (which would manifest as truncated left edges).
  // Padding is asymmetric: figure labels protrude horizontally far more than
  // they bleed above/below.
  //
  // The boxes from collectImageBoxes are in the same "pageHeight-flipped, raw
  // ctm.x" space that collectLines uses (so text-suppression matches). For the
  // bitmap crop we have to translate them into the rendered viewport space.
  const cropBoxes = merged
    .map((b) => shiftBox(b, -offsetX, offsetY))
    .map((b) => padBox(b, 30, 12, pageWidth, pageHeight));

  const lines = await collectLines(page, pageHeight, merged);
  const placed = cropBoxes.length > 0 ? await rasteriseImages(page, cropBoxes) : [];
  // The PlacedImage left/top is used downstream for reading-order alignment
  // with text lines, which still live in the un-shifted coordinate space.
  // Translate back so figures land next to their captions, not above them.
  const images = placed.map((p) => ({
    ...p,
    left: p.left + offsetX,
    top: p.top - offsetY,
  }));

  return { number: n, lines, images, pageWidth, pageHeight };
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
  // raw image-XObject decode would miss.
  const scale = 2;
  const viewport = page.getViewport({ scale });
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

async function collectLines(
  page: PDFPageProxy,
  pageHeight: number,
  imageBoxes: Box[]
): Promise<Line[]> {
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
      const gap = f.left - last.right;
      const needsSpace =
        gap > last.size * 0.18 && !last.text.endsWith(" ") && !f.str.startsWith(" ");
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

  return lines
    .map((l) => ({ ...l, text: stripImagePlaceholders(l.text).replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length > 0)
    .filter((l) => !isImagePlaceholder(l.text))
    .filter((l) => !isBarePageNumber(l.text));
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

function groupIntoBlocks(ordered: Positioned[], allLines: Line[]): Block[] {
  // Body text size = the most common rounded line size.
  const counts = new Map<number, number>();
  for (const l of allLines) {
    const s = Math.round(l.size);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let bodySize = 10;
  let best = -1;
  for (const [s, c] of counts) if (c > best) ((best = c), (bodySize = s));

  const blocks: Block[] = [];
  let para: { text: string; size: number; prevTop: number } | null = null;

  const flush = () => {
    if (para) {
      const level: TextBlock["level"] = para.size >= bodySize + 1.5 ? "h" : "p";
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
    const isHeading = line.size >= bodySize + 1.5;
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
  const blocks = groupIntoBlocks(ordered, filtered);
  return { number: r.number, blocks };
}
