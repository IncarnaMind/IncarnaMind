/**
 * Where a Document's reading is, as the interface tells it: pure, so the core and the window
 * agree on a Document that can be asked about.
 */
import type { DocumentStatus } from "../core/api";

export const isProcessing = (status: DocumentStatus) =>
  status === "queued" ||
  status === "extracting" ||
  status === "waiting-for-model" ||
  status === "embedding";

/** Its text has been read: search finds it, though its embeddings may still be on their way. */
export const isSearchable = (status: DocumentStatus) =>
  status === "ready" || status === "waiting-for-model" || status === "embedding";
