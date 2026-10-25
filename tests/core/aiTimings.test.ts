import { join } from "node:path";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core/core";
import { createMeter, type MeteredModel } from "../../src/core/cost/meter";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core/reranking";
import { type Database, openDatabase } from "../../src/core/storage";
import { flowNow, inFlow, inStep } from "../../src/core/timing/flows";
import { createTimings } from "../../src/core/timing/timings";
import { setUpWithDocuments, unaskedModel } from "../helpers/citations";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { question, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const USAGE = {
  inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
  outputTokens: { total: 40, text: 30, reasoning: 10 },
};

// A reply that thinks, then writes, then ends, unless `ends` is false: then it is cut off.
function thinkingModel({ ends = true }: { ends?: boolean } = {}) {
  return new MockLanguageModelV4({
    doStream: async () => {
      const parts: StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "Hmm." },
        { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "The tide turns twice a day." },
        { type: "text-end", id: "t" },
      ];
      return {
        stream: new ReadableStream<StreamPart>({
          async pull(controller) {
            const part = parts.shift();
            if (part) return controller.enqueue(part);
            if (!ends) return controller.close();
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: USAGE,
            });
            controller.close();
          },
        }),
      };
    },
  });
}

async function cloudCore(model: MockLanguageModelV4, dataDir?: string) {
  const folder = dataDir ?? (await createTempDataFolder());
  const core = startCore(folder, { createChatModel: () => model });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: "sk-test",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  return { core, dataDir: folder };
}

interface TimingRow {
  kind: string;
  flow: string | null;
  step: string | null;
  data_flow: string | null;
  provider_kind: string | null;
  model_id: string;
  reasoning: string | null;
  first_byte_ms: number | null;
  first_reasoning_ms: number | null;
  first_text_ms: number | null;
  end_ms: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  units: number | null;
  outcome: string;
}

const timingsIn = (dataDir: string) =>
  queryDatabase<TimingRow>(dataDir, "SELECT * FROM ai_timings ORDER BY started_at, rowid");

describe("How long each AI request took, by flow (#1624)", () => {
  // protects=every model request a Question makes is recorded with its flow, data flow, provider, model and reasoning setting, the times to its first byte, first reasoning, first text and end, and its tokens; the table holds no column for text; fails_when=a request isn't recorded, is recorded under no flow, a time is missing or out of order, or a column could hold a prompt or reply; no_claim=how fast a real model is, which eval/speed measures.
  test("a Question's requests are recorded with their flow, times, tokens and reasoning, and no text", async () => {
    const { core, dataDir } = await cloudCore(thinkingModel());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    const asked = question("When does the tide turn?");
    writeMind(client, [asked]);
    await client.settled();
    const finished = new Promise<void>((resolve) => core.on("answer.finished", () => resolve()));
    await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    await finished;
    core.close();

    const rows = timingsIn(dataDir);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "model",
        flow: "question",
        data_flow: "chat",
        provider_kind: "anthropic",
        model_id: "claude-haiku-5-5",
        outcome: "finished",
        input_tokens: 1200,
        cached_input_tokens: 1000,
        output_tokens: 40,
      });
      expect(row.first_byte_ms).not.toBeNull();
      expect(row.first_reasoning_ms ?? 0).toBeGreaterThanOrEqual(row.first_byte_ms ?? 0);
      expect(row.first_text_ms ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(
        row.first_reasoning_ms ?? 0,
      );
      expect(row.end_ms).toBeGreaterThanOrEqual(row.first_text_ms ?? 0);
    }
    expect(rows.some((row) => row.step === null && row.reasoning === "answer")).toBe(true);
    const columns = queryDatabase<{ name: string; type: string }>(
      dataDir,
      "SELECT name, type FROM pragma_table_info('ai_timings')",
    );
    const named = new Set(["id", "kind", "flow", "step", "data_flow", "provider_kind", "model_id"]);
    const texts = columns.filter((column) => column.type === "TEXT").map((column) => column.name);
    expect(
      texts.filter((name) => !named.has(name) && !name.endsWith("_at") && name !== "reasoning"),
    ).toEqual(["outcome"]);
  });

  // protects=a request made outside any flow is still recorded, under its data flow, so a flow nobody tagged shows in the table by itself; a reply cut off before its end says so; fails_when=it is dropped, or a cut-off reply reads as finished; no_claim=which flows are tagged, which the flow tests cover.
  test("a request outside any flow is recorded under its data flow, and a cut-off reply says so", async () => {
    const { core, dataDir } = await cloudCore(thinkingModel({ ends: false }));
    const { model } = await core.prepareChatModel();
    const streamed = streamText({ model, prompt: "Hello", onError: () => {} });
    for await (const _ of streamed.fullStream);
    core.close();
    expect(timingsIn(dataDir)).toEqual([
      expect.objectContaining({ kind: "model", flow: null, data_flow: "chat", outcome: "stopped" }),
    ]);
  });

  // protects=a flow started inside another is its step, and a step outside any flow is a flow of its own, so an edit an Answer makes is told from Edit with AI used directly; fails_when=the inner flow replaces the outer, or a lone step is dropped; no_claim=the request records themselves.
  test("a flow inside a flow is its step, and a step on its own is a flow", async () => {
    expect(inFlow("assistant-edit", () => inFlow("edit-with-ai", flowNow))).toEqual({
      flow: "assistant-edit",
      step: "edit-with-ai",
    });
    expect(inFlow("question", () => inStep("search-rewrite", flowNow))).toEqual({
      flow: "question",
      step: "search-rewrite",
    });
    expect(inStep("written-check", flowNow)).toEqual({ flow: "written-check", step: null });
    expect(
      await inFlow("question", async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return flowNow();
      }),
    ).toEqual({ flow: "question", step: null });
  });

  // protects=the steps run on this computer are timed where they run: each Document's indexing, and reranking with how many Passages it reranked and the flow it ran for; fails_when=either isn't recorded, or reranking records no count; no_claim=their speed.
  test("indexing and reranking on this computer are timed, reranking with how many Passages", async () => {
    const { core, dataDir } = await setUpWithDocuments(
      unaskedModel(),
      [
        { name: "Coast.md", contents: "# Coast\n\nThe lighthouse stands on the cliff." },
        { name: "Weather.md", contents: "# Weather\n\nRain comes from the west." },
      ],
      {},
      { embeddings: true },
    );
    await inFlow("find-support", () => core.searchEvidence("lighthouse"));
    core.close();
    const local = timingsIn(dataDir).filter((row) => row.kind === "local");
    expect(local.filter((row) => row.flow === "index-document")).toHaveLength(2);
    const reranked = local.filter((row) => row.model_id === BUILT_IN_RERANKING_MODEL.name);
    expect(reranked).toEqual([
      expect.objectContaining({
        flow: "find-support",
        step: null,
        provider_kind: "local",
        outcome: "finished",
      }),
    ]);
    expect(reranked[0]?.units).toBeGreaterThan(0);
  });

  // protects=transcribing a Meeting on this computer is timed, each stretch with its seconds of audio and the model that read it; fails_when=it isn't recorded, or records no audio; no_claim=the real engine's speed, which eval/speed and eval/transcription measure.
  test("a Meeting transcribed on this computer is timed, with the seconds of audio", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    record(12 * 1000, ["microphone"]);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    core.close();
    const transcribed = timingsIn(dataDir).filter((row) => row.flow === "transcribe");
    expect(transcribed.length).toBeGreaterThan(0);
    for (const row of transcribed) {
      expect(row).toMatchObject({ kind: "local", provider_kind: "local", outcome: "finished" });
      expect(row.units).toBeGreaterThan(0);
    }
  });

  // protects=the records stay on this computer for 30 days: older ones go at the next start; fails_when=they are kept forever, or newer ones go; no_claim=what reads them.
  test("records older than 30 days go at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock("2026-10-23T09:00:00.000Z");
    startCore(dataDir, { now: clock.now }).close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    for (const [id, at] of [
      ["old", "2026-09-20T09:00:00.000Z"],
      ["new", "2026-10-20T09:00:00.000Z"],
    ] as const) {
      db.run(
        `INSERT INTO ai_timings (id, kind, model_id, started_at, end_ms, outcome, created_at, updated_at)
         VALUES (?, 'model', 'm', ?, 1, 'finished', ?, ?)`,
        [id, at, at, at],
      );
    }
    db.close();
    startCore(dataDir, { now: clock.now }).close();
    expect(queryDatabase<{ id: string }>(dataDir, "SELECT id FROM ai_timings")).toEqual([
      { id: "new" },
    ]);
  });
});

describe("A timing record that can't be written (#1624)", () => {
  // A database whose writes fail, as a locked or closed one does, or a full disk.
  async function failingTimings() {
    const db = openDatabase(join(await createTempDataFolder(), DATABASE_FILE));
    const failing: Database = {
      ...db,
      run: () => {
        throw new Error("database is locked");
      },
    };
    const warned: string[] = [];
    const log = { info: () => {}, error: () => {}, warn: (event: string) => warned.push(event) };
    const timings = createTimings({ db: failing, now: () => new Date(), log });
    const meter = createMeter({ db: failing, now: () => new Date(), cap: () => null, timings });
    return { timings, meter, warned };
  }

  const FREE: MeteredModel = {
    providerId: "local",
    kind: "ollama",
    modelId: "local-model",
    flow: "chat",
    billing: "free",
    price: undefined,
    maxOutput: undefined,
    ollamaCloud: false,
  };

  // protects=a timing record that can't be written never reaches the request: the reply comes whole, and the failure is logged (#1624 review); fails_when=the stream errors after the reply, as it did; no_claim=the record, which is lost.
  test("a reply comes whole, and the lost record is logged", async () => {
    const { meter, warned } = await failingTimings();
    const result = streamText({ model: meter.wrap(thinkingModel(), FREE), prompt: "When?" });
    expect(await result.text).toBe("The tide turns twice a day.");
    expect(warned).toEqual(["timing.not_recorded"]);
  });

  // protects=cancelling a reply whose record can't be written still cancels the request at the model's provider; fails_when=the write throws before the cancel is passed on; no_claim=none beyond protects.
  test("cancelling a reply reaches the model", async () => {
    const { meter } = await failingTimings();
    let cancelled = false;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<StreamPart>({
          pull(controller) {
            controller.enqueue({ type: "text-delta", id: "t", delta: "The tide" });
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    const wrapped = meter.wrap(model, FREE);
    const { stream } = await wrapped.doStream({ prompt: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("stopped");
    expect(cancelled).toBe(true);
  });

  // protects=a local step whose record can't be written still gives its result; fails_when=the write's failure turns a good rerank or OCR page into a failure; no_claim=none beyond protects.
  test("a local step still gives its result", async () => {
    const { timings, warned } = await failingTimings();
    expect(await timings.local("rerank", "reranker", async () => 7)).toBe(7);
    timings.prune();
    expect(warned).toEqual(["timing.not_recorded", "timing.not_pruned"]);
  });
});

describe("Background work in the timing records (#1624)", () => {
  // protects=Organize's turn in the background queue is recorded under its data flow alone, not under the flow that happened to queue it (an Answer that saved a Document, say); fails_when=its requests carry that flow's tag; no_claim=the turn's own timing.
  test("a background turn queued inside a flow isn't tagged with it", async () => {
    let folderId = "";
    const filed = () => ({ text: JSON.stringify({ groupId: folderId, tags: [] }) });
    const model = scriptedModel(filed, { generate: filed });
    const { core, dataDir } = await cloudCore(model);
    folderId = (await core.createLibraryGroup({ name: "Tides", description: "The sea" })).id;
    const [provider] = await core.listChatProviders();
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider?.id ?? "", modelId: "claude-haiku-5-5" },
      },
      automatic: false,
    });
    const [service] = (await core.listChatProviders()).flatMap((each) => each.service ?? []);
    for (const flow of ["tagging", "classification"] as const) {
      if (service) await core.allowDataFlow(flow, service.id);
    }
    const sources = await createTempDataFolder();
    const [moon] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Moon.md",
        "# Moon\n\nSpring tides come at new and full moon.",
      ),
    ]);
    await inFlow("question", () => core.classifyDocuments([moon?.id ?? ""]));
    await vi.waitFor(
      async () =>
        expect(
          (await core.getLibrary()).assignments.filter((each) => each.status === "classified"),
        ).toHaveLength(1),
      { timeout: 10_000 },
    );
    const rows = queryDatabase<{ flow: string | null; data_flow: string | null }>(
      dataDir,
      "SELECT flow, data_flow FROM ai_timings WHERE kind = 'model'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.flow === null)).toBe(true);
  });
});
