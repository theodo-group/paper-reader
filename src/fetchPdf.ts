// Downloading a PDF from an arbitrary host hits the browser's CORS wall, so the
// bytes have to come through a proxy that adds permissive CORS headers.
//
// - On the local Bun dev/prod server, `/api/proxy` (see server.ts) fetches the
//   PDF server-side — fast and private.
// - On a static host like GitHub Pages there is no server, so we fall back to
//   public CORS proxies, tried in order until one returns the file.
const onLocalServer =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

type ProxyBuilder = (url: string) => string;

const PROXIES: ProxyBuilder[] = onLocalServer
  ? [(u) => `/api/proxy?url=${encodeURIComponent(u)}`]
  : [
      // codetabs is the one public proxy currently sending `Access-Control-
      // Allow-Origin: *` for arbitrary files (rate-limited ~5 req/s). The rest
      // are best-effort backups that come and go.
      (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
      (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];

export async function fetchPdf(url: string): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (const build of PROXIES) {
    try {
      const res = await fetch(build(url));
      if (!res.ok) {
        lastError = new Error(`Could not download PDF (${res.status})`);
        continue;
      }
      const buf = await res.arrayBuffer();
      // A proxy can answer 200 with an HTML error page; make sure we actually
      // got a PDF ("%PDF" magic bytes) before handing it to pdf.js.
      const magic = new Uint8Array(buf.slice(0, 5));
      const isPdf = magic[0] === 0x25 && magic[1] === 0x50 && magic[2] === 0x44 && magic[3] === 0x46;
      if (!isPdf) {
        lastError = new Error("Proxy did not return a PDF");
        continue;
      }
      return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not download PDF");
}
