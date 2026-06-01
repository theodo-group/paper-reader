# Paper Reader

Paste the URL of a hard-to-read PDF (e.g. a dense, two-column academic paper) and
get back a clean, **black-on-white** article in a normal reading font, with the
paper's **figures extracted as click-to-zoom images**.

**Live:** https://theodo-group.github.io/paper-reader/

```
bun install
bun dev        # http://localhost:3001  (hot reload)
# or
bun start
```

The default URL is the Deci/Olafsen/Ryan SDT paper — just press **Make readable**.

## How it works

- **`server.ts`** — a Bun fullstack server for local use. Serves the React app
  and exposes `/api/proxy?url=…`, which downloads the PDF server-side so the
  browser never hits CORS.
- **`src/fetchPdf.ts`** — picks how the PDF bytes are fetched: the local
  `/api/proxy` when running on the Bun server, or public CORS proxies when
  running as a static site (GitHub Pages).
- **`src/pdf/`** — the conversion engine, running in the browser with
  [pdf.js](https://mozilla.github.io/pdf.js/):
  - extracts the real text layer, merges fragments into lines, and detects
    1- vs 2-column layouts to recover reading order;
  - groups lines into paragraphs/headings (de-hyphenating line breaks);
  - walks the page operator list while tracking the transform matrix to find and
    rasterise each embedded figure to a PNG;
  - ignores full-page **scan backdrops** (a page-sized image sitting behind an
    invisible text layer) so the real text reads through instead of coming back
    as one giant image — while recovering the real **figures/tables** baked into
    that scan by their captions ("FIG. 1", "TABLE 2") and cropping them as
    images;
  - suppresses **garbled OCR debris** that scanned diagrams paint over their
    artwork (and crops full-page scanned **tables** as images instead of leaking
    their cells as text), stitches sentences that **continue across a page
    break** back into one paragraph, repairs **letter-spaced** OCR words
    ("o f j o b" → "of job"), and avoids mistaking a large-font body paragraph
    for a heading on size-jittery scans;
  - falls back to **OCR** ([tesseract.js](https://github.com/naptha/tesseract.js),
    in-browser) for pages that have no text layer at all.
- **`src/App.tsx` / `src/Lightbox.tsx`** — re-typesets the result and provides a
  full-screen zoomable image viewer (click a figure, click again for actual
  size, `Esc` to close).

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which runs
`bun run build` (bundling `index.html` into `dist/`) and publishes it to GitHub
Pages.

> **Note:** GitHub Pages serves static files only, so the server-side
> `/api/proxy` isn't available there. The static build routes PDF downloads
> through public CORS proxies instead. For a fully self-hosted, private path,
> run `bun start` (which uses the built-in proxy).

## Notes / limits

- Works best on PDFs with a real text layer (most digital papers), including
  scanned papers that carry an invisible OCR text layer behind a full-page image
  (the backdrop is dropped and the text reads through).
- Pages with no text layer at all are OCR'd in the browser with tesseract.js.
  This is slow (a few seconds per page) and downloads the language model from a
  CDN the first time; accuracy depends on scan quality.
- Column detection is heuristic; unusual layouts may interleave oddly.
- The pdf.js worker (and the tesseract.js core/model) are loaded from a CDN, so
  the page needs internet access the first time.
