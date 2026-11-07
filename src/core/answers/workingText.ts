/**
 * Whether parts of a step's text are the Answer or the model's own working (#2371). Their shape
 * doesn't say: a working note ("Citations need to be recorded now.") and a caveat about the
 * Documents are both text with no marker of its own, a note can sit between two Answer paragraphs
 * or on the Answer's last line, and the provider streams them in the same text block. So the
 * small-calls model is asked once, about every part that may be working, with the Question and the
 * Answer before it for context. A failure to decide, or no reply within the time limit, keeps the
 * text: losing the User's Answer is worse than showing a note.
 */
import { generateText, jsonSchema, Output } from "ai";
import { tagged } from "../promptData";
import type { ChatLanguageModel } from "../providers/models";
import { outputTokens } from "../providers/outputLimits";
import type { AnswerRequest } from "./engine";
import { smallCallModel } from "./smallCalls";

/** The instructions for the one request that decides (#2371). */
export const WORKING_TEXT_INSTRUCTIONS = [
  "You say whether parts of a model's reply belong in its Answer to the User, or are its own working.",
  "The model answered the User's Question, then wrote the text below just before asking IncarnaMind to record its Citations. Each <reply> is one part of that text, in order; judge every part.",
  'Reply "answer" for a part the User should read: about the Documents, their figures, the Question, where the information came from, what the model changed or did not change for a what-if, a limitation of the Answer (what it did not check or calculate, and what it could do next), or a sentence that sums up the Answer. A list item, a table row, or a line that continues a sentence is the Answer\'s.',
  'Reply "working" only when the whole part is the model talking to itself about the call it is about to make — recording Citations, calling a Tool, searching, checking or recalculating — and says nothing the User would read.',
  "A part that holds anything the User should read is the Answer's, even when it also says what the model did or did not do, or could do next.",
  "When in doubt, reply answer.",
  "Reply with one word for each part, in order.",
].join("\n");

/** How long the judgement may take before the engine keeps the text. */
export const WORKING_TEXT_TIME_LIMIT_MS = 20_000;

const partsSchema = jsonSchema<{ parts: ("answer" | "working")[] }>({
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: { type: "string", enum: ["answer", "working"] },
      description: "One word for each <reply>, in order: answer or working.",
    },
  },
  required: ["parts"],
});

/**
 * The parts' verdicts, in order: "answer" or "working". Null when the reply couldn't be read, the
 * count didn't match, or the time limit passed.
 */
export async function judgeWorkingText(
  model: ChatLanguageModel,
  temperature: number | undefined,
  signal: AbortSignal,
  question: string,
  context: string,
  parts: readonly string[],
  limitMs = WORKING_TEXT_TIME_LIMIT_MS,
): Promise<("answer" | "working")[] | null> {
  if (parts.length === 0) return [];
  let timedOut = false;
  const limit = AbortSignal.timeout(limitMs);
  limit.addEventListener("abort", () => (timedOut = true), { once: true });
  try {
    const result = await generateText({
      model,
      instructions: WORKING_TEXT_INSTRUCTIONS,
      prompt: [
        tagged("question", question, "", ["answer", "reply"]),
        tagged("answer", context, "", ["question", "reply"]),
        ...parts.map((text, index) =>
          tagged("reply", text, ` id="${index + 1}"`, ["answer", "question"]),
        ),
      ].join("\n\n"),
      temperature,
      maxOutputTokens: outputTokens("working-text"),
      output: Output.object({ schema: partsSchema, name: "parts" }),
      maxRetries: 0,
      abortSignal: AbortSignal.any([signal, limit]),
    });
    const verdicts = result.output.parts;
    return verdicts.length === parts.length ? verdicts : null;
  } catch (error) {
    if (!signal.aborted) {
      console.error(
        `Whether text beside cite is the model's working wasn't decided${timedOut ? ` within ${Math.round(limitMs / 1000)} s` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

/** The verdicts for `parts`; null when they couldn't be had, which keeps every part. */
export async function wroteWorking(
  request: Pick<AnswerRequest, "model" | "quickModel" | "question" | "signal">,
  context: string,
  parts: readonly string[],
  temperature: number | undefined,
): Promise<("answer" | "working")[] | null> {
  try {
    const small = await smallCallModel(request, temperature);
    return await judgeWorkingText(
      small.model,
      small.temperature,
      request.signal,
      request.question,
      context,
      parts,
    );
  } catch (error) {
    if (!request.signal.aborted) {
      console.error(
        `Whether text beside cite is the model's working wasn't decided: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}
