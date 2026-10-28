/// <reference types="electron-vite/node" />
import { randomUUID } from "node:crypto";
import { wrapLanguageModel } from "ai";
import { SENTENCES_CHECKED_AT_MOST } from "../../../shared/claimChecks";
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
import { type ClaimCheckRequest, claimFailureOf, runFailureOf } from "./claimCheck";
import { claimsAmong } from "./findClaims";
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
  placeholder?(check: ClaimCheckAttributes, position: number): void;
  publish(check: ClaimCheckAttributes, position: number): void;
  discard?(id: string): void;
}

/** The uncited sentences with a figure or quoted fact that the claim finder may take (#1445). */
export function uncitedFacts(blocks: readonly NodeJSON[]): Sentence[] {
  return checkableSentences(blocks).filter(
    (sentence) =>
      sentence.cited.length === 0 &&
      (readFigures(sentence.text).length > 0 || quotedFactsIn(sentence.text).length > 0),
  );
}

function measured(prepared: PreparedChatModel, add: (usage: TokenUsage) => void) {
  const timings: Timings = {
    request: () => ({
      heard: () => undefined,
      end: (_outcome, usage) => {
        if (!usage) return;
        add(usage);
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
    const candidates = uncitedFacts(input.blocks);
    if (candidates.length === 0) return;
    const prepared = await options.prepare(input.prepared);
    if (!prepared || input.searchable === 0 || input.signal.aborted) return;
    input.checking();
    const request = randomUUID();
    const positions = new Map(candidates.map((sentence, index) => [sentence, index]));
    const startedAt = options.now().toISOString();
    const used = measured(prepared, (usage) => {
      input.usage.inputTokens += usage.inputTokens ?? 0;
      input.usage.outputTokens += usage.outputTokens ?? 0;
      input.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      input.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    });
    const marks = new Map<Sentence, ClaimCheckAttributes>();
    const markOf = (sentence: Sentence): ClaimCheckAttributes => {
      const existing = marks.get(sentence);
      if (existing) return existing;
      const created: ClaimCheckAttributes = {
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
      };
      marks.set(sentence, created);
      return created;
    };
    const failed = (sentence: Sentence, reason: ClaimCheckFailure, detail: string | null) => {
      const at = options.now().toISOString();
      console.warn(
        `An uncited sentence in Answer ${input.answerId} couldn't be checked: ${reason}${detail ? ` (${detail})` : ""}`,
      );
      input.publish(
        { ...markOf(sentence), state: "not-checked", reason, detail, checkedAt: at },
        positions.get(sentence) ?? 0,
      );
    };
    const found = await claimsAmong(
      used,
      candidates.map((sentence) => sentence.text),
      "uncited",
      input.signal,
    );
    if (found.kind === "cancelled") return;
    if (found.kind === "failed") {
      const { reason, detail } = claimFailureOf(found.error);
      for (const sentence of candidates) failed(sentence, reason, detail);
      return;
    }
    const sentences = candidates.filter((_, index) => found.claims.has(index));
    for (const sentence of sentences) {
      input.placeholder?.(markOf(sentence), positions.get(sentence) ?? 0);
    }
    try {
      await runItems(
        sentences.slice(0, SENTENCES_CHECKED_AT_MOST),
        async (sentence) => {
          const result = await checkWithin(sentence, input, used);
          const failure = runFailureOf(result);
          if (failure) throw new RunItemError(failure);
          return result;
        },
        {
          concurrency: claimsAtOnce(prepared),
          signal: input.signal,
          onOutcome(sentence, outcome) {
            if (input.signal.aborted || outcome.status === "stopped") return;
            if (outcome.status === "not-checked") {
              failed(sentence, outcome.stop.reason, null);
              return;
            }
            if (outcome.status === "failed") {
              const { reason, detail } = claimFailureOf(outcome.error);
              failed(sentence, reason, detail);
              return;
            }
            const at = options.now().toISOString();
            if (outcome.value.verdict === "not-checked") {
              failed(sentence, outcome.value.reason, outcome.value.detail);
              return;
            }
            input.publish(
              options.withResult(markOf(sentence), outcome.value, at),
              positions.get(sentence) ?? 0,
            );
          },
        },
      );
      if (input.signal.aborted) return;
      for (const sentence of sentences.slice(SENTENCES_CHECKED_AT_MOST)) {
        failed(sentence, "too-many", null);
      }
    } finally {
      for (const sentence of sentences) input.discard?.(markOf(sentence).id);
    }
  };
}
