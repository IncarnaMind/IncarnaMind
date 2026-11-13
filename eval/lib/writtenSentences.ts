import * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE, CITATION_NODE } from "../../src/core";
import { countingCheckOf } from "../../src/shared/markKeys";
import { INLINE_NODE, isClaim, sentenceSpans } from "../../src/shared/sentences";

/** A sentence a write added, as a check reads it, with what its check's mark says. */
export interface WrittenSentence {
  /** Its place among the write's sentences in the Note's order, from 0. */
  place: number;
  text: string;
  cited: boolean;
  /** Its mark's state; null: it has no mark. */
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

/** A paragraph's text as a check reads it, each inline node as U+FFFC, with the mark each character carries. */
function lineOf(paragraph: Y.XmlElement) {
  let text = "";
  const marks: unknown[] = [];
  const cited: number[] = [];
  for (const child of paragraph.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const run of child.toDelta() as {
        insert: unknown;
        attributes?: Record<string, unknown>;
      }[]) {
        if (typeof run.insert !== "string") continue;
        const mark = countingCheckOf(run.attributes)?.attrs ?? null;
        text += run.insert;
        for (let at = 0; at < run.insert.length; at++) marks.push(mark);
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === CITATION_NODE) cited.push(text.length);
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
    if (UNCHECKED_BLOCKS.has(element.nodeName)) return;
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
      const hasCitation = cited.some((at) => at >= span.from && at < span.to);
      if (!hasCitation && !isClaim(words.replaceAll(INLINE_NODE, ""))) continue;
      const mark = marks.slice(span.from, span.to).find((each) => each !== null) ?? null;
      found.push({
        place: found.length,
        text: words.replaceAll(INLINE_NODE, "").trim(),
        cited: hasCitation,
        state: field(mark, "state"),
        reason: field(mark, "reason"),
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
