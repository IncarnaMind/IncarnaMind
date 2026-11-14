/**
 * The sentences of an Answer that cite a Citation (#2311): what its judgement reads, and what its
 * check step counts. Pure.
 */
import type { MarkedFigure } from "../core/api";
import { MARKER } from "./answerSentences";
import { FIGURE_MARKER } from "./figureMarkers";
import { comparableSentence, INLINE_NODE, isClaim, sentenceSpans } from "./sentences";
import { type CitedSource, onlyNamesItsSource } from "./sourceNames";

export interface CitedSentence {
  /** The sentence without its Citation markers. */
  sentence: string;
  /** Its paragraph, list item or table row, also without them. */
  context: string;
  /** The Citation markers it holds, in order. */
  markers: number[];
  /**
   * Where each of them is in the text: its place among all the text's Citation markers, from 0,
   * so a marker that two sentences reuse is told apart in each (#2847).
   */
  at: number[];
  /** It shows a Calculated figure, whose own check is the Calculation check (ADR-0021). */
  calculated: boolean;
  /** It is a table's row: its cells, read as one line. */
  inTable: boolean;
}

const FOOTNOTE_LINE = /^\s*\[\^\d{1,4}\]:/;
const BLOCK_MARKUP = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;
const BEFORE_MARKER = new RegExp(`\\s+(?=${INLINE_NODE})`, "gu");

/** Where a Calculated figure's shown text starts, while the sentences are found. */
const FIGURE_START = "\uE000";

const inlineNodes = (text: string) => text.split(INLINE_NODE).length - 1;

/** A marker leaves nothing behind, not even the space before it: "is quadratic [^2]." reads "is quadratic.". */
const withoutMarkers = (text: string) =>
  comparableSentence(text.replace(BEFORE_MARKER, "").replaceAll(FIGURE_START, ""));

/**
 * The claims of an Answer's Markdown that hold a Citation marker, each with its markers. A
 * sentence that only names the Document of its `citations` is none (#3093).
 */
export function citedSentences(
  text: string,
  figures: readonly Pick<MarkedFigure, "marker" | "shown">[] = [],
  citations: readonly (CitedSource & { marker: number })[] = [],
): CitedSentence[] {
  const found: CitedSentence[] = [];
  let seen = 0;
  for (const line of text.split("\n")) {
    const first = seen;
    seen += line.match(MARKER)?.length ?? 0;
    if (FOOTNOTE_LINE.test(line)) continue;
    const inTable = line.trimStart().startsWith("|");
    const markers: number[] = [];
    const marked = line
      .replace(BLOCK_MARKUP, "")
      .replace(
        FIGURE_MARKER,
        (marker, number: string) =>
          `${FIGURE_START}${figures.find((each) => each.marker === Number(number))?.shown ?? marker}`,
      )
      .replace(MARKER, (_, number: string) => {
        markers.push(Number(number));
        return INLINE_NODE;
      })
      .replace(/[*_`]/g, "")
      .replace(/\|/g, " ");
    const context = withoutMarkers(marked);
    for (const { from, to } of sentenceSpans(marked)) {
      const before = inlineNodes(marked.slice(0, from));
      const count = inlineNodes(marked.slice(from, to));
      const inside = markers.slice(before, before + count);
      const sentence = withoutMarkers(marked.slice(from, to));
      const cited = citations.filter((citation) => inside.includes(citation.marker));
      if (inside.length > 0 && isClaim(sentence) && !onlyNamesItsSource(sentence, cited)) {
        const calculated = marked.slice(from, to).includes(FIGURE_START);
        const at = inside.map((_, index) => first + before + index);
        found.push({ sentence, context, markers: inside, at, calculated, inTable });
      }
    }
  }
  return found;
}
