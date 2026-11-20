/**
 * The lines of a Passage a check may quote as what its Document says now: each without its Unit
 * mark, none of a row the file sets aside, and none of a Passage whose set-aside rows can't be told.
 */

import { SET_ASIDE_LINE, UNPLACED_MARK } from "../sheetRows";

/** A mark where a new Unit starts in a Passage: "[p. 4] ", "[slide 4] ", "[§ 2.1 Sensitivity] "… */
const UNIT_MARK = /^\[(?:p\. \d+|slides? [^\]]+|§[^\]]*|[^\]]*rows? [\d–-]+|lines? [\d–-]+)\] /;

/** A Passage's lines that can be quoted as what its Document says now, each without its Unit mark. */
export function quotableLines(passage: string): string[] {
  if (passage.startsWith(UNPLACED_MARK)) return [];
  return passage
    .split("\n")
    .filter((raw) => !SET_ASIDE_LINE.test(raw))
    .map((raw) => raw.replace(UNIT_MARK, "").trim())
    .filter((line) => line !== "");
}
