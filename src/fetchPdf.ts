// Fetching a PDF from another origin runs into the browser's CORS wall unless
// that host sends `Access-Control-Allow-Origin`. A few do (direct fetch works);
// most don't, so the bytes have to come through a proxy that adds the header.
//
// - On the local Bun dev/prod server, `/api/proxy` (see server.ts) fetches the
//   PDF server-side — fast and private, handles every host.
// - On a static host like GitHub Pages there is no server, so we try the origin
//   directly first (free + fast for CORS-friendly hosts) and then fall back to
//   public CORS proxies, tried in order until one returns a real PDF.
const onLocalServer =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Our own Cloudflare Worker proxy (see worker/proxy.js + wrangler.toml). Once
// deployed, set this to its URL — it becomes the reliable primary on the static
// site. Leave empty to rely only on direct fetch + the public proxies.
const WORKER_PROXY = "https://paper-reader-proxy.paper-reader-proxy.workers.dev";

type ProxyBuilder = (url: string) => string;

const STRATEGIES: ProxyBuilder[] = onLocalServer
  ? [(u) => `/api/proxy?url=${encodeURIComponent(u)}`]
  : [
      // 1. Direct — succeeds only when the host itself sends CORS headers.
      (u) => u,
      // 2. Our Worker, if configured — reliable and not rate-limited.
      ...(WORKER_PROXY
        ? [(u: string) => `${WORKER_PROXY}/?url=${encodeURIComponent(u)}`]
        : []),
      // 3. Public proxies — best-effort backups that come and go. codetabs
      //    currently sends `Access-Control-Allow-Origin: *` (rate-limited ~5/s).
      (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
      (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];

export async function fetchPdf(url: string): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (const build of STRATEGIES) {
    try {
      const res = await fetch(build(url));
      if (!res.ok) {
        lastError = new Error(`Could not download PDF (${res.status})`);
        continue;
      }
      const buf = await res.arrayBuffer();
      // A host/proxy can answer 200 with an HTML error page; make sure we
      // actually got a PDF ("%PDF" magic bytes) before handing it to pdf.js.
      const magic = new Uint8Array(buf.slice(0, 5));
      const isPdf = magic[0] === 0x25 && magic[1] === 0x50 && magic[2] === 0x44 && magic[3] === 0x46;
      if (!isPdf) {
        lastError = new Error("Did not get a PDF back");
        continue;
      }
      return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not download this PDF — every source failed (last: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }). The host may block cross-origin requests and the public proxies may be down.`
  );
}
