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
 * stop it. Stop on the Note's badge (`track`), an Undo or a reject that takes the write away
 * (`mindChanged`) and quitting (`stopAll`) end it; what it hadn't checked then lands not checked.
 * A newer write over the same Blocks takes their sentences over: the older check leaves them.
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
import { citationAttributesOf, citationClosingLength } from "../../../shared/citations";
import { restsElsewhere } from "../../../shared/citedNow";
import { readClaimCheck } from "../../../shared/claimChecks";
import { planOf } from "../../../shared/claimParts";
import { beginFigureCheck } from "../../../shared/figureChecks";
import { readTableBinding } from "../../../shared/figureRuns";
import {
  type InlineTextProjection,
  inlineLayout,
  inlineRange,
  inlineSpan,
  projectedContent,
  sliceInlineText,
} from "../../../shared/inlineText";
import { markValueOf } from "../../../shared/markKeys";
import {
  INLINE_NODES,
  NODE_CHARACTER,
  pendingProposals,
  readProposalAttribute,
  readProposalRef,
  targetText,
} from "../../../shared/proposals";
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
  type ClaimPartSpan,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
  type RunStop,
  type WrittenCheckProgress,
} from "../../api";
import { MindReadOnlyError } from "../../errors";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { asCheckWork } from "../../reranking/order";
import type { RepliesOut } from "../../runs/replies";
import { type Slots, slots } from "../../runs/stop";
import { realTimers } from "../../sources/pace";
import { inStep } from "../../timing/flows";
import { marksOfRun, type NodeJSON, syncContent, topLevelBlocks } from "../blocks";
import type { CheckedCitation, ClaimCheckRequest } from "./claimCheck";
import { type FirstLook, type FirstLookResult, quickLook } from "./fastPaths";
import { claimsAmong } from "./findClaims";
import { recordOpinions } from "./opinions";
import { repliesFirst } from "./repliesFirst";
import {
  type CheckOutcome,
  type CheckRuns,
  type CheckTry,
  CLAIM_TIME_LIMIT_MS,
  checkRunOf,
  recordCheck,
  runClaimChecks,
} from "./runCheck";
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

export interface WrittenCheckOptions extends CheckRuns {
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
  /**
   * Settles once the scope can tell every copy of the file the Mind was imported from (#2216), or
   * once `stop` aborts; after the core closes, only `stop` settles it.
   */
  evidenceReady(stop: AbortSignal, mindId: string): Promise<void>;
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
  /** The quick model that looks first at a write's sentences under the checks' model (./fastPaths); null: none. */
  quickModel(prepared: PreparedChatModel): Promise<PreparedChatModel | null>;
  firstLook(look: FirstLook): Promise<FirstLookResult>;
  /**
   * Aborts once the claims sort has taken too long: a reply may never come. Left out, the check's
   * own time limit, less any wait behind a reply.
   */
  sortTimeLimit?(): AbortSignal;
  /** Where a reply out on the check's provider holds its next request (./repliesFirst). */
  repliesOut?: RepliesOut;
  /** The core's lifetime: once it ends, the database is closed and nothing more is read. */
  closed: AbortSignal;
  /** Registers a check under its request, so the Note's Stop and quitting reach it (./index `track`). */
  track(requestId: string, mindId: string): { signal: AbortSignal; done(): void };
  /** Marks the request's sentences still being checked as stopped (./index `settleStopped`). */
  settleStopped(mindId: string, request: string): void;
  /** The same for the check of a write a Redo brought back, which runs no more. */
  settleBroughtBack(mindId: string, request: string): void;
  /** How far a check is, as its marks land, and once more as it ends. */
  progress(event: WrittenCheckProgress): void;
}

export interface CheckWrittenInput {
  mindId: string;
  /** The Blocks as the assistant wrote them. */
  blocks: readonly NodeJSON[];
  /** The ids of the top-level Blocks they were written as, in their order. */
  ids: readonly string[];
  /** The request of the Proposals the write made, so its Undo or reject is told from an edit. */
  write: string;
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
  /**
   * Hears its counts as each mark lands, so what is recorded of it says what the Note shows
   * even when IncarnaMind stops before the check ends.
   */
  progressed?(check: WrittenCheck): void;
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

/** Who judged a sentence: the quick model or the checks' own model (./fastPaths). */
interface Checked {
  by: PreparedChatModel;
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
      /** The Passages its check found that its Citations don't hold, each to cite after its part. */
      found?: readonly FoundCitation[];
    }
  /** A sentence with no fact: no mark, and its opinion is left out as Check this Note leaves it. */
  | { sentence: Sentence; opinion: readonly ClaimPartPlan[] };

/** A Passage the check found for a part, in the words it checked (`claim`, indexed by `span`). */
interface FoundCitation {
  claim: string;
  span: ClaimPartSpan;
  citation: CitationAttributes;
}

/**
 * The Passages a check of a sentence the assistant wrote found for its Supported parts that its
 * Citations don't hold (#3019): each becomes that part's Citation inside the assistant's own change,
 * in its number series, accepted or rejected with the rest. The verdict stays the model's.
 */
function foundCitations(
  sentence: Sentence,
  claim: string,
  result: ClaimCheckResult,
): FoundCitation[] {
  return (result.parts ?? []).flatMap((part) => {
    if (!restsElsewhere(part, sentence.citations, claim)) return [];
    const evidence = part.evidence[part.decidingEvidence ?? 0];
    return evidence
      ? [
          {
            claim,
            span: part.span,
            citation: { ...evidence, check: "found", checkReason: null, foundByCheck: true },
          },
        ]
      : [];
  });
}

/** The insert of the write's change that `node` is still in, waiting for the User; null: none. */
function waitingInsert(node: NodeJSON | undefined, change: string) {
  const inserted = (node?.marks ?? []).find((mark) => mark.type === PROPOSAL_INSERT_MARK);
  const ref = readProposalRef(inserted?.attrs);
  return ref?.request === change ? ref : null;
}

/** Whether the paragraph is still a whole Block the write's change adds, waiting for the User. */
function waitingBlock(element: Y.XmlElement, change: string): boolean {
  for (let at: Y.XmlElement | Y.XmlFragment | null = element; at instanceof Y.XmlElement; ) {
    const proposal = readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE));
    if (proposal?.kind === "insert" && proposal.request === change) return true;
    at = at.parent instanceof Y.XmlElement ? at.parent : null;
  }
  return false;
}

/**
 * The sentence `from`..`to` of a paragraph's content as the Note holds it, each found Passage's
 * Citation after its part's words (`at`, in the paragraph's offsets), and how many went in. One
 * goes in only inside the write's change while it still waits, as part of it: after words that
 * change inserts (the nearest words before it, past any Citation), or in a Block it adds. After
 * words the User accepted, or their own, a check writes nothing (#3019); the sentence reads found
 * elsewhere, with Add as Citation on its card.
 */
function withFound(
  content: readonly NodeJSON[],
  from: number,
  to: number,
  found: readonly { at: number; citation: CitationAttributes }[],
  change: { request: string; block: boolean },
): { nodes: NodeJSON[]; added: number } {
  const out: NodeJSON[] = [];
  let added = 0;
  const cited = new Set<number>();
  const points = new Set(found.map((each) => each.at));
  let before: NodeJSON | undefined;
  const cite = (at: number, beside = before) => {
    if (!points.has(at) || cited.has(at)) return;
    cited.add(at);
    const ref = waitingInsert(beside, change.request);
    if (!ref && !change.block) return;
    for (const each of found.filter((one) => one.at === at)) {
      added++;
      out.push({
        type: CITATION_NODE,
        attrs: {
          ...Object.fromEntries(
            Object.entries(each.citation).filter(
              ([, value]) => value !== null && value !== undefined,
            ),
          ),
          ...(ref && { [PROPOSAL_ATTRIBUTE]: { ...ref, kind: "insert" } }),
        },
      });
    }
  };
  for (const { node, start } of inlineLayout(content)) {
    if (node.type !== "text") {
      if (start < from || start >= to) continue;
      cite(start);
      out.push(node);
      continue;
    }
    const text = node.text ?? "";
    const end = Math.min(to, start + text.length);
    let at = Math.max(from, start);
    if (at >= end) continue;
    cite(at, before ?? node);
    for (const cut of [...points]
      .filter((point) => point > at && point < end)
      .sort((a, b) => a - b)) {
      before = { ...node, text: text.slice(at - start, cut - start) };
      out.push(before);
      cite(cut);
      at = cut;
    }
    before = { ...node, text: text.slice(at - start, end - start) };
    out.push(before);
    cite(end);
  }
  cite(to);
  return { nodes: out, added };
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
        const marks = marksOfRun(run.attributes).map((mark) => ({
          ...mark,
          attrs: mark.attrs ?? {},
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
 * changed them, its mark shows its check needs doing again. The Passages its check found go in as
 * its parts' Citations only inside the write's change `change` while it still waits there for the
 * User; once they accepted, rejected or changed it, its words are theirs and a check writes nothing
 * into them (#3019). A sentence of opinion only loses the mark it was checked under. False when
 * the sentence is gone from the Mind.
 */
function land(
  blocks: Y.XmlFragment,
  ids: readonly string[],
  change: string,
  landing: Landing,
): boolean {
  const { sentence } = landing;
  const element = paragraphIn(blocks, ids, sentence.path);
  const place = element ? placeOf(element, sentence) : null;
  if (!element || !place) return false;
  if ("opinion" in landing) {
    unmarkSentence(element, place.from, place.to, "check-against-documents");
    const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (!place.same || typeof blockId !== "string" || landing.opinion.length === 0) return true;
    const now = sentenceOf(element, blockId, place, figuresByBlock(blocks));
    recordOpinions(blocks, [{ ...now, parts: landing.opinion }]);
    return true;
  }
  const mark = landing.mark(blocks);
  const found = place.same ? foundPlaces(blocks, element, place, landing.found ?? []) : [];
  if (found.length > 0) {
    const content = inlineOf(element);
    const cited = withFound(content, place.from, place.to, found, {
      request: change,
      block: waitingBlock(element, change),
    });
    if (cited.added > 0) {
      syncContent(element, replaced(content, place.from, place.to, withMark(cited.nodes, mark)));
      return true;
    }
  }
  markSentence(element, place.from, place.to, mark);
  return true;
}

/**
 * Where each found Passage's Citation goes in the paragraph: after its part's words, as read now,
 * before the stop a part that ends the sentence takes with it.
 */
function foundPlaces(
  blocks: Y.XmlFragment,
  element: Y.XmlElement,
  place: { from: number; to: number },
  found: readonly FoundCitation[],
): { at: number; citation: CitationAttributes }[] {
  const blockId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  if (found.length === 0 || typeof blockId !== "string") return [];
  const now = checkText(sentenceOf(element, blockId, place, figuresByBlock(blocks)));
  if (!now.projection) return [];
  const { projection } = now;
  const text = paragraphText(inlineOf(element));
  return found.flatMap(({ claim, span, citation }) => {
    const end = claim === now.claim ? inlineRange(projection, span.start, span.end)?.to : undefined;
    if (end === undefined) return [];
    return [{ at: end - citationClosingLength(text.slice(place.from, end)), citation }];
  });
}

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

/** A node's text as rejecting the write `write` leaves it: what the write added left out. */
function textBefore(node: Y.XmlElement | Y.XmlText, write: string): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as Run[])
      .filter(
        (run) =>
          readProposalRef(markValueOf(PROPOSAL_INSERT_MARK, run.attributes))?.request !== write,
      )
      .map((run) => (typeof run.insert === "string" ? run.insert : NODE_CHARACTER))
      .join("");
  }
  const proposal = readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE));
  if (proposal?.kind === "insert" && proposal.request === write) return "";
  if (INLINE_NODES.has(node.nodeName)) return NODE_CHARACTER;
  return node
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || child instanceof Y.XmlElement ? textBefore(child, write) : "",
    )
    .join("");
}

const holdsWrite = (element: Y.XmlElement, write: string) =>
  readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE))?.request === write ||
  pendingProposals(element).some((each) => each.request === write);

/**
 * What a write changed in its Mind, read as it lands: each top-level Block it added (`before`
 * null) or changed in place, with the text it had before. Its ids alone can't tell an Undo of a
 * rewrite in place, which keeps them (#2830).
 */
interface WriteShape {
  write: string;
  ids: readonly string[];
  changed: readonly { id: string; before: string | null }[];
}

function shapeOf(blocks: Y.XmlFragment, ids: readonly string[], write: string): WriteShape {
  const changed = topLevelBlocks(blocks).flatMap((element) => {
    const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (typeof id !== "string" || !ids.includes(id) || !holdsWrite(element, write)) return [];
    const own = readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE));
    const added = own?.kind === "insert" && own.request === write;
    return [{ id, before: added ? null : textBefore(element, write) }];
  });
  return { write, ids, changed };
}

/**
 * Whether the write is gone: every Block it added is, and every one it changed in place reads
 * as before it, none of its changes waiting there. An Undo and a reject leave a Mind so; an edit
 * of the User's doesn't. With nothing of it waiting as it landed, its Blocks must all be gone.
 */
function writeGoneFrom(blocks: Y.XmlFragment, shape: WriteShape): boolean {
  const top = new Map(
    topLevelBlocks(blocks).map((element) => [
      String(element.getAttribute(BLOCK_ID_ATTRIBUTE)),
      element,
    ]),
  );
  if (shape.changed.length === 0) return !shape.ids.some((id) => top.has(id));
  return shape.changed.every(({ id, before }) => {
    const element = top.get(id);
    if (!element) return true;
    return before !== null && !holdsWrite(element, shape.write) && targetText(element) === before;
  });
}

/**
 * The check's mark on a sentence where it reads as written in the Mind now; null for none,
 * undefined when it doesn't read so.
 */
function markOn(
  blocks: Y.XmlFragment,
  ids: readonly string[],
  sentence: Sentence,
): ClaimCheckAttributes | null | undefined {
  const element = paragraphIn(blocks, ids, sentence.path);
  const place = element ? placeOf(element, sentence) : null;
  if (!element || !place?.same) return undefined;
  let at = 0;
  for (const node of inlineOf(element)) {
    const size = node.type === "text" ? (node.text?.length ?? 0) : 1;
    if (node.type === "text" && at < place.to && at + size > place.from) {
      const mark = node.marks?.find((each) => each.type === CLAIM_CHECK_MARK);
      if (mark) return readClaimCheck(mark.attrs);
    }
    at += size;
  }
  return null;
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

/** A check of a write still running: its Mind, its write, and how to end it at once. */
interface LiveCheck {
  mindId: string;
  shape: WriteShape;
  /** Ends it as it is: what it hadn't checked lands not checked; `undone`, an Undo took its write away. */
  end(undone?: boolean): void;
  /** A newer write went over these top-level Blocks: their sentences are its check's now. */
  leave(ids: readonly string[]): void;
  /** A Redo brought its undone write back: its record says what it couldn't check, as a stopped check's does. */
  back(): void;
}

/** A check an Undo of its write ended, until a Redo brings the write back. */
type UndoneCheck = { request: string } & Pick<LiveCheck, "shape" | "back">;

export function createWrittenCheck(options: WrittenCheckOptions) {
  const live = new Map<string, LiveCheck>();
  /** By Mind: the checks an Undo of their write ended, newest last, until a Redo brings the write back. */
  const undone = new Map<string, UndoneCheck[]>();
  /** The Minds a check's write looked gone from, waiting a moment to see if it stays gone. */
  const confirming = new Set<string>();
  // One write's check at a time, each at most `claimsAtOnce` requests at once: two side by side
  // missed the first-verdict bar the limit was set by (#1635, #2532). Ends once the last one ends.
  let turn: Promise<void> = Promise.resolve();
  /** The checks begun and not ended, the one whose turn it is among them. */
  let begunChecks = 0;
  /** IncarnaMind quit: a write's check that would begin now reads nothing of the closed database. */
  const closed = () => options.closed.aborted;

  function requestOf(
    sentence: Sentence,
    read: ReturnType<typeof checkText> & { place?: RecordCitePlace },
    mindId: string,
    scope: CheckScope,
    prepared: PreparedChatModel,
    limit: Slots,
    signal: AbortSignal,
  ): ClaimCheckRequest {
    return {
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
      signal,
    };
  }

  /** Whether an Undo or a reject took the write away (`writeGoneFrom`), or its Mind went. */
  const writeGone = (mindId: string, shape: WriteShape) => {
    try {
      return options.read(mindId, (note) => writeGoneFrom(note, shape));
    } catch (error) {
      console.warn(
        `What the assistant wrote in Mind ${mindId} couldn't be read, so it is taken as gone:`,
        error,
      );
      return true;
    }
  };

  /** Ends a check an Undo took the write of away, keeping it for a Redo to bring back. */
  const endUndone = (request: string, check: LiveCheck) => {
    const kept = [...(undone.get(check.mindId) ?? []), { request, ...check }];
    undone.set(check.mindId, kept.slice(-UNDONE_KEPT));
    check.end(true);
  };

  /**
   * Null when there was nothing to check, it couldn't be checked here, or an Undo or a reject took
   * the write away before its check began. Resolves once the check has begun, each sentence it
   * reads shown as being checked; `input.ended` hears its end.
   */
  async function checkWritten(input: CheckWrittenInput): Promise<WrittenCheck | null> {
    const { mindId, blocks } = input;
    // Its Blocks hold the newer write's text now: an older check's verdicts there would be of words gone.
    for (const older of [...live.values()]) {
      if (older.mindId === mindId) older.leave(input.ids);
    }
    if (closed() || judgesUnreliably(input.prepared)) return null;
    const sentences = checkableSentences(blocks);
    if (sentences.length === 0) return null;
    // Read as the write lands, before anything is awaited: a reject meanwhile leaves no Proposal to
    // tell the write by, and a rewrite in place keeps its Blocks' ids.
    const { shape, markedBefore } = options.read(mindId, (note) => ({
      shape: shapeOf(note, input.ids, input.write),
      // As each sentence was marked before the write: an Undo that brings its words back brings
      // their mark back too, rather than this check's.
      markedBefore: new Map(
        sentences.map((sentence) => [sentence, markOn(note, input.ids, sentence)]),
      ),
    }));
    // Readied as IncarnaMind quits, the model's readiness reads the closed database: that is
    // the check ending, not failing.
    const allowed = await options.prepare(input.prepared).catch((error: unknown) => {
      if (closed()) return null;
      throw error;
    });
    if (closed()) return null;
    const waiting = !allowed && options.widened(input.prepared);
    if (!allowed && !waiting) return null;
    // Waiting, nothing is sent: the Answer's model only names who the marks wait for.
    const prepared = allowed ?? input.prepared;
    const holding = waiting || input.answerFailed === true;
    const quick = holding
      ? null
      : await options.quickModel(prepared).catch((error: unknown) => {
          if (closed()) return null;
          console.warn(
            `No quick model looks first at what the assistant wrote in Mind ${mindId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
    // An Undo or a reject while the check was readied reached no check yet: it marks nothing, which
    // would land on the words brought back, and sends nothing. A window writing the Blocks again
    // only looks so for a moment (#2378).
    if (closed()) return null;
    if (writeGone(mindId, shape)) {
      await new Promise((resolve) => setTimeout(resolve, UNDONE_SETTLE_MS));
      if (closed() || writeGone(mindId, shape)) return null;
    }
    // The write landed before the Stop: its sentences say they were stopped, as a Stop mid-check
    // leaves them (#2710), rather than no mark, which reads as checked.
    const stopped = !holding && input.signal.aborted;
    const atWrite = options.scopeOf(mindId);
    if (atWrite.searchable === 0) return null;
    // Taken again once the evidence can tell the copies of the Mind's imported file (`checkThem`).
    let scope = atWrite.check;
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
      running: !holding && !stopped,
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
    /**
     * The sentences no longer the write's: gone from the Mind when their check ended, or taken
     * over by a newer write over their Blocks. They leave its count.
     */
    const left = new Set<Sentence>();
    /** The sentences whose check ended, landed or held. */
    const settled = new Set<Sentence>();
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
      const found: boolean[] = [];
      input.edit((note) => {
        for (const { landing } of landings) found.push(land(note, input.ids, input.write, landing));
      });
      let outcomes = 0;
      for (const [index, { landing, outcome }] of landings.entries()) {
        if (!outcome) continue;
        settled.add(landing.sentence);
        if (found[index]) {
          counted(outcome);
          outcomes++;
        } else left.add(landing.sentence);
      }
      if (outcomes === 0) return;
      options.retainEvidence(mindId);
      input.progressed?.(snapshot());
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

    if (holding || stopped) {
      const reason = waiting ? "consent-widened" : stopped ? "stopped" : "answer-failed";
      landAll(
        sentences.map((sentence) => ({
          landing: failedLanding(sentence, reason, null),
          outcome: "failed" as const,
        })),
      );
      return snapshot();
    }

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
    /** Gives each sentence still marked by this check the mark `next` names for it, or none. */
    const remark = (next: (sentence: Sentence) => ClaimCheckAttributes | null | undefined) =>
      input.edit((note) => {
        for (const sentence of sentences) {
          const to = next(sentence);
          if (to === undefined || markOn(note, input.ids, sentence)?.request !== request) continue;
          const element = paragraphIn(note, input.ids, sentence.path);
          const place = element ? placeOf(element, sentence) : null;
          if (!element || !place) continue;
          if (to) markSentence(element, place.from, place.to, to);
          else unmarkSentence(element, place.from, place.to, "check-against-documents");
        }
      });
    const restoreBefore = () => remark((sentence) => markedBefore.get(sentence));
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
    // A sentence lands as its check ends, so its verdict shows while the others are checked. A
    // table's wait, and land together after every check, in their order, as their marks are
    // footed against each other as they land (a total against its cells). The count moves as
    // each check ends all the same.
    const held: { index: number; landing: Landing; outcome: Outcome }[] = [];
    let waitingTurn = begunChecks > 0;
    begunChecks++;
    let turnOver: () => void = () => undefined;
    const ours = new Promise<void>((resolve) => {
      turnOver = resolve;
    });
    const before = turn;
    turn = before.then(() => ours);
    const progress = () => {
      const heldOpinions = held.filter(({ outcome }) => outcome === "opinion").length;
      options.progress({
        mindId,
        request,
        done: done.checked + done.failed + held.length - heldOpinions,
        total: sentences.length - done.leftOut - heldOpinions - left.size,
        running: done.running,
        waiting: done.running && waitingTurn,
      });
    };
    const landHeld = () => {
      const landings = held
        .sort((a, b) => a.index - b.index)
        .map(({ landing, outcome }) => ({ landing, outcome }));
      held.length = 0;
      landAll(landings);
    };
    /** Each sentence's own stop, for a newer write that takes it over while it is checked. */
    const stops = new Map<Sentence, AbortController>();
    let over = false;
    const end = (undone = false) => {
      if (over) return;
      over = true;
      done.undone = undone;
      ending.abort();
      live.delete(request);
      // A table's verdicts that ended before a Stop or quitting are its cells' still; an Undo
      // took the cells away, and brings back the marks of the words it brings back.
      try {
        if (undone) restoreBefore();
        else landHeld();
      } catch (error) {
        console.error(
          `The marks of what the assistant wrote in Mind ${mindId} couldn't be settled:`,
          error,
        );
      }
      try {
        options.settleStopped(mindId, request);
      } catch (error) {
        console.error(
          `The sentences still checked in Mind ${mindId} couldn't be marked stopped:`,
          error,
        );
      }
      // Settled while it still runs: a request no longer running is one quitting settled already.
      tracked.done();
      // What never landed couldn't be checked: Stop, an Undo or quitting ended it first.
      done.checkable = sentences.length - left.size;
      done.sent = done.checkable;
      done.failed = done.checkable - done.leftOut - done.checked;
      done.running = false;
      held.length = 0;
      begunChecks--;
      turnOver();
      progress();
      input.ended?.(snapshot());
    };
    const leave = (ids: readonly string[]) => {
      const inBlocks = (sentence: Sentence) => {
        const top = input.ids[sentence.path[0] ?? -1];
        return top !== undefined && ids.includes(top);
      };
      const heldThere = held.filter((each) => inBlocks(each.landing.sentence));
      const taken = [
        ...sentences.filter((sentence) => inBlocks(sentence) && !settled.has(sentence)),
        ...heldThere.map((each) => each.landing.sentence),
      ];
      if (taken.length === 0) return;
      held.splice(0, held.length, ...held.filter((each) => !heldThere.includes(each)));
      for (const sentence of taken) {
        left.add(sentence);
        stops.get(sentence)?.abort();
      }
      progress();
    };
    const back = () => {
      done.undone = false;
      input.ended?.(snapshot());
    };
    live.set(request, { mindId, shape, end, leave, back });
    progress();

    const blockAway = (sentence: Sentence) => {
      const id = input.ids[sentence.path[0] ?? -1];
      try {
        return options.read(
          mindId,
          (note) =>
            writeGoneFrom(note, shape) ||
            !topLevelBlocks(note).some((each) => each.getAttribute(BLOCK_ID_ATTRIBUTE) === id),
        );
      } catch (error) {
        console.warn(
          `What the assistant wrote in Mind ${mindId} couldn't be read, so it is taken as gone:`,
          error,
        );
        return true;
      }
    };
    const landNow = (landing: Landing, outcome: Outcome) => {
      // The claims sort lands its opinions here too, after a newer write may have taken them over.
      if (over || signal.aborted || left.has(landing.sentence)) return;
      // A window that writes a Block again sends its removal and its return as two changes
      // (#2378): a verdict that comes between them waits with a table's, and an Undo that took the
      // write away, ending the check, drops it.
      if (landing.sentence.inCell || blockAway(landing.sentence)) {
        settled.add(landing.sentence);
        held.push({ index: sentences.indexOf(landing.sentence), landing, outcome });
      } else landAll([{ landing, outcome }]);
      progress();
    };
    const failed = (sentence: Sentence, reason: ClaimCheckFailure, detail: string | null) =>
      landNow(failedLanding(sentence, reason, detail), "failed");
    const behind = repliesFirst(options.repliesOut, options.timers ?? realTimers);
    const sending = behind.model(prepared);
    const quickSending = quick && behind.model(quick);
    const ran = checkRunOf(options, prepared, signal, mindId);
    const run = {
      ...ran,
      timers: behind.timers,
      // A request answered as IncarnaMind quits has no record left to go in.
      record: ran.record && {
        ...ran.record,
        recordAiUse: (inputs: Parameters<NonNullable<typeof ran.record>["recordAiUse"]>[0]) => {
          if (!closed()) ran.record?.recordAiUse(inputs);
        },
      },
    };
    const checks = new Map<Sentence, Checked>();
    const landed = (sentence: Sentence, outcome: CheckOutcome) => {
      // A quick model that said no read the sentence too: a use of AI, whatever its check came to.
      if (quick && looked.get(sentence)?.asked)
        recordCheck(run.record, quick, "result" in outcome ? outcome.result : null);
      if (over || signal.aborted || left.has(sentence)) return;
      if (!("result" in outcome)) {
        failed(sentence, outcome.reason, outcome.detail);
        return;
      }
      const { result } = outcome;
      const { by } = checks.get(sentence) ?? { by: prepared };
      if (result.parts && !result.parts.some((part) => part.kind === "fact")) {
        landNow({ sentence, opinion: result.parts.map(planOf) }, "opinion");
        return;
      }
      const at = options.now().toISOString();
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
      const found = foundCitations(sentence, reads.get(sentence)?.claim ?? sentence.text, result);
      landNow(
        { sentence, mark, found },
        result.verdict === "unsupported" || result.verdict === "contradicted"
          ? result.verdict
          : "checked",
      );
    };
    // Every request the check sends waits for one of these, the first looks and the sort's too;
    // and as many sentences at once, cited or not, as main's check had (#2532).
    const limit = slots(claimsAtOnce(prepared));
    const sentencesAtOnce = slots(claimsAtOnce(prepared));
    // A sentence its check asks about again, after a rate limit, keeps its first look's answer:
    // asked again, a quick model's later yes would stand.
    const looked = new Map<Sentence, FirstLookResult>();
    const takenOver = (): ClaimCheckResult => ({
      verdict: "not-checked",
      reason: "stopped",
      detail: null,
      versions: [],
      excluded: [],
    });
    const checkOne = (sentence: Sentence, attempt: CheckTry): Promise<ClaimCheckResult> =>
      sentencesAtOnce.run(() => checkSentence(sentence, attempt));
    const checkSentence = (sentence: Sentence, attempt: CheckTry): Promise<ClaimCheckResult> =>
      asCheckWork(async () => {
        const own = new AbortController();
        stops.set(sentence, own);
        if (left.has(sentence)) own.abort();
        const ended = AbortSignal.any([signal, own.signal]);
        // A newer write took it over before its check began: nothing was sent, nothing failed.
        if (own.signal.aborted) return takenOver();
        signal.throwIfAborted();
        // A write that looks gone may be undone: nothing more is sent until `mindChanged` knows.
        if (writeGone(mindId, shape)) {
          await new Promise((resolve) => setTimeout(resolve, UNDONE_SETTLE_MS));
          if (own.signal.aborted) return takenOver();
          signal.throwIfAborted();
        }
        // Behind a reply out on its provider before its clock starts, so its time limit never runs
        // while its first request waits.
        await behind.before(sending, ended);
        if (own.signal.aborted) return takenOver();
        signal.throwIfAborted();
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
              ask: (asked, until) =>
                limit.run(() => quickLook(quickSending ?? quick, asked, until)),
              signal: AbortSignal.any([
                ended,
                behind.timeout(run.timeLimitMs * FIRST_LOOK_SHARE, ended),
              ]),
            })));
        if (quick && first?.result) {
          recordCheck(run.record, quick, first.result);
          checks.set(sentence, { by: quick });
          return first.result;
        }
        if (first) looked.set(sentence, first);
        checks.set(sentence, { by: prepared });
        return attempt(
          options.claimCheck,
          requestOf(sentence, read, mindId, scope, sending, limit, ended),
        );
      });
    const checkAll = (items: readonly Sentence[]) =>
      runClaimChecks(items, checkOne, {
        ...run,
        concurrency: claimsAtOnce(prepared),
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
     * the others lose their mark, an opinion's left out as Check this Note leaves it. One the sort
     * left undecided is a claim, as Check this Note keeps it. A sort that fails, or takes longer
     * than one sentence's check may, leaves each to its own check, which names its parts too.
     */
    const claimsOf = async (uncited: readonly Sentence[]): Promise<readonly Sentence[]> => {
      if (uncited.length === 0) return [];
      await behind.before(sending, signal);
      if (signal.aborted) return [];
      const timedOut =
        options.sortTimeLimit?.() ??
        behind.timeout(options.claimTimeLimitMs ?? CLAIM_TIME_LIMIT_MS, signal);
      const found = await claimsAmong(
        sending,
        uncited.map((sentence) => ({ text: reads.get(sentence)?.claim ?? sentence.text })),
        "own",
        AbortSignal.any([signal, timedOut]),
        true,
        { slots: limit },
      );
      if (found.kind === "cancelled" && timedOut.aborted && !signal.aborted) {
        console.warn(
          `The claims among what the assistant wrote in Mind ${mindId} weren't named in time, so each is checked.`,
        );
        return uncited;
      }
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
          found.undecided.has(index) ||
          parts.some((part) => part.kind === "fact") ||
          (reads.get(sentence)?.figures?.length ?? 0) > 0
        )
          claims.push(sentence);
        else landNow({ sentence, opinion: parts }, "opinion");
      }
      return claims;
    };
    /** Not checked for the stop the cited sentences met, with nothing sent: it would stop these too. */
    const stoppedBy = (items: readonly Sentence[], stop: RunStop) => {
      let outcomeError: { error: unknown } | null = null;
      for (const sentence of items) {
        try {
          landed(sentence, { failure: "stop", reason: stop.reason, detail: null, stop });
        } catch (error) {
          if (error instanceof MindReadOnlyError) refused = true;
          outcomeError ??= { error };
        }
      }
      return { stop, outcomeError };
    };
    const checkThem = async () => {
      try {
        // Its turn, or a Stop, an Undo, a reject or quitting first, which ends it with nothing sent.
        if (!signal.aborted) {
          await Promise.race([
            before,
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        }
        if (signal.aborted) return;
        if (waitingTurn) {
          waitingTurn = false;
          progress();
        }
        // The reply didn't wait for it: a Note imported from Word leaves its original's copies
        // out, and they must all be told first (#2216).
        await options.evidenceReady(signal, mindId);
        if (signal.aborted) return;
        const ready = options.scopeOf(mindId);
        if (ready.searchable === 0) {
          // Its only Documents were copies of its own file: nothing is checked, as when the
          // write finds no Document, and its sentences lose their marks.
          for (const sentence of sentences) left.add(sentence);
          remark(() => null);
          return;
        }
        scope = ready.check;
        // The cited sentences first, in the Note's order, so the marks main's check gives land
        // first (#2830); those with none after them, once the sort has named their claims.
        const cited = await checkAll(sentences.filter((sentence) => sentence.cited.length > 0));
        const rest = sentences.filter((sentence) => sentence.cited.length === 0);
        const uncited = cited.stop
          ? stoppedBy(rest, cited.stop)
          : await checkAll(await claimsOf(rest));
        done.stop = cited.stop ?? uncited.stop;
        const outcomeError = cited.outcomeError ?? uncited.outcomeError;
        if (outcomeError !== null) throw outcomeError.error;
      } catch (error) {
        console.error(`What the assistant wrote in Mind ${mindId} couldn't be checked:`, error);
      } finally {
        // Its last checks may end as an Undo takes the write away, before `mindChanged` knows, or
        // as a window writes a held verdict's Block again.
        if (
          !over &&
          (writeGone(mindId, shape) || held.some(({ landing }) => blockAway(landing.sentence)))
        ) {
          await new Promise((resolve) => setTimeout(resolve, UNDONE_SETTLE_MS));
        }
        const check = live.get(request);
        if (check && writeGone(mindId, shape)) endUndone(request, check);
        else end();
      }
    };
    void checkThem();
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
        const back = ended.filter((each) => !writeGone(mindId, each.shape));
        for (const each of back) {
          try {
            options.settleBroughtBack(mindId, each.request);
          } catch (error) {
            console.error(`A check undone in Mind ${mindId} couldn't be marked stopped:`, error);
          }
          each.back();
        }
        if (back.length > 0) {
          const left = ended.filter((each) => !back.includes(each));
          if (left.length > 0) undone.set(mindId, left);
          else undone.delete(mindId);
        }
        const gone = () =>
          [...live].filter(
            ([, check]) => check.mindId === mindId && writeGone(mindId, check.shape),
          );
        if (confirming.has(mindId) || gone().length === 0) return;
        // A window that draws a Block again sends its removal and its return as two changes: the
        // write is taken as undone only once it is still gone a moment later.
        confirming.add(mindId);
        setTimeout(() => {
          confirming.delete(mindId);
          for (const [request, check] of gone()) endUndone(request, check);
        }, UNDONE_SETTLE_MS);
      });
    },

    /** Ends every check at once, as IncarnaMind quits: what each hadn't checked lands not checked. */
    stopAll(): void {
      for (const check of [...live.values()]) check.end();
    },
  };
}
