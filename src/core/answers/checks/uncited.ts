/// <reference types="electron-vite/node" />
import { randomUUID } from "node:crypto";
import { wrapLanguageModel } from "ai";
import { readFigures } from "../../../shared/figures";
import type {
  AnswerUsage,
  ClaimCheckAttributes,
  ClaimCheckFailure,
  ClaimCheckResult,
} from "../../api";
import { type MeteredModel, timingMiddleware } from "../../cost/meter";
import type { PreparedChatModel } from "../../providers/chat";
import type { TokenUsage } from "../../runs/engine";
import { RunItemError, runItems } from "../../runs/stop";
import type { Timings } from "../../timing/timings";
import type { NodeJSON } from "../blocks";
import { quotedFactsIn } from "../quotedWords";
import { type ClaimCheckRequest, runFailureOf } from "./claimCheck";
import { claimsAtOnce } from "./runChecks";
import type { CheckScope } from "./verify";
import { checkableSentences, type Sentence } from "./written";

export interface UncitedCheckOptions {
  prepare(answer: PreparedChatModel): Promise<PreparedChatModel | null>;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  citedNow(cited: Sentence["cited"]): { documentName: string; quote: string }[];
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
  ): ClaimCheckAttributes;
  claimTimeLimitMs: number;
  now(): Date;
}

export interface UncitedCheckInput {
  answerId: string;
  mindId: string | null;
  blocks: readonly NodeJSON[];
  prepared: PreparedChatModel;
  scope: CheckScope;
  searchable: number;
  usage: AnswerUsage;
  signal: AbortSignal;
  checking(): void;
  publish(check: ClaimCheckAttributes): void;
}

const ABSENCE =
  /^(?:i|we)\b[\s\S]*\b(?:didn't|did not|couldn't|could not|can't|cannot)\s+(?:find|locate)|^(?:no|nothing)\b[\s\S]*\b(?:found|matches)|^(?:the\s+)?(?:documents?|library)\b[\s\S]*\b(?:don't|doesn't|do not|does not)\s+(?:say|state|mention|include|contain)|^(?:我|我们)?(?:没有|未能|无法|未)(?:找到|检索到|查找到)|^文档(?:中)?(?:没有|未)(?:提到|记载|包含)/iu;

/** The uncited sentences that state a figure or quoted fact, never the assistant's own absence. */
export function uncitedFacts(blocks: readonly NodeJSON[]): Sentence[] {
  return checkableSentences(blocks).filter(
    (sentence) =>
      sentence.cited.length === 0 &&
      !ABSENCE.test(sentence.text.trim()) &&
      (readFigures(sentence.text).length > 0 || quotedFactsIn(sentence.text).length > 0),
  );
}

function measured(prepared: PreparedChatModel, add: (usage: TokenUsage) => void) {
  const timings: Timings = {
    request: () => ({
      heard: () => undefined,
      end: (_outcome, usage) => {
        if (!usage) return;
        const full = usage as typeof usage & { cacheWriteTokens?: number };
        add({ ...usage, cacheWriteTokens: full.cacheWriteTokens });
      },
    }),
    step: () => undefined,
    local: async (_step, _model, work) => work(),
    prune: () => undefined,
  };
  const metered: MeteredModel = {
    providerId: prepared.provider.id,
    kind: prepared.provider.kind,
    modelId: prepared.modelId,
    flow: "checks",
    billing: "free",
    price: undefined,
    maxOutput: undefined,
    ollamaCloud:
      prepared.provider.kind === "ollama" && prepared.provider.service?.id === "ollama-cloud",
  };
  return {
    ...prepared,
    model: wrapLanguageModel({
      model: prepared.model,
      middleware: timingMiddleware(timings, metered),
    }),
  };
}

export function createUncitedCheck(options: UncitedCheckOptions) {
  async function checkWithin(
    sentence: Sentence,
    input: UncitedCheckInput,
    prepared: PreparedChatModel,
  ): Promise<ClaimCheckResult> {
    const { signal, scope } = input;
    const timedOut = AbortSignal.timeout(options.claimTimeLimitMs);
    const ended = AbortSignal.any([signal, timedOut]);
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
        cacheKey: input.mindId ?? input.answerId,
        signal: ended,
      }),
      givenUp,
    ]);
    if (replied !== null && !timedOut.aborted) return replied;
    return {
      verdict: "not-checked",
      reason: signal.aborted ? "stopped" : "failed",
      detail: signal.aborted
        ? null
        : `No reply within ${Math.round(options.claimTimeLimitMs / 1000)} seconds.`,
      versions: [],
      excluded: [],
    };
  }

  return async function checkUncited(input: UncitedCheckInput): Promise<void> {
    const sentences = uncitedFacts(input.blocks);
    if (sentences.length === 0) return;
    const prepared = await options.prepare(input.prepared);
    if (!prepared || input.searchable === 0) return;
    input.checking();
    const request = randomUUID();
    const startedAt = options.now().toISOString();
    const used = measured(prepared, (usage) => {
      input.usage.inputTokens += usage.inputTokens ?? 0;
      input.usage.outputTokens += usage.outputTokens ?? 0;
      input.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      input.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    });
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
      scope: input.scope.marked,
      versions: [],
      excluded: [],
      checkedAt: startedAt,
    });
    const failed = (sentence: Sentence, reason: ClaimCheckFailure, detail: string | null) => {
      const at = options.now().toISOString();
      input.publish({ ...markOf(sentence), state: "not-checked", reason, detail, checkedAt: at });
    };
    await runItems(
      sentences,
      async (sentence) => {
        const result = await checkWithin(sentence, input, used);
        const failure = runFailureOf(result);
        if (failure) throw new RunItemError(failure);
        if (input.signal.aborted) return;
        const at = options.now().toISOString();
        if (result.verdict === "not-checked") {
          failed(sentence, result.reason, result.detail);
          return;
        }
        input.publish(options.withResult(markOf(sentence), result, at));
      },
      { concurrency: claimsAtOnce(prepared), signal: input.signal },
    );
  };
}
