import type { Document } from "../../core/api";

/** How many Documents a Folder or Not in a Folder lists at first; "Show N more Documents" lists more, in place. */
export const FIRST_DOCUMENTS = 5;

/**
 * The Documents the sidebar's tree lists while batches are being added: those
 * it listed when the first batch began, never one that has arrived since, so
 * no row moves down as each part of a batch lands (#1329). `null`: nothing is
 * being added, so every Document shows. The Library's count follows them all.
 */
export function heldWhileAdding(
  documents: readonly Document[],
  held: readonly string[] | null,
): readonly Document[] {
  if (held === null) return documents;
  const before = new Set(held);
  return documents.filter((each) => before.has(each.id));
}

/** How many more the first "Show N more Documents" lists. */
const FIRST_STEP = 50;

/**
 * How many Documents the next "Show N more Documents" lists: 50 at first, then
 * twice as many each click, and all that is left once that is fewer, so a long
 * list reaches its end in a handful of clicks (#1354). `revealed` is what those
 * clicks added up to, so adding the first step to it gives the next step.
 */
export function moreDocumentsToShow(revealed: number, left: number): number {
  return Math.min(revealed + FIRST_STEP, left);
}
