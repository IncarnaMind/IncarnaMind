/**
 * The sentences of an Answer that cite a Citation (#2311): what its judgement reads, and what its
 * check step counts. Pure.
 */
import type { MarkedFigure } from "../core/api";
import { FIGURE_MARKER } from "./figureMarkers";
import { comparableSentence, INLINE_NODE, isClaim, sentenceSpans } from "./sentences";

export interface CitedSentence {
  /** The sentence without its Citation markers. */
  sentence: string;
  /** Its paragraph, list item or table row, also without them. */
  context: string;
  /** The Citation markers it holds, in order. */
  markers: number[];
  /** It shows a Calculated figure, whose own check is the Calculation check (ADR-0021). */
  calculated: boolean;
  /** It is a table's row: its cells, read as one line. */
  inTable: boolean;
}

const MARKER = /\[\^(\d+)\]/g;
const FOOTNOTE_LINE = /^\s*\[\^\d+\]:/;
const BLOCK_MARKUP = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;
const BEFORE_MARKER = new RegExp(`\\s+(?=${INLINE_NODE})`, "gu");

/** Where a Calculated figure's shown text starts, while the sentences are found. */
const FIGURE_START = "\uE000";

const inlineNodes = (text: string) => text.split(INLINE_NODE).length - 1;

/** A marker leaves nothing behind, not even the space before it: "is quadratic [^2]." reads "is quadratic.". */
const withoutMarkers = (text: string) =>
  comparableSentence(text.replace(BEFORE_MARKER, "").replaceAll(FIGURE_START, ""));

/** The claims of an Answer's Markdown that hold a Citation marker, each with its markers. */
export function citedSentences(
  text: string,
  figures: readonly Pick<MarkedFigure, "marker" | "shown">[] = [],
): CitedSentence[] {
  const found: CitedSentence[] = [];
  for (const line of text.split("\n")) {
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
      const inside = markers.slice(before, before + inlineNodes(marked.slice(from, to)));
      const sentence = withoutMarkers(marked.slice(from, to));
      if (inside.length > 0 && isClaim(sentence)) {
        const calculated = marked.slice(from, to).includes(FIGURE_START);
        found.push({ sentence, context, markers: inside, calculated, inTable });
      }
    }
  }
  return found;
}
