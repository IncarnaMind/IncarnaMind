/**
 * An Answer of the assistant's conversations as Blocks (ADR-0017): the Markdown
 * the model wrote made into the node types of Notes, each Citation marker made
 * into its Citation and each figure marker into its calculated figure's shown
 * text (ADR-0021), its words AI text, exactly as an Answer written into a Mind
 * is made. The assistant shows them, Copy copies them and Add to note puts
 * them into a note.
 */

import { markdownToBlocks } from "../core/answers/markdown";
import { forPage } from "../core/answers/pointersBack";
import { CITATION_NODE, type ConversationAnswer, type MarkedCitation } from "../core/api";
import { asGenerated } from "./aiText";
import { citationNode, type NodeJSON, withCitations } from "./blockJson";
import { checkableSentences, paragraphAt, withSentenceMark } from "./claimCheckBlocks";
import { withFigures } from "./figureMarkers";
import { withoutFraming } from "./noteBlocks";

/**
 * While it is written, what would still change how it looks is held back, and
 * a marker whose Citation hasn't come yet shows as being checked; once it has
 * ended, a marker with no Citation is left out. A figure marker with no
 * figure is left out.
 */
export function answerBlocks(
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures" | "status" | "claimChecks">,
): NodeJSON[] {
  const streaming = answer.status === "streaming";
  const cited = new Map(answer.citations.map(({ marker, ...citation }) => [marker, citation]));
  const figures = new Map(answer.figures.map((figure) => [figure.marker, figure]));
  const blocks = withCitations(markdownToBlocks(answer.text, { streaming }), (marker) => {
    const citation = cited.get(marker);
    if (citation) return citationNode(citation);
    return streaming ? citationNode(null) : null;
  });
  const generated = asGenerated(
    closeUpCitations(
      withFigures(
        blocks,
        (marker) => figures.get(marker) ?? null,
        (figure) => figure.shown,
      ),
    ),
  );
  const used = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const sentence of checkableSentences(generated)) {
    const occurrence = occurrences.get(sentence.text) ?? 0;
    occurrences.set(sentence.text, occurrence + 1);
    const check = answer.claimChecks?.find((each) => {
      if (each.text !== sentence.text) return false;
      return each.uncitedOccurrence === undefined
        ? !used.has(each.id)
        : each.uncitedOccurrence === occurrence;
    });
    if (check) used.add(check.id);
    const paragraph = check && paragraphAt(generated, sentence.path);
    if (!check || !paragraph) continue;
    paragraph.content = withSentenceMark(
      paragraph.content ?? [],
      sentence.from,
      sentence.to,
      check,
    );
  }
  return generated;
}

/**
 * A whole Answer as Add to note puts it in a page, for someone who never saw
 * the conversation: without the model's framing, nor what points to an
 * earlier Answer unless `question` asked about one. The Answer in the panel
 * keeps both.
 */
export const pageBlocks = (
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures">,
  question: string,
): NodeJSON[] =>
  withoutFraming(
    answerBlocks({
      ...answer,
      text: forPage(answer.text, question),
      status: "done",
      claimChecks: [],
    }),
  );

/** The Citation markers an Answer's text shows, in order, one for each place: a marker used twice is two. */
export function markersIn(text: string): number[] {
  const markers: number[] = [];
  withCitations(markdownToBlocks(text), (marker) => {
    markers.push(marker);
    return null;
  });
  return markers;
}

/** The markers an Answer's text shows that no Citation of it has, each once. */
export function markersWithoutCitation(answer: {
  text: string;
  citations: readonly Pick<MarkedCitation, "marker">[];
}): number[] {
  const cited = new Set(answer.citations.map(({ marker }) => marker));
  return [...new Set(markersIn(answer.text))].filter((marker) => !cited.has(marker));
}

/** Where the stand-ins of `shownRanges` count from: higher than any marker an Answer writes. */
const STAND_IN = 9000;

/**
 * Which of the `ranges` of `text` (in order, apart) the Answer shows as text
 * rather than inside code or maths, read as `answerBlocks` reads it: each is
 * swapped for a marker, and the markers that come out are the shown ones.
 */
export function shownRanges(
  text: string,
  ranges: readonly { start: number; end: number }[],
): boolean[] {
  if (ranges.length === 0 || ranges.length > 999) return ranges.map(() => false);
  let swapped = "";
  let at = 0;
  ranges.forEach(({ start, end }, index) => {
    swapped += `${text.slice(at, start)}[^${STAND_IN + index}]`;
    at = end;
  });
  const shown = new Set(markersIn(swapped + text.slice(at)));
  return ranges.map((_, index) => shown.has(STAND_IN + index));
}

/** A space between two Citations, or between a Citation and the punctuation after it, is not kept (#612). */
const PUNCTUATION_AFTER = /^[ \t]+(?=[.,;:!?)\]。，、；：！？）])/u;

/**
 * Citations side by side stand together and punctuation touches the Citation
 * before it, whatever spaces the model wrote around the markers.
 */
function closeUpCitations(blocks: readonly NodeJSON[]): NodeJSON[] {
  return blocks.map((block) => {
    if (!block.content || block.type === "codeBlock") return block;
    const siblings = block.content;
    const content: NodeJSON[] = [];
    siblings.forEach((child, index) => {
      if (child.type !== "text" || !child.text) {
        content.push(...closeUpCitations([child]));
        return;
      }
      if (content.at(-1)?.type !== CITATION_NODE) {
        content.push(child);
        return;
      }
      const text = child.text.replace(PUNCTUATION_AFTER, "");
      const betweenCitations = text.trim() === "" && siblings[index + 1]?.type === CITATION_NODE;
      if (!betweenCitations) content.push({ ...child, text });
    });
    return { ...block, content };
  });
}

/** Whether Blocks hold any words: an Answer that failed before writing any has nothing to keep. */
export const hasText = (blocks: readonly NodeJSON[]): boolean =>
  blocks.some(
    (block) =>
      (block.type === "text" && (block.text ?? "").trim() !== "") || hasText(block.content ?? []),
  );
