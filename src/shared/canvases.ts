/**
 * A Canvas (#3406): a page an outside agent wrote, drawn in a `<webview>` of its own session and
 * scheme. What the main process, the Canvas's preload and the window share: its address, the one
 * channel out of it and the one message it carries, and the limits of what it holds.
 */

/** The scheme a Canvas is served from: its own, privileged only as standard (src/main/canvases.ts). */
export const CANVAS_SCHEME = "incarnamind-canvas";

/** The in-memory session every Canvas is drawn in, apart from the app's own. */
export const CANVAS_PARTITION = "canvas";

/** The one channel from a Canvas's preload to the main process. */
export const CANVAS_CHANNEL = "canvas:message";

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

/** The one message a Canvas sends: the User pressed the marker of the Citation with this token. */
export interface CanvasMessage {
  kind: "cite";
  token: string;
}

/** Why a message from a Canvas was dropped, as the log names it. */
export type CanvasDrop =
  | "unknown-sender"
  | "not-an-object"
  | "unknown-kind"
  | "extra-fields"
  | "bad-token"
  | "too-many";

const TOKEN = /^[a-z0-9]{1,32}$/;

/** A message from a Canvas, checked by its shape alone: exactly its fields, each of its type. */
export function readCanvasMessage(
  value: unknown,
): { message: CanvasMessage } | { dropped: CanvasDrop } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { dropped: "not-an-object" };
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { dropped: "not-an-object" };
  const record = value as Record<string, unknown>;
  if (record.kind !== "cite") return { dropped: "unknown-kind" };
  if (Object.keys(record).length !== 2 || !("token" in record)) return { dropped: "extra-fields" };
  return typeof record.token === "string" && TOKEN.test(record.token)
    ? { message: { kind: "cite", token: record.token } }
    : { dropped: "bad-token" };
}

/**
 * What the main process tells the window about a Canvas it shows, by the showing's host: a Citation
 * the User pressed in it, or one of the window's own keys; a website it tried to open, which is only
 * offered to the User; or that it stopped, crashed or past its memory.
 */
export type CanvasFrameNews =
  | { host: string; kind: "cite"; token: string }
  | ({ host: string; kind: "key" } & CanvasKey)
  | { host: string; kind: "link"; url: string }
  | { host: string; kind: "stopped"; reason: "memory" | "crashed" };

/** A key pressed in a Canvas that is the window's own (`KEYS_FROM_CANVASES`, or Esc), to press there. */
export interface CanvasKey {
  key: string;
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

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
