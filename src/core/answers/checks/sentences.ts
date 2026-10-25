/**
 * The User's sentences in a Mind's Yjs document, for their checks (#96):
 * which sentences a selection touches, and the `CLAIM_CHECK_MARK` that
 * holds each one's result on its text. Offsets are `TextPlace` offsets: an
 * inline node counts as one character.
 */
import * as Y from "yjs";
import { readClaimCheck } from "../../../shared/claimChecks";
import { readProposalAttribute, readProposalRef } from "../../../shared/proposals";
import { comparableSentence, INLINE_NODE, sentenceSpans } from "../../../shared/sentences";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitedQuote,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type TextStretch,
  type WaitingSentences,
} from "../../api";
import { layout, textBlocks } from "../../proposals/write";

const BREAK = "hardBreak";

type Attributes = Record<string, unknown>;

interface Run {
  insert: unknown;
  attributes?: Attributes;
}

/** A sentence the selection touches, to check. */
export interface SelectedSentence {
  element: Y.XmlElement;
  blockId: string;
  from: number;
  to: number;
  /** As checks read it: an inline node as U+FFFC, a line break as "\n". */
  text: string;
  /** Its paragraph's text, for what its words refer to. */
  context: string;
  /** What its Citations quote. */
  cited: CitedQuote[];
}

export type SelectedSentences =
  | { ok: true; sentences: SelectedSentence[]; waiting: WaitingSentences }
  | { ok: false; reason: "nothing" };

/** A Block's text as checks read it. */
export function textOf(element: Y.XmlElement): string {
  return layout(element)
    .map(({ node }) =>
      node instanceof Y.XmlText
        ? (node.toDelta() as Run[])
            .map((run) => (typeof run.insert === "string" ? run.insert : INLINE_NODE))
            .join("")
        : node.nodeName === BREAK
          ? "\n"
          : INLINE_NODE,
    )
    .join("");
}

function changesIn(element: Y.XmlElement, from: number, to: number): string[] {
  const found = new Set<string>();
  const add = (ref: { id: string } | null) => {
    if (ref) found.add(ref.id);
  };
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    add(readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE)));
  }
  for (const { node, start, size } of layout(element)) {
    if (start + size <= from || start >= to) continue;
    if (node instanceof Y.XmlElement) {
      add(readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE)));
      continue;
    }
    let offset = start;
    for (const run of node.toDelta() as Run[]) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      if (offset < to && offset + length > from) {
        add(readProposalRef(run.attributes?.[PROPOSAL_INSERT_MARK]));
        add(readProposalRef(run.attributes?.[PROPOSAL_DELETE_MARK]));
      }
      offset += length;
    }
  }
  return [...found];
}

/** What the Citations in `from`..`to` of a Block quote. */
function citedIn(element: Y.XmlElement, from: number, to: number): CitedQuote[] {
  return layout(element).flatMap(({ node, start }) => {
    if (start < from || start >= to || !(node instanceof Y.XmlElement)) return [];
    if (node.nodeName !== CITATION_NODE) return [];
    const { documentId, documentName, contentHash, quote } = node.getAttributes() as Attributes;
    return typeof quote === "string" && quote !== ""
      ? [
          {
            documentName: typeof documentName === "string" ? documentName : "",
            quote,
            ...(typeof documentId === "string" && { documentId }),
            ...(typeof contentHash === "string" && { contentHash }),
          },
        ]
      : [];
  });
}

/**
 * The sentences each stretch touches, each whole and once: a sentence a
 * stretch only touches is checked all the same. Headings aren't checked.
 */
export function selectedSentences(
  blocks: Y.XmlFragment,
  stretches: readonly TextStretch[],
): SelectedSentences {
  const all = textBlocks(blocks);
  const idOf = (element: Y.XmlElement) => element.getAttribute(BLOCK_ID_ATTRIBUTE);
  const sentences: SelectedSentence[] = [];
  const waiting: WaitingSentences = { sentences: [], changeIds: [] };
  const seen = new Set<string>();
  for (const { from, to } of stretches) {
    const first = all.findIndex(({ element }) => idOf(element) === from.blockId);
    const last = all.findIndex(({ element }) => idOf(element) === to.blockId);
    if (first < 0 || last < first) continue;
    for (const [index, { element, busy }] of all.slice(first, last + 1).entries()) {
      if (busy || element.nodeName !== "paragraph") continue;
      const blockId = idOf(element);
      if (typeof blockId !== "string") continue;
      const text = textOf(element);
      const start = index === 0 ? from.offset : 0;
      const end = index === last - first ? to.offset : text.length;
      for (const span of sentenceSpans(text)) {
        const touched =
          start === end
            ? span.from <= start && start <= span.to
            : span.from < end && span.to > start;
        const key = `${blockId}:${span.from}`;
        if (!touched || seen.has(key)) continue;
        seen.add(key);
        const changes = changesIn(element, span.from, span.to);
        if (changes.length > 0) {
          waiting.sentences.push({
            from: { blockId, offset: span.from },
            to: { blockId, offset: span.to },
          });
          waiting.changeIds.push(...changes.filter((id) => !waiting.changeIds.includes(id)));
          continue;
        }
        sentences.push({
          element,
          blockId,
          from: span.from,
          to: span.to,
          text: text.slice(span.from, span.to),
          context: text,
          cited: citedIn(element, span.from, span.to),
        });
      }
    }
  }
  return sentences.length + waiting.sentences.length > 0
    ? { ok: true, sentences, waiting }
    : { ok: false, reason: "nothing" };
}

/** Every sentence of the Mind's paragraphs, in order, but those holding a change still waiting. */
export function everySentence(blocks: Y.XmlFragment): SelectedSentence[] {
  return textBlocks(blocks).flatMap(({ element, busy }) => {
    const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (busy || element.nodeName !== "paragraph" || typeof blockId !== "string") return [];
    const text = textOf(element);
    return sentenceSpans(text).flatMap((span) =>
      changesIn(element, span.from, span.to).length > 0
        ? []
        : [
            {
              element,
              blockId,
              from: span.from,
              to: span.to,
              text: text.slice(span.from, span.to),
              context: text,
              cited: citedIn(element, span.from, span.to),
            },
          ],
    );
  });
}

/** Puts a check's mark on `from`..`to` of a Block's text, in place of any check there. */
export function markSentence(
  element: Y.XmlElement,
  from: number,
  to: number,
  check: ClaimCheckAttributes,
): void {
  for (const { node, start, size } of layout(element)) {
    if (!(node instanceof Y.XmlText)) continue;
    const begin = Math.max(from, start);
    const end = Math.min(to, start + size);
    if (begin >= end) continue;
    node.format(begin - start, end - begin, { [CLAIM_CHECK_MARK]: { ...check } });
  }
}

/** Takes the marks of checks made by `action` off `from`..`to` of a Block's text; true if there were any. */
export function unmarkSentence(
  element: Y.XmlElement,
  from: number,
  to: number,
  action: ClaimCheckAttributes["action"],
): boolean {
  let removed = false;
  for (const { node, start } of layout(element)) {
    if (!(node instanceof Y.XmlText)) continue;
    let offset = start;
    for (const run of node.toDelta() as Run[]) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      const check = readClaimCheck(run.attributes?.[CLAIM_CHECK_MARK]);
      if (check?.action === action && offset < to && offset + length > from) {
        const begin = Math.max(from, offset);
        node.format(begin - start, Math.min(to, offset + length) - begin, {
          [CLAIM_CHECK_MARK]: null,
        });
        removed = true;
      }
      offset += length;
    }
  }
  return removed;
}

/** Where a check's mark is: its Block and the stretch of text from its first marked character to its last. */
export interface MarkedSentence {
  element: Y.XmlElement;
  from: number;
  to: number;
  check: ClaimCheckAttributes;
}

/** Every check's mark in the Mind, in order. */
export function markedSentences(blocks: Y.XmlFragment): MarkedSentence[] {
  const found = new Map<string, MarkedSentence>();
  for (const { element } of textBlocks(blocks)) {
    for (const { node, start } of layout(element)) {
      if (!(node instanceof Y.XmlText)) continue;
      let offset = start;
      for (const run of node.toDelta() as Run[]) {
        const length = typeof run.insert === "string" ? run.insert.length : 1;
        const check = readClaimCheck(run.attributes?.[CLAIM_CHECK_MARK]);
        if (check) {
          const known = found.get(check.id);
          if (known && known.element === element) known.to = offset + length;
          else if (!known)
            found.set(check.id, { element, from: offset, to: offset + length, check });
        }
        offset += length;
      }
    }
  }
  return [...found.values()];
}

/** Whether the User keeps a sentence as their own view (#1111): a check's mark on it says so, and its words are as they were. */
export function keptAsView(
  marks: readonly MarkedSentence[],
  sentence: Pick<SelectedSentence, "element" | "from" | "to" | "text">,
): boolean {
  return marks.some(
    ({ element, from, to, check }) =>
      check.kept === true &&
      element === sentence.element &&
      from < sentence.to &&
      to > sentence.from &&
      comparableSentence(check.text) === comparableSentence(sentence.text),
  );
}

/**
 * Every check in the Mind with the whole sentences its marked text is in, as they read now, and
 * where its mark is (`MarkedSentence`).
 */
export function checkedSentences(
  blocks: Y.XmlFragment,
): (MarkedSentence & { sentence: string; cited: CitedQuote[] })[] {
  return markedSentences(blocks).map((marked) => {
    const { element, from, to } = marked;
    const text = textOf(element);
    const touched = sentenceSpans(text).filter((span) => span.from < to && span.to > from);
    const start = Math.min(from, touched[0]?.from ?? from);
    const end = Math.max(to, touched.at(-1)?.to ?? to);
    return { ...marked, sentence: text.slice(start, end), cited: citedIn(element, start, end) };
  });
}

/** Changes a check's result where its mark is now; false when its mark has gone (its sentence was deleted). */
export function updateCheck(
  blocks: Y.XmlFragment,
  id: string,
  change: (check: ClaimCheckAttributes) => ClaimCheckAttributes,
): boolean {
  const marked = markedSentences(blocks).find((each) => each.check.id === id);
  if (!marked) return false;
  for (const { node } of layout(marked.element)) {
    if (!(node instanceof Y.XmlText)) continue;
    let offset = 0;
    for (const run of node.toDelta() as Run[]) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      const check = readClaimCheck(run.attributes?.[CLAIM_CHECK_MARK]);
      if (check?.id === id)
        node.format(offset, length, { [CLAIM_CHECK_MARK]: { ...change(check) } });
      offset += length;
    }
  }
  return true;
}
