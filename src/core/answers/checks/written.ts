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
 * One check per sentence, and one edit per sentence it cuts, on the Answer's
 * model prepared for the checks flow: each request checks that flow's consent
 * as it is sent, so turning it off stops the rest at once (#1206), as the cost
 * cap and a plan's limit do. Nothing is checked when the flow is off as it
 * starts, or on a model on this computer too small to judge reliably (#680).
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { SENTENCES_CHECKED_AT_MOST } from "../../../shared/claimChecks";
import type { RecordCitePlace } from "../../../shared/recordCiteChoices";
import { INLINE_NODE, isClaim, sentenceSpans } from "../../../shared/sentences";
import { judgesUnreliably } from "../../../shared/smallModel";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitedQuote,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckFailure,
  type ClaimCheckResult,
  type EditAction,
  type RecordAiUseInput,
  type RunStop,
} from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { scanRecordCites } from "../../recordCites/parser";
import { RunItemError, runItems } from "../../runs/stop";
import { inStep } from "../../timing/flows";
import { type MarkJSON, type NodeJSON, syncContent, topLevelBlocks } from "../blocks";
import { type ClaimCheckRequest, recordJudged, runFailureOf } from "./claimCheck";
import { claimsAtOnce } from "./runChecks";
import { markSentence } from "./sentences";
import type { CheckScope } from "./verify";

const UNCHECKED: ReadonlySet<string> = new Set(["question", "codeBlock", "blockMath", "heading"]);

export interface WrittenCheckOptions {
  /**
   * The Answer's model prepared for the checks flow, whose consent each request then checks
   * as it is sent (ADR-0022); null when that flow may not send to it now. Never asks.
   */
  prepare(answer: PreparedChatModel): Promise<PreparedChatModel | null>;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  /** Where the Mind's sentences are checked, as Check this Mind checks them. */
  scopeOf(mindId: string): { searchable: number; check: CheckScope };
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): { documentName: string; quote: string }[];
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
  ): ClaimCheckAttributes;
  retainEvidence(mindId: string): void;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  /** Edit with AI's new text for a passage not in a Mind (../../edits, `editText`). */
  editText(
    prepared: PreparedChatModel,
    ask: { action: EditAction; instruction: string },
    passage: { text: string; context: string; quotes: readonly string[] },
    signal: AbortSignal,
  ): Promise<string | null>;
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
  blocked: { reason: "consent-revoked" | "local-mode"; count: number } | null;
  cut: string[];
  unsupported: number;
  contradicted: number;
}

interface Sentence {
  /** An index into each level's content, from the top-level Block down to its paragraph. */
  path: number[];
  from: number;
  to: number;
  /** As checks read it: an inline node as U+FFFC, a line break as "\n". */
  text: string;
  context: string;
  cited: CitedQuote[];
}

function paragraphText(content: readonly NodeJSON[]): string {
  return content
    .map((node) =>
      node.type === "text" ? (node.text ?? "") : node.type === "hardBreak" ? "\n" : INLINE_NODE,
    )
    .join("");
}

function inlineLayout(content: readonly NodeJSON[]): { node: NodeJSON; start: number }[] {
  let at = 0;
  return content.map((node) => {
    const start = at;
    at += node.type === "text" ? (node.text ?? "").length : 1;
    return { node, start };
  });
}

function quoteOf(node: NodeJSON): CitedQuote | null {
  const attrs = node.attrs ?? {};
  const { quote, documentName, documentId, contentHash } = attrs;
  if (typeof quote !== "string" || quote === "") return null;
  return {
    documentName: typeof documentName === "string" ? documentName : "",
    quote,
    ...(typeof documentId === "string" && { documentId }),
    ...(typeof contentHash === "string" && { contentHash }),
  };
}

/** The sentences a check reads that the write holds (#1909): every sentence with a Citation, and every claim with none. */
function checkableSentences(blocks: readonly NodeJSON[]): Sentence[] {
  const found: Sentence[] = [];
  const visit = (nodes: readonly NodeJSON[], path: number[]) => {
    nodes.forEach((node, index) => {
      if (UNCHECKED.has(node.type)) return;
      const here = [...path, index];
      const content = node.content ?? [];
      if (node.type !== "paragraph") {
        visit(content, here);
        return;
      }
      const context = paragraphText(content);
      const layout = inlineLayout(content);
      for (const span of sentenceSpans(context)) {
        const text = context.slice(span.from, span.to);
        const cited = layout.flatMap(({ node: inline, start }) => {
          if (inline.type !== CITATION_NODE || start < span.from || start >= span.to) return [];
          return quoteOf(inline) ?? [];
        });
        if (cited.length === 0 && !isClaim(text)) continue;
        found.push({ path: here, from: span.from, to: span.to, text, context, cited });
      }
    });
  };
  visit(blocks, []);
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

interface Landing {
  sentence: Sentence;
  /** The cut, in place of the sentence's own words; null: they stay. */
  nodes: NodeJSON[] | null;
  mark: ClaimCheckAttributes;
}

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

/**
 * Lands one sentence in the Mind: cut or marked while it reads as it was
 * written; once the User has changed it, only marked, so its words stay and
 * its check shows it needs doing again.
 */
function land(blocks: Y.XmlFragment, ids: readonly string[], landing: Landing): void {
  const { sentence } = landing;
  const element = paragraphIn(blocks, ids, sentence.path);
  if (!element) return;
  const content = inlineOf(element);
  const text = paragraphText(content);
  const spans = sentenceSpans(text);
  const same = spans
    .filter((span) => text.slice(span.from, span.to) === sentence.text)
    .sort((a, b) => Math.abs(a.from - sentence.from) - Math.abs(b.from - sentence.from))[0];
  if (same && landing.nodes) {
    syncContent(element, replaced(content, same.from, same.to, landing.nodes));
    return;
  }
  if (same) {
    markSentence(element, same.from, same.to, landing.mark);
    return;
  }
  const written = sentenceSpans(sentence.context);
  const index = written.findIndex((span) => span.from === sentence.from);
  const now = spans.length === written.length ? spans[index] : undefined;
  if (now) markSentence(element, now.from, now.to, landing.mark);
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
        quotes: [...marked.citations.values()].map((node) => quoteOf(node)?.quote ?? ""),
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
      const quote = node ? quoteOf(node) : null;
      return quote ? [quote] : [];
    });
    const checked = await checkWithin(
      { ...sentence, text: kept.replace(MARKER, INLINE_NODE), cited },
      mindId,
      scope,
      prepared,
      signal,
    );
    recordJudged(options.recordAiUse, mindId, prepared, checked, options.now().toISOString());
    return checked.verdict === "supported" ? nodes : null;
  }

  /** One sentence's check, given up on once it takes longer than the time limit. */
  async function checkWithin(
    sentence: Sentence,
    mindId: string,
    scope: CheckScope,
    prepared: PreparedChatModel,
    signal: AbortSignal,
    place?: RecordCitePlace,
  ): Promise<ClaimCheckResult> {
    const timedOut = AbortSignal.timeout(options.claimTimeLimitMs);
    const ended = AbortSignal.any([signal, timedOut]);
    // A reply that never comes, even once aborted, is given up on all the same.
    const givenUp = new Promise<null>((resolve) =>
      ended.addEventListener("abort", () => resolve(null), { once: true }),
    );
    const replied = await Promise.race([
      options.claimCheck({
        claim: sentence.text,
        context: sentence.context,
        cited: options.citedNow(sentence.cited),
        scope: scope.scope,
        model: prepared,
        mindId,
        ...(place && { place }),
        cacheKey: mindId,
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

  const placeOf = (
    sentence: Sentence,
    blocks: readonly NodeJSON[],
    ids: readonly string[],
  ): RecordCitePlace | undefined => {
    const own = paragraphAt(blocks, sentence.path)?.attrs?.[BLOCK_ID_ATTRIBUTE];
    const top = sentence.path[0];
    const fallback = top === undefined ? undefined : ids[top];
    const blockId = typeof own === "string" ? own : fallback;
    return blockId ? { blockId, from: sentence.from } : undefined;
  };

  // Null when there was nothing to check, or it couldn't be checked here.
  return (input: CheckWrittenInput) => inStep("written-check", () => checkWritten(input));

  async function checkWritten(input: CheckWrittenInput): Promise<WrittenCheck | null> {
    const { mindId, blocks, signal } = input;
    if (judgesUnreliably(input.prepared)) return null;
    const checkable = checkableSentences(blocks);
    // The claims with no Citation are left to the one count and Check the rest (#1909).
    const sentences = checkable.filter((sentence) => sentence.cited.length > 0);
    if (sentences.length === 0) return null;
    const prepared = await options.prepare(input.prepared);
    if (!prepared) return null;
    const { searchable, check: scope } = options.scopeOf(mindId);
    if (searchable === 0) return null;
    const sending = sentences.slice(0, SENTENCES_CHECKED_AT_MOST);
    input.checking(sending.length);
    const request = randomUUID();
    const startedAt = options.now().toISOString();
    const { outcomes, stop } = await runItems(
      sending,
      async (sentence) => {
        const result = await checkWithin(
          sentence,
          mindId,
          scope,
          prepared,
          signal,
          placeOf(sentence, blocks, input.ids),
        );
        const failure = runFailureOf(result);
        if (failure) throw new RunItemError(failure);
        const uncovered =
          result.verdict === "unsupported" && result.unsupported?.covered
            ? result.unsupported.uncovered
            : null;
        const nodes = uncovered
          ? await cutOf(blocks, mindId, sentence, uncovered, prepared, scope, signal)
          : null;
        return { result, uncovered, nodes };
      },
      {
        concurrency: sending.some(
          (sentence) => scanRecordCites(sentence.text, { hasPrevious: true }).length > 0,
        )
          ? 1
          : claimsAtOnce(prepared),
        signal,
      },
    );
    if (signal.aborted) return null;

    const done: WrittenCheck = {
      request,
      blocks: [...input.ids],
      checkable: checkable.length,
      cited: sentences.length,
      sent: sending.length,
      checked: 0,
      failed: 0,
      stop,
      blocked: null,
      cut: [],
      unsupported: 0,
      contradicted: 0,
    };
    const landings: Landing[] = [];
    const markOf = (sentence: Sentence): ClaimCheckAttributes => ({
      id: randomUUID(),
      request,
      action: "check-against-documents",
      state: "checking",
      reason: null,
      detail: null,
      providerId: prepared.provider.id,
      modelId: prepared.modelId,
      text: sentence.text,
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
    const failed = (sentence: Sentence, reason: ClaimCheckFailure, detail: string | null) => {
      done.failed++;
      if (reason === "consent-revoked" || reason === "local-mode") {
        done.blocked = {
          reason: done.blocked?.reason ?? reason,
          count: (done.blocked?.count ?? 0) + 1,
        };
      }
      console.warn(
        `A sentence the assistant wrote in Mind ${mindId} couldn't be checked before it landed: ${reason}${detail ? ` (${detail})` : ""}`,
      );
      landings.push({
        sentence,
        nodes: null,
        mark: notChecked(markOf(sentence), reason, detail, options.now().toISOString()),
      });
    };
    sending.forEach((sentence, index) => {
      const outcome = outcomes[index];
      if (!outcome || outcome.status === "stopped") return;
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
      const { result, uncovered, nodes } = outcome.value;
      const at = options.now().toISOString();
      recordJudged(options.recordAiUse, mindId, prepared, result, at);
      if (result.verdict === "not-checked") {
        failed(sentence, result.reason, result.detail);
        return;
      }
      done.checked++;
      const mark = options.withResult(markOf(sentence), result, at);
      if (result.verdict === "supported") {
        landings.push({ sentence, nodes: null, mark });
        return;
      }
      if (nodes && uncovered) {
        done.cut.push(uncovered);
        landings.push({ sentence, nodes: withMark(nodes, mark), mark });
        return;
      }
      done[result.verdict]++;
      landings.push({ sentence, nodes: null, mark });
    });
    const at = options.now().toISOString();
    for (const sentence of sentences.slice(SENTENCES_CHECKED_AT_MOST)) {
      landings.push({
        sentence,
        nodes: null,
        mark: notChecked(markOf(sentence), "too-many", null, at),
      });
    }
    if (landings.length > 0) {
      input.edit((note) => {
        for (const landing of landings) land(note, input.ids, landing);
      });
      options.retainEvidence(mindId);
    }
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
