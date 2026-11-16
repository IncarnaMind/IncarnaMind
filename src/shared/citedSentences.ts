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
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^\s*#{1,6}\s+/;
/** A hard break: two trailing spaces or a backslash end a line that a paragraph goes on from. */
const HARD_BREAK = /(?: {2,}|\\)$/;
const CJK_EDGE = /\p{Script=Han}|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const BEFORE_MARKER = new RegExp(`\\s+(?=${INLINE_NODE})`, "gu");

/** Where a Calculated figure's shown text starts, while the sentences are found. */
const FIGURE_START = "\uE000";

const inlineNodes = (text: string) => text.split(INLINE_NODE).length - 1;

/** A line's end that ends its sentence: a stop, a colon or a semicolon, past closing marks and Citations. */
const SENTENCE_FINISHED = /[.!?。！？:：;；][\s"'”’)\]）」』»*_~￼]*(?:\[\^\d{1,4}\]\s*)*$/u;

/**
 * Whether `line` goes on the sentence the line before it left unfinished: it opens in lower case
 * ("the main hall at the Stoke site…"), as a wrapped line of prose does, or with a fragment too
 * short to be a claim of its own ("installed [^1].", "February 2027 [^2]."), which no judgement
 * reads, so its Citation would show found beside a sentence nobody judged (#3213).
 */
function endsTheLineBefore(line: string): boolean {
  if (/^\p{Ll}/u.test(line.trimStart())) return true;
  const marked = line.replace(MARKER, INLINE_NODE).trim();
  const [first] = sentenceSpans(marked);
  return first !== undefined && !isClaim(withoutMarkers(marked.slice(first.from, first.to)));
}

/**
 * The lines of an Answer's Markdown, a sentence wrapped over a line break read as one line: a line
 * goes on from the line before it when that one doesn't end its sentence and this one goes on it
 * (`endsTheLineBefore`): in lower case, or a fragment too short to be a claim. A line that is a
 * claim of its own ("Cost: £185,000 [^1]", a sentence), a block of its own (a list item, a heading, a quote, a table
 * row, a footnote, a line of a code fence), or follows a hard break stays its own unit.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  let open = false;
  for (const line of text.split("\n")) {
    const fence = FENCE.test(line);
    const standalone =
      fence ||
      fenced ||
      line.trim() === "" ||
      FOOTNOTE_LINE.test(line) ||
      HEADING.test(line) ||
      line.trimStart().startsWith("|");
    if (fence) fenced = !fenced;
    const previous = lines.at(-1);
    if (
      open &&
      previous !== undefined &&
      !standalone &&
      !BLOCK_MARKUP.test(line) &&
      !SENTENCE_FINISHED.test(previous) &&
      endsTheLineBefore(line)
    ) {
      const apart = CJK_EDGE.test(previous.slice(-1)) && CJK_EDGE.test(line.trimStart().charAt(0));
      lines[lines.length - 1] = `${previous}${apart ? "" : " "}${line.trimStart()}`;
    } else lines.push(line);
    open = !standalone && !HARD_BREAK.test(line);
  }
  return lines;
}

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
  for (const line of logicalLines(text)) {
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
      // The words lost their Markdown above, so the names are compared without it too: "Annual_Report".
      const cited = citations
        .filter((citation) => inside.includes(citation.marker))
        .map((citation) => ({
          ...citation,
          documentName:
            typeof citation.documentName === "string"
              ? citation.documentName.replace(/[*_`]/g, "")
              : citation.documentName,
        }));
      if (inside.length > 0 && isClaim(sentence) && !onlyNamesItsSource(sentence, cited)) {
        const calculated = marked.slice(from, to).includes(FIGURE_START);
        const at = inside.map((_, index) => first + before + index);
        found.push({ sentence, context, markers: inside, at, calculated, inTable });
      }
    }
  }
  return found;
}
