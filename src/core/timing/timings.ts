// Only numbers and names are kept, never a request's or a reply's text, and nothing is sent.
import { randomUUID } from "node:crypto";
import type { Logger } from "../adapters";
import type { Database } from "../storage";
import { type FlowTag, flowNow } from "./flows";

const KEPT_DAYS = 30;

export interface ModelRequestTiming {
  dataFlow: string;
  providerKind: string;
  modelId: string;
  /** The reasoning setting it was asked with ("off", "summary", "answer", "careful"); null if none. */
  reasoning: string | null;
}

export type TimingOutcome = "finished" | "failed" | "stopped";

interface Usage {
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createTimings(options: { db: Database; now: () => Date; log: Logger }) {
  const { db, now, log } = options;

  function insert(row: {
    kind: "model" | "local";
    tag: FlowTag | null;
    dataFlow: string | null;
    providerKind: string | null;
    modelId: string;
    reasoning: string | null;
    startedAt: string;
    firstByteMs: number | null;
    firstReasoningMs: number | null;
    firstTextMs: number | null;
    firstToolMs: number | null;
    endMs: number;
    usage: Usage | null;
    units: number | null;
    outcome: TimingOutcome;
  }): void {
    const at = now().toISOString();
    // A record is never worth a request or a step: a locked or closed database, or a full disk,
    // loses the record, and the reply, the cancel or the result goes on.
    try {
      db.run(
        `INSERT INTO ai_timings (id, kind, flow, step, data_flow, provider_kind, model_id, reasoning,
         started_at, first_byte_ms, first_reasoning_ms, first_text_ms, first_tool_ms, end_ms,
         input_tokens, cached_input_tokens, output_tokens, units, outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          row.kind,
          row.tag?.flow ?? null,
          row.tag?.step ?? null,
          row.dataFlow,
          row.providerKind,
          row.modelId,
          row.reasoning,
          row.startedAt,
          row.firstByteMs,
          row.firstReasoningMs,
          row.firstTextMs,
          row.firstToolMs,
          row.endMs,
          row.usage?.inputTokens ?? null,
          row.usage?.cachedInputTokens ?? null,
          row.usage?.outputTokens ?? null,
          row.units,
          row.outcome,
          at,
          at,
        ],
      );
    } catch (error) {
      log.warn("timing.not_recorded", {
        kind: row.kind,
        flow: row.tag?.flow ?? null,
        step: row.tag?.step ?? null,
        model: row.modelId,
        reason: messageOf(error),
      });
    }
  }

  return {
    request(model: ModelRequestTiming) {
      const tag = flowNow();
      const startedAt = now().toISOString();
      const start = performance.now();
      const since = () => Math.round(performance.now() - start);
      let firstByteMs: number | null = null;
      let firstReasoningMs: number | null = null;
      let firstTextMs: number | null = null;
      let firstToolMs: number | null = null;
      let ended = false;
      return {
        heard(type: string): void {
          // The provider's stream opens with "stream-start" before a byte of the reply comes.
          if (type === "stream-start") return;
          firstByteMs ??= since();
          if (type === "reasoning-delta") firstReasoningMs ??= since();
          else if (type === "text-delta") firstTextMs ??= since();
          else if (type === "tool-input-start" || type === "tool-call") firstToolMs ??= since();
        },
        end(outcome: TimingOutcome, usage: Usage | null): void {
          if (ended) return;
          ended = true;
          insert({
            kind: "model",
            tag,
            dataFlow: model.dataFlow,
            providerKind: model.providerKind,
            modelId: model.modelId,
            reasoning: model.reasoning,
            startedAt,
            firstByteMs,
            firstReasoningMs,
            firstTextMs,
            firstToolMs,
            endMs: since(),
            usage,
            units: null,
            outcome,
          });
        },
      };
    },

    step(step: string, model: string, ms: number, units: number | null): void {
      insert({
        kind: "local",
        tag: flowNow() ?? { flow: step, step: null },
        dataFlow: null,
        providerKind: "local",
        modelId: model,
        reasoning: null,
        startedAt: new Date(now().getTime() - ms).toISOString(),
        firstByteMs: null,
        firstReasoningMs: null,
        firstTextMs: null,
        firstToolMs: null,
        endMs: Math.round(ms),
        usage: null,
        units,
        outcome: "finished",
      });
    },

    async local<T>(
      step: string,
      model: string,
      work: () => Promise<T>,
      unitsOf: (result: T) => number | null = () => null,
    ): Promise<T> {
      const tag = flowNow();
      const startedAt = now().toISOString();
      const start = performance.now();
      const record = (outcome: TimingOutcome, units: number | null) =>
        insert({
          kind: "local",
          tag: tag ?? { flow: step, step: null },
          dataFlow: null,
          providerKind: "local",
          modelId: model,
          reasoning: null,
          startedAt,
          firstByteMs: null,
          firstReasoningMs: null,
          firstTextMs: null,
          firstToolMs: null,
          endMs: Math.round(performance.now() - start),
          usage: null,
          units,
          outcome,
        });
      try {
        const result = await work();
        record("finished", unitsOf(result));
        return result;
      } catch (error) {
        record(error instanceof Error && error.name === "AbortError" ? "stopped" : "failed", null);
        throw error;
      }
    },

    prune(): void {
      const before = new Date(now().getTime() - KEPT_DAYS * 86_400_000).toISOString();
      try {
        db.run("DELETE FROM ai_timings WHERE started_at < ?", [before]);
      } catch (error) {
        log.warn("timing.not_pruned", { reason: messageOf(error) });
      }
    },
  };
}

export type Timings = ReturnType<typeof createTimings>;
