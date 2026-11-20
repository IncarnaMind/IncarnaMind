import type { Mind } from "../../core/api";

/**
 * Whether a Note has a row of its own in the lists: the check of an earlier version of a file an
 * outside agent handed over is its newest version's, whose card opens it (#3412).
 */
export const isListedMind = (mind: Pick<Mind, "supersededBy">): boolean =>
  mind.supersededBy === undefined;
