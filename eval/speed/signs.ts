/**
 * How a flow of `npm run eval:speed` is timed (eval/speed/README.md): from the User's action, by
 * the signs of work the core sends while it runs, as a window would show them.
 */
import type { Core, CoreEventName, Document } from "../../src/core";

export type Language = "en" | "zh-CN";

export interface FlowContext {
  core: Core;
  language: Language;
  /** The mixed sample set: the generated PDFs in eval/data/ and the readable Documents in eval/data/real/. */
  documents: ReadonlyMap<string, Document>;
}

/** When the window saw each kind of sign, in milliseconds from the User's action. */
export interface FlowSigns {
  /** The User's action, after whatever the flow set up first. */
  startedAt: string;
  firstSignMs: number | null;
  firstWordsMs: number | null;
  /** The first change in the page, which an Answer's words in the panel may come before. */
  firstChangeMs: number | null;
  doneMs: number;
  /** The longest stretch with no new sign of work, from the action to the end. */
  longestQuietMs: number;
}

export interface Flow {
  id: string;
  /** What a User does, for the report. */
  label: string;
  run(context: FlowContext): Promise<FlowSigns>;
}

// A suggestion, a Research plan, Folders and Tags arrive whole, when the call returns: their words come at the end.
export const wordsAtEnd = (signs: FlowSigns): FlowSigns => ({
  ...signs,
  firstWordsMs: signs.firstWordsMs ?? signs.doneMs,
});

/** The events that show the User something is happening; those in `WORDS` carry words. */
export const SIGNS: readonly CoreEventName[] = [
  "answer.started",
  "answer.phase",
  "answer.reasoning",
  "answer.delta",
  "answer.toolCallStarted",
  "answer.toolCallFinished",
  "answer.citationAdded",
  "mind.writing",
  "mind.update",
  "comparison.filling",
  "task.changed",
  "mindCheck.early",
];
const WORDS: ReadonlySet<CoreEventName> = new Set(["answer.delta", "mind.update"]);

/**
 * Times `act` by the signs the core sends while it runs, those of the Mind `mindId` only (null:
 * of any Mind), and those of `also`: the signs a window other than the Note's shows (the Library's).
 */
export async function timed(
  core: Core,
  mindId: string | null,
  act: () => Promise<unknown>,
  also: readonly CoreEventName[] = [],
): Promise<FlowSigns> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const at = () => performance.now() - start;
  const signs: number[] = [];
  let firstWordsMs: number | null = null;
  let firstChangeMs: number | null = null;
  const stops = [...SIGNS, ...also].map((event) =>
    core.on(event, (payload: unknown) => {
      const place = (payload ?? {}) as { mindId?: string | null };
      if (mindId !== null && typeof place.mindId === "string" && place.mindId !== mindId) return;
      signs.push(at());
      if (WORDS.has(event)) firstWordsMs ??= at();
      if (event === "mind.update") firstChangeMs ??= at();
    }),
  );
  try {
    await act();
  } finally {
    for (const stop of stops) stop();
  }
  const doneMs = at();
  const marks = [0, ...signs, doneMs];
  const longestQuietMs = marks
    .slice(1)
    .reduce((longest, mark, index) => Math.max(longest, mark - (marks[index] ?? 0)), 0);
  return {
    startedAt,
    firstSignMs: signs[0] ?? null,
    firstWordsMs,
    firstChangeMs,
    doneMs,
    longestQuietMs,
  };
}
