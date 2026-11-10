/**
 * When a write's checked sentences go more than six at once (#2532): the first six start at once,
 * as at six, and each later one once every one of the first six has had its first reply back, or
 * ended or failed without one, so the key is never sent twelve first requests together (on
 * 2026-11-05 that made the first mark later on Claude Sonnet 5.5's Chinese write). None starts
 * later than it would at six places: the n-th later one goes once n checks have ended.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { PreparedChatModel } from "../../providers/chat";
import type { ChatLanguageModel } from "../../providers/models";

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

export interface Stagger {
  /** `prepared` for the sentence at `index`'s check; one of the first says when its first reply is back. */
  model(index: number, prepared: PreparedChatModel): PreparedChatModel;
  /** Resolves when the sentence at `index` may start, or the run is stopped. */
  turn(index: number): Promise<void>;
  /** The sentence at `index`'s check came to its outcome, whatever it was. */
  ended(index: number): void;
}

const NONE: Stagger = {
  model: (_, prepared) => prepared,
  turn: () => Promise.resolve(),
  ended: () => undefined,
};

/** Calls `back` as each request `model` is sent ends: its reply streamed to the end, returned or failed. */
function hearingReplies(model: ChatLanguageModel, back: () => void): ChatLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        try {
          return await doGenerate();
        } finally {
          back();
        }
      },
      wrapStream: async ({ doStream }) => {
        let result: Awaited<ReturnType<typeof doStream>>;
        try {
          result = await doStream();
        } catch (error) {
          back();
          throw error;
        }
        const stream = result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            flush() {
              back();
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
}

/** The first `first` sentences start at once and the rest after them, as above; `first` null: all as they come. */
export function stagger(first: number | null, signal: AbortSignal): Stagger {
  if (first === null) return NONE;
  const back = new Set<number>();
  let ended = 0;
  const waiting: { after: number; go(): void }[] = [];
  const release = () => {
    for (const each of [...waiting]) {
      if (back.size < first && ended <= each.after && !signal.aborted) continue;
      waiting.splice(waiting.indexOf(each), 1);
      each.go();
    }
  };
  const isBack = (index: number) => {
    if (index >= first || back.has(index)) return;
    back.add(index);
    release();
  };
  signal.addEventListener("abort", release, { once: true });
  return {
    model(index, prepared) {
      if (index >= first) return prepared;
      let hearing: ChatLanguageModel | null = null;
      return {
        ...prepared,
        // Wrapped when a request first asks for it, as the check's own listener is (./runCheck).
        get model() {
          hearing ??= hearingReplies(prepared.model, () => isBack(index));
          return hearing;
        },
      };
    },
    turn(index) {
      // The sentence at `first + n` would take the place the (n + 1)th check to end freed.
      const after = index - first;
      if (after < 0 || back.size >= first || ended > after || signal.aborted) {
        return Promise.resolve();
      }
      return new Promise((go) => {
        waiting.push({ after, go });
      });
    },
    ended(index) {
      ended++;
      if (index < first) back.add(index);
      release();
    },
  };
}
