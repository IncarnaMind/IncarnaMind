/**
 * Requests to OpenAI's Responses API ask OpenAI not to store them (#159): every
 * request the app makes with an API-key OpenAI model carries `store: false`,
 * whatever it is for. The tests run the real OpenAI provider against a stand-in
 * for `fetch` that records each request body.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnswerEngineEvent, AnswerRequest, AnswerTools } from "../../src/core/answers/engine";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { chatGroupClassifier } from "../../src/core/library/classifier";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chatClassifier } from "../../src/core/tags/classify";
import { createTempDataFolder, startCore } from "../helpers/core";
import { type Captured, stubOpenAI } from "../helpers/stubOpenAI";

afterEach(() => vi.unstubAllGlobals());

const openai = (modelId = "gpt-5.5") =>
  createAiSdkChatModel({ kind: "openai", baseUrl: null, apiKey: "sk-test", modelId });

/** Every request went to the Responses API and said not to store. */
function expectNoneStored(requests: Captured[], count?: number) {
  if (count !== undefined) expect(requests).toHaveLength(count);
  expect(requests.length).toBeGreaterThan(0);
  for (const { url, body } of requests) {
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body.store).toBe(false);
    // Reasoning summaries stay off: nothing here asks for them.
    expect(JSON.stringify(body.reasoning ?? {})).not.toContain("summary");
  }
}

const documents = (searches: string[] = []): AnswerTools => ({
  documentCount: 1,
  documentLanguages: [{ language: "Chinese", documents: 1 }],
  async searchDocuments(query) {
    searches.push(query);
    return { text: "No Passages found.", passageCount: 0 };
  },
  cite: () => "Recorded.",
});

function request(overrides: Partial<AnswerRequest> = {}): AnswerRequest {
  return {
    instructions: () => "Answer from the Documents.",
    messages: [{ role: "user", content: "What is a Mind?" }],
    question: "What is a Mind?",
    model: openai(),
    documents: documents(),
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function run(answer: AnswerRequest): Promise<AnswerEngineEvent[]> {
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate(answer)) events.push(event);
  return events;
}

describe("Requests to OpenAI say not to store", () => {
  test("an Answer with the Tool loop: every step of the loop", async () => {
    const requests = stubOpenAI([
      { call: { name: "search_documents", input: { query: "Mind" } } },
      { text: "A Mind is a note." },
    ]);

    const events = await run(request());

    expect(events.at(-1)).toEqual({ type: "finished" });
    expect(events.filter((event) => event.type === "text-delta")).not.toHaveLength(0);
    expectNoneStored(requests, 2);
    // The second step holds the first's Tool call: it was sent in full, not by reference.
    expect(JSON.stringify(requests[1]?.body.input)).toContain("function_call");
  });

  test("an Answer by structured output, with its query rewritten and translated", async () => {
    const requests = stubOpenAI([
      { text: "what is a Mind" },
      { text: "什么是 Mind" },
      { text: JSON.stringify({ answer: "A Mind is a note.", citations: [] }) },
    ]);

    const events = await run(
      request({
        support: "structured-output",
        messages: [
          { role: "user", content: "Tell me about tides." },
          { role: "assistant", content: "Tides are caused by the Moon." },
          { role: "user", content: "What is a Mind?" },
        ],
      }),
    );

    expect(events.at(-1)).toEqual({ type: "finished" });
    // The rewrite, the translation and the Answer itself.
    expectNoneStored(requests, 3);
    expect(requests[2]?.body.text).toMatchObject({ format: { type: "json_schema" } });
  });

  test("a plain Answer, with no Documents to search", async () => {
    const requests = stubOpenAI([{ text: "A Mind is a note." }]);

    const events = await run(
      request({ documents: { ...documents(), documentCount: 0 }, support: "none" }),
    );

    expect(events.at(-1)).toEqual({ type: "finished" });
    expectNoneStored(requests, 1);
  });

  test("automatic tagging and Organize", async () => {
    const requests = stubOpenAI([
      { text: JSON.stringify({ tags: ["Report"] }) },
      { text: JSON.stringify({ groupId: "g-reports", tags: ["t-report"] }) },
    ]);
    const tags = [{ id: "t-report", name: "Report", description: "A report of findings" }];
    const excerpt = { name: "QBR", kind: "pdf" as const, pageCount: 2, text: "Quarterly review." };
    const signal = new AbortController().signal;

    const tagged = await chatClassifier(openai()).decide({ tags, excerpt, signal });
    const organized = await chatGroupClassifier(openai(), false).organize(
      [
        {
          id: "g-reports",
          name: "Reports",
          description: "Reports",
          countsOwnFiles: false,
          keepInside: false,
          createdAt: "",
          updatedAt: "",
        },
      ],
      tags,
      excerpt,
      signal,
    );

    expect(tagged.decisions.map((tag) => tag.tagId)).toEqual(["t-report"]);
    expect(organized.groupId).toBe("g-reports");
    expectNoneStored(requests, 2);
  });

  test("the connection test", async () => {
    const requests = stubOpenAI([{ text: "OK" }]);
    const core = startCore(await createTempDataFolder(), { createChatModel: createAiSdkChatModel });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));

    const result = await core.testChatConnection({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-5.5",
    });

    expect(result).toEqual({ ok: true });
    expectNoneStored(requests, 1);
  });

  test("an option set by a caller is kept, and only store is forced", async () => {
    const requests = stubOpenAI([{ text: "OK" }]);
    const { generateText } = await import("ai");

    await generateText({
      model: openai(),
      prompt: "Hi",
      providerOptions: { openai: { store: true, user: "someone" } },
      maxRetries: 0,
    });

    expectNoneStored(requests, 1);
    expect(requests[0]?.body.user).toBe("someone");
  });

  test("other providers are left alone", async () => {
    const requests = stubOpenAI([{ text: "OK" }]);
    const { generateText } = await import("ai");
    const compatible = createAiSdkChatModel({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: null,
      modelId: "local",
    });

    await generateText({ model: compatible, prompt: "Hi", maxRetries: 0 }).catch(() => undefined);

    expect(requests.every(({ body }) => !("store" in body))).toBe(true);
  });
});
