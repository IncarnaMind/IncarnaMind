import type { Mind } from "../core/api";

/**
 * Whether a Note is listed, wherever Notes are listed (the sidebar, Home, ⌘K, the pickers, an
 * agent's `list_minds`): the check of an earlier version of a file an outside agent handed over is
 * its newest version's, and opens only from that Note's card (#3412).
 */
export const isListedMind = (mind: Pick<Mind, "supersededBy">): boolean =>
  mind.supersededBy === undefined;
