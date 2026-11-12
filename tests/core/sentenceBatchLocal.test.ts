/**
 * An Answer's sentence check on a model in Ollama on this computer (#2951): a model that can only
 * think, given the smallest window its memory leaves, keeps 4,096 tokens for a reply, and its
 * batch is held to that, not to 300 a sentence. Against a stub of Ollama's API.
 */
import { describe, expect, test } from "vitest";
import { answerEnded, answerJudged } from "../helpers/citations";
import { answerChats, GIB, setUpLocalModel, TIDES } from "../helpers/localModels";
import { type OllamaModelStub, startOllamaServer } from "../helpers/ollama";

/** A model of 32 billion parameters that can only think, and calls no Tools. */
const THINKER: OllamaModelStub = {
  name: "thinker:32b",
  capabilities: ["completion", "thinking"],
  size: 20 * GIB,
  modelInfo: {
    "general.architecture": "qwen2",
    "general.parameter_count": 32_763_876_352,
    "qwen2.block_count": 64,
    "qwen2.context_length": 131_072,
    "qwen2.attention.head_count": 40,
    "qwen2.attention.head_count_kv": 8,
    "qwen2.embedding_length": 5_120,
  },
  thinking: { values: [true], default: true },
};

const CITED = JSON.stringify({
  answer: "Spring tides happen at new moon and at full moon [^1].",
  citations: [
    { marker: 1, passage: "P1", quote: "Spring tides happen at new moon and at full moon" },
  ],
});

const isBatch = (body: Record<string, unknown>) =>
  JSON.stringify(body.messages ?? []).includes("You check sentences an Answer wrote");

describe("a sentence batch on a model in Ollama (#2951)", { timeout: 120_000 }, () => {
  test("a model that can only think, on the smallest window, is held to the 4,096 tokens it keeps for a reply", async () => {
    const ollama = await startOllamaServer({
      models: [THINKER],
      reply: (body) =>
        isBatch(body)
          ? { content: JSON.stringify({ sentences: [] }) }
          : JSON.stringify(body.messages ?? []).includes("You answer Questions")
            ? { content: CITED }
            : { content: JSON.stringify({ tags: [] }) },
    });
    const { core } = await setUpLocalModel(ollama, THINKER.name, {
      memory: 24 * GIB,
      documents: [{ name: "Tides.md", contents: TIDES }],
    });

    const asked = await core.askInConversation({ text: "When are spring tides?" });
    if (!asked.asked) throw new Error("Not asked.");
    const ended = await answerEnded(core, asked.answerId);
    await answerJudged(core, asked.conversation.id, asked.answerId);
    const settings = (body: Record<string, unknown>) => body.options as Record<string, number>;
    const answerChat = answerChats(ollama).at(0);
    const batch = ollama.chats.find((chat) => isBatch(chat.body));

    expect(ended.event).toBe("finished");
    expect(answerChat && settings(answerChat.body).num_ctx).toBe(8_192);
    expect(batch && settings(batch.body).num_predict).toBe(4_096);
  });
});
