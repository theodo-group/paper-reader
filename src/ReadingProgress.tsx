import { useEffect } from "react";

const KEY_PREFIX = "paper-reader:progress:";

/**
 * Headless reading-position tracker. No UI — persists the live scroll
 * fraction per-document in localStorage and restores it the next time the
 * same document is opened.
 */
export function ReadingProgress({ docKey, active }: { docKey: string; active: boolean }) {
  const storageKey = KEY_PREFIX + docKey;

  // Restore the saved scroll position when the document changes. Wait two
  // frames so the freshly-rendered content has been laid out and
  // scrollHeight reflects the real document size.
  useEffect(() => {
    if (!active || !docKey) return;
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(storageKey)) || 0;
    } catch {
      /* ignore */
    }
    saved = Math.min(1, Math.max(0, saved));
    if (saved <= 0) return;
    const restore = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: saved * max });
    };
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(restore);
      cancelHandle.id = id2;
    });
    const cancelHandle = { id: id1 };
    return () => cancelAnimationFrame(cancelHandle.id);
  }, [storageKey, docKey, active]);

  // Save the current scroll fraction as the reader moves.
  useEffect(() => {
    if (!active) return;
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const frac = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      try {
        localStorage.setItem(storageKey, String(frac));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [storageKey, active]);

  return null;
}
