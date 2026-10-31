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
import type { ChatLanguageModel } from "./models";

export const OUTPUT_LIMITS = {
  answer: { most: 8_000 },
  "answer-step": { most: 32_000 },
  "check-step": { most: 8_000 },
  // A Meeting's notes: the User's lines filled out and the sections after them, with the thinking
  // before them, can pass an Answer's room (#2306).
  "meeting-fill": { most: 16_000 },
  "search-query": { most: 256 },
  tags: { most: 512 },
  organize: { most: 512 },
  "find-claims": { most: 4_000 },
  "claimed-changes": { most: 2_048 },
  // A record for each sentence it cites: a Meeting's notes ask for dozens at once (#2306).
  "unmarked-quotes": { most: 8_000, each: 150 },
  "quote-retry": { most: 600, each: 100 },
  "figure-retry": { most: 1_800, each: 300 },
  evidence: { most: 4_000, each: 600 },
  comparison: { most: 300 },
  "record-cite": { most: 400 },
  "absence-read": { most: 400 },
  // Room for a model that thinks whatever it is asked, before its plan.
  "research-plan": { most: 4_096 },
  "research-tags": { most: 1_024 },
  "web-search": { most: 2_048 },
  suggestion: { most: 400 },
  "skill-draft": { most: 900 },
  edit: { most: 16_000 },
  "connection-test": { most: 64 },
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

/** A reply that reached its call's output limit. `wrote`: it had text before the limit, not only thinking. */
export class CutShortError extends Error {
  constructor(
    readonly limit: number | undefined,
    readonly wrote: boolean,
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
        throw new CutShortError(params.maxOutputTokens, wrote);
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
                  error: new CutShortError(params.maxOutputTokens, wrote),
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
