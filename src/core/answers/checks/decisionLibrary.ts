/**
 * Whether a sentence is about the Library itself (#2525), asked of a decision model before its
 * first reading calls the sentence Unsupported. No Passage states how many Documents the Library
 * holds or what they are called, so such a sentence is left to its own check, which counts the
 * Library's lists.
 */
import type { JevNoulQuestion } from "../../providers/jev";
import type { DecisionReader } from "./decisionFirst";

const ABOUT = "L";

// The line was measured with these words, sent as they are here.
export const LIBRARY_QUESTION: JevNoulQuestion = {
  type: "noul",
  instructions:
    "Is the sentence about the reader's own collection of files itself, rather than about what a file says? The sentence is one line of a note someone will check against their documents.",
  criteria: {
    true: "The sentence is about the collection: how many documents, folders or notes it holds, what one of them is called, what kind of file one is, where one is filed or how it is tagged.",
    false:
      "The sentence is about something a document's text could state: a fact, a figure, an event, a comparison, or the writer's judgement about them.",
  },
};

/** How sure the model is that `sentence` is about the Library itself; null where it couldn't be asked. */
export const libraryScore = async (
  reader: Pick<DecisionReader, "ask">,
  sentence: string,
  signal: AbortSignal,
): Promise<number | null> =>
  (await reader.ask({ sentence }, { [ABOUT]: LIBRARY_QUESTION }, signal))?.[ABOUT] ?? null;

/**
 * Whether the sentence is left to its own check as one about the Library. So is one the model
 * couldn't be asked about, or has no measured line for: its first reading doesn't settle it.
 */
export async function aboutLibrary(
  reader: DecisionReader,
  sentence: string,
  signal: AbortSignal,
): Promise<boolean> {
  const line = reader.lines.library;
  if (line === undefined) return true;
  const score = await libraryScore(reader, sentence, signal);
  return score === null || score >= line;
}
