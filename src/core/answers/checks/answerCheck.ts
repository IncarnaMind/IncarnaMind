/**
 * An Answer's sentences with Citations, checked before it ends (#2311). The Citation check finds
 * a quote's words where it points, never whether they back the sentence: "包括两台 K9 窑炉并已
 * 安装好" kept its found Citation of "£185,000 for two K9 kilns, installed". Each sentence is
 * checked as Check this Note checks it (./claimCheck), with the quotes it cites, in the Answer's
 * Search scope, and its Citations show the result: found only when it is supported.
 *
 * The first `SENTENCES_CHECKED_AT_MOST`, a few at a time, each within the claim time limit, on
 * the Answer's model prepared for the checks flow, which never asks; none on a model on this
 * computer too small to judge reliably (#680). A sentence that couldn't be checked keeps its
 * Citations as the Citation check left them.
 */
import { SENTENCES_CHECKED_AT_MOST } from "../../../shared/claimChecks";
import { FIGURE_MARKER } from "../../../shared/figureMarkers";
import { comparableSentence, INLINE_NODE, isClaim, sentenceSpans } from "../../../shared/sentences";
import { judgesUnreliably } from "../../../shared/smallModel";
import type {
  ChatModelChoice,
  CitedQuote,
  ClaimCheckResult,
  MarkedCitation,
  MarkedFigure,
} from "../../api";
import type { EvidenceScope } from "../../documents/evidence";
import type { PreparedChatModel } from "../../providers/chat";
import { runItems, slots } from "../../runs/stop";
import { inStep } from "../../timing/flows";
import type { CheckedCitation, ClaimCheckRequest } from "./claimCheck";
import { claimsAtOnce } from "./runChecks";

export interface CitedSentence {
  /** The sentence without its Citation markers. */
  sentence: string;
  /** Its paragraph, list item or table row, also without them. */
  context: string;
  /** The Citation markers it holds, in order. */
  markers: number[];
  /** It shows a Calculated figure, whose own check is the Calculation check (ADR-0021). */
  calculated: boolean;
}

const MARKER = /\[\^(\d+)\]/g;
const FOOTNOTE_LINE = /^\s*\[\^\d+\]:/;
const BLOCK_MARKUP = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;
const BEFORE_MARKER = new RegExp(`\\s+(?=${INLINE_NODE})`, "gu");

/** Where a Calculated figure's shown text starts, while the sentences are found. */
const FIGURE_START = "\uE000";

const inlineNodes = (text: string) => text.split(INLINE_NODE).length - 1;

/** A marker leaves nothing behind, not even the space before it: "is quadratic [^2]." reads "is quadratic.". */
const withoutMarkers = (text: string) =>
  comparableSentence(text.replace(BEFORE_MARKER, "").replaceAll(FIGURE_START, ""));

/** The claims of an Answer's Markdown that hold a Citation marker, each with its markers. */
export function citedSentences(
  text: string,
  figures: readonly Pick<MarkedFigure, "marker" | "shown">[] = [],
): CitedSentence[] {
  const found: CitedSentence[] = [];
  for (const line of text.split("\n")) {
    if (FOOTNOTE_LINE.test(line)) continue;
    const markers: number[] = [];
    const marked = line
      .replace(BLOCK_MARKUP, "")
      .replace(
        FIGURE_MARKER,
        (marker, number: string) =>
          `${FIGURE_START}${figures.find((each) => each.marker === Number(number))?.shown ?? marker}`,
      )
      .replace(MARKER, (_, number: string) => {
        markers.push(Number(number));
        return INLINE_NODE;
      })
      .replace(/[*_`]/g, "")
      .replace(/\|/g, " ");
    const context = withoutMarkers(marked);
    for (const { from, to } of sentenceSpans(marked)) {
      const before = inlineNodes(marked.slice(0, from));
      const inside = markers.slice(before, before + inlineNodes(marked.slice(from, to)));
      const sentence = withoutMarkers(marked.slice(from, to));
      if (inside.length > 0 && isClaim(sentence)) {
        const calculated = marked.slice(from, to).includes(FIGURE_START);
        found.push({ sentence, context, markers: inside, calculated });
      }
    }
  }
  return found;
}

/** What a checked sentence's result makes of each of its found Citations. */
export interface SupportResult {
  check: "found" | "unsupported" | "contradicted";
  /** For unsupported or contradicted: what the Documents say, in one plain sentence. */
  verdict: string | null;
}

export interface AnswerCheckInput {
  text: string;
  citations: readonly MarkedCitation[];
  figures: readonly MarkedFigure[];
  /** The Documents of the Answer's Search scope; null: every Document. */
  documentIds: readonly string[] | null;
  model: ChatModelChoice;
  signal: AbortSignal;
}

export interface AnswerCheckOptions {
  /** The model prepared for the checks flow; null when that flow may not send to it now. Never asks. */
  prepare(choice: ChatModelChoice): Promise<PreparedChatModel | null>;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  scope(documentIds: readonly string[] | null): EvidenceScope;
  searchableCount(documentIds: readonly string[] | null): number;
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): CheckedCitation[];
  /** How long one check may take: a reply may never come. */
  claimTimeLimitMs: number;
}

/**
 * The sentences the check reads: claims whose Citations' quotes were found, each with those. One
 * that shows a Calculated figure is left to the figure's own check: the sentence holds a number no
 * Passage states.
 */
function sentencesToCheck(
  input: Pick<AnswerCheckInput, "text" | "citations" | "figures">,
): (CitedSentence & { found: MarkedCitation[] })[] {
  return citedSentences(input.text, input.figures)
    .filter((each) => !each.calculated)
    .map((each) => ({
      ...each,
      found: each.markers.flatMap((marker) => {
        const citation = input.citations.find((cited) => cited.marker === marker);
        return citation?.check === "found" ? [citation] : [];
      }),
    }))
    .filter((each) => each.found.length > 0)
    .slice(0, SENTENCES_CHECKED_AT_MOST);
}

const WORSE: Record<SupportResult["check"], number> = {
  found: 0,
  unsupported: 1,
  contradicted: 2,
};

function supportOf(result: ClaimCheckResult): SupportResult | null {
  if (result.parts && !result.parts.some((part) => part.kind === "fact")) return null;
  switch (result.verdict) {
    case "supported":
      return { check: "found", verdict: null };
    case "unsupported":
      return { check: "unsupported", verdict: result.unsupported?.reason ?? null };
    case "contradicted":
      return { check: "contradicted", verdict: result.says };
    default:
      return null;
  }
}

export function createAnswerCheck(options: AnswerCheckOptions) {
  /** One sentence's check, given up on once it takes longer than the time limit. */
  async function checkWithin(request: ClaimCheckRequest): Promise<ClaimCheckResult | null> {
    const ended = AbortSignal.any([request.signal, AbortSignal.timeout(options.claimTimeLimitMs)]);
    // A reply that never comes, even once aborted, is given up on all the same.
    const givenUp = new Promise<null>((resolve) =>
      ended.addEventListener("abort", () => resolve(null), { once: true }),
    );
    return Promise.race([options.claimCheck({ ...request, signal: ended }), givenUp]);
  }

  /**
   * Each checked marker's result, its sentences' worst; null when nothing could be checked here.
   * A marker missing from it keeps the Citation check's result.
   */
  async function checkAnswer(input: AnswerCheckInput): Promise<Map<number, SupportResult> | null> {
    const sentences = sentencesToCheck(input);
    if (sentences.length === 0) return null;
    const prepared = await options.prepare(input.model);
    if (!prepared || judgesUnreliably(prepared)) return null;
    const scope = options.scope(input.documentIds);
    if (options.searchableCount(scope.documentIds) === 0) return null;
    const limit = slots(claimsAtOnce(prepared));
    const { outcomes } = await runItems(
      sentences,
      (sentence) =>
        checkWithin({
          claim: sentence.sentence,
          context: sentence.context,
          cited: options.citedNow(sentence.found),
          scope,
          model: prepared,
          opinionsLeftOut: true,
          slots: limit,
          signal: input.signal,
        }),
      { concurrency: claimsAtOnce(prepared), signal: input.signal },
    );
    const results = new Map<number, SupportResult>();
    sentences.forEach((sentence, index) => {
      const outcome = outcomes[index];
      const support = outcome?.status === "done" && outcome.value ? supportOf(outcome.value) : null;
      if (!support) return;
      for (const { marker } of sentence.found) {
        const before = results.get(marker);
        if (!before || WORSE[support.check] > WORSE[before.check]) results.set(marker, support);
      }
    });
    return results;
  }

  return (input: AnswerCheckInput) => inStep("answer-check", () => checkAnswer(input));
}
