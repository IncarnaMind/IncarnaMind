/**
 * A model whose provider refuses it, or turns it away as busy, has its requests go to another
 * (#2526): call help's quick model giving way to the Answers model.
 */
import { APICallError, generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { refusedGoesTo } from "../../src/core/providers/modelRefusal";
import { failingModel, failingStreamModel, replyingModel, streamingModel } from "../helpers/models";

const refusal = (statusCode: number, message: string) =>
  new APICallError({
    message,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });

/** `own`, going to `instead`, and what it said of the switch. */
function goingTo(own: MockLanguageModelV4, instead: MockLanguageModelV4) {
  const heard: string[] = [];
  const model = refusedGoesTo(own, instead, {
    switched: () => heard.push("switched"),
    refused: (error) => heard.push(`refused ${error instanceof Error ? error.message : ""}`),
  });
  return { model, heard };
}

describe("A refused model", () => {
  test("a model not found: the request and every one after it go to the other, which is told once", async () => {
    const own = failingStreamModel(404, "model: claude-haiku-5-5 not found");
    const instead = streamingModel(["From the other"]);
    const { model, heard } = goingTo(own, instead);

    const first = await streamText({ model, prompt: "Hi" }).text;
    const second = await streamText({ model, prompt: "Again" }).text;

    expect([first, second]).toEqual(["From the other", "From the other"]);
    expect(own.doStreamCalls).toHaveLength(1);
    expect(instead.doStreamCalls).toHaveLength(2);
    expect(heard).toEqual(["switched", "refused model: claude-haiku-5-5 not found"]);
  });

  test("a request that isn't streamed goes to the other too", async () => {
    const own = failingModel(403, "This key can't use this model");
    const instead = replyingModel("From the other");
    const { model, heard } = goingTo(own, instead);

    const { text } = await generateText({ model, prompt: "Hi" });

    expect(text).toBe("From the other");
    expect(heard).toEqual(["switched", "refused This key can't use this model"]);
  });

  test("refused on a later request, it goes to the other from that one", async () => {
    let asked = 0;
    const own = new MockLanguageModelV4({
      doStream: async (options) => {
        asked += 1;
        if (asked > 1) throw refusal(404, "model not found");
        return streamingModel(["From its own"]).doStream(options);
      },
    });
    const instead = streamingModel(["From the other"]);
    const { model, heard } = goingTo(own, instead);

    const first = await streamText({ model, prompt: "Hi" }).text;
    const second = await streamText({ model, prompt: "Again" }).text;

    expect([first, second]).toEqual(["From its own", "From the other"]);
    expect(heard).toEqual(["switched", "refused model not found"]);
  });

  test("busy: the request goes to the other, which isn't told the model was refused", async () => {
    const own = failingStreamModel(429, "rate limited");
    const instead = streamingModel(["From the other"]);
    const { model, heard } = goingTo(own, instead);

    expect(await streamText({ model, prompt: "Hi", maxRetries: 0 }).text).toBe("From the other");
    expect(heard).toEqual(["switched"]);
  });

  test("refused there too: the other's failure stands, and the model isn't counted as refused", async () => {
    const own = failingStreamModel(404, "model not found");
    const instead = failingStreamModel(402, "Your credit balance is too low");
    const { model, heard } = goingTo(own, instead);
    let failure: unknown = null;

    await streamText({
      model,
      prompt: "Hi",
      onError: ({ error }) => (failure = error),
    }).consumeStream();

    expect(failure).toMatchObject({ statusCode: 402 });
    expect(heard).toEqual(["switched"]);
  });

  test.each([
    { name: "a bad key", statusCode: 401, message: "invalid x-api-key" },
    { name: "a request too long", statusCode: 400, message: "prompt is too long: 250000 tokens" },
    {
      name: "a Tool the model can't take",
      statusCode: 400,
      message: "model does not support tools",
    },
    {
      name: "the request's own shape",
      statusCode: 400,
      message: "messages.1.content.0.text: cache_control cannot be set for empty text blocks",
    },
    { name: "no credit", statusCode: 402, message: "Your credit balance is too low" },
  ])(
    "$name stays with the model, sending nothing to the other",
    async ({ statusCode, message }) => {
      const own = failingStreamModel(statusCode, message);
      const instead = streamingModel(["From the other"]);
      const { model, heard } = goingTo(own, instead);
      let failure: unknown = null;

      await streamText({
        model,
        prompt: "Hi",
        onError: ({ error }) => (failure = error),
      }).consumeStream();

      expect(failure).toMatchObject({ statusCode });
      expect(instead.doStreamCalls).toHaveLength(0);
      expect(heard).toEqual([]);
    },
  );
});
