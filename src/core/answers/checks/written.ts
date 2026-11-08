/**
 * What the assistant writes into a Mind, checked right after it lands, never in front of the
 * reply (#1111, #2830).
 *
 * Every sentence it wrote that a check reads, each with a Citation and each claim with none
 * (#1909), is checked as Check this Mind would check it (./claimCheck: the Mind's Folder, the
 * Citations' quotes sent), a few at a time, each within a time limit; those with no Citation once
 * the model has named the claims among them, as Check this Mind names them (./findClaims). Each
 * shows as being checked from the start, and its mark lands as its check ends; one that couldn't
 * be checked (a failure, a limit, the time limit, Stop) lands marked not checked, with why. A
 * sentence that makes no claim, or states only an opinion, takes no mark, its opinion left out as
 * Check this Mind leaves it. The
 * check only marks: a part a sentence's Citations don't support is the User's to cut, from its
 * card. Only while a sentence reads as it was written does its mark land on its words as they
 * are; one the User changed meanwhile is marked to be checked again.
 *
 * The check runs on its own once begun: the turn doesn't wait for it, and a new message doesn't
 * stop it. Stop on the Note's badge (`track`), an Undo that takes the write away (`mindChanged`)
 * and quitting (`stopAll`) end it; what it hadn't checked then lands not checked.
 *
 * Before its check, a sentence with one Citation may be found Supported by a plain yes from the
 * provider's quick-tasks model, the same service (./fastPaths, #1667). Anything else goes on to
 * its check.
 *
 * One check per sentence, on the Answer's model prepared for the checks flow: each request checks
 * that flow's consent as it is sent, so turning it off stops the rest at once (#1206), as the
 * cost cap and a plan's limit do. Nothing is checked when the flow is off as it starts, or on a
 * model on this computer too small to judge reliably (#680). Allowed before checks sent more, the
 * flow isn't asked about here: each sentence lands not checked, waiting for the User to allow the
 * more (#2525).
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { citationAttributesOf } from "../../../shared/citations";
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
  type RecordAiUseInput,
  type RunStop,
  type WrittenCheckProgress,
} from "../../api";
import { MindReadOnlyError } from "../../errors";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { asCheckWork } from "../../reranking/order";
import { type ItemOutcome, RunItemError, runItems, type Slots, slots } from "../../runs/stop";
import { inStep } from "../../timing/flows";
import { type NodeJSON, topLevelBlocks } from "../blocks";
import {
  type CheckedCitation,
  type ClaimCheckRequest,
  recordJudged,
  runFailureOf,
} from "./claimCheck";
import { type FirstLook, type FirstLookResult, quickLook } from "./fastPaths";
import { claimsAmong } from "./findClaims";
import { recordOpinions } from "./opinions";
import { claimsAtOnce } from "./runChecks";
import {
  checkText,
  citedQuoteOf,
  figuresByBlock,
  markSentence,
  sentenceOf,
  unmarkSentence,
} from "./sentences";
import type { CheckScope } from "./verify";

const UNCHECKED: ReadonlySet<string> = new Set(["question", "codeBlock", "blockMath", "heading"]);

/** How many writes Undo took away a Mind keeps, so a Redo that brings one back finds its sentences stopped. */
const UNDONE_KEPT = 20;

/** How long a write must stay gone from its Mind before its check is taken as undone. */
const UNDONE_SETTLE_MS = 1_000;

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
  /** The quick model that looks first at a write's sentences under the checks' model (./fastPaths); null: none. */
  quickModel(prepared: PreparedChatModel): Promise<PreparedChatModel | null>;
  firstLook(look: FirstLook): Promise<FirstLookResult>;
  /** How long one check may take, as contradiction watch gives one claim: a reply may never come. */
  claimTimeLimitMs: number;
  /** Registers a check under its request, so the Note's Stop and quitting reach it (./index `track`). */
  track(requestId: string, mindId: string): { signal: AbortSignal; done(): void };
  /** Marks the request's sentences still being checked as stopped (./index `settleStopped`). */
  settleStopped(mindId: string, request: string): void;
  /** How far a check is, as its marks land, and once more as it ends. */
  progress(event: WrittenCheckProgress): void;
  now(): Date;
}

export interface CheckWrittenInput {
  mindId: string;
  /** The Blocks as the assistant wrote them. */
  blocks: readonly NodeJSON[];
  /** The ids of the top-level Blocks they were written as, in their order. */
  ids: readonly string[];
  prepared: PreparedChatModel;
  /** The Answer's: aborted before the check begins, nothing is checked. */
  signal: AbortSignal;
  /**
   * The Answer failed before its text could be checked: each sentence lands not checked, and
   * nothing is sent to the provider that just failed.
   */
  answerFailed?: boolean;
  /** Changes the Mind's content, in one transaction. */
  edit(change: (blocks: Y.XmlFragment) => void): void;
  /** Hears the check once it is over, when `checkWritten` resolved with it still running; a short one may end first. */
  ended?(check: WrittenCheck): void;
}

/**
 * What the check did: of the sentences the write holds that a check reads (`checkable`), how
 * many have a Citation (`cited`), how many it sent, how many got a verdict, how many couldn't
 * be checked, how many make no claim to check (an opinion, or none), and what stopped it; of the verdicts, how many
 * are unsupported or contradicted. Its marks share `request`. `blocked`: the sentences the User's
 * own choice kept from being sent, among those that couldn't be checked. `running` until its last
 * mark has landed; `undone` once an Undo took its write away, which ended it.
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
  leftOut: number;
  stop: RunStop | null;
  blocked: { reason: "consent-revoked" | "local-mode" | "consent-widened"; count: number } | null;
  unsupported: number;
  contradicted: number;
  running: boolean;
  undone: boolean;
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
  /** In a table's cell, whose figures are footed against the table's other cells as they land. */
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

/** A sentence's check: `by`, the model whose verdict it is, the quick model's or the checks' own. */
interface Checked {
  result: ClaimCheckResult;
  by: PreparedChatModel;
  /** The quick model that read the sentence first and passed it on to its check. */
  passedOn: PreparedChatModel | null;
}

/**
 * The first look gets a tenth of a sentence's time, and its check all of it after: a small
 * model's one-word reply takes about a second, so one that takes longer has more likely hung.
 */
const FIRST_LOOK_SHARE = 0.1;

/** What a landing counts as: a verdict, a sentence that couldn't be checked, or one that states only an opinion. */
type Outcome = "checked" | "unsupported" | "contradicted" | "failed" | "opinion";

type Landing =
  | {
      sentence: Sentence;
      /** Its mark, made where it lands: a figure's result is footed against the table it is in. */
      mark(blocks: Y.XmlFragment): ClaimCheckAttributes;
    }
  /** A sentence with no fact: no mark, and its opinion is left out as Check this Note leaves it. */
  | { sentence: Sentence; opinion: readonly ClaimPartPlan[] };

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
 * Lands one sentence in the Mind: marked where it is, its words as they are; once the User has
 * changed them, its mark shows its check needs doing again. A sentence of opinion only loses
 * the mark it was checked under.
 */
function land(blocks: Y.XmlFragment, ids: readonly string[], landing: Landing): void {
  const { sentence } = landing;
  const element = paragraphIn(blocks, ids, sentence.path);
  const place = element ? placeOf(element, sentence) : null;
  if (!element || !place) return;
  if ("opinion" in landing) {
    unmarkSentence(element, place.from, place.to, "check-against-documents");
    const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (!place.same || typeof blockId !== "string" || landing.opinion.length === 0) return;
    const now = sentenceOf(element, blockId, place, figuresByBlock(blocks));
    recordOpinions(blocks, [{ ...now, parts: landing.opinion }]);
    return;
  }
  markSentence(element, place.from, place.to, landing.mark(blocks));
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

/** A check of a write still running: its Mind, its write's Blocks, and how to end it at once. */
interface LiveCheck {
  mindId: string;
  ids: readonly string[];
  /** Ends it as it is: what it hadn't checked lands not checked; `undone`, an Undo took its write away. */
  end(undone?: boolean): void;
}

export function createWrittenCheck(options: WrittenCheckOptions) {
  const live = new Map<string, LiveCheck>();
  /** By Mind: the checks an Undo of their write ended, newest last, until a Redo brings the write back. */
  const undone = new Map<string, { request: string; ids: readonly string[] }[]>();
  /** The Minds a check's write looked gone from, waiting a moment to see if it stays gone. */
  const confirming = new Set<string>();

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

  /** Whether any of the write's top-level Blocks is still in its Mind. */
  const stillThere = (mindId: string, ids: readonly string[]) => {
    try {
      return options.read(mindId, (note) =>
        topLevelBlocks(note).some((each) =>
          ids.includes(String(each.getAttribute(BLOCK_ID_ATTRIBUTE))),
        ),
      );
    } catch {
      return false;
    }
  };

  /**
   * Null when there was nothing to check, or it couldn't be checked here. Resolves once the check
   * has begun, each sentence it reads shown as being checked; `input.ended` hears its end.
   */
  async function checkWritten(input: CheckWrittenInput): Promise<WrittenCheck | null> {
    const { mindId, blocks } = input;
    if (judgesUnreliably(input.prepared) || input.signal.aborted) return null;
    const sentences = checkableSentences(blocks);
    if (sentences.length === 0) return null;
    const allowed = await options.prepare(input.prepared);
    const waiting = !allowed && options.widened(input.prepared);
    if (!allowed && !waiting) return null;
    // Waiting, nothing is sent: the Answer's model only names who the marks wait for.
    const prepared = allowed ?? input.prepared;
    const { searchable, check: scope } = options.scopeOf(mindId);
    if (searchable === 0) return null;
    const reads = options.read(mindId, (note) => {
      const figures = figuresByBlock(note);
      return new Map(
        sentences.map((sentence) => {
          const place = notePlace(note, input.ids, sentence);
          const read = readAsChecked(note, input.ids, sentence, figures);
          return [sentence, place ? { ...read, place } : read];
        }),
      );
    });
    const holding = waiting || input.answerFailed === true;
    const request = randomUUID();
    const startedAt = options.now().toISOString();
    const markIds = new Map(sentences.map((sentence) => [sentence, randomUUID()]));
    const done: WrittenCheck = {
      request,
      blocks: [...input.ids],
      checkable: sentences.length,
      cited: sentences.filter((sentence) => sentence.cited.length > 0).length,
      sent: sentences.length,
      checked: 0,
      failed: 0,
      leftOut: 0,
      stop: null,
      blocked: null,
      unsupported: 0,
      contradicted: 0,
      running: !holding,
      undone: false,
    };
    const snapshot = (): WrittenCheck => ({
      ...done,
      blocks: [...done.blocks],
      ...(done.blocked && { blocked: { ...done.blocked } }),
    });
    const markOf = (
      sentence: Sentence,
      by: PreparedChatModel = prepared,
    ): ClaimCheckAttributes => ({
      id: markIds.get(sentence) ?? randomUUID(),
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
    // A Note a newer version wrote refuses every edit, so once one is refused the rest aren't tried.
    let refused = false;
    const counted = (outcome: Outcome) => {
      if (outcome === "opinion") done.leftOut++;
      else if (outcome === "failed") done.failed++;
      else {
        done.checked++;
        if (outcome !== "checked") done[outcome]++;
      }
    };
    const landAll = (landings: readonly { landing: Landing; outcome: Outcome | null }[]) => {
      if (landings.length === 0 || refused) return;
      input.edit((note) => {
        for (const { landing } of landings) land(note, input.ids, landing);
      });
      const outcomes = landings.flatMap(({ outcome }) => (outcome ? [outcome] : []));
      for (const outcome of outcomes) counted(outcome);
      if (outcomes.length > 0) options.retainEvidence(mindId);
    };
    const blockedBy = (reason: ClaimCheckFailure) => {
      if (reason !== "consent-revoked" && reason !== "local-mode" && reason !== "consent-widened")
        return;
      done.blocked = {
        reason: done.blocked?.reason ?? reason,
        count: (done.blocked?.count ?? 0) + 1,
      };
    };
    const failedLanding = (
      sentence: Sentence,
      reason: ClaimCheckFailure,
      detail: string | null,
    ): Landing => {
      blockedBy(reason);
      console.warn(
        `A sentence the assistant wrote in Mind ${mindId} couldn't be checked: ${reason}${detail ? ` (${detail})` : ""}`,
      );
      const at = options.now().toISOString();
      return { sentence, mark: () => notChecked(markOf(sentence), reason, detail, at) };
    };

    if (holding) {
      landAll(
        sentences.map((sentence) => ({
          landing: failedLanding(sentence, waiting ? "consent-widened" : "answer-failed", null),
          outcome: "failed" as const,
        })),
      );
      return snapshot();
    }

    const quick = await options.quickModel(prepared).catch((error: unknown) => {
      console.warn(
        `No quick model looks first at what the assistant wrote in Mind ${mindId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (input.signal.aborted) return null;
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
    // Each sentence shows as being checked until its own mark lands.
    landAll(
      sentences.map((sentence) => ({
        landing: { sentence, mark: () => begun(sentence, prepared) },
        outcome: null,
      })),
    );

    const tracked = options.track(request, mindId);
    const ending = new AbortController();
    const signal = AbortSignal.any([tracked.signal, ending.signal]);
    const progress = () =>
      options.progress({
        mindId,
        request,
        done: done.checked + done.failed,
        total: sentences.length - done.leftOut,
        running: done.running,
      });
    let over = false;
    const end = (undone = false) => {
      if (over) return;
      over = true;
      done.undone = undone;
      ending.abort();
      live.delete(request);
      tracked.done();
      try {
        options.settleStopped(mindId, request);
      } catch (error) {
        console.error(
          `The sentences still checked in Mind ${mindId} couldn't be marked stopped:`,
          error,
        );
      }
      // What never landed couldn't be checked: Stop, an Undo or quitting ended it first.
      done.failed = sentences.length - done.leftOut - done.checked;
      done.running = false;
      progress();
      input.ended?.(snapshot());
    };
    live.set(request, { mindId, ids: input.ids, end });
    progress();

    // A sentence lands as its check ends, so its verdict shows while the others are checked. A
    // table's wait, and land together after every check, in their order, as their marks are
    // footed against each other as they land (a total against its cells).
    const held: { index: number; landing: Landing; outcome: Outcome }[] = [];
    const landNow = (landing: Landing, outcome: Outcome) => {
      if (landing.sentence.inCell)
        held.push({ index: sentences.indexOf(landing.sentence), landing, outcome });
      else {
        landAll([{ landing, outcome }]);
        progress();
      }
    };
    const failed = (sentence: Sentence, reason: ClaimCheckFailure, detail: string | null) =>
      landNow(failedLanding(sentence, reason, detail), "failed");
    const landed = (sentence: Sentence, outcome: ItemOutcome<Checked>) => {
      if (over || signal.aborted || outcome.status === "stopped") return;
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
      const { result, by, passedOn } = outcome.value;
      if (result.parts && !result.parts.some((part) => part.kind === "fact")) {
        landNow({ sentence, opinion: result.parts.map(planOf) }, "opinion");
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
      const mark = (note: Y.XmlFragment) =>
        options.withResult(
          begun(sentence, by),
          result,
          at,
          note,
          mindId,
          reads.get(sentence)?.claim,
        );
      landNow(
        { sentence, mark },
        result.verdict === "unsupported" || result.verdict === "contradicted"
          ? result.verdict
          : "checked",
      );
    };
    const limit = slots(claimsAtOnce(prepared));
    // A sentence its check asks about again, after a rate limit, keeps its first look's answer:
    // asked again, a quick model's later yes would stand.
    const looked = new Map<Sentence, FirstLookResult>();
    const checkOne = (sentence: Sentence): Promise<Checked> =>
      asCheckWork(async () => {
        // A write that looks gone may be undone: nothing more is sent until `mindChanged` knows.
        if (!stillThere(mindId, input.ids)) {
          await new Promise((resolve) => setTimeout(resolve, UNDONE_SETTLE_MS));
          signal.throwIfAborted();
        }
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
        if (quick && first?.result) return { result: first.result, by: quick, passedOn: null };
        if (first) looked.set(sentence, first);
        const result = await checkWithin(sentence, read, mindId, scope, prepared, limit, signal);
        const failure = runFailureOf(result);
        if (failure) throw new RunItemError(failure);
        return { result, by: prepared, passedOn: first?.asked ? quick : null };
      });
    const checkAll = (items: readonly Sentence[]) =>
      runItems(items, checkOne, {
        concurrency: claimsAtOnce(prepared),
        signal,
        // The run hears a throw once and returns it, so a mark that can't land is never its
        // sentence's failure. Refusing stays here: once one edit is refused the rest aren't tried.
        onOutcome(sentence, outcome) {
          try {
            landed(sentence, outcome);
          } catch (error) {
            console.error(
              `What the assistant wrote in Mind ${mindId} was checked, but marks couldn't land:`,
              error,
            );
            if (error instanceof MindReadOnlyError) refused = true;
            throw error;
          }
        },
      });
    /**
     * The sentences with no Citation that make claims, as Check this Note names them (./findClaims):
     * the others lose their mark, an opinion's left out as Check this Note leaves it. A sort that
     * fails leaves each to its own check, which names its parts too.
     */
    const claimsOf = async (uncited: readonly Sentence[]): Promise<readonly Sentence[]> => {
      if (uncited.length === 0) return [];
      const found = await claimsAmong(
        prepared,
        uncited.map((sentence) => ({ text: reads.get(sentence)?.claim ?? sentence.text })),
        "own",
        signal,
        true,
        { slots: limit },
      );
      if (found.kind === "cancelled") return [];
      if (found.kind === "failed") {
        console.warn(
          `The claims among what the assistant wrote in Mind ${mindId} couldn't be named, so each is checked: ${found.error.message}`,
        );
        return uncited;
      }
      const claims: Sentence[] = [];
      for (const [index, sentence] of uncited.entries()) {
        const parts = found.parts.get(index) ?? [];
        if (
          parts.some((part) => part.kind === "fact") ||
          (reads.get(sentence)?.figures?.length ?? 0) > 0
        )
          claims.push(sentence);
        else landNow({ sentence, opinion: parts }, "opinion");
      }
      return claims;
    };
    const run = async () => {
      try {
        // The cited sentences go at once; those with none, once the sort has named the claims.
        const [cited, uncited] = await Promise.all([
          checkAll(sentences.filter((sentence) => sentence.cited.length > 0)),
          claimsOf(sentences.filter((sentence) => sentence.cited.length === 0)).then(checkAll),
        ]);
        const stop = cited.stop ?? uncited.stop;
        const outcomeError = cited.outcomeError ?? uncited.outcomeError;
        done.stop = stop;
        if (!signal.aborted) {
          landAll(
            held
              .sort((a, b) => a.index - b.index)
              .map(({ landing, outcome }) => ({ landing, outcome })),
          );
        }
        if (outcomeError !== null) throw outcomeError.error;
      } catch (error) {
        console.error(`What the assistant wrote in Mind ${mindId} couldn't be checked:`, error);
      } finally {
        end();
      }
    };
    void run();
    return snapshot();
  }

  return {
    checkWritten: (input: CheckWrittenInput) => inStep("written-check", () => checkWritten(input)),

    /**
     * A Mind changed: a check whose write is no longer there (an Undo took it away, or the Mind
     * went) ends, and a write an Undo took away that a Redo brought back has its sentences shown
     * as stopped rather than still being checked.
     */
    mindChanged(mindId: string): void {
      queueMicrotask(() => {
        const ended = undone.get(mindId) ?? [];
        const back = ended.filter((each) => stillThere(mindId, each.ids));
        for (const { request } of back) {
          try {
            options.settleStopped(mindId, request);
          } catch (error) {
            console.error(`A check undone in Mind ${mindId} couldn't be marked stopped:`, error);
          }
        }
        if (back.length > 0) {
          const left = ended.filter((each) => !back.includes(each));
          if (left.length > 0) undone.set(mindId, left);
          else undone.delete(mindId);
        }
        const gone = () =>
          [...live].filter(
            ([, check]) => check.mindId === mindId && !stillThere(mindId, check.ids),
          );
        if (confirming.has(mindId) || gone().length === 0) return;
        // A window that draws a Block again sends its removal and its return as two changes: the
        // write is taken as undone only once it is still gone a moment later.
        confirming.add(mindId);
        setTimeout(() => {
          confirming.delete(mindId);
          const taken = gone();
          if (taken.length === 0) return;
          const kept = [
            ...(undone.get(mindId) ?? []),
            ...taken.map(([request, check]) => ({ request, ids: check.ids })),
          ];
          undone.set(mindId, kept.slice(-UNDONE_KEPT));
          for (const [, check] of taken) check.end(true);
        }, UNDONE_SETTLE_MS);
      });
    },

    /** Ends every check at once, as IncarnaMind quits: what each hadn't checked lands not checked. */
    stopAll(): void {
      for (const check of [...live.values()]) check.end();
    },
  };
}
