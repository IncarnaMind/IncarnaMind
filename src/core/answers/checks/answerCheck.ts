/**
 * An Answer's sentences with Citations, judged once it ends (#2311). The Citation check finds a
 * quote's words where it points, never whether they back the sentence: "包括两台 K9 窑炉并已安装好"
 * kept the green check of "£185,000 for two K9 kilns, installed". Its sentences are judged top to
 * bottom in batches against the Passages their Citations quote (./sentenceBatch), on the model that
 * answered as its own request used it, a few batches at a time, each within the claim time limit;
 * none on a model on this computer too small to judge reliably (#680). Its Citations show the
 * result: found only when it is supported. A limit that stops the judgement stops it at a batch,
 * so the sentences it leaves are the last ones.
 */
import { generateText } from "ai";
import { type CitedSentence, citedSentences } from "../../../shared/citedSentences";
import { judgesUnreliably } from "../../../shared/smallModel";
import type {
  ChatModelChoice,
  Citation,
  CitedQuote,
  MarkedCitation,
  MarkedFigure,
} from "../../api";
import type { EstimatedRead } from "../../cost/meter";
import type { EvidenceScope } from "../../documents/evidence";
import type { PreparedChatModel } from "../../providers/chat";
import { outputTokens } from "../../providers/outputLimits";
import { classifyProviderError } from "../../providers/providerErrors";
import { inStep } from "../../timing/flows";
import { estimateTokens } from "../context";
import { answerTemperature } from "../engine";
import { needsCalculation } from "./calculationGate";
import type { CheckedCitation } from "./claimCheck";
import { claimsAtOnce } from "./runChecks";
import {
  type BatchPassage,
  type BatchSentence,
  type BatchVerdict,
  batchesOf,
  batchPrompt,
  readBatchReply,
  SENTENCE_BATCH_INSTRUCTIONS,
} from "./sentenceBatch";

/** What a checked sentence's result makes of each of its found Citations. */
export interface SupportResult {
  check: "found" | "unsupported" | "contradicted";
  /** For unsupported or contradicted: what the Documents say, in one plain sentence. */
  verdict: string | null;
}

/** The limit that stopped a judgement before a sentence: the Answer's own, or the monthly cap. */
export type JudgementStop = "answer-limit" | "monthly-limit";

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
  /**
   * Each waiting marker's result once every sentence it is cited in is judged; null when one
   * couldn't be, with the limit that stopped it, if one did.
   */
  onJudged?(marker: number, result: SupportResult | null, stop: JudgementStop | null): void;
}

export interface AnswerCheckOptions {
  /** The model that answered, as the Answer's own request used it; null when it can't be used now. */
  prepare(choice: ChatModelChoice): Promise<PreparedChatModel | null>;
  scope(documentIds: readonly string[] | null): EvidenceScope;
  searchableCount(documentIds: readonly string[] | null): number;
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): CheckedCitation[];
  /** The Passages those quotes are on, within the scope. */
  passages(cited: readonly CheckedCitation[], scope: EvidenceScope): BatchPassage[];
  /** A cited Document's Units, for whether the quotes state a sentence's numbers. */
  units(citation: Citation): readonly { text: string }[];
  /** How long one batch may take: a reply may never come. */
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

/** A sentence a batch judged, as its Citations show it; null when it isn't judged. */
async function supportOf(
  sentence: CitedSentence & { found: MarkedCitation[] },
  verdict: BatchVerdict | undefined,
  units: AnswerCheckOptions["units"],
): Promise<SupportResult | null> {
  // A sentence sorted as all opinion is left unjudged, never supported: the sort is a model's, and
  // a fact sorted as opinion must not show the green check.
  if (!verdict || verdict.kind === "opinion") return null;
  if (verdict.verdict === "contradicted") return { check: "contradicted", verdict: verdict.says };
  // Who does it, and whether it has happened, as Roles and Time do in a sentence's own check (#1668).
  if (
    verdict.verdict === "unsupported" ||
    verdict.roles === "differs" ||
    verdict.time === "differs"
  ) {
    return { check: "unsupported", verdict: verdict.says };
  }
  // A number no quote states is a calculation no one made (ADR-0021): the sentence isn't judged.
  const calculation = await needsCalculation({
    claim: sentence.sentence,
    verdict: { verdict: "supported", topic: "found", calculations: [] },
    attempted: false,
    computed: [],
    inputs: [],
    citations: sentence.found.map((citation) => ({ citation, units: units(citation) })),
    confirm: async () => false,
  });
  return calculation ? null : { check: "found", verdict: null };
}

/** The limit a failed batch met, if it was one. */
function stopOf(error: unknown): JudgementStop | null {
  const failure = classifyProviderError(error);
  if (failure.kind !== "cost-cap") return null;
  return failure.budget ? "answer-limit" : "monthly-limit";
}

/** About what a batch's reply writes for each sentence. */
const LIKELY_OUTPUT_TOKENS = 120;

export function createAnswerCheck(options: AnswerCheckOptions) {
  /** The sentences to judge, each with what it cites and the Passages those quotes are on. */
  function asked(input: Omit<AnswerCheckInput, "model" | "signal">) {
    const scope = options.scope(input.documentIds);
    return sentencesToCheck(input).map((sentence) => {
      const cited = options.citedNow(sentence.found);
      return {
        ...sentence,
        quotes: cited,
        passages: options.passages(cited, scope),
      } satisfies BatchSentence;
    });
  }

  /** The requests judging would send, a batch each: about what each writes, and the most it may. */
  function requests(input: Omit<AnswerCheckInput, "model" | "signal">): EstimatedRead | null {
    const batches = batchesOf(asked(input).filter((sentence) => sentence.passages.length > 0));
    if (batches.length === 0) return null;
    const inputTokens = (batch: BatchSentence[]) =>
      estimateTokens(SENTENCE_BATCH_INSTRUCTIONS) + estimateTokens(batchPrompt(batch));
    return {
      likely: batches.map((batch) => ({
        inputTokens: inputTokens(batch),
        outputTokens: LIKELY_OUTPUT_TOKENS * batch.length,
      })),
      most: batches.map((batch) => ({
        inputTokens: inputTokens(batch),
        outputTokens: outputTokens("sentence-batch", batch.length),
      })),
    };
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
    const judged = asked(input);

    const waitingIn = (sentence: (typeof judged)[number]) =>
      sentence.found.filter(({ marker }) => input.waiting.has(marker));
    const left = new Map<number, number>();
    for (const { marker } of judged.flatMap(waitingIn)) {
      left.set(marker, (left.get(marker) ?? 0) + 1);
    }
    const worst = new Map<number, SupportResult>();
    const unjudged = new Map<number, JudgementStop | null>();
    const results = new Map<number, SupportResult>();
    const settle = (
      sentence: (typeof judged)[number],
      support: SupportResult | null,
      stop: JudgementStop | null,
    ) => {
      for (const { marker } of waitingIn(sentence)) {
        const before = worst.get(marker);
        if (!support) unjudged.set(marker, unjudged.get(marker) ?? stop);
        else if (!before || WORSE[support.check] > WORSE[before.check]) worst.set(marker, support);
        const remaining = (left.get(marker) ?? 1) - 1;
        left.set(marker, remaining);
        if (remaining > 0) continue;
        const result = worst.get(marker);
        const known = result && (!unjudged.has(marker) || result.check !== "found");
        if (known) results.set(marker, result);
        input.onJudged?.(
          marker,
          known ? result : null,
          known ? null : (unjudged.get(marker) ?? null),
        );
      }
    };

    /** The limit that stopped the judgement: no batch after the one it stopped sends anything. */
    let stopped: JudgementStop | null = null;
    const judge = async (batch: (typeof judged)[number][]) => {
      if (stopped || input.signal.aborted) {
        for (const sentence of batch) settle(sentence, null, stopped);
        return;
      }
      const ended = AbortSignal.any([input.signal, AbortSignal.timeout(options.claimTimeLimitMs)]);
      let verdicts = new Map<number, BatchVerdict>();
      try {
        const { text } = await generateText({
          model: prepared.model,
          instructions: SENTENCE_BATCH_INSTRUCTIONS,
          prompt: batchPrompt(batch),
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
          maxOutputTokens: outputTokens("sentence-batch", batch.length),
          maxRetries: 1,
          abortSignal: ended,
        });
        verdicts = await readBatchReply(text, batch.length);
      } catch (error) {
        const stop = stopOf(error);
        if (stop) stopped ??= stop;
        for (const sentence of batch) settle(sentence, null, stop);
        return;
      }
      for (const [index, sentence] of batch.entries()) {
        settle(sentence, await supportOf(sentence, verdicts.get(index + 1), options.units), null);
      }
    };

    // In order, a few at a time: a limit met at one batch leaves the ones after it.
    // A sentence whose quotes are on no Passage in scope, such as an older version's, has nothing
    // to be judged against: it isn't sent.
    for (const sentence of judged) if (sentence.passages.length === 0) settle(sentence, null, null);
    const queue = batchesOf(judged.filter((sentence) => sentence.passages.length > 0));
    const workers = Array.from(
      { length: Math.min(claimsAtOnce(prepared), queue.length) },
      async () => {
        for (let batch = queue.shift(); batch; batch = queue.shift()) await judge(batch);
      },
    );
    await Promise.all(workers);
    return results;
  }

  return {
    check: (input: AnswerCheckInput) => inStep("answer-check", () => checkAnswer(input)),
    requests,
  };
}
