/**
 * The most each kind of model call may write, its thinking included (#2275). A call that sets no
 * limit gets its provider's default, up to 128,000 tokens on Claude, so every call reads its own
 * here by kind. `each`: the call asks about several items, and gets this much for each, up to
 * `most`. The model's own most, where it is less, still applies.
 *
 * A reply that reaches its limit is cut off, so what it wrote is never read as whole:
 * `endsAtLimit` makes it a failure, `CutShortError`, which each call reports as its other
 * failures ("cut-short").
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { TokenUsage } from "../runs/engine";
import type { ChatLanguageModel } from "./models";

export const OUTPUT_LIMITS = {
  answer: { most: 8_000 },
  "answer-step": { most: 32_000 },
  "check-step": { most: 8_000 },
  // A Meeting's notes: the User's lines filled out and the sections after them, with the thinking
  // before them, can pass an Answer's room (#2306).
  "meeting-fill": { most: 16_000 },
  // A Meeting's notes asked again after a reply that reached `meeting-fill`'s room, as DeepSeek
  // V4.1 Flash's thinking on a call with typed notes did once: the cost cap sets aside a request's
  // whole room, so only that retry gets this much (#2306).
  "meeting-fill-retry": { most: 32_000 },
  "search-query": { most: 256 },
  tags: { most: 512 },
  // Several Documents tagged in one request, as Organize's run and Re-tag send them (#2339).
  "tag-batch": { most: 2_400, each: 160 },
  organize: { most: 512 },
  folders: { most: 1_024 },
  // Organize's plan at any size (../library/plan): a sample sorted, a batch placed, subfolders named.
  "folder-plan": { most: 4_000, each: 40 },
  placements: { most: 2_048, each: 40 },
  subfolders: { most: 4_000, each: 80 },
  "find-claims": { most: 4_000 },
  "claimed-changes": { most: 2_048 },
  // A record for each sentence it cites: a Meeting's notes ask for dozens at once (#2306).
  "unmarked-quotes": { most: 8_000, each: 150 },
  "quote-retry": { most: 600, each: 100 },
  "figure-retry": { most: 1_800, each: 300 },
  evidence: { most: 4_000, each: 600 },
  "covered-evidence": { most: 600 },
  confirm: { most: 300 },
  strict: { most: 300 },
  "strict-figure": { most: 300 },
  recheck: { most: 300 },
  nearest: { most: 300 },
  // Two phrases, which a record cite asks for too, as much room as its own judgement has.
  parts: { most: 400 },
  presence: { most: 300 },
  "strict-presence": { most: 300 },
  rewrite: { most: 300 },
  "record-cite": { most: 400 },
  "absence-read": { most: 400 },
  "sentence-batch": { most: 2_400, each: 300 },
  // Room for a model that thinks whatever it is asked, before its plan.
  "research-plan": { most: 4_096 },
  "research-tags": { most: 1_024 },
  "web-search": { most: 2_048 },
  suggestion: { most: 400 },
  "skill-draft": { most: 900 },
  edit: { most: 16_000 },
  "connection-test": { most: 64 },
  // A yes or a no, after the thinking of a model that thinks first: DeepSeek V4.1 Flash, thinking,
  // wrote up to 748 tokens before its word in 80 replies, and one in five passed 64 (#2817).
  "quick-check": { most: 2_048 },
  // One word for each part of a step's text: whether it is the Answer's or the model's working (#2371).
  "working-text": { most: 256 },
  // One sentence of a check's card written again in the interface's language (#2081).
  restate: { most: 400 },
} as const satisfies Record<string, { most: number; each?: number }>;

export type ModelCallKind = keyof typeof OUTPUT_LIMITS;

/** The most any call may write: no request needs more room for its reply. */
export const LONGEST_OUTPUT = Math.max(
  ...Object.values(OUTPUT_LIMITS).map((limit: { most: number }) => limit.most),
);

/** `count`: the items a call of a kind with `each` asks about. */
export function outputTokens(kind: ModelCallKind, count = 1): number {
  const limit: { most: number; each?: number } = OUTPUT_LIMITS[kind];
  return limit.each === undefined
    ? limit.most
    : Math.min(limit.most, limit.each * Math.max(1, count));
}

/**
 * A reply that reached its call's output limit. `wrote`: it had text before the limit, not only
 * thinking. `usage`: the tokens its provider reported for it, which were spent all the same.
 */
export class CutShortError extends Error {
  constructor(
    readonly limit: number | undefined,
    readonly wrote: boolean,
    readonly usage: TokenUsage | null = null,
  ) {
    super(
      `The model's reply reached its output limit${limit === undefined ? "" : ` of ${limit} tokens`} and was cut short.`,
    );
    this.name = "CutShortError";
  }
}

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;
type ReportedUsage = Extract<StreamPart, { type: "finish" }>["usage"];

const usageOf = (usage: ReportedUsage): TokenUsage => ({
  inputTokens: usage.inputTokens.total,
  outputTokens: usage.outputTokens.total,
  cachedInputTokens: usage.inputTokens.cacheRead,
  cacheWriteTokens: usage.inputTokens.cacheWrite,
});

/** The model, with each reply that reaches its output limit made a `CutShortError`: thrown, or the stream's error in place of its finish. */
export function endsAtLimit(model: ChatLanguageModel): ChatLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        if (result.finishReason.unified !== "length") return result;
        const wrote = result.content.some(
          (part) => part.type === "text" && part.text.trim() !== "",
        );
        throw new CutShortError(params.maxOutputTokens, wrote, usageOf(result.usage));
      },
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        let wrote = false;
        const stream = result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(part, controller) {
              if (part.type === "text-delta" && part.delta.trim() !== "") wrote = true;
              if (part.type === "finish" && part.finishReason.unified === "length") {
                controller.enqueue({
                  type: "error",
                  error: new CutShortError(params.maxOutputTokens, wrote, usageOf(part.usage)),
                });
                return;
              }
              controller.enqueue(part);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
}
