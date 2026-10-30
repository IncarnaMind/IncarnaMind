/**
 * Resolving a Question's Search scope (CONTEXT.md) to the Documents its
 * search covers, when the Question is asked: the union of the Documents in
 * its Folders (each with its sub-Folders, at any depth), those with its
 * Tags, and its individual Documents. Folders, Tags and Documents deleted
 * since are ignored: they add nothing.
 */
export { resolveSearchScope, type ScopeSources } from "../shared/searchScope";

import type { SearchScope } from "./api";
import { InvalidInputError, isRecord } from "./errors";

function parseIdList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id !== "")) {
    throw new InvalidInputError(`${what} must be a list of ids.`);
  }
  return [...new Set(value as string[])];
}

/** A Search scope from input; one that names nothing is none (null). */
export function parseSearchScope(value: unknown): SearchScope | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new InvalidInputError("A Search scope must be an object.");
  const scope = {
    folderIds: parseIdList(value.folderIds, "A Search scope's Folders"),
    tagIds: parseIdList(value.tagIds, "A Search scope's Tags"),
    documentIds: parseIdList(value.documentIds, "A Search scope's Documents"),
  };
  const empty = scope.folderIds.length + scope.tagIds.length + scope.documentIds.length === 0;
  return empty ? null : scope;
}
