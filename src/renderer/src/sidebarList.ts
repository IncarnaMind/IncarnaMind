/** How many Documents a Folder or Not in a Folder lists at first; "Show N more Documents" lists more, in place. */
export const FIRST_DOCUMENTS = 5;

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
