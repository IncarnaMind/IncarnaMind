import type { CitationLocation } from "../core/api";
import { parseLocation } from "./locations";

/**
 * Where the figures a check couldn't read are (#2510): the Document's text it read, which the
 * check's card names and opens. A not-checked result keeps it as its detail.
 */
export interface UnreadFigures {
  documentId: string;
  documentName: string;
  contentHash: string;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
}

export const unreadFiguresDetail = (place: UnreadFigures): string => JSON.stringify(place);

const pageOf = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === "number" && Number.isInteger(value) ? value : undefined;

/** The place a not-checked result's detail names; null when it names none. */
export function unreadFiguresOf(detail: string | null): UnreadFigures | null {
  let read: Partial<Record<keyof UnreadFigures, unknown>>;
  try {
    read = JSON.parse(detail ?? "") ?? {};
  } catch {
    return null;
  }
  const { documentId, documentName, contentHash } = read;
  const pageFrom = pageOf(read.pageFrom);
  const pageTo = pageOf(read.pageTo);
  if (
    typeof documentId !== "string" ||
    typeof documentName !== "string" ||
    typeof contentHash !== "string" ||
    pageFrom === undefined ||
    pageTo === undefined
  )
    return null;
  const location = read.location === null ? null : parseLocation(read.location);
  return { documentId, documentName, contentHash, pageFrom, pageTo, location };
}
