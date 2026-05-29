// Cloudflare Worker: a CORS-friendly PDF proxy for Paper Reader.
//
// GitHub Pages can't run server.ts, so the static site needs something that
// fetches a PDF and re-serves it with `Access-Control-Allow-Origin`. This is
// that something — the same job as server.ts's /api/proxy, but free + always-on.
//
//   Usage:  https://<worker-url>/?url=<url-encoded PDF link>
//
// Deploy with:  bunx wrangler deploy   (see wrangler.toml)

// Only these origins get a permissive CORS header back, so the Worker can't be
// trivially abused as an open proxy from arbitrary websites. Add your own dev
// origins here if needed.
const ALLOWED_ORIGINS = new Set([
  "https://theodo-group.github.io",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
]);
const DEFAULT_ORIGIN = "https://theodo-group.github.io";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default {
  async fetch(request) {
    const reqOrigin = request.headers.get("Origin");
    const allowOrigin =
      reqOrigin && ALLOWED_ORIGINS.has(reqOrigin) ? reqOrigin : DEFAULT_ORIGIN;
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url", { status: 400, headers: cors });
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/pdf,*/*" },
        redirect: "follow",
      });
    } catch (err) {
      return new Response(`Fetch failed: ${err}`, { status: 502, headers: cors });
    }

    if (!upstream.ok) {
      return new Response(`Upstream responded ${upstream.status}`, {
        status: 502,
        headers: cors,
      });
    }

    return new Response(upstream.body, {
      headers: {
        ...cors,
        "Content-Type": upstream.headers.get("Content-Type") || "application/pdf",
        // PDFs are immutable enough; let the browser/edge cache for an hour.
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
