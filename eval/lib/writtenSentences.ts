import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitationAttributes,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
} from "../../src/core";
import { citationAttributesOf } from "../../src/shared/citations";
import { asCitedNow } from "../../src/shared/citedNow";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { countingCheckOf, hasMarkIn } from "../../src/shared/markKeys";
import { pendingProposals, readProposalAttribute } from "../../src/shared/proposals";
import { INLINE_NODE, isClaim, sentenceSpans } from "../../src/shared/sentences";

/** A sentence a write added, as a check reads it, with what its check's mark says. */
export interface WrittenSentence {
  /** Its place among the write's sentences in the Note's order, from 0. */
  place: number;
  text: string;
  cited: boolean;
  /** Its mark's state as the Note reads it against the sentence's Citations; null: it has no mark. */
  state: string | null;
  reason: string | null;
  /** When its mark was set, as the mark says. */
  checkedAt: string | null;
}

const UNCHECKED_BLOCKS = new Set(["heading", "question", "codeBlock", "blockMath"]);

const field = (value: unknown, name: string): string | null => {
  const found = typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  return typeof found === "string" && found !== "" ? found : null;
};

/** Whether a waiting change takes the node out, a Block at any depth or an inline node. */
const removed = (node: Y.XmlElement) =>
  readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "delete";

/** A paragraph's text as a check reads it, each inline node as U+FFFC, with the mark each character carries. */
function lineOf(paragraph: Y.XmlElement) {
  let text = "";
  const marks: unknown[] = [];
  const cited: { at: number; citation: Partial<CitationAttributes> }[] = [];
  for (const child of paragraph.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const run of child.toDelta() as {
        insert: unknown;
        attributes?: Record<string, unknown>;
      }[]) {
        // Words and nodes a waiting change takes out aren't the write's sentence.
        if (typeof run.insert !== "string" || hasMarkIn(PROPOSAL_DELETE_MARK, run.attributes))
          continue;
        const mark = countingCheckOf(run.attributes)?.attrs ?? null;
        text += run.insert;
        for (let at = 0; at < run.insert.length; at++) marks.push(mark);
      }
    } else if (child instanceof Y.XmlElement) {
      if (removed(child)) continue;
      if (child.nodeName === CITATION_NODE)
        cited.push({ at: text.length, citation: citationAttributesOf(child.getAttributes()) });
      text += child.nodeName === "hardBreak" ? "\n" : INLINE_NODE;
      marks.push(null);
    }
  }
  return { text, marks, cited };
}

/**
 * The sentences of the top-level Blocks `ids` names, in the Note's order, that a check of what was
 * written reads: those with a Citation, and the claims among those with none.
 */
export function writtenSentences(
  blocks: Y.XmlFragment,
  ids: ReadonlySet<string>,
): WrittenSentence[] {
  const found: WrittenSentence[] = [];
  const visit = (element: Y.XmlElement, inHeader: boolean) => {
    if (UNCHECKED_BLOCKS.has(element.nodeName) || removed(element)) return;
    if (element.nodeName !== "paragraph") {
      for (const child of element.toArray())
        if (child instanceof Y.XmlElement)
          visit(child, inHeader || element.nodeName === "tableHeader");
      return;
    }
    if (inHeader) return;
    const { text, marks, cited } = lineOf(element);
    for (const span of sentenceSpans(text)) {
      const words = text.slice(span.from, span.to);
      const held = cited.flatMap(({ at, citation }) =>
        at >= span.from && at < span.to ? [citation] : [],
      );
      const sentence = words.replaceAll(INLINE_NODE, "").trim();
      if (held.length === 0 && !isClaim(sentence)) continue;
      const mark = marks.slice(span.from, span.to).find((each) => each !== null) ?? null;
      const check = readClaimCheck(mark);
      const read = check && asCitedNow(check, held, sentence);
      found.push({
        place: found.length,
        text: sentence,
        cited: held.length > 0,
        state: read?.state ?? null,
        reason: read?.reason ?? null,
        checkedAt: field(mark, "checkedAt"),
      });
    }
  };
  for (const block of blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    const id = block.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (typeof id === "string" && ids.has(id)) visit(block, false);
  }
  return found;
}

/**
 * The top-level Blocks the write's change `request` is in while it waits, read from the Note: the
 * Blocks it added and the existing ones it rewrote.
 */
export function writtenBlocks(blocks: Y.XmlFragment, request: string): string[] {
  return blocks.toArray().flatMap((block) => {
    if (!(block instanceof Y.XmlElement)) return [];
    const id = block.getAttribute(BLOCK_ID_ATTRIBUTE);
    const holds =
      readProposalAttribute(block.getAttribute(PROPOSAL_ATTRIBUTE))?.request === request ||
      pendingProposals(block).some((ref) => ref.request === request);
    return typeof id === "string" && holds ? [id] : [];
  });
}
