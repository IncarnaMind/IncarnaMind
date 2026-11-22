/**
 * Names shared by the main process and the renderer for the Document viewer.
 *
 * The main process serves each live Document's file at
 * `incarnamind-document://<documentId>/`, streamed from where the User keeps
 * it, so whole files never cross IPC. A Document whose file is missing or
 * can't be reached gets a 404; its kept text comes from `readDocumentText`.
 */

import type { DocumentPlace, TabCitation } from "../core/api";

export const DOCUMENT_SCHEME = "incarnamind-document";

/** The URL the main process serves a Document's file at. */
export const documentFileUrl = (documentId: string): string =>
  `${DOCUMENT_SCHEME}://${encodeURIComponent(documentId)}/`;

/** The Document id a `documentFileUrl` names, or null if the URL isn't one. */
export function documentIdFromUrl(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== `${DOCUMENT_SCHEME}:` || !parsed.hostname) return null;
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    return null;
  }
  return decodeURIComponent(parsed.hostname);
}

/**
 * The URL the main process serves a picture a Document shows at: a Markdown
 * file's from beside it, by the path written in the file, or a saved web
 * page's (#756), by its path in the snapshot, under the Document's own URL.
 */
export const documentImageUrl = (documentId: string, path: string): string =>
  `${documentFileUrl(documentId)}${path.split("/").map(encodeURIComponent).join("/")}`;

/** The Document and the picture's path a `documentImageUrl` names, or null if it isn't one. */
export function documentImageFromUrl(url: string): { documentId: string; path: string } | null {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== `${DOCUMENT_SCHEME}:` || !parsed.hostname) return null;
  if (parsed.pathname === "/" || parsed.pathname === "" || parsed.search || parsed.hash) {
    return null;
  }
  try {
    const path = parsed.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
    return { documentId: decodeURIComponent(parsed.hostname), path };
  } catch {
    return null;
  }
}

/**
 * Where to open a Document in the viewer. Citations open it at their page range
 * and quote; a click in the sidebar opens it at the top.
 */
export interface DocumentLocation extends DocumentPlace {
  documentId: string;
}

/** What the viewer knows of the Citation it was opened from. */
export type ViewerCitation = TabCitation;

/** The most quotes one opening of a Document marks: those of the Citations one chip stands for. */
export const MOST_QUOTES_AT_ONCE = 50;
