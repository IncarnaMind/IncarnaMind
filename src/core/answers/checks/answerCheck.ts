/**
 * An Answer's sentences with Citations, judged once it ends (#2311). The Citation check finds a
 * quote's words where it points, never whether they back the sentence: "包括两台 K9 窑炉并已安装好"
 * kept the green check of "£185,000 for two K9 kilns, installed". Its sentences are judged top to
 * bottom in batches against the Passages their Citations quote (./sentenceBatch), on the model that
 * answered as its own request used it, a few batches at a time, each within the claim time limit;
 * none on a model on this computer too small to judge reliably (#680). Its Citations show the
 * result: found only when it is supported and the words it cites say so (#2739). A limit that
 * stops the judgement stops it at a batch, so the sentences it leaves are the last ones.
 */
import { type CitedSentence, citedSentences } from "../../../shared/citedSentences";
import type { Figure } from "../../../shared/figures";
import { judgesUnreliably } from "../../../shared/smallModel";
import type {
  ChatModelChoice,
  Citation,
  CitedQuote,
  Currency,
  MarkedCitation,
  MarkedFigure,
  Money,
  ProviderError,
} from "../../api";
import type { EstimatedRead, EstimatedRequest } from "../../cost/meter";
import { inCurrency, promptTokensOf } from "../../cost/price";
import type { EvidenceScope } from "../../documents/evidence";
import type { Language } from "../../language";
import type { PreparedChatModel } from "../../providers/chat";
import { type OwnRoom, outputTokens } from "../../providers/outputLimits";
import { currentTask } from "../../runs/current";
import { inStep } from "../../timing/flows";
import { estimateTokens } from "../context";
import { answerTemperature } from "../engine";
import { judge, lines } from "../judge";
import { figureReadings, needsCalculation } from "./calculationGate";
import type { CheckedCitation } from "./claimCheck";
import { claimsAtOnce } from "./runChecks";
import {
  BATCH_TAGS,
  type BatchPassage,
  type BatchSentence,
  type BatchVerdict,
  batchesOf,
  batchParts,
  batchPrompt,
  passesSentence,
  readBatchText,
  sentenceBatchInstructions,
} from "./sentenceBatch";
import type { UnitGate } from "./unitGate";
import { isSameUnit } from "./units";

/** What a checked sentence's result makes of each of its found Citations. */
export interface SupportResult {
  check: "found" | "unsupported" | "contradicted";
  /** For unsupported or contradicted: what the Documents say, in one plain sentence. */
  verdict: string | null;
}

/**
 * Why a judgement stopped before a sentence: the Answer's own limit, the monthly cap, or a model
 * on this computer too small to judge the sentence at all.
 */
export type JudgementStop = "answer-limit" | "monthly-limit" | "small-model";

/**
 * Why a sentence's batch was cut short where a limit had kept its room below the room for
 * thinking (#2962): the batches after it still go.
 */
export type JudgementCut = "answer-limit-unfinished" | "monthly-limit-unfinished";

const UNFINISHED = {
  "answer-limit": "answer-limit-unfinished",
  "monthly-limit": "monthly-limit-unfinished",
} as const satisfies Record<string, JudgementCut>;

/** A limit that can keep a batch below its room for thinking. */
type HeldBy = keyof typeof UNFINISHED;

export interface AnswerCheckInput {
  text: string;
  citations: readonly MarkedCitation[];
  figures: readonly MarkedFigure[];
  /** The Citations to judge: their sentences are checked with them, and with every found quote beside them. */
  waiting: ReadonlySet<number>;
  /** The Mind the Answer was asked in, whose own snapshot is never its evidence; null: none. */
  mindId: string | null;
  /** The Documents of the Answer's Search scope; null: every Document. */
  documentIds: readonly string[] | null;
  model: ChatModelChoice;
  signal: AbortSignal;
  /**
   * Each waiting marker's result once every sentence it is cited in is judged; null when one
   * couldn't be, with the limit that stopped it, if one did.
   */
  onJudged?(
    marker: number,
    result: SupportResult | null,
    stop: JudgementStop | JudgementCut | null,
  ): void;
  /**
   * Each sentence's own result as it is judged, before its markers' (`onJudged`), which are their
   * sentences' worst; null when it couldn't be judged. `read`: the model answered about it, even
   * where that leaves no result (sorted as opinion, words its quote doesn't state, a number that
   * needs a calculation). It changes no Citation's result.
   */
  onSentence?(sentence: CitedSentence, result: SupportResult | null, read: boolean): void;
  /** Why nothing was judged, when no batch was reached: the model can't judge the sentence. */
  onStop?(stop: JudgementStop): void;
}

export interface AnswerCheckOptions {
  /** The interface language: what a sentence's result on its Citations is written in. */
  language(): Language;
  /** The model that answered, as the Answer's own request used it; null when it can't be used now. */
  prepare(choice: ChatModelChoice): Promise<PreparedChatModel | null>;
  scope(mindId: string | null, documentIds: readonly string[] | null): EvidenceScope;
  searchableCount(documentIds: readonly string[] | null): number;
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): CheckedCitation[];
  /** The Passages those quotes are on, within the scope. */
  passages(cited: readonly CheckedCitation[], scope: EvidenceScope): BatchPassage[];
  /** A cited Document's Units, for whether the quotes state a sentence's numbers. */
  units(citation: Citation): readonly { text: string }[];
  /** Check against Documents' own gate: whether the quotes back the units the sentence states. */
  unstatedUnit: UnitGate;
  /** How long one batch may take: a reply may never come. */
  claimTimeLimitMs: number;
  /** The most one request may cost, as the meter reserves it; null for one it doesn't reserve. */
  mostOf(model: ChatModelChoice, request: EstimatedRequest): Money | null;
  /** What a Run's requests have settled at, in `currency`. */
  spent(runId: string, currency: Currency): number;
  /** What the monthly cap leaves, counting what open requests may cost; null with no cap. */
  capLeft(): Money | null;
}

/** The sentences that hold a waiting Citation, each with its Citations whose quotes were found. */
function sentencesToCheck(
  input: Pick<AnswerCheckInput, "text" | "citations" | "figures" | "waiting">,
): (CitedSentence & { found: MarkedCitation[] })[] {
  return citedSentences(input.text, input.figures, input.citations)
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
    citedSentences(input.text, input.figures, input.citations)
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
  { units, unstatedUnit }: Pick<AnswerCheckOptions, "units" | "unstatedUnit">,
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
  // A Citation shows its words beside the check: a sentence they don't state is never green,
  // whatever another part of the Passage says (#2739).
  if (!passesSentence(verdict)) return null;
  // A unit, currency or scale its quotes give otherwise is what Check against Documents finds too,
  // and says so in the same words (#2997).
  const unit = unstatedUnit(sentence.found, sentence.sentence);
  if (unit) return { check: "unsupported", verdict: unit.why.reason };
  // A number no quote states is a calculation no one made (ADR-0021): the sentence isn't judged.
  const calculation = await needsCalculation({
    claim: sentence.sentence,
    verdict: { verdict: "supported", topic: "found", calculations: [] },
    attempted: false,
    computed: [],
    inputs: [],
    citations: sentence.found.map((citation) => ({ citation, units: units(citation) })),
    quotedWords: [
      ...new Set(sentence.found.flatMap((citation) => citation.quotedWordsFound ?? [])),
    ],
    confirm: async (figure) => pinnedByModel(figure, sentence.found, units),
  });
  return calculation ? null : { check: "found", verdict: null };
}

/**
 * Whether the words the model quoted for a sentence, all its Citations' together, hold `figure` as
 * their one figure of its unit (#2739), read as the figure rule reads a quote: in its page's figure
 * context, a unit its page states included. A whole sentence shown around them may hold others of
 * that unit, and only the model's own words say which it meant. With nothing widened they are the
 * words the rule read, which hold several, so the sentence stays unjudged, as it always has.
 */
export function pinnedByModel(
  figure: Figure,
  cited: readonly Citation[],
  units: AnswerCheckOptions["units"],
): boolean {
  const ofUnit = cited.flatMap((citation) =>
    figureReadings(citation.given ?? citation.quote, units(citation)).filter((readings) =>
      readings.some((each) => isSameUnit(each.unit, figure.unit)),
    ),
  );
  const [only] = ofUnit;
  return (
    ofUnit.length === 1 &&
    only !== undefined &&
    only.some((each) => isSameUnit(each.unit, figure.unit) && each.value === figure.value)
  );
}

/** The limit a failed batch met, if it was one. */
function stopOf(failure: ProviderError): JudgementStop | null {
  if (failure.kind !== "cost-cap") return null;
  return failure.budget ? "answer-limit" : "monthly-limit";
}

/**
 * A batch's room for its thinking and records, held to the model's own room, as an Answer's is,
 * and never under the room for its records alone (#2951).
 */
const batchRoom = (sentences: number, own: OwnRoom): number =>
  Math.max(
    outputTokens("sentence-batch-records", sentences),
    outputTokens("sentence-batch", sentences, own),
  );

/**
 * The extra tokens each batch gets when `spare` tokens are shared in equal parts among batches
 * that each want up to `wanted` more (#2962): every batch the same, none past what it wants, and
 * what one can't use goes to the others. Infinity when every batch has all it wants.
 */
export function equalShare(spare: number, wanted: readonly number[]): number {
  let left = Math.max(0, spare);
  const sorted = [...wanted].sort((a, b) => a - b);
  for (const [at, want] of sorted.entries()) {
    const share = left / (sorted.length - at);
    if (want > share) return share;
    left -= want;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * A batch's request at its most, as the meter reserves it: its prompt counted as the meter counts
 * one, and all the reply may write, so a limit of their sum lets every batch through (#1554).
 */
function mostRequest(
  batch: readonly BatchSentence[],
  instructions: string,
  room: number,
): EstimatedRequest {
  const asSent = {
    content: [{ type: "text", text: batchPrompt(batch), providerOptions: CACHED }],
  };
  return {
    inputTokens: promptTokensOf([{ content: instructions }, asSent]),
    outputTokens: room,
  };
}

/** About what a batch's reply writes for each sentence. */
const LIKELY_OUTPUT_TOKENS = 120;
/** The cache mark a provider's request may carry on its text (../../providers/promptCache). */
const CACHED = { anthropic: { cacheControl: { type: "ephemeral" } } };

export function createAnswerCheck(options: AnswerCheckOptions) {
  /** The sentences to judge, each with what it cites and the Passages those quotes are on. */
  function asked(input: Omit<AnswerCheckInput, "model" | "signal">) {
    const scope = options.scope(input.mindId, input.documentIds);
    return sentencesToCheck(input).map((sentence) => {
      const cited = options.citedNow(sentence.found);
      return {
        ...sentence,
        quotes: cited,
        passages: options.passages(cited, scope),
      } satisfies BatchSentence;
    });
  }

  /**
   * The requests judging would send, a batch each: about what each writes, and the most it may on
   * a model of `own` room.
   */
  function requests(
    input: Omit<AnswerCheckInput, "model" | "signal">,
    own: OwnRoom,
  ): EstimatedRead | null {
    const batches = batchesOf(asked(input).filter((sentence) => sentence.passages.length > 0));
    if (batches.length === 0) return null;
    const instructions = sentenceBatchInstructions(options.language());
    const inputTokens = (batch: BatchSentence[]) =>
      estimateTokens(instructions) + estimateTokens(batchPrompt(batch));
    return {
      likely: batches.map((batch) => ({
        inputTokens: inputTokens(batch),
        outputTokens: LIKELY_OUTPUT_TOKENS * batch.length,
      })),
      most: batches.map((batch) => mostRequest(batch, instructions, batchRoom(batch.length, own))),
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
    if (!prepared) return null;
    if (judgesUnreliably(prepared)) {
      input.onStop?.("small-model");
      return null;
    }
    const scope = options.scope(input.mindId, input.documentIds);
    if (options.searchableCount(scope.documentIds) === 0) return null;
    const judged = asked(input);
    const instructions = sentenceBatchInstructions(options.language());

    const waitingIn = (sentence: (typeof judged)[number]) =>
      sentence.found.filter(({ marker }) => input.waiting.has(marker));
    const left = new Map<number, number>();
    for (const { marker } of judged.flatMap(waitingIn)) {
      left.set(marker, (left.get(marker) ?? 0) + 1);
    }
    const worst = new Map<number, SupportResult>();
    const unjudged = new Map<number, JudgementStop | JudgementCut | null>();
    const results = new Map<number, SupportResult>();
    const settle = (
      sentence: (typeof judged)[number],
      support: SupportResult | null,
      stop: JudgementStop | JudgementCut | null,
      read = false,
    ) => {
      input.onSentence?.(sentence, support, read);
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
    /** Batches with a request out, which the meter counts at the most each may cost until it settles. */
    let open = 0;
    /** What the batches out may cost at most, in the limit's currency. */
    let outMost = 0;
    let waiting: (() => void)[] = [];
    const settledAll = () =>
      open === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve));
    let sent = 0;

    /**
     * One request for a batch: its verdicts, the limit that refused it, the limit that held its
     * room when its reply was cut short at that room, or null when it failed.
     */
    const send = async (
      batch: (typeof judged)[number][],
      { most, room, held }: { most: number; room: number; held: HeldBy | null },
    ): Promise<Map<number, BatchVerdict> | JudgementStop | JudgementCut | null> => {
      const id = ++sent;
      open++;
      try {
        const judged = await judge({
          model: prepared.model,
          question: { id: "sentence-batch", instructions },
          within: { most: room },
          parts: batchParts(batch),
          data: BATCH_TAGS,
          // Read from its text, not as one JSON value: a reply can hold a corrected answer (#3029).
          reply: lines((text) => readBatchText(text, batch.length)),
          items: batch.length,
          retries: 1,
          signal: input.signal,
          timeoutMs: options.claimTimeLimitMs,
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
        });
        if (judged.ok && judged.value.size > 0) return judged.value;
        if (judged.ok || judged.reason === "unreadable" || judged.reason === "refused") {
          console.warn(
            `Batch ${id} of an Answer's ${batch.length} sentences had no readable reply.`,
          );
          return new Map();
        }
        if (judged.reason === "cut-short" && held) return UNFINISHED[held];
        return judged.error ? stopOf(judged.error) : null;
      } finally {
        outMost -= most;
        open--;
        if (open === 0) {
          for (const resolve of waiting) resolve();
          waiting = [];
        }
      }
    };

    /**
     * Whether a batch fits within the judgement's limit, counting what its batches have settled at
     * and what those still out may cost at most: batches are let through one after another, in
     * their order, so the one that doesn't fit is the first left, and none after it is sent. One
     * that would fit once those out have settled waits for them. Null: no limit holds it.
     */
    const task = currentTask.getStore();
    const limit = task?.budget ?? null;
    let admitted: Promise<unknown> = Promise.resolve();
    /**
     * The limit a batch that may cost `reserved` at most would pass now, if any. What the cap
     * leaves counts the batches out that the meter has reserved already, and those let through
     * that it hasn't yet are counted again: under a cap it errs early, never past it.
     */
    const passes = (reserved: Money | null): JudgementStop | null => {
      if (!reserved) return null;
      const out = (currency: Currency) =>
        limit ? inCurrency(outMost, limit.currency, currency) : 0;
      const cap = options.capLeft();
      if (
        cap &&
        out(cap.currency) + inCurrency(reserved.amount, reserved.currency, cap.currency) >
          cap.amount
      ) {
        return "monthly-limit";
      }
      if (!task || !limit) return null;
      const most = inCurrency(reserved.amount, reserved.currency, limit.currency);
      return options.spent(task.id, limit.currency) + outMost + most > limit.amount
        ? "answer-limit"
        : null;
    };
    const own: OwnRoom = {
      most: prepared.capabilities.facts.maxOutput,
      window: prepared.window?.outputTokens,
    };
    const reservedAt = (batch: (typeof judged)[number][], room: number) =>
      options.mostOf(input.model, mostRequest(batch, instructions, room));
    const recordsRoom = (batch: (typeof judged)[number][]) =>
      outputTokens("sentence-batch-records", batch.length);
    /** The batches of this check not admitted yet, in the order they go. */
    let unadmitted: (typeof judged)[number][][] = [];
    /**
     * What each limit leaves beyond the records' rooms of every batch not yet sent, open together
     * beside the batches out, in its own currency. The monthly cap counts a batch out twice, as
     * `passes` does once it is sent: what the meter set aside for it and what `outMost` holds.
     */
    const spareUnder = (atRecords: readonly Money[]) => {
      const total = (currency: Currency) =>
        atRecords.reduce((sum, each) => sum + inCurrency(each.amount, each.currency, currency), 0);
      const out = (currency: Currency) =>
        limit ? inCurrency(outMost, limit.currency, currency) : 0;
      const spare: {
        stop: HeldBy;
        amount: number;
        currency: Currency;
      }[] = [];
      const cap = options.capLeft();
      if (cap) {
        spare.push({
          stop: "monthly-limit",
          amount: cap.amount / 2 - out(cap.currency) - total(cap.currency),
          currency: cap.currency,
        });
      }
      if (task && limit) {
        spare.push({
          stop: "answer-limit",
          amount:
            limit.amount - options.spent(task.id, limit.currency) - outMost - total(limit.currency),
          currency: limit.currency,
        });
      }
      return spare;
    };
    /**
     * A batch's room (#2962): its records' room, and its equal part of what the limits leave once
     * every batch not yet sent is set aside at its records' room, so none of them waits or is
     * refused for it, up to its room for thinking. `held`: the limit that kept it below that room.
     */
    const roomFor = (batch: (typeof judged)[number][], atRecords: Money | null) => {
      const room = batchRoom(batch.length, own);
      const records = recordsRoom(batch);
      if (room <= records) return { room: records, reserved: atRecords, held: null };
      const roomy = reservedAt(batch, room);
      // A model with no price sets nothing aside, so no limit is at stake, even past the cap.
      if (!atRecords || !roomy) return { room, reserved: roomy, held: null };
      const unsent = [batch, ...unadmitted.filter((each) => each !== batch)];
      const old = unsent.flatMap((each) => {
        const reserved = each === batch ? atRecords : reservedAt(each, recordsRoom(each));
        return reserved ? [reserved] : [];
      });
      const perToken = (roomy.amount - atRecords.amount) / (room - records);
      const tightest = spareUnder(old)
        .map((each) => ({
          stop: each.stop,
          tokens: each.amount / inCurrency(perToken, atRecords.currency, each.currency),
        }))
        .reduce<{ stop: HeldBy; tokens: number } | null>(
          (least, each) => (least && least.tokens <= each.tokens ? least : each),
          null,
        );
      if (!tightest) return { room, reserved: roomy, held: null };
      const wanted = unsent.map((each) => batchRoom(each.length, own) - recordsRoom(each));
      // Within a millionth of a token: a limit set to the sum of the rooms gives each its whole.
      const share = Math.floor(equalShare(tightest.tokens, wanted) + 1e-6);
      const given = Math.min(room, records + share);
      return {
        room: given,
        reserved: given === room ? roomy : reservedAt(batch, given),
        held: given < room ? tightest.stop : null,
      };
    };
    const admit = (
      batch: (typeof judged)[number][],
    ): Promise<{ most: number; room: number; held: HeldBy | null } | JudgementStop | null> => {
      const turn = admitted.then(async () => {
        try {
          if (input.signal.aborted) return null;
          const atRecords = reservedAt(batch, recordsRoom(batch));
          while (passes(atRecords) && open > 0) {
            await settledAll();
            // Stopped, or the core closed with the database, while it waited: nothing more is read.
            if (input.signal.aborted) return null;
          }
          const stop = passes(atRecords);
          if (stop) return stop;
          const { room, reserved, held } = roomFor(batch, atRecords);
          const most =
            reserved && limit ? inCurrency(reserved.amount, reserved.currency, limit.currency) : 0;
          outMost += most;
          return { most, room, held };
        } finally {
          unadmitted = unadmitted.filter((each) => each !== batch);
        }
      });
      admitted = turn;
      return turn;
    };

    const judgeBatch = async (batch: (typeof judged)[number][]) => {
      const admission = stopped ? stopped : await admit(batch);
      if (admission === null || typeof admission === "string" || stopped || input.signal.aborted) {
        stopped ??= typeof admission === "string" ? admission : null;
        for (const sentence of batch) settle(sentence, null, stopped);
        return;
      }
      const reply = await send(batch, admission);
      if (reply === null || typeof reply === "string") {
        if (reply === "answer-limit" || reply === "monthly-limit") stopped ??= reply;
        for (const sentence of batch) settle(sentence, null, reply);
        return;
      }
      for (const [index, sentence] of batch.entries()) {
        const verdict = reply.get(index + 1);
        settle(sentence, await supportOf(sentence, verdict, options), null, verdict !== undefined);
      }
    };

    // In order, a few at a time: a limit met at one batch leaves the ones after it.
    // A sentence whose quotes are on no Passage in scope, such as an older version's, has nothing
    // to be judged against: it isn't sent.
    for (const sentence of judged) if (sentence.passages.length === 0) settle(sentence, null, null);
    const queue = batchesOf(judged.filter((sentence) => sentence.passages.length > 0));
    unadmitted = [...queue];
    const workers = Array.from(
      { length: Math.min(claimsAtOnce(prepared), queue.length) },
      async () => {
        for (let batch = queue.shift(); batch; batch = queue.shift()) await judgeBatch(batch);
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
