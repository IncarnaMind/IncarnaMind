/**
 * Whether text a model wrote after its Answer, just before `cite` or `calculate`, is part of the
 * Answer or the model's own working (#2371). Its shape doesn't say: a working note ("Citations need
 * to be recorded now.") and a caveat about the Documents are both a paragraph with no marker of its
 * own, and the provider streams them in the same text block. So the small-calls model is asked once,
 * with the Question and the Answer's last paragraph for context. A failure to decide keeps the text:
 * losing the User's Answer is worse than showing a note.
 */
import { generateText, jsonSchema, Output } from "ai";
import { tagged } from "../promptData";
import type { ChatLanguageModel } from "../providers/models";
import { outputTokens } from "../providers/outputLimits";
import type { AnswerRequest } from "./engine";
import { smallCallModel } from "./smallCalls";

/** The instructions for the one request that decides (#2371). */
export const WORKING_TEXT_INSTRUCTIONS = [
  "You say whether text a model wrote belongs in its Answer to the User, or is its own working.",
  "The model answered the User's Question, then wrote the text below just before asking IncarnaMind to record its Citations.",
  'Reply "working" only when the text is the model talking to itself about the call it is about to make — recording Citations, calling a Tool, searching, checking or recalculating — and says nothing the User would read.',
  'Reply "answer" when the text says anything the User should read: about the Documents, their figures, the Question, where the information came from, what the model changed or did not change for a what-if, a limitation of the Answer, or a sentence that sums up the Answer.',
  "A sentence that repeats or sums up what the Answer already says is the Answer's.",
  "When in doubt, reply answer.",
  "Reply with the one word, answer or working.",
].join("\n");

const partSchema = jsonSchema<{ part: "answer" | "working" }>({
  type: "object",
  properties: {
    part: {
      type: "string",
      enum: ["answer", "working"],
      description: "Whether the text is the Answer's, or the model's working on its next call.",
    },
  },
  required: ["part"],
});

/** What the judge says of `text`: "working" or "answer"; null when it couldn't be asked or read. */
export async function judgeWorkingText(
  model: ChatLanguageModel,
  temperature: number | undefined,
  signal: AbortSignal,
  question: string,
  answer: string,
  text: string,
): Promise<"answer" | "working" | null> {
  try {
    const result = await generateText({
      model,
      instructions: WORKING_TEXT_INSTRUCTIONS,
      prompt: [tagged("question", question), tagged("answer", answer), tagged("reply", text)].join(
        "\n\n",
      ),
      temperature,
      maxOutputTokens: outputTokens("working-text"),
      output: Output.object({ schema: partSchema, name: "part" }),
      maxRetries: 0,
      abortSignal: signal,
    });
    return result.output.part;
  } catch (error) {
    if (!signal.aborted) {
      console.error(
        `Whether text beside cite is the model's working wasn't decided: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

/** True when `text` is the model's working on the call it is about to make; false when it is the Answer's, and on any failure. */
export async function wroteWorking(
  request: Pick<AnswerRequest, "model" | "quickModel" | "question" | "signal">,
  answer: string,
  text: string,
  temperature: number | undefined,
): Promise<boolean> {
  try {
    const small = await smallCallModel(request, temperature);
    return (
      (await judgeWorkingText(
        small.model,
        small.temperature,
        request.signal,
        request.question,
        answer,
        text,
      )) === "working"
    );
  } catch (error) {
    if (!request.signal.aborted) {
      console.error(
        `Whether text beside cite is the model's working wasn't decided: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }
}
