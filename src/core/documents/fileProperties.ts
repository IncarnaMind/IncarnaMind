/**
 * What a Document's file records about itself (#2458), as the documents table keeps it: JSON of
 * `FileProperties`, written when its metadata is read and checked again when it is read back, so
 * a value an older, damaged or synced row holds is never taken for one the file records.
 */
import type { FileProperties } from "../api";
import { isRecord } from "../errors";
import { ownDate, w3cDate } from "./creationDate";

/** The longest text a file's property is taken as: longer is no name a person wrote. */
const MAX_PROPERTY_CHARACTERS = 200;

/** Control characters, and the one a reader puts for bytes it couldn't decode. */
const GARBLED = /[\p{Cc}\uFFFD]/u;

/** The first of the values a file records that reads as text, its spaces made single; else null. */
export const readableText = (...written: (string | null | undefined)[]): string | null =>
  written
    .map((each) => each?.replace(/\s+/g, " ").trim() ?? "")
    .find((each) => each !== "" && each.length <= MAX_PROPERTY_CHARACTERS && !GARBLED.test(each)) ??
  null;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A stored value as it was written, or undefined when it can't have been. */
const stored = (
  value: unknown,
  valid: (text: string) => string | null,
): string | null | undefined =>
  value === null ? null : typeof value === "string" && valid(value) === value ? value : undefined;

const ownDateOf = (text: string) => ownDate([w3cDate(text) === text ? text : null], new Date());

/** Stored properties, checked; null when none were read, or what is stored can't be read. */
export function parseFileProperties(json: string | null): FileProperties | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    console.error(`A Document's stored file properties aren't JSON: ${String(error)}`);
    return null;
  }
  if (!isRecord(value)) return null;
  const created = stored(value.created, ownDateOf);
  const modified = stored(value.modified, ownDateOf);
  const author = stored(value.author, (text) => readableText(text));
  const sheets = value.sheets;
  const listed =
    isRecord(sheets) &&
    isCount(sheets.count) &&
    isCount(sheets.hidden) &&
    sheets.count > 0 &&
    sheets.hidden <= sheets.count
      ? { count: sheets.count, hidden: sheets.hidden }
      : undefined;
  // A value that can't be the file's makes them all unknown: never "the file records none".
  if (created === undefined || modified === undefined || author === undefined) return null;
  if (sheets !== null && listed === undefined) return null;
  return { created, modified, author, sheets: listed ?? null };
}

export const storedFileProperties = (properties: FileProperties | null): string | null =>
  properties === null ? null : JSON.stringify(properties);

/**
 * When the file was created as this computer's file system says, from the nanoseconds stat gave
 * (src/core/documents/files.ts); null for none.
 */
export function fileCreatedAt(nanoseconds: string | null): string | null {
  if (nanoseconds === null || !/^\d+$/.test(nanoseconds)) return null;
  const milliseconds = Number(BigInt(nanoseconds) / 1_000_000n);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}
