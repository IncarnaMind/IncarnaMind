/**
 * Answers from a local model kept within its context window by IncarnaMind's
 * own rules (see src/core/answers/window.ts), never cut by Ollama: against a
 * stub of Ollama's API that counts each request's tokens, refuses one over
 * `num_ctx` when it says `truncate: false`, and would otherwise cut it.
 */
import { APICallError } from "ai";
import { describe, expect, test } from "vitest";
import { classifyProviderError, contextOverflow } from "../../src/core/providers/providerErrors";
import { translate } from "../../src/shared/i18n";
import { askAndEnd, GIB, messagesOf, QWEN35, setUpLocalModel } from "../helpers/localModels";
import { note, question, writeMind } from "../helpers/minds";
import { startOllamaServer } from "../helpers/ollama";

/** 30 Notes of about 500 tokens each, then a Question. */
const bigMind = () => {
  const notes = Array.from({ length: 30 }, (_, index) =>
    note(`Note ${String(index + 1).padStart(2, "0")}: ${"lorem ipsum ".repeat(170)}`),
  );
  return { notes, asked: question("Summarise my Notes.") };
};

describe("Fitting an Answer into a local model's window", () => {
  test("a large Question context is cut by IncarnaMind's rules, oldest first, and never by Ollama", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35],
      reply: () => ({ content: "They are about lorem ipsum." }),
    });
    // 8 GB of memory: an 8,192-token window.
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35.name, {
      memory: 8 * GIB,
    });
    const { notes, asked } = bigMind();
    writeMind(client, [...notes, asked]);

    const { ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);

    expect(ended.event).toBe("finished");
    expect(ollama.chats).toHaveLength(1);
    const [chat] = ollama.chats;
    expect(chat).toMatchObject({ refused: false, cut: false });
    const body = chat?.body ?? {};
    expect(body).toMatchObject({
      truncate: false,
      options: { num_ctx: 8_192, num_predict: 2_048 },
    });
    // The request leaves the output its room.
    expect((chat?.tokens ?? 0) + 2_048).toBeLessThanOrEqual(8_192);
    const text = messagesOf(body)
      .filter((message) => message.role !== "system")
      .map((message) => message.content)
      .join("\n\n");
    expect(text.endsWith("Summarise my Notes.")).toBe(true);
    // The newest Notes are kept, in order; the oldest are left out.
    const kept = [...text.matchAll(/Note (\d\d):/g)].map((match) => Number(match[1]));
    expect(kept.at(-1)).toBe(30);
    expect(kept).toEqual(
      Array.from({ length: kept.length }, (_, index) => 31 - kept.length + index),
    );
    expect(kept.length).toBeLessThan(15);
    expect(text).not.toContain("Note 01:");
  });

  test("when the model counts more than the estimate, Ollama refuses the request, and it is sent again smaller", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35],
      reply: () => ({ content: "They are about lorem ipsum." }),
      // A tokenizer that counts about twice our estimate, as Qwen's does for text full of digits.
      countTokens: (body) => Math.ceil(JSON.stringify(body.messages).length / 2),
    });
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35.name, {
      memory: 8 * GIB,
    });
    const { notes, asked } = bigMind();
    writeMind(client, [...notes, asked]);

    const { ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);

    expect(ended.event).toBe("finished");
    expect(ollama.chats.map((chat) => chat.refused)).toEqual([true, false]);
    const [first, second] = ollama.chats;
    expect(second?.tokens ?? 0).toBeLessThan(first?.tokens ?? 0);
    expect((second?.tokens ?? 0) + 2_048).toBeLessThanOrEqual(8_192);
    expect(ollama.chats.some((chat) => chat.cut)).toBe(false);
  });

  test("a Question that can't fit fails as too long, in words, and nothing is sent", async () => {
    const ollama = await startOllamaServer({ models: [QWEN35], reply: () => ({ content: "?" }) });
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35.name, {
      memory: 8 * GIB,
    });
    const asked = question(`Summarise this: ${"lorem ipsum dolor sit amet ".repeat(2_000)}`);
    writeMind(client, [asked]);

    const { ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);

    expect(ended.event).toBe("failed");
    expect(ended.payload).toMatchObject({ error: { kind: "too-long" } });
    expect(ollama.chats).toHaveLength(0);
    expect(translate("en", "answer.error.too-long")).toMatch(/too long for the model/);
    expect(translate("zh-CN", "answer.error.too-long")).toMatch(/超出了模型的上限/);
  });

  test("a cloud model gets its own window whatever the memory, and a long conversation fits it", async () => {
    const cloud = {
      ...QWEN35,
      name: "gpt-oss:20b-cloud",
      remote: true,
      modelInfo: { "general.architecture": "gptoss", "gptoss.context_length": 131_072 },
    };
    const ollama = await startOllamaServer({
      models: [cloud],
      reply: () => ({ content: "They are about lorem ipsum." }),
    });
    const { core, mind, client } = await setUpLocalModel(ollama, cloud.name, { memory: 8 * GIB });
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });
    const { notes, asked } = bigMind();
    writeMind(client, [...notes, asked]);

    const { ended } = await askAndEnd(core, client, mind.id, asked.attrs.id);

    expect(ended.event).toBe("finished");
    const [chat] = ollama.chats;
    expect(chat).toMatchObject({ refused: false, cut: false });
    expect(chat?.body).toMatchObject({ options: { num_ctx: 131_072 } });
    const text = messagesOf(chat?.body ?? {})
      .map((message) => message.content)
      .join("\n\n");
    expect([...text.matchAll(/Note \d\d:/g)].length).toBeGreaterThan(15);
  });

  test("Ollama's refusal of a request that is too long reads as too long, with its counts", () => {
    const refusal = new APICallError({
      message:
        "request (6029 tokens) exceeds the available context size (4096 tokens), try increasing it",
      url: "http://127.0.0.1:11434/api/chat",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(classifyProviderError(refusal).kind).toBe("too-long");
    expect(contextOverflow(refusal)).toEqual({ promptTokens: 6029, windowTokens: 4096 });
    expect(contextOverflow(new Error("exceeds the available context size"))).toBeNull();
  });
});
