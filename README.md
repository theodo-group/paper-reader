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
    rasterise each embedded figure to a PNG.
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

- Works on PDFs that have a real text layer (most digital papers). Pure scans
  with no text layer would need OCR — not included here.
- Column detection is heuristic; unusual layouts may interleave oddly.
- The pdf.js worker is loaded from jsDelivr at the exact installed version, so
  the page needs internet access the first time.
