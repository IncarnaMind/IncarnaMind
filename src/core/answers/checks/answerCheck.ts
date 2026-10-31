/**
 * An Answer's sentences with Citations, judged once it ends (#2311). The Citation check finds a
 * quote's words where it points, never whether they back the sentence: "包括两台 K9 窑炉并已安装好"
 * kept the green check of "£185,000 for two K9 kilns, installed". Each sentence is checked as Check
 * this Note checks it (./claimCheck), with the quotes it cites, in the Answer's Search scope, on the
 * model that answered as its own request used it, a few at a time and each within the claim time
 * limit; none on a model on this computer too small to judge reliably (#680). Its Citations show the
 * result: found only when it is supported.
 */
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
  /** It is a table's row: its cells, read as one line. */
  inTable: boolean;
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
    const inTable = line.trimStart().startsWith("|");
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
        found.push({ sentence, context, markers: inside, calculated, inTable });
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
  /** The Citations to judge: their sentences are checked with them, and with every found quote beside them. */
  waiting: ReadonlySet<number>;
  /** The Documents of the Answer's Search scope; null: every Document. */
  documentIds: readonly string[] | null;
  model: ChatModelChoice;
  signal: AbortSignal;
  /** Each waiting marker's result once every sentence it is cited in is judged; null when one couldn't be. */
  onJudged?(marker: number, result: SupportResult | null): void;
}

export interface AnswerCheckOptions {
  /** The model that answered, as the Answer's own request used it; null when it can't be used now. */
  prepare(choice: ChatModelChoice): Promise<PreparedChatModel | null>;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  scope(documentIds: readonly string[] | null): EvidenceScope;
  searchableCount(documentIds: readonly string[] | null): number;
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): CheckedCitation[];
  /** How long one check may take: a reply may never come. */
  claimTimeLimitMs: number;
}

/** The sentences that hold a waiting Citation, each with its Citations whose quotes were found. */
function sentencesToCheck(
  input: Pick<AnswerCheckInput, "text" | "citations" | "figures" | "waiting">,
): (CitedSentence & { found: MarkedCitation[] })[] {
  return citedSentences(input.text, input.figures)
    .filter((each) => !each.calculated)
    .filter((each) => each.markers.some((marker) => input.waiting.has(marker)))
    .map((each) => ({
      ...each,
      found: each.markers.flatMap((marker) => {
        const citation = input.citations.find((cited) => cited.marker === marker);
        return citation && (citation.check === "found" || input.waiting.has(marker))
          ? [citation]
          : [];
      }),
    }));
}

/**
 * The markers of the Citations whose quotes were found in the claims of an Answer: each sentence of
 * them is judged. A sentence that shows a Calculated figure is judged by the figure's own check
 * (ADR-0021), which reads the numbers its Citations quote and works the figure out.
 */
export function judgedMarkers(
  input: Pick<AnswerCheckInput, "text" | "citations" | "figures">,
): Set<number> {
  return new Set(
    citedSentences(input.text, input.figures)
      .filter((each) => !each.calculated)
      .flatMap((each) =>
        each.markers.filter(
          (marker) => input.citations.find((cited) => cited.marker === marker)?.check === "found",
        ),
      ),
  );
}

const WORSE: Record<SupportResult["check"], number> = {
  found: 0,
  unsupported: 1,
  contradicted: 2,
};

function supportOf(result: ClaimCheckResult): SupportResult | null {
  // A sentence that is all opinion claims nothing a quote could fail to back.
  if (result.parts && !result.parts.some((part) => part.kind === "fact")) {
    return { check: "found", verdict: null };
  }
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
   * Each waiting marker's result, its sentences' worst; null when nothing could be checked here. A
   * marker missing from it couldn't be judged: one of its sentences wasn't, and none it was judged
   * in was worse than supported.
   */
  async function checkAnswer(input: AnswerCheckInput): Promise<Map<number, SupportResult> | null> {
    const sentences = sentencesToCheck(input);
    if (sentences.length === 0) return null;
    const prepared = await options.prepare(input.model);
    if (!prepared || judgesUnreliably(prepared)) return null;
    const scope = options.scope(input.documentIds);
    if (options.searchableCount(scope.documentIds) === 0) return null;
    const waitingIn = (sentence: (typeof sentences)[number]) =>
      sentence.found.filter(({ marker }) => input.waiting.has(marker));
    const left = new Map<number, number>();
    for (const { marker } of sentences.flatMap(waitingIn)) {
      left.set(marker, (left.get(marker) ?? 0) + 1);
    }
    const worst = new Map<number, SupportResult>();
    const unjudged = new Set<number>();
    const results = new Map<number, SupportResult>();
    const limit = slots(claimsAtOnce(prepared));
    await runItems(
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
      {
        concurrency: claimsAtOnce(prepared),
        signal: input.signal,
        onOutcome: (sentence, outcome) => {
          const support =
            outcome.status === "done" && outcome.value ? supportOf(outcome.value) : null;
          for (const { marker } of waitingIn(sentence)) {
            const before = worst.get(marker);
            if (!support) unjudged.add(marker);
            else if (!before || WORSE[support.check] > WORSE[before.check]) {
              worst.set(marker, support);
            }
            const remaining = (left.get(marker) ?? 1) - 1;
            left.set(marker, remaining);
            if (remaining > 0) continue;
            const result = worst.get(marker);
            const known = result && (!unjudged.has(marker) || result.check !== "found");
            if (known) results.set(marker, result);
            input.onJudged?.(marker, known ? result : null);
          }
        },
      },
    );
    return results;
  }

  return (input: AnswerCheckInput) => inStep("answer-check", () => checkAnswer(input));
}
