/**
 * The everyday record hears an Answer's own requests through the Library's chat model (#3019), so
 * the input tokens a new instruction adds to each answering request can be read against main's.
 */
import { describe, expect, test } from "vitest";
import { watchTokens } from "../../eval/lib/tokens";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const LINE = "Spring tides happen just after a new moon or a full moon.";

describe("Hearing an Answer", () => {
  // protects=an Answer asked inside the token watcher's hear has each of its own model requests heard, with its system prompt and its tokens, though the core runs it after askInConversation returns; fails_when=the Answer's requests run outside the hearing, so the record has no answering request's tokens; no_claim=how many tokens a real provider counts.
  test("hears each of its own requests, with their tokens", async () => {
    const tokens = watchTokens();
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const passage = shownPassages(searched.text).find((each) => each.text.includes(LINE));
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage?.id, quote: LINE }] },
              },
            ],
          };
        }
        return { text: "Spring tides come at new and full moon[^1]." };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: `# Tides\n\n${LINE}\n` }],
      { createChatModel: tokens.chatModels(() => model) },
    );

    const { requests } = await tokens.hear(() =>
      askAssistant(core, {
        text: "When are spring tides?",
        mindId: null,
        conversationId: null,
        focus: null,
      }),
    );

    const answering = requests.filter(({ prompt }) =>
      prompt.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("Cite every claim you draw from a Passage"),
      ),
    );
    expect(answering.length).toBeGreaterThanOrEqual(3);
    for (const { usage } of answering) expect(usage.inputTokens).toBeGreaterThan(0);
  });
});
