/**
 * How every surface numbers a Note's footnotes (#2292): one footnote for each source and place,
 * a later Citation of it repeating that footnote's number (#1381); a footnote the User wrote, or
 * a calculated figure's note, takes the next number as it comes. The Note, the Word export, the
 * PDF and Copy with Citations all number with this, so a Citation's number is the same in all of
 * them, and what counts as "the same source and place" has one definition (`footnoteSubjectKey`).
 */
import type { FootnoteSubject } from "./citations";
import { footnoteSubjectKey } from "./citations";
import { MOST_QUOTES_AT_ONCE } from "./documentViewer";

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

/** What a run of Citations side by side holds, for `sharedMarkOf`. */
export interface MarkRun<T> {
  /** A Citation's note (`footnoteSubjectKey`); null for one that has a note of its own. */
  noteOf: (inline: T) => string | null;
  isCitation: (inline: T) => boolean;
  /** What may stand between two Citations of a run. */
  isSpace: (inline: T) => boolean;
}

/**
 * The Citation (its index) whose mark the one at `index` shares, or null when it writes its own:
 * the first of its note in their run of Citations side by side, as the Note shows each number
 * once in such a run (#3654), for as many quotes as one opening marks.
 */
export function sharedMarkOf<T>(
  inlines: readonly T[],
  index: number,
  run: MarkRun<T>,
): number | null {
  const own = inlines[index];
  if (own === undefined || !run.isCitation(own) || run.noteOf(own) === null) return null;
  let start = index;
  for (let at = index - 1; at >= 0; at--) {
    const before = inlines[at] as T;
    if (run.isSpace(before)) continue;
    if (!run.isCitation(before)) break;
    start = at;
  }
  const leads = new Map<string, { at: number; count: number }>();
  for (let at = start; at <= index; at++) {
    const each = inlines[at] as T;
    const note = run.isCitation(each) ? run.noteOf(each) : null;
    if (note === null) continue;
    const lead = leads.get(note);
    const joins = lead !== undefined && lead.count < MOST_QUOTES_AT_ONCE;
    if (at === index) return joins ? lead.at : null;
    if (joins) lead.count += 1;
    else leads.set(note, { at, count: 1 });
  }
  return null;
}
