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
import type { ChatLanguageModel, ContextWindow } from "./models";

export const OUTPUT_LIMITS = {
  answer: { most: 8_000 },
  "answer-step": { most: 32_000 },
  "check-step": { most: 8_000 },
  // A Meeting's notes: the User's lines filled out and the sections after them, with the thinking
  // before them, can pass an Answer's room (#2306). On a four-minute call Claude Haiku 5.5 thought
  // and wrote 16,850 tokens: a reply cut off while it thinks has nothing to keep, so the room is
  // one that reply fits in, not a smaller one with a second ask (#2839). The notes of a 12 to 19
  // minute call are 50 to 110 facts, thought out at some 420 tokens each before the first is
  // written: 32,000 was reached in a third to a half of such fills, each two minutes paid for
  // nothing (#3251).
  // `own`: more than a window keeps for every call's reply, so the notes' Run makes the room.
  "meeting-fill": { most: 64_000, own: true },
  "search-query": { most: 256 },
  tags: { most: 512 },
  // Several Documents tagged in one request, as Organize's run and Re-tag send them (#2339).
  "tag-batch": { most: 2_400, each: 160 },
  organize: { most: 512 },
  folders: { most: 1_024 },
  // Organize's plan at any size (../library/plan): a sample sorted, a batch placed, subfolders named.
  // A sort lists its Folders, each named and described, before its Documents: Claude Haiku 5.5
  // wrote about 270 tokens and 18 a Document, so a sort of 15 ran past 40 a Document (#2737).
  "folder-plan": { most: 4_000, each: 40, base: 600 },
  placements: { most: 2_048, each: 40 },
  subfolders: { most: 4_000, each: 80 },
  "find-claims": { most: 4_000 },
  "claimed-changes": { most: 2_048 },
  // One word, after the thinking of a model that thinks first, as "quick-check" has room for.
  "request-done": { most: 2_048 },
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
  // A batch's records, up to about 120 tokens a sentence, after the thinking of a model that
  // thinks first, which comes once a request whatever its size: DeepSeek V4.1 Flash thought up to
  // 6,234 tokens before the records of 6 sentences, Claude Haiku 5.5 up to 1,579 (#2951).
  "sentence-batch": { most: 7_400, each: 300, base: 5_000 },
  // A batch's records alone: the least room a batch gets (#2951). Where the room above can't be set
  // aside beside the batches still to come under the Answer's limit or the monthly cap, a batch has
  // this and an equal part of what those limits leave (#2962).
  "sentence-batch-records": { most: 2_400, each: 300 },
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
  // A yes or a no: whether a request asks to take text out (#2333).
  "removal-asked": { most: 256 },
  // One sentence of a check's card written again in the interface's language (#2081).
  restate: { most: 400 },
} as const satisfies Record<string, { most: number; each?: number; base?: number; own?: true }>;

export type ModelCallKind = keyof typeof OUTPUT_LIMITS;

/**
 * The most a call may write in the room a window keeps for every call's reply. A kind with `own`
 * asks for more, and has it only where its Run gave it (`ownRoom`).
 */
export const LONGEST_OUTPUT = Math.max(
  ...Object.values(OUTPUT_LIMITS).map((limit: { most: number; own?: true }) =>
    limit.own ? 0 : limit.most,
  ),
);

/** What a model can write in one reply: its own most, and the room its window keeps for a reply. */
export interface OwnRoom {
  most?: number | undefined;
  window?: number | undefined;
  /** What its Run gave a kind with its own room (`ownRoom`): none, the room every call has. */
  own?: number | undefined;
}

/**
 * `count`: the items a call of a kind with `each` asks about, after its `base`. `within`: held to
 * the model's own room, so its provider never refuses the request for asking more.
 */
export function outputTokens(kind: ModelCallKind, count = 1, within?: OwnRoom): number {
  const limit: { most: number; each?: number; base?: number; own?: true } = OUTPUT_LIMITS[kind];
  const asked =
    limit.each === undefined
      ? limit.most
      : Math.min(limit.most, (limit.base ?? 0) + limit.each * Math.max(1, count));
  // Never read off the window's size: a model whose input limit is under its context keeps more
  // than this for a reply already, and a monthly cap may not hold it (#3251).
  const room = limit.own ? Math.min(asked, Math.max(LONGEST_OUTPUT, within?.own ?? 0)) : asked;
  return Math.min(
    room,
    within?.most ?? Number.POSITIVE_INFINITY,
    within?.window ?? Number.POSITIVE_INFINITY,
  );
}

/**
 * The room a Run of `kind` may give its reply where that is more than every call has: at most
 * half of the window and the model's own `most`. None where the model's most isn't known, so its
 * provider never refuses the request for asking more.
 */
export function ownRoom(
  kind: ModelCallKind,
  window: ContextWindow | undefined,
  most: number | undefined,
): number | undefined {
  if (!window || most === undefined) return undefined;
  const room = Math.min(OUTPUT_LIMITS[kind].most, most, Math.floor(window.tokens / 2));
  return room > LONGEST_OUTPUT ? room : undefined;
}

/** `window`, keeping at least `room` for a reply. */
export const withRoom = (window: ContextWindow, room: number): ContextWindow =>
  room > window.outputTokens ? { ...window, outputTokens: room } : window;

/**
 * The most items one request of `kind` has room to answer whole. A request that asks about more
 * is cut off and nothing of its reply is read, so its caller asks in several.
 */
export function itemsInRoom(kind: ModelCallKind): number {
  const limit: { most: number; each?: number; base?: number } = OUTPUT_LIMITS[kind];
  if (limit.each === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor((limit.most - (limit.base ?? 0)) / limit.each));
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
