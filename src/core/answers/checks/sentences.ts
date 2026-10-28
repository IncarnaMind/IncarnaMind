/**
 * The User's sentences in a Mind's Yjs document, for their checks (#96):
 * which sentences a selection touches, and the `CLAIM_CHECK_MARK` that
 * holds each one's result on its text. Offsets are `TextPlace` offsets: an
 * inline node counts as one character.
 */
import * as Y from "yjs";
import { readCalculatedFigureEvidence } from "../../../shared/calculatedFigures";
import { chartCheckText, chartPoints, readChart } from "../../../shared/charts";
import { keptOn, readClaimCheck } from "../../../shared/claimChecks";
import { readProposalAttribute, readProposalRef } from "../../../shared/proposals";
import { INLINE_NODE, sentenceSpans } from "../../../shared/sentences";
import {
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  type CheckFigure,
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
import { figuresInMind } from "./figureOccurrences";

const BREAK = "hardBreak";

function writeCheck(
  element: Y.XmlElement<Record<string, string | ClaimCheckAttributes>>,
  check: ClaimCheckAttributes | null,
): void {
  if (check) element.setAttribute(CLAIM_CHECK_MARK, { ...check });
  else element.removeAttribute(CLAIM_CHECK_MARK);
}

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
  figures?: CheckFigure[];
}

export type SelectedSentences =
  | { ok: true; sentences: SelectedSentence[]; waiting: WaitingSentences }
  | { ok: false; reason: "nothing" };

/** A Block's text as checks read it. */
export function textOf(element: Y.XmlElement): string {
  if (element.nodeName === CHART_NODE) return chartCheckText(readChart(element.getAttributes()));
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

export function sentenceSpansIn(element: Y.XmlElement) {
  if (element.nodeName === CHART_NODE) return [{ from: 0, to: 1 }];
  return sentenceSpans(
    textOf(element),
    layout(element).flatMap(({ node, start }) =>
      node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE ? [start] : [],
    ),
  );
}

export function wordsOf(element: Y.XmlElement, from = 0, to = textOf(element).length): string {
  if (element.nodeName === CHART_NODE) return textOf(element);
  let words = textOf(element).slice(from, to);
  for (const { node, start } of layout(element).reverse()) {
    if (
      !(node instanceof Y.XmlElement) ||
      node.nodeName !== CALCULATED_FIGURE_NODE ||
      start < from ||
      start >= to
    )
      continue;
    const figure = readCalculatedFigureEvidence(node.getAttributes());
    if (figure)
      words = words.slice(0, start - from) + figure.figure.shown + words.slice(start - from + 1);
  }
  return words;
}

export function checkText(sentence: SelectedSentence) {
  return {
    claim: wordsOf(sentence.element, sentence.from, sentence.to),
    // A table cell's words alone don't say what its figure is; its row and column headings do.
    context:
      (sentence.figures?.[0]?.label !== undefined ? sentence.figures[0]?.context : undefined) ??
      wordsOf(sentence.element),
    ...(sentence.figures?.length && { figures: sentence.figures }),
  };
}

/** The figures a check reads in each of the Mind's Blocks, by Block id. */
export function figuresByBlock(blocks: Y.XmlFragment): ReadonlyMap<string, CheckFigure[]> {
  const index = new Map<string, CheckFigure[]>();
  for (const figure of figuresInMind(blocks)) {
    const id =
      figure.locator.kind === "text" ? figure.locator.from.blockId : figure.locator.blockId;
    const values = index.get(id) ?? [];
    values.push(figure);
    index.set(id, values);
  }
  return index;
}

/**
 * What a Mind's stored checks are compared with of its figures now: each figure's context, and
 * whether a marked table cell holds any (`ClaimCheckNow.figured`).
 */
/** A paragraph that is a table's cell: a whole-sentence check of it read it without its row and column. */
export const inTableCell = (element: Y.XmlElement): boolean =>
  element.nodeName === "paragraph" &&
  element.parent instanceof Y.XmlElement &&
  (element.parent.nodeName === "tableCell" || element.parent.nodeName === "tableHeader");

export function figuresNow(blocks: Y.XmlFragment): {
  figureContexts: Map<string, string>;
  figured(marked: { element: Y.XmlElement; from: number; to: number }): boolean;
} {
  const found = figuresInMind(blocks);
  const byBlock = new Map<string, CheckFigure[]>();
  for (const figure of found) {
    if (figure.locator.kind !== "text") continue;
    const id = figure.locator.from.blockId;
    byBlock.set(id, [...(byBlock.get(id) ?? []), figure]);
  }
  return {
    figureContexts: new Map(found.map((figure) => [figure.id, figure.context])),
    figured: ({ element, from, to }) => {
      const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
      return (
        inTableCell(element) &&
        typeof blockId === "string" &&
        inSpan(byBlock.get(blockId) ?? [], from, to).length > 0
      );
    },
  };
}

/** A paragraph's sentence as its check reads it: its words, its paragraph, its Citations and its figures. */
export function sentenceOf(
  element: Y.XmlElement,
  blockId: string,
  span: { from: number; to: number },
  figures: ReadonlyMap<string, CheckFigure[]>,
): SelectedSentence {
  const text = textOf(element);
  return {
    element,
    blockId,
    from: span.from,
    to: span.to,
    text: text.slice(span.from, span.to),
    context: text,
    cited: citedIn(element, span.from, span.to),
    figures: inSpan(figures.get(blockId) ?? [], span.from, span.to),
  };
}

const inSpan = (figures: readonly CheckFigure[], from: number, to: number) =>
  figures.filter(
    (figure) =>
      figure.locator.kind === "chart" ||
      (figure.locator.from.offset >= from && figure.locator.to.offset <= to),
  );

function chartSentence(
  element: Y.XmlElement,
  figures: readonly CheckFigure[],
): SelectedSentence | null {
  const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  if (typeof blockId !== "string" || chartPoints(readChart(element.getAttributes())).length === 0)
    return null;
  const text = textOf(element);
  return {
    element,
    blockId,
    from: 0,
    to: 1,
    text,
    context: text,
    cited: [],
    figures: [...figures],
  };
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

/** What a Citation, by its attributes, quotes; null for one with no quote. */
export function citedQuoteOf(attributes: Readonly<Record<string, unknown>>): CitedQuote | null {
  const { documentId, documentName, contentHash, passageId, quote } = attributes;
  if (typeof quote !== "string" || quote === "") return null;
  return {
    documentName: typeof documentName === "string" ? documentName : "",
    quote,
    ...(typeof documentId === "string" && { documentId }),
    ...(typeof contentHash === "string" && { contentHash }),
    ...(typeof passageId === "string" && { passageId }),
  };
}

/** What the Citations in `from`..`to` of a Block quote. */
function citedIn(element: Y.XmlElement, from: number, to: number): CitedQuote[] {
  return layout(element).flatMap(({ node, start }) => {
    if (start < from || start >= to || !(node instanceof Y.XmlElement)) return [];
    if (node.nodeName !== CITATION_NODE) return [];
    return citedQuoteOf(node.getAttributes()) ?? [];
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
  const all = textBlocks(blocks, { charts: true });
  const figures = figuresByBlock(blocks);
  const idOf = (element: Y.XmlElement) => element.getAttribute(BLOCK_ID_ATTRIBUTE);
  const sentences: SelectedSentence[] = [];
  const waiting: WaitingSentences = { sentences: [], changeIds: [] };
  const seen = new Set<string>();
  for (const { from, to } of stretches) {
    const first = all.findIndex(({ element }) => idOf(element) === from.blockId);
    const last = all.findIndex(({ element }) => idOf(element) === to.blockId);
    if (first < 0 || last < first) continue;
    for (const [index, { element, busy }] of all.slice(first, last + 1).entries()) {
      if (busy || (element.nodeName !== "paragraph" && element.nodeName !== CHART_NODE)) continue;
      const blockId = idOf(element);
      if (typeof blockId !== "string") continue;
      if (element.nodeName === CHART_NODE) {
        const sentence = chartSentence(element, figures.get(blockId) ?? []);
        if (!sentence || seen.has(blockId)) continue;
        seen.add(blockId);
        const changes = changesIn(element, 0, 1);
        if (changes.length > 0) {
          waiting.sentences.push({ from: { blockId, offset: 0 }, to: { blockId, offset: 1 } });
          waiting.changeIds.push(...changes.filter((id) => !waiting.changeIds.includes(id)));
        } else sentences.push(sentence);
        continue;
      }
      const text = textOf(element);
      const start = index === 0 ? from.offset : 0;
      const end = index === last - first ? to.offset : text.length;
      for (const span of sentenceSpansIn(element)) {
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
        sentences.push(sentenceOf(element, blockId, span, figures));
      }
    }
  }
  return sentences.length + waiting.sentences.length > 0
    ? { ok: true, sentences, waiting }
    : { ok: false, reason: "nothing" };
}

/** Every sentence of the Mind's paragraphs, in order, but those holding a change still waiting. */
export function everySentence(blocks: Y.XmlFragment): SelectedSentence[] {
  const figures = figuresByBlock(blocks);
  return textBlocks(blocks, { charts: true }).flatMap(({ element, busy }) => {
    const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (busy || typeof blockId !== "string") return [];
    if (element.nodeName === CHART_NODE) {
      const sentence = chartSentence(element, figures.get(blockId) ?? []);
      return sentence && changesIn(element, 0, 1).length === 0 ? [sentence] : [];
    }
    if (element.nodeName !== "paragraph") return [];
    return sentenceSpansIn(element).flatMap((span) =>
      changesIn(element, span.from, span.to).length > 0
        ? []
        : [sentenceOf(element, blockId, span, figures)],
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
  if (element.nodeName === CHART_NODE) {
    if (from < 1 && to > 0) writeCheck(element, check);
    return;
  }
  const parts = layout(element).filter(({ start, size }) => start < to && start + size > from);
  const hasText = parts.some(({ node }) => node instanceof Y.XmlText);
  let owned = false;
  for (const { node } of parts) {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== CALCULATED_FIGURE_NODE) continue;
    writeCheck(node, !hasText && !owned ? check : null);
    owned = true;
  }
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
  if (element.nodeName === CHART_NODE) {
    const check = readClaimCheck(element.getAttribute(CLAIM_CHECK_MARK));
    if (check?.action !== action || from >= 1 || to <= 0) return false;
    writeCheck(element, null);
    return true;
  }
  let removed = false;
  for (const { node, start } of layout(element)) {
    if (node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE) {
      const check = readClaimCheck(node.getAttribute(CLAIM_CHECK_MARK));
      if (check?.action === action && start < to && start + 1 > from) {
        writeCheck(node, null);
        removed = true;
      }
    }
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
  for (const { element } of textBlocks(blocks, { charts: true })) {
    if (element.nodeName === CHART_NODE) {
      const check = readClaimCheck(element.getAttribute(CLAIM_CHECK_MARK));
      if (check && !found.has(check.id)) found.set(check.id, { element, from: 0, to: 1, check });
      continue;
    }
    for (const { node, start } of layout(element)) {
      if (node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE) {
        const check = readClaimCheck(node.getAttribute(CLAIM_CHECK_MARK));
        if (check && !found.has(check.id))
          found.set(check.id, { element, from: start, to: start + 1, check });
      }
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

/** Whether the User keeps a sentence as their own view (#1111, #1909): a kept mark at its place, with its words as they were. */
export function keptAsView(
  marks: readonly MarkedSentence[],
  sentence: Pick<SelectedSentence, "element" | "from" | "to" | "text">,
): boolean {
  return keptOn(
    marks
      .filter((mark) => mark.check.kept === true && mark.element === sentence.element)
      .map((mark) => ({ from: mark.from, to: mark.to, text: mark.check.text })),
    sentence,
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
    if (element.nodeName === CHART_NODE) return { ...marked, sentence: text, cited: [] };
    const touched = sentenceSpansIn(element).filter((span) => span.from < to && span.to > from);
    const start = Math.min(from, touched[0]?.from ?? from);
    const end = Math.max(to, touched.at(-1)?.to ?? to);
    return { ...marked, sentence: text.slice(start, end), cited: citedIn(element, start, end) };
  });
}

/**
 * Each Citation's sentence as checks read it, by the Citation's id: what a person's own check of
 * it rests on (#1933), as the editor reads it.
 */
export function citationSentences(blocks: Y.XmlFragment): Map<string, string> {
  const found = new Map<string, string>();
  for (const { element } of textBlocks(blocks)) {
    const citations = layout(element).filter(
      ({ node }) => node instanceof Y.XmlElement && node.nodeName === CITATION_NODE,
    );
    if (citations.length === 0) continue;
    const text = textOf(element);
    const spans = sentenceSpansIn(element);
    for (const { node, start } of citations) {
      const id = node instanceof Y.XmlElement ? node.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
      const span = spans.find((each) => each.from <= start && start < each.to);
      if (typeof id === "string" && span) found.set(id, text.slice(span.from, span.to));
    }
  }
  return found;
}

/** The requests the checks on a Mind's blocks were made with, each once: what each kept unread (#740). */
export function checkRequests(blocks: Y.XmlFragment): string[] {
  return [
    ...new Set(
      checkedSentences(blocks)
        .map(({ check }) => check.request)
        .filter((request) => request !== ""),
    ),
  ];
}

/** Changes a check's result where its mark is now; false when its mark has gone (its sentence was deleted). */
export function updateCheck(
  blocks: Y.XmlFragment,
  id: string,
  change: (check: ClaimCheckAttributes) => ClaimCheckAttributes,
): boolean {
  const marked = markedSentences(blocks).find((each) => each.check.id === id);
  if (!marked) return false;
  if (marked.element.nodeName === CHART_NODE) {
    writeCheck(marked.element, change(marked.check));
    return true;
  }
  for (const { node } of layout(marked.element)) {
    if (node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE) {
      const check = readClaimCheck(node.getAttribute(CLAIM_CHECK_MARK));
      if (check?.id === id) writeCheck(node, change(check));
    }
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
