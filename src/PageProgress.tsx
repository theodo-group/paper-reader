import { useEffect, useRef, useState, type CSSProperties } from "react";

/** Number of confetti pieces in a burst. */
const PIECES = 20;

/**
 * Thin article-progress bar pinned to the top of the screen (mobile only —
 * hidden by CSS on wider viewports). The fill advances in discrete steps,
 * one per source-PDF page, by watching which `.page-marker` last scrolled
 * past the reading line — never continuously with the scroll position.
 * Tick marks split the track at every 10%, and crossing into a new 10%
 * decile fires a small confetti burst from the tip of the fill.
 */
export function PageProgress({ total, active }: { total: number; active: boolean }) {
  const [page, setPage] = useState(0);
  const [burst, setBurst] = useState(0);
  // Last decile celebrated; -1 = not yet measured (so restoring a saved
  // scroll position deep into the article doesn't fire confetti on load).
  const decileRef = useRef(-1);

  // Track the current source page: the last page marker above the reading
  // line (top third of the viewport). Updates only when that index changes.
  useEffect(() => {
    if (!active) {
      setPage(0);
      decileRef.current = -1;
      return;
    }
    const markers = Array.from(document.querySelectorAll<HTMLElement>(".doc .page-marker"));
    if (markers.length === 0) return;
    const update = () => {
      const line = window.innerHeight / 3;
      let current = 0;
      for (const m of markers) {
        if (m.getBoundingClientRect().top < line) current += 1;
        else break;
      }
      // Reaching the very bottom counts as having read the last page.
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) current = markers.length;
      setPage(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active, total]);

  const frac = total > 0 ? Math.min(1, page / total) : 0;

  // Celebrate each newly reached 10% decile; scrolling back up re-arms it.
  useEffect(() => {
    const decile = Math.floor(frac * 10);
    if (decileRef.current === -1) {
      decileRef.current = decile; // first measurement — no celebration
    } else if (decile > decileRef.current) {
      decileRef.current = decile;
      setBurst((b) => b + 1);
    } else if (decile < decileRef.current) {
      decileRef.current = decile;
    }
  }, [frac]);

  // Remove the confetti from the DOM once its animation has played out.
  useEffect(() => {
    if (!burst) return;
    const id = setTimeout(() => setBurst(0), 1200);
    return () => clearTimeout(id);
  }, [burst]);

  if (!active) return null;

  return (
    <div
      className="pageprogress"
      role="progressbar"
      aria-label="Article progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(frac * 100)}
    >
      <div className="pp-track">
        <div className="pp-fill" style={{ width: `${frac * 100}%` }} />
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} style={{ left: `${(i + 1) * 10}%` }} />
        ))}
      </div>
      {burst > 0 && (
        <div className="pp-confetti" key={burst} style={{ left: `${frac * 100}%` }} aria-hidden>
          {Array.from({ length: PIECES }, (_, i) => {
            // Deterministic upward fan: angle spreads across 180°, distance
            // and hue vary per piece — no randomness needed.
            const angle = (Math.PI * (i + 0.5)) / PIECES;
            const dist = 46 + ((i * 37) % 44);
            const style = {
              "--x": `${Math.cos(angle) * dist}px`,
              "--y": `${-Math.sin(angle) * dist - 8}px`,
              "--r": `${((i * 137) % 360) - 180}deg`,
              background: `hsl(${(i * 360) / PIECES} 90% 55%)`,
              animationDelay: `${(i % 4) * 30}ms`,
            } as CSSProperties;
            return <span key={i} style={style} />;
          })}
        </div>
      )}
    </div>
  );
}
