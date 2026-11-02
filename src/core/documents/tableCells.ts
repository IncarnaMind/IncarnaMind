/**
 * A table's cells as text (#448): which hold figures, the footnote mark after one, and a table
 * read from a file that gives its cells (a Word file's, a deck's), headed as a page's table is
 * (./tables). Apart from ./tables, which the renderer can't import: its viewers read Word files
 * and decks with the readers that use this.
 */
import type { UnitTable } from "../../shared/units";

export const MAX_HEADING_ROWS = 3;

const FIGURE =
  /^[<>≈~≤≥]?\s?[-+−–(（]?[$€£¥]?\s?\d[\d,.\s]*(?:%|\s?(?:[kmb]n?|bn|pp|x|×|万|亿|元))?[)）]?$/iu;
export const CJK_EDGE = /[\u2e80-\u2fdf\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

const RAISED_DIGITS = "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079";
const LOWERED_DIGITS = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";

/**
 * A run's digits set raised or lowered, written as Unicode's superscript or subscript digits:
 * read as plain digits, a footnote mark "²" after "1,240.50" would make it 1,240.502 (#448).
 */
export const shiftedDigits = (text: string, raised: boolean) =>
  text.replace(/\d/g, (digit) => (raised ? RAISED_DIGITS : LOWERED_DIGITS)[Number(digit)] ?? digit);

/** A footnote's mark set after a figure: "17,347.75²", "4,812*", "(55.8)†". */
const FOOTNOTE_MARK =
  /(?<=[\p{Nd})）%])(?:[\u00b9\u00b2\u00b3\u2070\u2074-\u2079]+|[*†‡§¶]{1,3})$/u;

/** A cell's text without the footnote mark after its figure, and the mark ("" when it has none). */
export function withoutFootnoteMark(text: string): { text: string; mark: string } {
  const trimmed = text.trim();
  const mark = FOOTNOTE_MARK.exec(trimmed)?.[0] ?? "";
  return { text: mark ? trimmed.slice(0, -mark.length) : trimmed, mark };
}

// Full-width digits are a figure's in a Chinese table; a footnote mark after one doesn't make it words.
export const isFigure = (text: string) =>
  FIGURE.test(withoutFootnoteMark(text).text.normalize("NFKC").trim());
const YEAR = /^(?:FY\s?)?(?:19|20)\d{2}$/i;
const isYear = (text: string) => YEAR.test(text.normalize("NFKC").trim());
/** A figure in the body of a table: a year names a column more often than it fills one. */
export const isDatum = (text: string) => isFigure(text) && !isYear(text);

export const join = (a: string, b: string) =>
  !a
    ? b
    : !b
      ? a
      : CJK_EDGE.test(a.at(-1) ?? "") && CJK_EDGE.test(b[0] ?? "")
        ? a + b
        : `${a} ${b}`;

/** Which of a table's `width` columns hold figures: most of their cells, in most of its rows. */
export function figureColumns(rows: readonly (readonly string[])[], width: number): boolean[] {
  return Array.from({ length: width }, (_, column) => {
    const filled = rows.map((row) => row[column] ?? "").filter((text) => text !== "");
    const figures = filled.filter(isFigure).length;
    return figures >= 2 && figures >= filled.length / 2 && filled.length >= rows.length / 2;
  });
}

/**
 * A table whose file gives its cells, a Word file's or a deck's (#448): the rows above the first
 * that holds a figure, other than a year, head its columns, as on a page. A heading over a group of
 * columns names each of them ("Cost (EUR)" over Internal and External). Null for a table with no
 * column of figures.
 */
export function cellTable(rows: readonly (readonly string[])[]): UnitTable | null {
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  if (width < 2) return null;
  const firstData = rows.findIndex((row) => row.some(isDatum));
  if (firstData < 0) return null;
  const headingCount = Math.min(firstData, MAX_HEADING_ROWS);
  const body = rows
    .slice(headingCount)
    .map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ""));
  if (!figureColumns(body, width).some(Boolean)) return null;
  const headings = Array.from({ length: width }, () => "");
  rows.slice(0, headingCount).forEach((row) => {
    let group = "";
    for (let column = 0; column < width; column++) {
      const text = (row[column] ?? "").trim();
      if (column > 0 && text) group = text;
      // A heading covers the empty grid cells a span leaves after it, in the last heading row as
      // in an upper one: without it the covered column would be named by its letter alone.
      const named = text || (column > 0 ? group : "");
      headings[column] = join(headings[column] ?? "", named);
    }
  });
  return { headings, rows: body };
}
