/**
 * What a Document's file records about itself (#2458), as the documents table keeps it: JSON of
 * `FileProperties`, written when its metadata is read and read back checked, so a value an older
 * or a damaged row holds is never taken for one the file records.
 */
import type { FileProperties } from "../api";
import { isRecord } from "../errors";

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function sheetsOf(value: unknown): FileProperties["sheets"] {
  if (!isRecord(value) || !isCount(value.count) || !isCount(value.hidden)) return null;
  return value.count > 0 && value.hidden <= value.count
    ? { count: value.count, hidden: value.hidden }
    : null;
}

/** Stored properties, checked; null when none were read, or what is stored can't be read. */
export function parseFileProperties(json: string | null): FileProperties | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  return {
    created: textOrNull(value.created),
    modified: textOrNull(value.modified),
    author: textOrNull(value.author),
    sheets: sheetsOf(value.sheets),
  };
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
