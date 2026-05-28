import * as pdfjsLib from "pdfjs-dist";

// The worker is fetched from jsDelivr at the *exact* installed version, so it
// always matches the main library — no manual asset copying required.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export { pdfjsLib };

export type TextBlock = {
  kind: "text";
  text: string;
  level: "h" | "p"; // heading vs paragraph
};

export type ImageBlock = {
  kind: "image";
  url: string;
  width: number;
  height: number;
};

export type Block = TextBlock | ImageBlock;

export type ReflowPage = {
  number: number;
  blocks: Block[];
};

export type Progress = (done: number, total: number, phase?: string) => void;

export type BackendName = "heuristic" | "claude-vision" | "claude-pdf";

export interface ReflowBackend {
  /** Stable identifier — must match a key in the backend registry. */
  readonly name: BackendName;
  reflow(data: ArrayBuffer, onProgress?: Progress): Promise<ReflowPage[]>;
}

export type ReflowOptions = {
  backend?: BackendName;
  onProgress?: Progress;
};
