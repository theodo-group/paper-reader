import index from "./index.html";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const server = Bun.serve({
  port: Number(process.env.PORT) || 3001,
  routes: {
    "/": index,

    // Fetch the PDF server-side so the browser never hits CORS.
    "/api/proxy": async (req) => {
      const target = new URL(req.url).searchParams.get("url");
      if (!target) {
        return new Response("Missing ?url", { status: 400 });
      }
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          headers: { "User-Agent": BROWSER_UA, Accept: "application/pdf,*/*" },
          redirect: "follow",
        });
      } catch (err) {
        return new Response(`Fetch failed: ${err}`, { status: 502 });
      }
      if (!upstream.ok) {
        return new Response(`Upstream responded ${upstream.status}`, {
          status: 502,
        });
      }
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
        },
      });
    },
  },
  development: true,
});

console.log(`Paper Reader running at ${server.url}`);
