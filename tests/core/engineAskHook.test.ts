/**
 * The engine tells a caller that passes `onAsk` when a turn check asks the model once more
 * (#1766): the claim check keeps what it wrote down across an ask about something else. A caller
 * that doesn't pass it sends the same requests and gets the same events as before the hook; the
 * file snapshot was written by the engine as it was on `main` before it.
 */
import { expect, test } from "vitest";
import { type AnswerRequest, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { type ModelCall, scriptedModel } from "../helpers/models";

async function run(onAsk?: AnswerRequest["onAsk"]) {
  const calls: ModelCall[] = [];
  const model = scriptedModel((call) => {
    calls.push(call);
    return { text: calls.length === 1 ? "The tide turns at noon." : "The tide turns twice a day." };
  });
  const events: unknown[] = [];
  for await (const event of createAiSdkAnswerEngine().generate({
    instructions: () => "Answer the question.",
    messages: [{ role: "user", content: "When does the tide turn?" }],
    question: "When does the tide turn?",
    model,
    documents: {
      documentCount: 1,
      searchDocuments: async () => ({ text: "", passageCount: 0, passageIds: [] }),
      cite: () => "Recorded.",
    },
    tools: [],
    support: "tools",
    turnChecks: [
      {
        name: "noon",
        check: (reply) =>
          reply.includes("noon") ? { claims: [], note: "Say how often it turns." } : null,
      },
    ],
    ...(onAsk && { onAsk }),
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return {
    requests: calls.map(({ index, tools, json, system, prompt, results, options }) => ({
      index,
      tools,
      json,
      system,
      prompt,
      results,
      messages: options.prompt,
    })),
    events,
  };
}

test("a caller without onAsk sends the requests and gets the events it did before the hook", async () => {
  const ran = await run();
  expect(ran.requests).toHaveLength(2);
  await expect(`${JSON.stringify(ran, null, 2)}\n`).toMatchFileSnapshot(
    "../fixtures/answers/ask-hook.json.snap",
  );
});

test("a caller with onAsk is told of the ask, and its run is the same", async () => {
  const told: { note: string; reply: string; setAside: readonly string[] }[] = [];
  const withHook = await run((note, reply, setAside) => told.push({ note, reply, setAside }));
  expect(told).toEqual([
    { note: "Say how often it turns.", reply: "The tide turns at noon.", setAside: [] },
  ]);
  expect(withHook).toEqual(await run());
});
