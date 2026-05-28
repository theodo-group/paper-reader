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
      return await res.arrayBuffer();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not download PDF");
}
