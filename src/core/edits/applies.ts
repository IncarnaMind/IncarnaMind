import type { EditAction } from "../api";

export const MOST_OF_IT = 0.5;

/** New text maps onto the selection when at least half of it is found there. */
export function mapsOnto(found: number, total: number): boolean {
  return total === 0 || found / total >= MOST_OF_IT;
}

/** The tasks that take no text out: a paragraph a reply takes out whole is no wish of the User's (#2333). */
export const TAKES_NOTHING_OUT: ReadonlySet<EditAction> = new Set([
  "shorten",
  "improve",
  "translate",
]);

/**
 * What was meant can't be told when an edit takes out most of the selection, so it waits, even
 * when its new text is all found there: a reply that keeps one sentence of five (#2356). A task
 * that takes no text out waits whenever its reply takes a whole paragraph out, by quoting it or by
 * not reaching it, whatever share of the text it is: the reply alone says so, and the task
 * doesn't (#2333).
 */
export function waitsForUser(edit: {
  action: EditAction;
  removed: number;
  added: number;
  selected: number;
  removedWhole?: number;
  /** The User's words, read, don't ask for all that the reply quotes as taken out: that is the reply's doing. */
  widerThanAsked?: boolean;
}): boolean {
  if (
    (TAKES_NOTHING_OUT.has(edit.action) || edit.widerThanAsked === true) &&
    (edit.removedWhole ?? 0) > 0
  ) {
    return true;
  }
  if (edit.action === "translate" || edit.selected === 0) return false;
  return (edit.removed - edit.added) / edit.selected > MOST_OF_IT;
}
