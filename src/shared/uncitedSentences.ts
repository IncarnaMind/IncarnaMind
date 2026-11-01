/**
 * Which sentences an outside agent's change leaves with no Citation (#352): one rule for the
 * count on the change's bar and the list the agent gets back, so the two always agree. Each
 * reads the paragraphs the change is in its own way (the editor's document, the Mind's Yjs
 * document) and hands them here.
 */
import { INLINE_NODE, isClaim, type SentenceSpan, sentenceSpans } from "./sentences";

/** A paragraph as it reads with the change accepted and the others not. */
export interface ChangedParagraph {
  /** Its text, an inline node as `INLINE_NODE`. */
  text: string;
  /** Where its text holds what the change adds. */
  mine: ReadonlySet<number>;
  /** Where its Citations are. */
  cited: ReadonlySet<number>;
  /** Headings and table cells aren't sentences that make claims of their own. */
  kind: "paragraph" | "heading" | "cell";
}

/**
 * Its sentences that hold words of the change, make a claim (`isClaim`, as the Note's checks
 * count them) and hold no Citation.
 */
export function uncitedSpans(paragraph: ChangedParagraph): SentenceSpan[] {
  if (paragraph.kind !== "paragraph") return [];
  return sentenceSpans(paragraph.text).filter((span) => {
    let mine = false;
    for (let at = span.from; at < span.to; at++) {
      if (paragraph.cited.has(at)) return false;
      mine ||= paragraph.mine.has(at);
    }
    return mine && isClaim(paragraph.text.slice(span.from, span.to));
  });
}

/** A sentence's words, its inline nodes left out. */
export const sentenceWords = (paragraph: ChangedParagraph, span: SentenceSpan): string =>
  paragraph.text.slice(span.from, span.to).replaceAll(INLINE_NODE, "").replace(/\s+/g, " ").trim();
