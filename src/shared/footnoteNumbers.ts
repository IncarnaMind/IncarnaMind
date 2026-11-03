/**
 * How every surface numbers a Note's footnotes (#2292): one footnote for each source and place,
 * a later Citation of it repeating that footnote's number (#1381); a footnote the User wrote, or
 * a calculated figure's note, takes the next number as it comes. The Note, the Word export, the
 * PDF and Copy with Citations all number with this, so a Citation's number is the same in all of
 * them, and what counts as "the same source and place" has one definition (`footnoteSubjectKey`).
 */
import type { FootnoteSubject } from "./citations";
import { footnoteSubjectKey } from "./citations";

/** Where a Citation's footnote is in the numbering. */
export interface FootnoteNumber {
  /** The footnote's number, from 1. */
  number: number;
  /** The first Citation of its source and place: the footnote is written here, not repeated. */
  first: boolean;
}

/** Numbers the marks of one Note or export; call `citation`/`footnote` in the order they come. */
export class FootnoteNumbering {
  private readonly numbers = new Map<string, number>();
  private next = 1;

  /** The number a Citation of this subject has, and whether it is its footnote's first citation. */
  citation(subject: FootnoteSubject): FootnoteNumber {
    const key = footnoteSubjectKey(subject);
    const known = this.numbers.get(key);
    if (known !== undefined) return { number: known, first: false };
    const number = this.next;
    this.next += 1;
    this.numbers.set(key, number);
    return { number, first: true };
  }

  /** The number for a footnote that is not a Citation's: the User's own, or a figure's note. */
  footnote(): number {
    const number = this.next;
    this.next += 1;
    return number;
  }
}
