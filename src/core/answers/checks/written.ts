/**
 * What the assistant writes into a Mind, checked before it lands (#1111).
 *
 * The sentences it wrote with Citations, the first `SENTENCES_CHECKED_AT_MOST`
 * of them, are checked as Check this Mind would check them (./claimCheck: the
 * Mind's Folder, the Citations' quotes sent), a few at a time, each within a
 * time limit. The claims it wrote with no Citation are left to the one count
 * and Check the rest (#1909). The words are still the assistant's changes
 * then, not the Mind's.
 *
 * - A part its Citations don't support, as the check names it, is taken out
 *   with Edit with AI's own request (`cut-unsupported`); the Citations stay on
 *   what is left, each word keeps its own formatting, and the sentence shows
 *   it needs a check again, as after the card's cut. A cut that would lose
 *   every Citation, add one or leave no claim isn't used, nor one that does
 *   more than take words out (#1397), nor one its Citations don't support once
 *   cut: the sentence then lands as written, marked.
 * - A sentence the check covered, supported included, lands with its check's
 *   mark, so Check this Mind doesn't find it again later and the count that
 *   must close after a write counts it once (#1909).
 * - One that couldn't be checked (a failure, a limit, the time limit, or past
 *   the first `SENTENCES_CHECKED_AT_MOST`) lands marked not checked, with why.
 *
 * Only the sentences cut or marked are written, and only while each reads as
 * it was written: one the User changed meanwhile keeps their words, marked to
 * be checked again.
 *
 * Before its check, a sentence with one Citation may be found Supported by a plain
 * yes from the provider's quick-tasks model, the same service (./fastPaths,
 * #1667). Anything else goes on to its check.
 *
 * One check per sentence, and one edit per sentence it cuts, on the Answer's
 * model prepared for the checks flow: each request checks that flow's consent
 * as it is sent, so turning it off stops the rest at once (#1206), as the cost
 * cap and a plan's limit do. Nothing is checked when the flow is off as it
 * starts, or on a model on this computer too small to judge reliably (#680).
 * Allowed before checks sent more, the flow isn't asked about here: each
 * sentence lands not checked, waiting for the User to allow the more (#2525).
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { citationAttributesOf } from "../../../shared/citations";
import { SENTENCES_CHECKED_AT_MOST } from "../../../shared/claimChecks";
import { planOf } from "../../../shared/claimParts";
import { beginFigureCheck } from "../../../shared/figureChecks";
import { readTableBinding } from "../../../shared/figureRuns";
import {
  type InlineTextProjection,
  inlineLayout,
  inlineSpan,
  projectedContent,
  sliceInlineText,
} from "../../../shared/inlineText";
import { INLINE_NODE, isClaim, onlyNamesItsTable, sentenceSpans } from "../../../shared/sentences";
import { judgesUnreliably } from "../../../shared/smallModel";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitationAttributes,
  type CitedQuote,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckFailure,
  type ClaimCheckResult,
  type ClaimPartPlan,
  type EditAction,
  type RecordAiUseInput,
  type RunStop,
} from "../../api";
import { MindReadOnlyError } from "../../errors";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { asCheckWork } from "../../reranking/order";
import { type ItemOutcome, RunItemError, runItems, type Slots, slots } from "../../runs/stop";
import { inStep } from "../../timing/flows";
import { type MarkJSON, type NodeJSON, syncContent, topLevelBlocks } from "../blocks";
import {
  type CheckedCitation,
  type ClaimCheckRequest,
  recordJudged,
  runFailureOf,
} from "./claimCheck";
import { type FirstLook, type FirstLookResult, quickLook } from "./fastPaths";
import { recordOpinions } from "./opinions";
import { claimsAtOnce } from "./runChecks";
import { checkText, citedQuoteOf, figuresByBlock, markSentence, sentenceOf } from "./sentences";
import type { CheckScope } from "./verify";

const UNCHECKED: ReadonlySet<string> = new Set(["question", "codeBlock", "blockMath", "heading"]);

export interface WrittenCheckOptions {
  /**
   * The Answer's model prepared for the checks flow, whose consent each request then checks
   * as it is sent (ADR-0022); null when that flow may not send to it now. Never asks.
   */
  prepare(answer: PreparedChatModel): Promise<PreparedChatModel | null>;
  /** Whether the User allowed the checks flow to the Answer's model before it sent more, and not the more yet. */
  widened(answer: PreparedChatModel): boolean;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  /** Where the Mind's sentences are checked, as Check this Mind checks them. */
  scopeOf(mindId: string): { searchable: number; check: CheckScope };
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): CheckedCitation[];
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
    sourceText?: string,
  ): ClaimCheckAttributes;
  /** Reads the Mind's content, where what the assistant wrote already is. */
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  retainEvidence(mindId: string): void;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  /** Edit with AI's new text for a passage not in a Mind (../../edits, `editText`). */
  editText(
    prepared: PreparedChatModel,
    ask: { action: EditAction; instruction: string },
    passage: { text: string; context: string; quotes: readonly string[] },
    signal: AbortSignal,
  ): Promise<string | null>;
  /** The quick model that looks first at a write's sentences under the checks' model (./fastPaths); null: none. */
  quickModel(prepared: PreparedChatModel): Promise<PreparedChatModel | null>;
  firstLook(look: FirstLook): Promise<FirstLookResult>;
  /** How long one check may take, as contradiction watch gives one claim: a reply may never come. */
  claimTimeLimitMs: number;
  now(): Date;
}

export interface CheckWrittenInput {
  mindId: string;
  /** The Blocks as the assistant wrote them. */
  blocks: readonly NodeJSON[];
  /** The ids of the top-level Blocks they were written as, in their order. */
  ids: readonly string[];
  prepared: PreparedChatModel;
  signal: AbortSignal;
  /**
   * The Answer failed before its text could be checked: each cited sentence lands not checked,
   * and nothing is sent to the provider that just failed.
   */
  answerFailed?: boolean;
  /** How many sentences are being checked, as the check starts. */
  checking(count: number): void;
  /** Changes the Mind's content, in one transaction. */
  edit(change: (blocks: Y.XmlFragment) => void): void;
}

/**
 * What the check did: of the claims the write holds (`checkable`), how many
 * have a Citation and were checked (`cited`), how many it sent, how many got a
 * verdict and how many couldn't be checked, and what stopped it; each part it
 * cut, as it named it; how many land marked. Its marks share `request`.
 * `blocked`: the sentences the User's own choice kept from being sent, among
 * those that couldn't be checked.
 */
export interface WrittenCheck {
  request: string;
  /** The write's top-level Blocks, so Check the rest checks this write's sentences alone (#1909). */
  blocks: string[];
  checkable: number;
  cited: number;
  sent: number;
  checked: number;
  failed: number;
  stop: RunStop | null;
  blocked: { reason: "consent-revoked" | "local-mode" | "consent-widened"; count: number } | null;
  cut: string[];
  unsupported: number;
  contradicted: number;
}

interface Sentence {
  /** An index into each level's content, from the top-level Block down to its paragraph. */
  path: number[];
  from: number;
  to: number;
  text: string;
  context: string;
  rawText: string;
  rawContext: string;
  projection: InlineTextProjection;
  cited: CitedQuote[];
  /** Its Citations as they are written, for the quick model's first look (./fastPaths). */
  citations: Partial<CitationAttributes>[];
  /** Where it is in what was written, for whether the quick model may look first (./fastPaths). */
  place: FirstLook["place"];
  /** In a table's cell, whose words are a figure, not a clause a cut could take out. */
  inCell: boolean;
}

function paragraphText(content: readonly NodeJSON[]): string {
  return content
    .map((node) =>
      node.type === "text" ? (node.text ?? "") : node.type === "hardBreak" ? "\n" : INLINE_NODE,
    )
    .join("");
}

/** An Analysis's own table: its cells are its run's, never claims a check reads (#2378). */
const boundTable = (node: NodeJSON) =>
  node.type === "table" && readTableBinding(node.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]) !== null;

/** The sentences a check reads that the write holds (#1909): every sentence with a Citation, and every claim with none. */
export function checkableSentences(blocks: readonly NodeJSON[]): Sentence[] {
  const found: Sentence[] = [];
  // Before the write's first Block: the Note's start, when the write begins the Note.
  let after: FirstLook["place"]["after"] = { kind: "start" };
  const visit = (
    nodes: readonly NodeJSON[],
    path: number[],
    inCell: boolean,
    inHeader: boolean,
  ) => {
    nodes.forEach((node, index) => {
      if (node.type === "heading") {
        after = { kind: "heading", text: projectedContent(node.content ?? []).projection.text };
        return;
      }
      if (UNCHECKED.has(node.type) || boundTable(node)) {
        after = { kind: "paragraph" };
        return;
      }
      const here = [...path, index];
      const content = node.content ?? [];
      if (node.type !== "paragraph") {
        visit(
          content,
          here,
          inCell || node.type === "tableCell" || node.type === "tableHeader",
          inHeader || node.type === "tableHeader",
        );
        // A chart, a picture or a rule between them is something a sentence may lean on too.
        if (content.length === 0) after = { kind: "paragraph" };
        return;
      }
      // A header cell names its column or row, and a caption its table: they state nothing a check
      // could support (#2378).
      if (
        inHeader ||
        (content.some((inline) => inline.type === ANALYSIS_TABLE_NODE) &&
          onlyNamesItsTable(paragraphText(content)))
      ) {
        after = { kind: "paragraph" };
        return;
      }
      const rawContext = paragraphText(content);
      const layout = inlineLayout(content);
      const { pieces, projection: whole } = projectedContent(content);
      const spans = sentenceSpans(rawContext);
      for (const span of spans) {
        let from = span.from;
        let to = span.to;
        while (pieces.some((piece) => piece.kind === "citation" && piece.from === from)) from++;
        while (pieces.some((piece) => piece.kind === "citation" && piece.to === to)) to--;
        const mapped = inlineSpan(whole, from, to);
        const projection = mapped && sliceInlineText(whole, mapped.start, mapped.end);
        if (!projection) continue;
        const text = projection.text;
        const inSpan = layout.filter(
          ({ node: inline, start }) =>
            inline.type === CITATION_NODE && start >= span.from && start < span.to,
        );
        const cited = inSpan.flatMap(({ node: inline }) => citedQuoteOf(inline.attrs ?? {}) ?? []);
        const citations = inSpan.map(({ node: inline }) =>
          citationAttributesOf(inline.attrs ?? {}),
        );
        if (cited.length === 0 && !isClaim(text)) continue;
        // A sentence the Answer's own judgement settled came with its mark: it isn't checked again.
        const carried = layout.some(
          ({ node: inline, start }) =>
            inline.type === "text" &&
            start >= span.from &&
            start < span.to &&
            (inline.marks ?? []).some((mark) => mark.type === CLAIM_CHECK_MARK),
        );
        if (carried) continue;
        found.push({
          path: here,
          from: span.from,
          to: span.to,
          text,
          context: whole.text,
          rawText: rawContext.slice(span.from, span.to),
          rawContext,
          projection,
          cited,
          citations,
          place: { opens: span === spans[0], after },
          inCell,
        });
      }
      after = { kind: "paragraph" };
    });
  };
  visit(blocks, [], false, false);
  return found;
}

const MARKER = /\[(\d{1,3})\]/g;

/** Null when the sentence holds an inline node a marker can't stand for (a formula, a footnote), which a cut would lose. */
function asMarked(
  content: readonly NodeJSON[],
  from: number,
  to: number,
): { passage: string; context: string; citations: Map<number, NodeJSON> } | null {
  const citations = new Map<number, NodeJSON>();
  let context = "";
  let passage = "";
  for (const { node, start } of inlineLayout(content)) {
    let piece: string;
    if (node.type === "text") piece = node.text ?? "";
    else if (node.type === "hardBreak") piece = "\n";
    else if (node.type === CITATION_NODE) {
      citations.set(citations.size + 1, node);
      piece = `[${citations.size}]`;
    } else if (start >= from && start < to) return null;
    else piece = "";
    context += piece;
    if (node.type === "text") {
      const text = node.text ?? "";
      passage += text.slice(Math.max(0, from - start), Math.max(0, to - start));
    } else if (start >= from && start < to) passage += piece;
  }
  return { passage: passage.trim(), context, citations };
}

const sameMarks = (a: readonly MarkJSON[], b: readonly MarkJSON[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Each character of the sentence's words, with its own marks, but a check's. */
function lettersOf(
  content: readonly NodeJSON[],
  from: number,
  to: number,
): { text: string; marks: MarkJSON[][] } {
  let text = "";
  const marks: MarkJSON[][] = [];
  for (const { node, start } of inlineLayout(content)) {
    if (node.type !== "text") continue;
    const own = (node.marks ?? []).filter((mark) => mark.type !== CLAIM_CHECK_MARK);
    const words = (node.text ?? "").slice(Math.max(0, from - start), Math.max(0, to - start));
    text += words;
    for (let index = 0; index < words.length; index++) marks.push(own);
  }
  return { text, marks };
}

// One Chinese, Japanese or Korean character, a run of letters or digits, or one mark.
const WORD = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+|[^\s]`;

const TOKEN = new RegExp(`${WORD}|\\s+`, "gu");

/**
 * The cut's words as text nodes, each word with the marks it had in the
 * sentence; a word the sentence didn't have takes the marks all its words share.
 */
function wordsWithMarks(words: string, letters: ReturnType<typeof lettersOf>): NodeJSON[] {
  const [first, ...rest] = letters.marks;
  const shared = (first ?? []).filter((mark) =>
    rest.every((marks) => marks.some((each) => sameMarks([each], [mark]))),
  );
  const nodes: NodeJSON[] = [];
  let cursor = 0;
  for (const match of words.matchAll(TOKEN)) {
    const token = match[0];
    const at = letters.text.indexOf(token, cursor);
    const marks = at < 0 ? shared : (letters.marks[at] ?? shared);
    if (at >= 0) cursor = at + token.length;
    const last = nodes.at(-1);
    if (last && sameMarks(last.marks ?? [], marks)) last.text = `${last.text ?? ""}${token}`;
    else nodes.push({ type: "text", text: token, ...(marks.length > 0 && { marks }) });
  }
  return nodes;
}

const PIECE = new RegExp(`\\[\\d{1,3}\\]|${WORD}`, "gu");

const CITATION_PIECE = /^\[\d{1,3}\]$/;

const STOP = /^[.!?。！？]$/u;

const TRAILING_MARK = /^[,;:，；：、]$/u;

const capitalised = (word: string) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`;

/**
 * Whether each Citation still follows some of the words it was written after,
 * those since the Citation before it, so none comes to back another part's
 * words: a Citation goes only when all its words go too. Citations side by
 * side share the words before them.
 */
function citationsKeepTheirWords(pieces: readonly string[], kept: ReadonlySet<number>): boolean {
  let ownKept = false;
  let afterCitation = false;
  for (const [at, piece] of pieces.entries()) {
    if (CITATION_PIECE.test(piece)) {
      if (kept.has(at) !== ownKept) return false;
      afterCitation = true;
      continue;
    }
    if (afterCitation) {
      ownKept = false;
      afterCitation = false;
    }
    if (kept.has(at) && /[\p{L}\p{N}]/u.test(piece)) ownKept = true;
  }
  return true;
}

/** The sentence's own full stop, looking back past any Citations written after it, or -1. */
function stopOf(pieces: readonly RegExpExecArray[]): number {
  let at = pieces.length - 1;
  while (at >= 0 && CITATION_PIECE.test(pieces[at]?.[0] ?? "")) at--;
  return at >= 0 && STOP.test(pieces[at]?.[0] ?? "") ? at : -1;
}

/**
 * The passage with only what the cut left out taken out (#1397): each word,
 * mark and marker it keeps, and the spaces between them, as the passage has
 * them; where words went, a space if the cut has one there; and its own full
 * stop, in its place. Null when the cut rewords, reorders or adds anything,
 * keeps a Citation but none of its words, or takes nothing out.
 */
function takenOut(passage: string, cut: string): string | null {
  const pieces = [...passage.matchAll(PIECE)];
  const keptAt = new Set<number>();
  const spaced = new Set<number>();
  let last = -1;
  let cutAt = 0;
  for (const wanted of cut.matchAll(PIECE)) {
    const [text] = wanted;
    // With the first words gone, the sentence may start with the next one's capital.
    const fits = (piece: string) => piece === text || (last < 0 && capitalised(piece) === text);
    let at = last + 1;
    while (at < pieces.length && !fits(pieces[at]?.[0] ?? "")) at++;
    const piece = pieces[at];
    if (!piece) return null;
    if (last >= 0 && at > last + 1 && /\s/u.test(cut.slice(cutAt, wanted.index))) spaced.add(at);
    last = at;
    keptAt.add(at);
    cutAt = wanted.index + text.length;
  }
  if (keptAt.size === 0) return null;
  const stop = stopOf(pieces);
  if (stop >= 0 && !keptAt.has(stop)) {
    keptAt.add(stop);
    const before = [...keptAt].filter((at) => at < stop).sort((a, b) => b - a)[0];
    // The stop takes the place of a comma or colon the cut kept before it.
    if (before !== undefined && TRAILING_MARK.test(pieces[before]?.[0] ?? ""))
      keptAt.delete(before);
  }
  if (keptAt.size === pieces.length) return null;
  if (
    !citationsKeepTheirWords(
      pieces.map(([piece]) => piece),
      keptAt,
    )
  )
    return null;
  let kept = "";
  let previous = -1;
  for (const at of [...keptAt].sort((a, b) => a - b)) {
    const piece = pieces[at];
    if (!piece) return null;
    const after = pieces[previous];
    if (after) {
      kept +=
        at === previous + 1
          ? passage.slice(after.index + after[0].length, piece.index)
          : spaced.has(at)
            ? " "
            : "";
    }
    // A sentence whose first words went starts with the next word's capital.
    kept += previous < 0 && at > 0 ? capitalised(piece[0]) : piece[0];
    previous = at;
  }
  return kept;
}

/** Null when the cut keeps no Citation, adds or repeats one, or leaves no claim of its own (a label, as in "Crime:"). */
function cutNodes(
  cut: string,
  sentence: readonly number[],
  citations: ReadonlyMap<number, NodeJSON>,
  letters: ReturnType<typeof lettersOf>,
): NodeJSON[] | null {
  const used = new Set<number>();
  const nodes: NodeJSON[] = [];
  let last = 0;
  for (const match of cut.matchAll(MARKER)) {
    const number = Number(match[1]);
    const citation = citations.get(number);
    if (!citation || !sentence.includes(number) || used.has(number)) return null;
    used.add(number);
    const at = match.index ?? 0;
    nodes.push(...wordsWithMarks(cut.slice(last, at), letters), citation);
    last = at + match[0].length;
  }
  nodes.push(...wordsWithMarks(cut.slice(last), letters));
  return used.size === 0 || !isClaim(cut.replace(MARKER, "")) ? null : nodes;
}

/** A sentence's check: `by`, the model whose verdict it is, the quick model's or the checks' own. */
interface Checked {
  result: ClaimCheckResult;
  uncovered: string | null;
  nodes: NodeJSON[] | null;
  by: PreparedChatModel;
  /** The quick model that read the sentence first and passed it on to its check. */
  passedOn: PreparedChatModel | null;
}

/**
 * The first look gets a tenth of a sentence's time, and its check all of it after: a small
 * model's one-word reply takes about a second, so one that takes longer has more likely hung.
 */
const FIRST_LOOK_SHARE = 0.1;

type Landing =
  | {
      sentence: Sentence;
      /** The cut, in place of the sentence's own words; null: they stay. */
      nodes: NodeJSON[] | null;
      /** Its mark, made where it lands: a figure's result is footed against the table it is in. */
      mark(blocks: Y.XmlFragment): ClaimCheckAttributes;
    }
  /** A sentence with no fact: no mark, and its opinion is left out as Check this Note leaves it. */
  | { sentence: Sentence; opinion: readonly ClaimPartPlan[] };

const withMark = (nodes: readonly NodeJSON[], mark: ClaimCheckAttributes): NodeJSON[] =>
  nodes.map((node) =>
    node.type === "text"
      ? {
          ...node,
          marks: [
            ...(node.marks ?? []).filter((each) => each.type !== CLAIM_CHECK_MARK),
            { type: CLAIM_CHECK_MARK, attrs: { ...mark } },
          ],
        }
      : node,
  );

/** A paragraph's content with the sentence `from`..`to` in it put as `nodes`. */
function replaced(
  content: readonly NodeJSON[],
  from: number,
  to: number,
  nodes: readonly NodeJSON[],
): NodeJSON[] {
  const out: NodeJSON[] = [];
  let placed = false;
  const place = () => {
    if (placed) return;
    placed = true;
    out.push(...nodes);
  };
  for (const { node, start } of inlineLayout(content)) {
    if (node.type !== "text") {
      if (start >= from && start < to) place();
      else out.push(node);
      continue;
    }
    const text = node.text ?? "";
    const before = text.slice(0, Math.max(0, from - start));
    const after = text.slice(Math.max(0, to - start));
    if (before) out.push({ ...node, text: before });
    if (start + text.length > from && start < to) place();
    if (after && start + text.length > to) out.push({ ...node, text: after });
  }
  place();
  return out;
}

/** A paragraph's inline content as it is in the Mind now. */
function inlineOf(parent: Y.XmlElement): NodeJSON[] {
  return parent.toArray().flatMap((child): NodeJSON[] => {
    if (child instanceof Y.XmlText) {
      const runs = child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
      return runs.flatMap((run) => {
        if (typeof run.insert !== "string") return [];
        const marks = Object.entries(run.attributes ?? {}).map(([type, attrs]) => ({
          type,
          attrs: (attrs ?? {}) as Record<string, unknown>,
        }));
        return [{ type: "text", text: run.insert, ...(marks.length > 0 && { marks }) }];
      });
    }
    if (!(child instanceof Y.XmlElement)) return [];
    return [
      {
        type: child.nodeName,
        attrs: child.getAttributes() as Record<string, unknown>,
        ...(child.length > 0 && { content: inlineOf(child) }),
      },
    ];
  });
}

/** The paragraph a written sentence is in, as the Mind holds it now; undefined once it's gone. */
function paragraphIn(
  blocks: Y.XmlFragment,
  ids: readonly string[],
  path: readonly number[],
): Y.XmlElement | undefined {
  const [top, ...inner] = path;
  let element = topLevelBlocks(blocks).find(
    (each) => top !== undefined && each.getAttribute(BLOCK_ID_ATTRIBUTE) === ids[top],
  );
  for (const index of inner) {
    const children = element?.toArray().filter((each) => each instanceof Y.XmlElement) ?? [];
    element = children[index];
  }
  return element?.nodeName === "paragraph" ? element : undefined;
}

// The same words nearest where they were written, else, once the User has changed them, the
// sentence in the same place.
function placeOf(
  element: Y.XmlElement,
  sentence: Sentence,
): { from: number; to: number; same: boolean } | null {
  const text = paragraphText(inlineOf(element));
  const spans = sentenceSpans(text);
  const same = spans
    .filter((span) => text.slice(span.from, span.to) === sentence.rawText)
    .sort((a, b) => Math.abs(a.from - sentence.from) - Math.abs(b.from - sentence.from))[0];
  if (same) return { ...same, same: true };
  const written = sentenceSpans(sentence.rawContext);
  const index = written.findIndex((span) => span.from === sentence.from);
  const now = spans.length === written.length ? spans[index] : undefined;
  return now ? { ...now, same: false } : null;
}

/**
 * Lands one sentence in the Mind: cut or marked while it reads as it was
 * written; once the User has changed it, only marked, so its words stay and
 * its check shows it needs doing again.
 */
function land(blocks: Y.XmlFragment, ids: readonly string[], landing: Landing): void {
  const { sentence } = landing;
  const element = paragraphIn(blocks, ids, sentence.path);
  const place = element ? placeOf(element, sentence) : null;
  if (!element || !place) return;
  if ("opinion" in landing) {
    const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (!place.same || typeof blockId !== "string" || landing.opinion.length === 0) return;
    const now = sentenceOf(element, blockId, place, figuresByBlock(blocks));
    recordOpinions(blocks, [{ ...now, parts: landing.opinion }]);
    return;
  }
  const mark = landing.mark(blocks);
  if (place.same && landing.nodes) {
    syncContent(
      element,
      replaced(inlineOf(element), place.from, place.to, withMark(landing.nodes, mark)),
    );
    return;
  }
  markSentence(element, place.from, place.to, mark);
}

// Read as Check this Mind reads it, a table cell with its headings and each figure with its own
// place, so a written sentence's results are the ones Check this Mind gives (#1459).
function readAsChecked(
  blocks: Y.XmlFragment,
  ids: readonly string[],
  sentence: Sentence,
  figures: ReturnType<typeof figuresByBlock>,
): ReturnType<typeof checkText> {
  const element = paragraphIn(blocks, ids, sentence.path);
  const blockId = element?.getAttribute(BLOCK_ID_ATTRIBUTE);
  const place = element ? placeOf(element, sentence) : null;
  if (!element || typeof blockId !== "string" || !place?.same)
    return { claim: sentence.text, context: sentence.context, projection: sentence.projection };
  return checkText(sentenceOf(element, blockId, place, figures));
}

/** Where the sentence is in the Note, for what its record cites' `Id.` and `supra` refer to. */
function notePlace(
  blocks: Y.XmlFragment,
  ids: readonly string[],
  sentence: Sentence,
): RecordCitePlace | undefined {
  const element = paragraphIn(blocks, ids, sentence.path);
  const blockId = element?.getAttribute(BLOCK_ID_ATTRIBUTE);
  const place = element ? placeOf(element, sentence) : null;
  return typeof blockId === "string" && place?.same ? { blockId, from: place.from } : undefined;
}

const notChecked = (
  mark: ClaimCheckAttributes,
  reason: ClaimCheckFailure,
  detail: string | null,
  at: string,
): ClaimCheckAttributes => ({ ...mark, state: "not-checked", reason, detail, checkedAt: at });

export function createWrittenCheck(options: WrittenCheckOptions) {
  async function cutOf(
    blocks: readonly NodeJSON[],
    mindId: string,
    sentence: Sentence,
    uncovered: string,
    prepared: PreparedChatModel,
    scope: CheckScope,
    limit: Slots,
    signal: AbortSignal,
  ): Promise<NodeJSON[] | null> {
    const content = paragraphAt(blocks, sentence.path)?.content ?? [];
    const marked = asMarked(content, sentence.from, sentence.to);
    if (!marked) return null;
    const numbers = [...marked.passage.matchAll(MARKER)].map((match) => Number(match[1]));
    const cut = await options.editText(
      prepared,
      { action: "cut-unsupported", instruction: uncovered },
      {
        text: marked.passage,
        context: marked.context,
        quotes: [...marked.citations.values()].map(
          (node) => citedQuoteOf(node.attrs ?? {})?.quote ?? "",
        ),
      },
      signal,
    );
    const kept = cut === null ? null : takenOut(marked.passage, cut);
    if (kept === null) return null;
    const letters = lettersOf(content, sentence.from, sentence.to);
    const nodes = cutNodes(kept, numbers, marked.citations, letters);
    if (!nodes) return null;
    // Words a cut takes out must not change what the sentence says, so the cut is checked once, as it would land.
    const cited = [...kept.matchAll(MARKER)].flatMap((match) => {
      const node = marked.citations.get(Number(match[1]));
      const quote = node ? citedQuoteOf(node.attrs ?? {}) : null;
      return quote ? [quote] : [];
    });
    const { projection } = projectedContent(nodes);
    const claim = projection.text;
    const checked = await checkWithin(
      { ...sentence, text: claim, cited, projection },
      { claim, context: sentence.context, projection },
      mindId,
      scope,
      prepared,
      limit,
      signal,
    );
    recordJudged(options.recordAiUse, mindId, prepared, checked, options.now().toISOString());
    return checked.verdict === "supported" ? nodes : null;
  }

  /** One sentence's check, given up on once it takes longer than the time limit. */
  async function checkWithin(
    sentence: Sentence,
    read: ReturnType<typeof checkText> & { place?: RecordCitePlace },
    mindId: string,
    scope: CheckScope,
    prepared: PreparedChatModel,
    limit: Slots,
    signal: AbortSignal,
  ): Promise<ClaimCheckResult> {
    const timedOut = AbortSignal.timeout(options.claimTimeLimitMs);
    const ended = AbortSignal.any([signal, timedOut]);
    // A reply that never comes, even once aborted, is given up on all the same.
    const givenUp = new Promise<null>((resolve) =>
      ended.addEventListener("abort", () => resolve(null), { once: true }),
    );
    const replied = await Promise.race([
      options.claimCheck({
        ...read,
        cited: options.citedNow(sentence.cited),
        scope: scope.scope,
        searched: scope.wanted,
        model: prepared,
        mindId,
        recordClaim: sentence.rawText,
        cacheKey: mindId,
        opinionsLeftOut: true,
        slots: limit,
        signal: ended,
      }),
      givenUp,
    ]);
    if (replied !== null && !timedOut.aborted) return replied;
    return {
      verdict: "not-checked",
      reason: "failed",
      detail: `No reply within ${Math.round(options.claimTimeLimitMs / 1000)} seconds.`,
      versions: [],
      excluded: [],
    };
  }

  // Null when there was nothing to check, or it couldn't be checked here.
  return (input: CheckWrittenInput) => inStep("written-check", () => checkWritten(input));

  async function checkWritten(input: CheckWrittenInput): Promise<WrittenCheck | null> {
    const { mindId, blocks, signal } = input;
    if (judgesUnreliably(input.prepared)) return null;
    const checkable = checkableSentences(blocks);
    // The claims with no Citation are left to the one count and Check the rest (#1909).
    const sentences = checkable.filter((sentence) => sentence.cited.length > 0);
    if (sentences.length === 0) return null;
    const allowed = await options.prepare(input.prepared);
    const waiting = !allowed && options.widened(input.prepared);
    if (!allowed && !waiting) return null;
    // Waiting, nothing is sent: the Answer's model only names who the marks wait for.
    const prepared = allowed ?? input.prepared;
    const { searchable, check: scope } = options.scopeOf(mindId);
    if (searchable === 0) return null;
    const sending = sentences.slice(0, SENTENCES_CHECKED_AT_MOST);
    const reads = options.read(mindId, (note) => {
      const figures = figuresByBlock(note);
      return new Map(
        sending.map((sentence) => {
          const place = notePlace(note, input.ids, sentence);
          const read = readAsChecked(note, input.ids, sentence, figures);
          return [sentence, place ? { ...read, place } : read];
        }),
      );
    });
    const holding = waiting || input.answerFailed === true;
    if (!holding) input.checking(sending.length);
    const request = randomUUID();
    const startedAt = options.now().toISOString();
    const limit = slots(claimsAtOnce(prepared));
    const quick = holding
      ? null
      : await options.quickModel(prepared).catch((error: unknown) => {
          console.warn(
            `No quick model looks first at what the assistant wrote in Mind ${mindId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
    // A sentence its check asks about again, after a rate limit, keeps its first look's answer:
    // asked again, a quick model's later yes would stand.
    const looked = new Map<Sentence, FirstLookResult>();
    // What the Note holds just before the write: its first paragraph follows that.
    const beforeWrite =
      quick &&
      options.read(mindId, (note): FirstLook["place"]["after"] => {
        const top = topLevelBlocks(note);
        const at = top.findIndex((each) => each.getAttribute(BLOCK_ID_ATTRIBUTE) === input.ids[0]);
        const previous = at > 0 ? top[at - 1] : undefined;
        if (at === 0) return { kind: "start" };
        return previous?.nodeName === "heading"
          ? { kind: "heading", text: paragraphText(inlineOf(previous)).replaceAll(INLINE_NODE, "") }
          : { kind: "unknown" };
      });
    const done: WrittenCheck = {
      request,
      blocks: [...input.ids],
      checkable: checkable.length,
      cited: sentences.length,
      sent: sending.length,
      checked: 0,
      failed: 0,
      stop: null,
      blocked: null,
      cut: [],
      unsupported: 0,
      contradicted: 0,
    };
    // A Note a newer version wrote refuses every edit, so once one is refused the rest aren't tried.
    let refused = false;
    const landedSentences = new Set<Sentence>();
    const landAll = (landings: readonly Landing[]) => {
      if (landings.length === 0 || refused) return;
      input.edit((note) => {
        for (const landing of landings) land(note, input.ids, landing);
      });
      for (const landing of landings) landedSentences.add(landing.sentence);
      options.retainEvidence(mindId);
    };
    const couldNotLand = (error: unknown) =>
      console.error(
        `What the assistant wrote in Mind ${mindId} was checked, but marks couldn't land:`,
        error,
      );
    // A sentence lands as its check ends, so its verdict shows while the others are checked. Two
    // wait, and land together after every check, in their order: a table's, as its marks are
    // footed against each other as they land (a total against its cells), and a cut, as it
    // changes the Note's words, which a later sentence's `Id.` reads and every place was found in.
    const held: { index: number; landing: Landing }[] = [];
    const landNow = (landing: Landing) => {
      const { sentence } = landing;
      if (sentence.inCell || ("nodes" in landing && landing.nodes !== null))
        held.push({ index: sending.indexOf(sentence), landing });
      else landAll([landing]);
    };
    const cuts: { index: number; uncovered: string }[] = [];
    const markOf = (
      sentence: Sentence,
      by: PreparedChatModel = prepared,
    ): ClaimCheckAttributes => ({
      id: randomUUID(),
      request,
      action: "check-against-documents",
      state: "checking",
      reason: null,
      detail: null,
      providerId: by.provider.id,
      modelId: by.modelId,
      text: reads.get(sentence)?.claim ?? sentence.text,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: scope.marked,
      versions: [],
      excluded: [],
      checkedAt: startedAt,
    });
    const begun = (sentence: Sentence, by: PreparedChatModel): ClaimCheckAttributes => {
      const figures = reads.get(sentence)?.figures;
      return figures?.length
        ? beginFigureCheck(
            null,
            markOf(sentence, by),
            figures,
            null,
            reads.get(sentence)?.projection,
          )
        : markOf(sentence, by);
    };
    const failed = (sentence: Sentence, reason: ClaimCheckFailure, detail: string | null) => {
      done.failed++;
      if (reason === "consent-revoked" || reason === "local-mode" || reason === "consent-widened") {
        done.blocked = {
          reason: done.blocked?.reason ?? reason,
          count: (done.blocked?.count ?? 0) + 1,
        };
      }
      console.warn(
        `A sentence the assistant wrote in Mind ${mindId} couldn't be checked before it landed: ${reason}${detail ? ` (${detail})` : ""}`,
      );
      const at = options.now().toISOString();
      landNow({
        sentence,
        nodes: null,
        mark: () => notChecked(markOf(sentence), reason, detail, at),
      });
    };
    const landed = (sentence: Sentence, outcome: ItemOutcome<Checked>) => {
      if (signal.aborted || outcome.status === "stopped") return;
      if (outcome.status === "not-checked") {
        failed(sentence, outcome.stop.reason, null);
        return;
      }
      if (outcome.status === "failed") {
        const rateLimited = outcome.error.kind === "rate-limit";
        failed(
          sentence,
          rateLimited ? "rate-limit" : "failed",
          rateLimited ? null : outcome.error.message,
        );
        return;
      }
      const { result, uncovered, nodes, by, passedOn } = outcome.value;
      if (result.parts && !result.parts.some((part) => part.kind === "fact")) {
        landNow({
          sentence,
          opinion: result.parts.map(planOf),
        });
        return;
      }
      const at = options.now().toISOString();
      recordJudged(options.recordAiUse, mindId, by, result, at);
      // A quick model that said no read the sentence too: a use of AI once the sentence is checked.
      if (passedOn) recordJudged(options.recordAiUse, mindId, passedOn, result, at);
      if (result.verdict === "not-checked") {
        failed(sentence, result.reason, result.detail);
        return;
      }
      done.checked++;
      const mark = (note: Y.XmlFragment) =>
        options.withResult(
          begun(sentence, by),
          result,
          at,
          note,
          mindId,
          reads.get(sentence)?.claim,
        );
      if (result.verdict === "supported") {
        landNow({ sentence, nodes: null, mark });
        return;
      }
      if (nodes && uncovered) {
        cuts.push({ index: sending.indexOf(sentence), uncovered });
        landNow({ sentence, nodes, mark });
        return;
      }
      done[result.verdict]++;
      landNow({ sentence, nodes: null, mark });
    };
    const { stop, outcomeError } = await runItems(
      holding ? [] : sending,
      (sentence): Promise<Checked> =>
        asCheckWork(async () => {
          const read = reads.get(sentence) ?? { claim: sentence.text, context: sentence.context };
          const first =
            looked.get(sentence) ??
            (quick &&
              (await options.firstLook({
                claim: read.claim,
                figures: read.figures?.length ?? 0,
                inCell: sentence.inCell,
                place:
                  sentence.place.after.kind === "start" && beforeWrite
                    ? { ...sentence.place, after: beforeWrite }
                    : sentence.place,
                paragraph: sentence.context,
                citations: sentence.citations,
                scope: scope.scope,
                ask: (asked, until) => quickLook(quick, asked, until),
                signal: AbortSignal.any([
                  signal,
                  AbortSignal.timeout(options.claimTimeLimitMs * FIRST_LOOK_SHARE),
                ]),
              })));
          if (quick && first?.result) {
            return {
              result: first.result,
              uncovered: null,
              nodes: null,
              by: quick,
              passedOn: null,
            };
          }
          if (first) looked.set(sentence, first);
          const result = await checkWithin(sentence, read, mindId, scope, prepared, limit, signal);
          const failure = runFailureOf(result);
          if (failure) throw new RunItemError(failure);
          // Asked to cut what a cell's Citations don't state, Edit with AI rewrote its figure.
          const uncovered =
            result.verdict === "unsupported" && result.unsupported?.covered && !sentence.inCell
              ? result.unsupported.uncovered
              : null;
          const nodes = uncovered
            ? await cutOf(blocks, mindId, sentence, uncovered, prepared, scope, limit, signal)
            : null;
          return { result, uncovered, nodes, by: prepared, passedOn: first?.asked ? quick : null };
        }),
      {
        concurrency: claimsAtOnce(prepared),
        signal,
        // The run hears a throw once and returns it, so a mark that can't land is never its
        // sentence's failure; the check fails after the marks that can land have, so none counts
        // as checked. Refusing stays here: once one edit is refused the rest aren't tried.
        onOutcome(sentence, outcome) {
          try {
            landed(sentence, outcome);
          } catch (error) {
            couldNotLand(error);
            if (error instanceof MindReadOnlyError) refused = true;
            throw error;
          }
        },
      },
    );
    if (signal.aborted) {
      // Stopped before a sentence's check ended: it lands Not checked, so a found Citation never
      // reads as checked (#2710). The marks that landed, and a held verdict that was checked,
      // stay.
      const at = options.now().toISOString();
      const heldLandings = held.sort((a, b) => a.index - b.index).map(({ landing }) => landing);
      const heldSentences = new Set(heldLandings.map((landing) => landing.sentence));
      landAll([
        ...heldLandings,
        ...sentences
          .filter((sentence) => !landedSentences.has(sentence) && !heldSentences.has(sentence))
          .map(
            (sentence): Landing => ({
              sentence,
              nodes: null,
              mark: () => notChecked(markOf(sentence), "stopped", null, at),
            }),
          ),
      ]);
      done.stop = stop;
      return done;
    }
    if (waiting) for (const sentence of sending) failed(sentence, "consent-widened", null);
    else if (holding) for (const sentence of sending) failed(sentence, "answer-failed", null);
    const at = options.now().toISOString();
    landAll([
      ...held.sort((a, b) => a.index - b.index).map(({ landing }) => landing),
      ...sentences.slice(SENTENCES_CHECKED_AT_MOST).map(
        (sentence): Landing => ({
          sentence,
          nodes: null,
          mark: () => notChecked(markOf(sentence), "too-many", null, at),
        }),
      ),
    ]);
    if (outcomeError !== null) throw outcomeError.error;
    done.stop = stop;
    done.cut = cuts.sort((a, b) => a.index - b.index).map(({ uncovered }) => uncovered);
    return done;
  }
}

function paragraphAt(blocks: readonly NodeJSON[], path: readonly number[]): NodeJSON | undefined {
  let nodes: readonly NodeJSON[] | undefined = blocks;
  let node: NodeJSON | undefined;
  for (const index of path) {
    node = nodes?.[index];
    nodes = node?.content;
  }
  return node;
}
