import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { reflowPdf, type ReflowPage } from "./pdf";
import { fetchPdf } from "./fetchPdf";
import { bionic } from "./bionic";
import { Lightbox } from "./Lightbox";
import { ReadingProgress } from "./ReadingProgress";

const DEFAULT_URL =
  "https://selfdeterminationtheory.org/wp-content/uploads/2017/03/2017_DeciOlafsenRyan_annurev-orgpsych.pdf";

const LAST_URL_KEY = "paper-reader:last-url";
const FONT_SIZE_KEY = "paper-reader:font-size";
const BIONIC_KEY = "paper-reader:bionic";

// Reader font size in px. Generous default; clamp keeps the line measure sane.
const DEFAULT_FONT = 21;
const MIN_FONT = 15;
const MAX_FONT = 34;
const FONT_STEP = 2;

type Status =
  | { state: "idle" }
  | { state: "loading"; done: number; total: number; phase: string }
  | { state: "done" }
  | { state: "error"; message: string };

export function App() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [pages, setPages] = useState<ReflowPage[]>([]);
  const [loadedUrl, setLoadedUrl] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [zoom, setZoom] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(FONT_SIZE_KEY));
      if (saved >= MIN_FONT && saved <= MAX_FONT) return saved;
    } catch {
      /* ignore */
    }
    return DEFAULT_FONT;
  });
  const [bionicOn, setBionicOn] = useState(() => {
    try {
      return localStorage.getItem(BIONIC_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Persist the Bionic Reading preference across visits.
  const toggleBionic = useCallback(() => {
    setBionicOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(BIONIC_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Persist the reader's chosen font size across visits.
  const changeFont = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(MAX_FONT, Math.max(MIN_FONT, prev + delta));
      try {
        localStorage.setItem(FONT_SIZE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const convert = useCallback(async (targetUrl: string) => {
    const clean = targetUrl.trim();
    if (!clean) return;
    setPages([]);
    setStatus({ state: "loading", done: 0, total: 0, phase: "Downloading PDF…" });
    try {
      const buf = await fetchPdf(clean);
      setStatus({ state: "loading", done: 0, total: 0, phase: "Parsing pages…" });
      const result = await reflowPdf(buf, {
        onProgress: (done, total, phase) =>
          setStatus({ state: "loading", done, total, phase: phase ?? "Reflowing pages…" }),
      });
      setPages(result);
      setLoadedUrl(clean);
      setStatus({ state: "done" });
      // Reflect the open article in the address bar so the page is shareable
      // and bookmarkable; the ?pdfUrl= param is what bootstrap reads on load.
      // Skip when it's already the current URL (e.g. auto-load from a link or
      // back-navigation) to avoid stacking duplicate history entries.
      try {
        const next = new URL(window.location.href);
        if (next.searchParams.get("pdfUrl") !== clean) {
          next.searchParams.set("pdfUrl", clean);
          window.history.pushState({ pdfUrl: clean }, "", next);
        }
      } catch {
        /* malformed URL / sandboxed history — non-fatal */
      }
      // Remember the last successfully loaded PDF so the homepage can offer it again.
      try {
        localStorage.setItem(LAST_URL_KEY, clean);
      } catch {
        /* localStorage may be unavailable (private mode) — non-fatal */
      }
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // On first load: a ?pdfUrl= query param auto-loads; otherwise pre-fill the
  // input with the last PDF the user opened (remembered in localStorage).
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const fromQuery = new URLSearchParams(window.location.search).get("pdfUrl");
    if (fromQuery) {
      setUrl(fromQuery);
      convert(fromQuery);
      return;
    }
    try {
      const last = localStorage.getItem(LAST_URL_KEY);
      if (last) setUrl(last);
    } catch {
      /* ignore */
    }
  }, [convert]);

  // Back/forward navigation: sync the displayed article with the URL. Going
  // back to a ?pdfUrl-less entry returns to the idle homepage.
  useEffect(() => {
    const onPopState = () => {
      const target = new URLSearchParams(window.location.search).get("pdfUrl");
      if (target) {
        setUrl(target);
        if (target !== loadedUrl) convert(target);
      } else {
        setPages([]);
        setLoadedUrl("");
        setStatus({ state: "idle" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [convert, loadedUrl]);

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-inner">
          <span className="logo">📄 Paper&nbsp;Reader</span>
          <input
            className="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/paper.pdf"
            onKeyDown={(e) => e.key === "Enter" && convert(url)}
            spellCheck={false}
          />
          <button className="go" onClick={() => convert(url)} disabled={status.state === "loading"}>
            {status.state === "loading" ? "Working…" : "Make readable"}
          </button>
          <div className="fontsize" role="group" aria-label="Reader text size">
            <button
              className="small"
              onClick={() => changeFont(-FONT_STEP)}
              disabled={fontSize <= MIN_FONT}
              aria-label="Smaller text"
              title="Smaller text"
            >
              A
            </button>
            <button
              className="big"
              onClick={() => changeFont(FONT_STEP)}
              disabled={fontSize >= MAX_FONT}
              aria-label="Larger text"
              title="Larger text"
            >
              A
            </button>
          </div>
          <button
            className={`bionic-toggle${bionicOn ? " on" : ""}`}
            onClick={toggleBionic}
            aria-pressed={bionicOn}
            title="Bionic Reading — bold the start of each word to guide the eye"
          >
            <b>Bio</b>nic
          </button>
        </div>
        {status.state === "loading" && (
          <div className="progress">
            {status.phase}
            {status.total > 0 && ` ${status.done}/${status.total}`}
          </div>
        )}
      </header>

      <main className="page">
        {status.state === "idle" && (
          <p className="hint">
            Paste a PDF link and press <b>Make readable</b>. The text is re-typeset in a clean
            black-on-white font and figures become click-to-zoom images.
          </p>
        )}
        {status.state === "error" && <p className="error">⚠ {status.message}</p>}

        <article className="doc" style={{ "--reader-font": `${fontSize}px` } as CSSProperties}>
          {pages.flatMap((p) =>
            p.blocks.map((b, i) => {
              const key = `${p.number}-${i}`;
              if (b.kind === "image") {
                return (
                  <figure className="fig" key={key}>
                    <img
                      src={b.url}
                      alt={`Figure from page ${p.number}`}
                      loading="lazy"
                      onClick={() => setZoom(b.url)}
                    />
                    <figcaption>click to zoom</figcaption>
                  </figure>
                );
              }
              const content = bionicOn ? bionic(b.text) : b.text;
              return b.level === "h" ? <h2 key={key}>{content}</h2> : <p key={key}>{content}</p>;
            })
          )}
        </article>
      </main>

      <ReadingProgress docKey={loadedUrl} active={status.state === "done" && pages.length > 0} />

      {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
