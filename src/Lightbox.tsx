import { useEffect, useState } from "react";

/** Full-screen image viewer. Click image to toggle fit / actual-size zoom. */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="close" onClick={onClose} aria-label="Close">
        ✕
      </button>
      <img
        className={zoomed ? "zoomed" : "fit"}
        src={src}
        alt="Figure"
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((z) => !z);
        }}
      />
      <div className="lightbox-hint">{zoomed ? "click to fit" : "click to zoom · Esc to close"}</div>
    </div>
  );
}
