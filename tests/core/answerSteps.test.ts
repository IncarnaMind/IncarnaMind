import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, CoreEvents } from "../../src/core";
import { answerEnded, answerJudged, citingModel, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * An Answer's steps in the assistant (#391), through the core's public
 * interface: the model's reasoning summary and how long it thought, kept
 * only from a provider that summarizes reasoning and never sent back to the
 * model; the phases and the times; and what each search found, so its
 * Citations can be told. Scripted models stand in for the providers.
 */

const SUMMARY =
  "The Question is about spring tides. I will search the Documents for them, then cite the page.";
const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);

/** A model that reasons, then answers in one go. */
const reasoningModel = (answer = "At new and full moon.") =>
  scriptedModel(() => ({ reasoning: SUMMARY, text: answer }), { judgesItsAnswers: true });

/** A core whose chat model is `model`, on a provider of `kind`, its Questions allowed to go there. */
async function setUp(model: MockLanguageModelV4, kind: "anthropic" | "ollama") {
  const dataDir = await createTempDataFolder();
  const adapters = { createChatModel: scriptedModels(model).createChatModel };
  const core = startCore(dataDir, adapters);
  const provider =
    kind === "anthropic"
      ? await core.saveChatProvider({
          kind,
          apiKey: "sk-ant-test",
          modelId: "claude-sonnet-5-5",
        })
      : await core.saveChatProvider({ kind, modelId: "local-model" });
  if (provider.service) await core.allowDataFlow("chat", provider.service.id);
  return { core, dataDir, adapters };
}

/** Asks in a conversation and resolves with its Answer as stored once it ended, and the events it sent. */
async function ask(core: Core, text: string, conversationId: string | null = null) {
  const reasoning: CoreEvents["answer.reasoning"][] = [];
  const stop = core.on("answer.reasoning", (event) => reasoning.push(event));
  const result = await core.askInConversation({ text, conversationId });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  stop();
  const answer = await answerJudged(core, result.conversation.id, result.answerId);
  return {
    answer,
    conversationId: result.conversation.id,
    reasoning,
  };
}

describe("The model's reasoning", { timeout: 30_000 }, () => {
  // protects=a provider's reasoning summary is announced, kept with the Answer, and survives a restart; fails_when=the summary is lost, not announced, or differs after a restart; no_claim=a scripted model stands in for Anthropic: the request it would carry is tests/core/reasoningRequests.test.ts's.
  test("from a provider that summarizes it, is announced, kept with the Answer, with how long it thought, and survives a restart", async () => {
    const { core, dataDir, adapters } = await setUp(reasoningModel(), "anthropic");

    const { answer, conversationId, reasoning } = await ask(core, "When are spring tides?");

    expect(reasoning.map((event) => event.text).join("")).toBe(SUMMARY);
    expect(reasoning.every((event) => event.conversationId === conversationId)).toBe(true);
    expect(answer.steps?.reasoning).toEqual({ summary: SUMMARY, ms: expect.any(Number) });
    expect(answer.steps?.sentAt).toEqual(expect.any(String));
    expect(Date.parse(answer.steps?.finishedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(answer.steps?.sentAt ?? ""),
    );
    expect(answer.steps?.phases.map((each) => each.phase)).toEqual([
      "writing",
      "checking-claims",
      "writing",
    ]);
    core.close();

    const later = startCore(dataDir, adapters);
    const { messages } = await later.getConversation(conversationId);
    expect(messages.find((message) => message.id === answer.id)).toEqual(answer);
    later.close();
  });

  // protects=the reasoning never goes back to the model with the next Question; fails_when=the next Question's request holds the summary; no_claim=only the conversation's context is checked, not what a provider would keep on its side.
  test("is never sent back to the model in the next Question's context", async () => {
    const model = reasoningModel("At new and full moon.");
    const { core } = await setUp(model, "anthropic");
    const { conversationId } = await ask(core, "When are spring tides?");

    await ask(core, "And neap tides?", conversationId);

    const next = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(next).toContain("At new and full moon.");
    expect(next).not.toContain("spring tides. I will search");
    core.close();
  });

  // protects=raw chain of thought from a provider that doesn't summarize is never stored or shown; fails_when=it reaches the Answer's steps, an event or the database; no_claim=a scripted model stands in for Ollama's thinking.
  test("from a provider whose reasoning is raw, is dropped: never announced, stored or shown", async () => {
    const { core, dataDir } = await setUp(reasoningModel(), "ollama");

    const { answer, reasoning } = await ask(core, "When are spring tides?");

    expect(reasoning).toEqual([]);
    expect(answer.steps?.reasoning).toBeNull();
    expect(answer.text).toBe("At new and full moon.");
    const rows = queryDatabase<{ row: string }>(
      dataDir,
      "SELECT json_object('text', text, 'steps', steps, 'calls', tool_calls) AS row FROM conversation_messages",
    );
    expect(rows.map((each) => each.row).join("\n")).not.toContain("I will search");
    core.close();
  });
});

describe("A search's steps", { timeout: 60_000 }, () => {
  // protects=a search keeps the Passages it found, so its Citations can be told; fails_when=a search's call has no Passages, or not the cited one; no_claim=a scripted model stands in for the provider.
  test("keep the Passages it found, among them the one its Citation points to, and the phases with their times", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    await addAndProcess(core, [await writeSourceFile(sources, "Tides.pdf", TIDES)]);

    const { answer } = await ask(core, "When are spring tides?");

    const [search] = answer.toolCalls;
    expect(search).toMatchObject({ tool: "search_documents", status: "done" });
    expect(search?.passages).toContain(answer.citations[0]?.passageId);
    expect(answer.steps?.phases.map((each) => each.phase)).toEqual([
      "writing",
      "searching",
      "writing",
      "checking-claims",
      "writing",
    ]);
    const times = answer.steps?.phases.map((each) => Date.parse(each.at)) ?? [];
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    core.close();
  });

  // protects=a failed search keeps why it failed, sorted as a provider's error, and the Answer goes on; fails_when=the call has no error kind, or the Answer fails with it; no_claim=a reranker that refuses its key stands in for any search model's failure.
  test("keep why a search failed, and the Answer goes on", async () => {
    const model = scriptedModel(
      (call) =>
        call.tools.length > 0
          ? { error: { status: 400, message: "this model does not support tools" } }
          : {
              text: JSON.stringify({ answer: "I couldn't search your Documents.", citations: [] }),
            },
      { judgesItsAnswers: true },
    );
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(model).createChatModel,
      reranker: async () => {
        throw new APICallError({
          message: "Invalid API key.",
          url: "https://api.cohere.com/v2/rerank",
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createSourceFolder();
    await addAndProcess(core, [await writeSourceFile(sources, "Tides.pdf", TIDES)]);

    const { answer } = await ask(core, "When are spring tides?");

    expect(answer.status).toBe("done");
    expect(answer.toolCalls[0]).toMatchObject({
      tool: "search_documents",
      status: "failed",
      error: { kind: "auth", message: expect.stringContaining("Invalid API key") },
    });
    core.close();
  });
});

describe("A Document read", { timeout: 60_000 }, () => {
  test("after a search miss ends with the figure on the read page cited", async () => {
    const model = scriptedModel(
      (call) => {
        if (!call.tools.includes("read_document"))
          return { text: "read_document was not offered." };
        const reads = call.results.filter((result) => result.tool === "read_document");
        if (call.results.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "no matching words" } }] };
        }
        if (reads.length === 0) {
          return {
            calls: [{ tool: "read_document", input: { document: "Filing", pages: "2" } }],
          };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const passages = shownPassages(reads.at(-1)?.text ?? "");
          return {
            calls: [
              {
                tool: "cite",
                input: {
                  citations: [
                    {
                      marker: 1,
                      passage: passages[0]?.id,
                      pageFrom: 2,
                      pageTo: 2,
                      quote: "Comparable sales declined 6.2%.",
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: "Comparable sales declined 6.2% [^1]." };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf([
      { lines: ["Segment results", "Domestic comparable sales declined 5.1%."] },
      { lines: ["Consolidated results", "Comparable sales declined 6.2%."] },
    ]);
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    const { answer } = await ask(core, "What was the consolidated comparable-sales change?");

    expect(answer.text).toBe("Comparable sales declined 6.2% [^1].");
    expect(answer.citations[0]).toMatchObject({ pageFrom: 2, pageTo: 2, check: "found" });
    const read = answer.toolCalls.find((call) => call.tool === "read_document");
    expect(read).toMatchObject({ status: "done", input: { document: "Filing", pages: "2" } });
    expect(read?.passages).toContain(answer.citations[0]?.passageId);
    core.close();
  });

  test("reads the Document's opening when no pages are given", async () => {
    const model = scriptedModel(
      (call) => {
        const reads = call.results.filter((result) => result.tool === "read_document");
        if (call.results.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "no matching words" } }] };
        }
        if (reads.length === 0) {
          return { calls: [{ tool: "read_document", input: { document: "Filing" } }] };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const passages = shownPassages(reads.at(-1)?.text ?? "");
          return {
            calls: [
              {
                tool: "cite",
                input: {
                  citations: [
                    {
                      marker: 1,
                      passage: passages[0]?.id,
                      pageFrom: 1,
                      pageTo: 1,
                      quote: "Domestic comparable sales declined 5.1%.",
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: "Domestic comparable sales declined 5.1% [^1]." };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf([
      { lines: ["Segment results", "Domestic comparable sales declined 5.1%."] },
      { lines: ["Consolidated results", "Comparable sales declined 6.2%."] },
    ]);
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    const { answer } = await ask(core, "What was the domestic comparable-sales change?");

    expect(answer.text).toBe("Domestic comparable sales declined 5.1% [^1].");
    expect(answer.citations[0]).toMatchObject({ pageFrom: 1, pageTo: 1, check: "found" });
    core.close();
  });

  test("reads around a Passage the model was already shown", async () => {
    const model = scriptedModel(
      (call) => {
        const reads = call.results.filter((result) => result.tool === "read_document");
        if (call.results.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "Segment results" } }] };
        }
        if (reads.length === 0) {
          const searched = call.results.find((result) => result.tool === "search_documents");
          const passages = shownPassages(searched?.text ?? "");
          return {
            calls: [
              {
                tool: "read_document",
                input: { document: "Filing", passage: passages[0]?.id, after: 1 },
              },
            ],
          };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const passages = shownPassages(reads.at(-1)?.text ?? "");
          const consolidated = passages.find((passage) =>
            passage.text.includes("Comparable sales declined 6.2%."),
          );
          return {
            calls: [
              {
                tool: "cite",
                input: {
                  citations: [
                    {
                      marker: 1,
                      passage: consolidated?.id,
                      pageFrom: 2,
                      pageTo: 2,
                      quote: "Comparable sales declined 6.2%.",
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: "Comparable sales declined 6.2% [^1]." };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf([
      { lines: ["Segment results", "Domestic comparable sales declined 5.1%."] },
      { lines: ["Consolidated results", "Comparable sales declined 6.2%."] },
    ]);
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    const { answer } = await ask(core, "What was the consolidated comparable-sales change?");

    expect(answer.text).toBe("Comparable sales declined 6.2% [^1].");
    expect(answer.citations[0]).toMatchObject({ pageFrom: 2, pageTo: 2, check: "found" });
    core.close();
  });

  test("stops at three reads in one Answer", async () => {
    const model = scriptedModel(
      (call) => {
        const reads = call.results.filter((result) => result.tool === "read_document");
        if (reads.length < 4) {
          return {
            calls: [
              {
                tool: "read_document",
                input: { document: "Filing", pages: String(reads.length + 1) },
              },
            ],
          };
        }
        return { text: "Done reading." };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf(
      Array.from({ length: 4 }, (_, index) => ({ lines: [`Page ${index + 1}`] })),
    );
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    const { answer } = await ask(core, "Read this filing.");

    const reads = answer.toolCalls.filter((call) => call.tool === "read_document");
    expect(reads).toHaveLength(4);
    expect(reads.slice(0, 3).map((call) => call.resultCount)).toEqual([1, 1, 1]);
    expect(reads[3]?.resultCount).toBe(0);
    const last = model.doStreamCalls.at(-1);
    const text = JSON.stringify(last?.prompt);
    expect(text).toContain("3-read limit");
    core.close();
  });

  test("a page-range read overlaps one-page Passages and records its capped range", async () => {
    let readText = "";
    const model = scriptedModel(
      (call) => {
        if (call.results.length === 0) {
          return {
            calls: [{ tool: "read_document", input: { document: "Filing", pages: "1-40" } }],
          };
        }
        readText = call.results.find((result) => result.tool === "read_document")?.text ?? "";
        return { text: "Read the first three pages." };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf(
      Array.from({ length: 4 }, (_, index) => ({
        lines: [
          `Page ${index + 1}`,
          ...Array.from(
            { length: 40 },
            (_, line) =>
              `note${line} ${Array.from({ length: 15 }, (_, word) => `word${word}`).join(" ")}`,
          ),
        ],
      })),
    );
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    const { answer } = await ask(core, "Read the filing's first pages.");

    const read = answer.toolCalls.find((call) => call.tool === "read_document");
    expect(read).toMatchObject({
      status: "done",
      input: { document: "Filing", pages: "1–3" },
    });
    expect(read?.resultCount).toBeGreaterThan(3);
    expect(readText).toContain("Only the first 3 requested pages are shown.");
    expect(readText).toContain('pages="1"');
    expect(readText).toContain('pages="2"');
    expect(readText).toContain('pages="3"');
    expect(readText).not.toContain('pages="4"');
    core.close();
  });

  test("a search miss without a read says I didn't find and has no Citation", async () => {
    const model = scriptedModel(
      (call) =>
        call.results.length === 0
          ? { calls: [{ tool: "search_documents", input: { query: "no matching words" } }] }
          : { text: "I didn't find the consolidated comparable-sales change in “Filing”." },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf([
      { lines: ["Segment results", "Domestic comparable sales declined 5.1%."] },
      { lines: ["Consolidated results", "Comparable sales declined 6.2%."] },
    ]);
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    const { answer } = await ask(core, "What was the consolidated comparable-sales change?");

    expect(answer.text).toBe("I didn't find the consolidated comparable-sales change in “Filing”.");
    expect(answer.citations).toEqual([]);
    expect(answer.toolCalls.filter((call) => call.tool === "read_document")).toEqual([]);
    core.close();
  });

  test("refuses a page number outside the safe integer range", async () => {
    const model = scriptedModel(
      (call) =>
        call.results.length === 0
          ? {
              calls: [
                {
                  tool: "read_document",
                  input: { document: "Filing", pages: "9".repeat(400) },
                },
              ],
            }
          : { text: "I couldn't read that page." },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    await addAndProcess(core, [
      await writeSourceFile(sources, "Filing.pdf", buildPdf([{ lines: ["Page 1"] }])),
    ]);

    const { answer } = await ask(core, "Read an invalid page.");

    expect(answer.text).toBe("I couldn't read that page.");
    expect(answer.toolCalls).toContainEqual(
      expect.objectContaining({ tool: "read_document", status: "done", resultCount: 0 }),
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "Pages must be one page or a range",
    );
    core.close();
  });

  test("tells the model which pages a search covered", async () => {
    const model = scriptedModel(
      (call) =>
        call.results.length === 0
          ? { calls: [{ tool: "search_documents", input: { query: "Consolidated results" } }] }
          : { text: "Read the result." },
      { judgesItsAnswers: true },
    );
    const { core } = await setUp(model, "ollama");
    const sources = await createSourceFolder();
    const filing = buildPdf(
      Array.from({ length: 30 }, (_, index) => ({
        lines: [
          `Page ${index + 1}`,
          index === 7 ? "Consolidated results" : "Segment note",
          ...Array.from(
            { length: 40 },
            (_, line) =>
              `note${line} ${Array.from({ length: 15 }, (_, word) => `word${word}`).join(" ")}`,
          ),
        ],
      })),
    );
    await addAndProcess(core, [await writeSourceFile(sources, "Filing.pdf", filing)]);

    await ask(core, "What is in this filing?");

    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toMatch(/pages [0-9, –]+ of 30/);
    core.close();
  });
});
