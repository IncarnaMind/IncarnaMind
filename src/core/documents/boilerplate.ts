/**
 * Running headers, footers and page numbers: lines repeated at the top or the
 * bottom of many pages of a PDF. They are removed from each page before the
 * pages are joined, so a sentence that runs across a page break reads on
 * without them. Processing removes them before building Passages and stores
 * the pages as they are then (see `document_pages`), and the Citation check
 * reads those stored pages: both join the same text. Pure: it runs in the
 * processing worker and in tests.
 */
import { normaliseText } from "../../shared/text";
import { cutUnit } from "../../shared/units";
import type { PageText } from "./passages";

export interface BoilerplateParameters {
  /** How many lines at each end of a page may be header or footer lines. */
  edgeLines: number;
  /** A line is boilerplate when it repeats at a page's edge on at least this many pages… */
  minPages: number;
  /** …and on at least this share of the pages that have text. */
  minShare: number;
  /** Longer lines are body text, never a header or a footer. In normalised characters. */
  maxLineLength: number;
}

/**
 * Not tuned by an evaluation yet: chosen on the sample PDFs, whose running
 * headers repeat on most pages and whose page numbers are a line of their own.
 */
export const BOILERPLATE_PARAMETERS: BoilerplateParameters = {
  edgeLines: 4,
  minPages: 3,
  minShare: 0.3,
  maxLineLength: 200,
};

const ROMAN_NUMERAL = /^[ivxlcdm]+\.?$/;

/**
 * What a line is compared by: normalised, lowercased, with every number as
 * "#", so "Page 3 of 40" and "Page 4 of 40" are the same line, as are the bare
 * page numbers "3" and "iv". Null for an empty or a long line.
 */
function keyOf(line: string, maxLength: number): string | null {
  const normalised = normaliseText(line).toLowerCase();
  if (!normalised || normalised.length > maxLength) return null;
  return ROMAN_NUMERAL.test(normalised) ? "#" : normalised.replace(/\p{N}+/gu, "#");
}

/** The non-empty lines at each end of a page: up to `count` from the top and from the bottom. */
function edgeLinesOf(lines: readonly string[], count: number): string[] {
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length <= count * 2) return filled;
  return [...filled.slice(0, count), ...filled.slice(-count)];
}

/**
 * The pages without their running headers, footers and page numbers: lines,
 * peeled from each edge of a page inwards, that repeat (numbers aside) at the
 * edges of enough of the Document's pages. A page made only of such lines
 * keeps them. Documents without pages are returned as they are.
 */
export function stripBoilerplate<Page extends PageText>(
  pages: readonly Page[],
  parameters: BoilerplateParameters = BOILERPLATE_PARAMETERS,
): Page[] {
  const { edgeLines, minPages, minShare, maxLineLength } = parameters;
  const copy = () => pages.map((page) => ({ ...page }));
  // Only a PDF's pages have running headers and footers; slides, sections and rows don't.
  if (
    pages.length < minPages ||
    pages.some((page) => page.page === null || (page.kind ?? "page") !== "page")
  ) {
    return copy();
  }

  const split = pages.map((page) => page.text.split("\n"));
  const withText = split.filter((lines) => lines.some((line) => line.trim() !== "")).length;
  const needed = Math.max(minPages, Math.ceil(withText * minShare));

  // On how many pages each line appears at an edge.
  const counts = new Map<string, number>();
  for (const lines of split) {
    const keys = new Set<string>();
    for (const line of edgeLinesOf(lines, edgeLines)) {
      const key = keyOf(line, maxLineLength);
      if (key) keys.add(key);
    }
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const boilerplate = new Set(
    [...counts].filter(([, count]) => count >= needed).map(([key]) => key),
  );
  if (boilerplate.size === 0) return copy();

  const isBoilerplate = (line: string) => {
    const key = keyOf(line, maxLineLength);
    return key !== null && boilerplate.has(key);
  };
  return pages.map((page, index) => {
    const lines = split[index] as string[];
    let start = 0;
    let end = lines.length;
    for (let peeled = 0; start < end && peeled < edgeLines; ) {
      const line = lines[start] as string;
      if (line.trim() === "") start++;
      else if (isBoilerplate(line)) {
        start++;
        peeled++;
      } else break;
    }
    for (let peeled = 0; end > start && peeled < edgeLines; ) {
      const line = lines[end - 1] as string;
      if (line.trim() === "") end--;
      else if (isBoilerplate(line)) {
        end--;
        peeled++;
      } else break;
    }
    const kept = lines.slice(start, end).join("\n");
    // A page with nothing but such lines keeps them: they may be all it says ("Page 3 of 40").
    if (kept.trim() === "") return { ...page };
    // Where what is kept starts in the page's text, so a scanned page's anchors move with it.
    const from = lines.slice(0, start).reduce((sum, line) => sum + line.length + 1, 0);
    const leading = kept.length - kept.trimStart().length;
    return cutUnit(page, from + leading, from + kept.trimEnd().length);
  });
}
