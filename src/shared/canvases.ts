/**
 * A Canvas (#3406): a page an outside agent wrote, drawn in a `<webview>` of its own session and
 * scheme. What the main process, the Canvas's preload and the window share: its address, the one
 * channel out of it and the two messages that channel carries, and the limits of what it holds.
 */

/** The scheme a Canvas is served from: its own, privileged only as standard (src/main/canvases.ts). */
export const CANVAS_SCHEME = "incarnamind-canvas";

/** The in-memory session every Canvas is drawn in, apart from the app's own. */
export const CANVAS_PARTITION = "canvas";

/** The one channel from a Canvas's preload to the main process. */
export const CANVAS_CHANNEL = "canvas:message";

/** What the Canvas's preload exposes to its page, and nothing besides. */
export const CANVAS_BRIDGE_KEY = "incarnamindCanvas";

export interface CanvasPageBridge {
  /** Asks IncarnaMind to open a Citation the agent wrote in the page, as `[cite:…]`. */
  openCitation(cite: string): void;
}

/** A showing of a Canvas is known by a random host, minted for it, that no page can guess. */
const FRAME_HOST = /^[0-9a-f]{32}$/;

export const canvasFrameUrl = (host: string) => `${CANVAS_SCHEME}://${host}/`;

/** The showing an address belongs to, or null for one that isn't a Canvas's. */
export function canvasHostOf(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== `${CANVAS_SCHEME}:`) return null;
  return FRAME_HOST.test(parsed.hostname) && parsed.port === "" && parsed.username === ""
    ? parsed.hostname
    : null;
}

/** The limits of a Canvas's version: what `publish_canvas` and `update_canvas` refuse past them. */
export const CANVAS_LIMITS = {
  /** Its HTML, in UTF-8. */
  htmlBytes: 2 * 1024 * 1024,
  /** One file it uses. */
  fileBytes: 10 * 1024 * 1024,
  /** Its HTML and files together. */
  totalBytes: 25 * 1024 * 1024,
  files: 50,
  /** A file's name, as the HTML refers to it. */
  nameCharacters: 200,
} as const;

/** The tallest page a Canvas may say it is, in CSS pixels. */
export const MAX_CANVAS_HEIGHT = 1_000_000;

/** The two messages a Canvas sends, and nothing else. */
export type CanvasMessage = { kind: "height"; height: number } | { kind: "cite"; cite: string };

/** Why a message from a Canvas was dropped, as the log names it. */
export type CanvasDrop =
  | "unknown-sender"
  | "not-an-object"
  | "unknown-kind"
  | "extra-fields"
  | "bad-height"
  | "bad-cite"
  | "too-many";

const CITE = /^\[cite:[a-z0-9]{1,32}\]$/;

/** A message from a Canvas, checked by its shape alone: exactly its fields, each of its type. */
export function readCanvasMessage(
  value: unknown,
): { message: CanvasMessage } | { dropped: CanvasDrop } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { dropped: "not-an-object" };
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { dropped: "not-an-object" };
  const fields = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (record.kind === "height") {
    if (fields.length !== 2 || !("height" in record)) return { dropped: "extra-fields" };
    const { height } = record;
    return typeof height === "number" &&
      Number.isFinite(height) &&
      height >= 0 &&
      height <= MAX_CANVAS_HEIGHT
      ? { message: { kind: "height", height: Math.ceil(height) } }
      : { dropped: "bad-height" };
  }
  if (record.kind === "cite") {
    if (fields.length !== 2 || !("cite" in record)) return { dropped: "extra-fields" };
    const { cite } = record;
    return typeof cite === "string" && CITE.test(cite)
      ? { message: { kind: "cite", cite } }
      : { dropped: "bad-cite" };
  }
  return { dropped: "unknown-kind" };
}

/**
 * What the main process tells the window about a Canvas it shows, by the showing's host: its height
 * or a Citation it asked to open; a website it tried to open, which is only offered to the User; or
 * that it stopped, crashed or past its memory.
 */
export type CanvasFrameNews =
  | { host: string; kind: "height"; height: number }
  | { host: string; kind: "cite"; cite: string }
  | { host: string; kind: "link"; url: string }
  | { host: string; kind: "stopped"; reason: "memory" | "crashed" };

/** A website a Canvas may offer the User to open in their browser: web and mail addresses alone. */
export function offeredLink(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  return parsed.protocol === "https:" ||
    parsed.protocol === "http:" ||
    parsed.protocol === "mailto:"
    ? parsed.href
    : null;
}
