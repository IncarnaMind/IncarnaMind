import type { MockLanguageModelV4 } from "ai/test";
import { expect } from "vitest";
import type {
  AnswerToolCall,
  AskInConversationInput,
  ConversationAnswer,
  Core,
  MindChange,
} from "../../src/core";
import { answerEnded, answerJudged } from "./citations";

/** Asks in the assistant and resolves with the Answer as stored once it has ended. */
export async function askAssistant(
  core: Core,
  input: AskInConversationInput,
  ends: "finished" | "failed" = "finished",
): Promise<ConversationAnswer> {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe(ends);
  return answerJudged(core, result.conversation.id, result.answerId);
}

export const mindCalls = (answer: ConversationAnswer): AnswerToolCall[] =>
  answer.toolCalls.filter((call) => call.source === "minds");

export const changesIn = (answer: ConversationAnswer): MindChange[] =>
  mindCalls(answer).flatMap((call) => (call.mindChange ? [call.mindChange] : []));

/** The Answer's own requests to the model: not the check Runs of what it wrote into a Mind (#1111). */
export { answerRequests } from "./models";

/** What the model was told a Tool call came to: the last Tool result it read. */
export const lastResult = (model: MockLanguageModelV4) => {
  const prompt = model.doStreamCalls.at(-1)?.prompt ?? [];
  const results = prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" &&
          (part.output.type === "text" || part.output.type === "error-text")
            ? [part.output.value]
            : [],
        )
      : [],
  );
  return results.at(-1) ?? "";
};
