/**
 * An Answer's sentences are judged once it ends (#2311), but a model on this computer too small
 * to judge them (#680) never gets to: its Citations stay Not checked, and say why, so nothing
 * reads as checked that wasn't (#2375). Against a stub of Ollama's API; nothing here needs Ollama.
 */
import { describe, expect, test } from "vitest";
import { answerEnded, answerJudged } from "../helpers/citations";
import { answering, QWEN35, setUpLocalModel, TIDES } from "../helpers/localModels";
import { startOllamaServer } from "../helpers/ollama";

const CITED = JSON.stringify({
  answer: "Spring tides happen at new moon and at full moon [^1].",
  citations: [
    { marker: 1, passage: "P1", quote: "Spring tides happen at new moon and at full moon" },
  ],
});

describe("judging an Answer on a model too small to judge", { timeout: 120_000 }, () => {
  test("its Citation stays Not checked, and names the model as the reason", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35],
      reply: answering(() => ({ content: CITED })),
    });
    const { core } = await setUpLocalModel(ollama, QWEN35.name, {
      documents: [{ name: "Tides.md", contents: TIDES }],
    });

    const asked = await core.askInConversation({ text: "When are spring tides?" });
    if (!asked.asked) throw new Error("Not asked.");
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    const answer = await answerJudged(core, asked.conversation.id, asked.answerId);

    expect(answer.citations).toMatchObject([{ check: "not-checked", checkReason: "small-model" }]);
  });
});
