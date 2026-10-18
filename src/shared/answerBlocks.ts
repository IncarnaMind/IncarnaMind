/**
 * An Answer of the assistant's conversations as Blocks (ADR-0017): the Markdown
 * the model wrote made into the node types of Notes, each Citation marker made
 * into its Citation and each figure marker into its calculated figure's shown
 * text (ADR-0021), its words AI text, exactly as an Answer written into a Mind
 * is made. The assistant shows them, Copy copies them and Add to note puts
 * them into a note.
 */

import { markdownToBlocks } from "../core/answers/markdown";
import { CITATION_NODE, type ConversationAnswer } from "../core/api";
import { asGenerated } from "./aiText";
import { citationNode, type NodeJSON, withCitations } from "./blockJson";
import { withFigures } from "./figureMarkers";

/**
 * While it is written, what would still change how it looks is held back, and
 * a marker whose Citation hasn't come yet shows as being checked; once it has
 * ended, a marker with no Citation is left out. A figure marker with no
 * figure is left out.
 */
export function answerBlocks(
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures" | "status">,
): NodeJSON[] {
  const streaming = answer.status === "streaming";
  const cited = new Map(answer.citations.map(({ marker, ...citation }) => [marker, citation]));
  const figures = new Map(answer.figures.map((figure) => [figure.marker, figure]));
  const blocks = withCitations(markdownToBlocks(answer.text, { streaming }), (marker) => {
    const citation = cited.get(marker);
    if (citation) return citationNode(citation);
    return streaming ? citationNode(null) : null;
  });
  return asGenerated(
    closeUpCitations(
      withFigures(
        blocks,
        (marker) => figures.get(marker) ?? null,
        (figure) => figure.shown,
      ),
    ),
  );
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
