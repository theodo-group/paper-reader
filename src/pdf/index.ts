import { HeuristicBackend } from "./heuristic";
import type { BackendName, ReflowBackend, ReflowOptions, ReflowPage } from "./types";

export type {
  BackendName,
  Block,
  ImageBlock,
  Progress,
  ReflowOptions,
  ReflowPage,
  TextBlock,
} from "./types";

/**
 * Backend registry. To add a new backend (e.g. a Claude-vision pipeline that
 * renders each page to PNG and asks the model for clean markdown, or one that
 * uses Claude's native PDF input), implement `ReflowBackend` and register the
 * factory here. The rest of the app picks backends by name via `reflowPdf`.
 */
const backends: Partial<Record<BackendName, () => ReflowBackend>> = {
  heuristic: () => new HeuristicBackend(),
  // "claude-vision": () => new ClaudeVisionBackend(),
  // "claude-pdf": () => new ClaudePdfBackend(),
};

const DEFAULT_BACKEND: BackendName = "heuristic";

export function listBackends(): BackendName[] {
  return Object.keys(backends) as BackendName[];
}

export async function reflowPdf(
  data: ArrayBuffer,
  opts: ReflowOptions = {}
): Promise<ReflowPage[]> {
  const name = opts.backend ?? DEFAULT_BACKEND;
  const factory = backends[name];
  if (!factory) throw new Error(`Unknown PDF backend: ${name}`);
  return factory().reflow(data, opts.onProgress);
}
