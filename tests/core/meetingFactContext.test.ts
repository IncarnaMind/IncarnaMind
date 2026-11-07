import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  type AnswerEngineEvent,
  type AnswerRequest,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import { withTranscript } from "../../src/core/answers/liveTranscript";
import { createWindowBudget } from "../../src/core/answers/window";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { type FillHistory, notesContext } from "../../src/core/meetings/fillPrompt";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { promptOf, scriptedModel, scriptedModels } from "../helpers/models";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const QUESTION = "Fill the recorded facts.";
const WINDOW = { tokens: 8_192, outputTokens: 2_048 };
const TRANSCRIPT = [
  '<passage id="P1" document="Current Transcript">',
  `[0:00 Dana] FIRST_CURRENT_CUE ${"current detail ".repeat(110)}`,
  "</passage>",
  '<passage id="P2" document="Current Transcript">',
  `[0:30 Dana] LAST_CURRENT_CUE ${"later detail ".repeat(150)}`,
  "</passage>",
].join("\n");

function contextWithHistory(count: number) {
  const history: FillHistory = {
    part: 2,
    facts: Array.from({ length: count }, (_, index) => ({
      id: `P1_F${index + 1}`,
      topic: `retained subject ${index + 1}`,
      text: `Recorded detail ${index + 1}: ${"supporting words ".repeat(26)}`,
      lines: ["L1"],
      sections: ["actions"],
    })),
  };
  const context = notesContext(
    [
      { marker: "L1", text: "review assignments", heading: false },
      { marker: "L2", text: "final review date", heading: false },
    ],
    QUESTION,
    history,
  );
  return { ...context, messages: withTranscript(context.messages, TRANSCRIPT) };
}

test.each([
  { facts: 0, reserve: 0 },
  { facts: 0, reserve: 4_500 },
  { facts: 32, reserve: 0 },
  { facts: 32, reserve: 4_500 },
  { facts: 64, reserve: 0 },
  { facts: 64, reserve: 4_500 },
])(
  "required Meeting input with $facts retained facts and $reserve search reserve is whole or refused",
  ({ facts, reserve }) => {
    const context = contextWithHistory(facts);
    const request = {
      instructions: "",
      tools: "",
      messages: context.messages,
      question: QUESTION,
      reserve,
      requiredContext: true as const,
    };
    const fit = createWindowBudget(WINDOW).fit(request);

    if (facts === 0) {
      expect(fit.ok).toBe(true);
      if (!fit.ok) throw new Error(fit.error.message);
      expect(fit.messages).toEqual(context.messages);
      expect(fit.messages[0]?.content).toContain("FIRST_CURRENT_CUE");
      expect(fit.messages[0]?.content).toContain("LAST_CURRENT_CUE");
      expect(fit.messages[0]?.content).toContain("L1: review assignments");
      expect(fit.messages[0]?.content).toContain("L2: final review date");
    } else {
      expect(fit).toMatchObject({ ok: false, error: { kind: "too-long" } });
    }
  },
);

test.each([
  { cost: "instructions", instructions: "system ".repeat(3_000), tools: "", factor: 1.25 },
  { cost: "Tool definitions", instructions: "", tools: "schema ".repeat(3_000), factor: 1.25 },
  { cost: "learned tokenizer factor", instructions: "", tools: "", factor: 4 },
])("required input also accounts for $cost", ({ instructions, tools, factor }) => {
  const context = contextWithHistory(0);
  const fit = createWindowBudget(WINDOW, factor).fit({
    instructions,
    tools,
    messages: context.messages,
    question: QUESTION,
    requiredContext: true,
  });
  expect(fit).toMatchObject({ ok: false, error: { kind: "too-long" } });
});

test("required input counts every message, fixed overhead, output and safety margin at the boundary", () => {
  const request = {
    instructions: "D",
    tools: "E",
    messages: [
      { role: "user" as const, content: "A", stablePrefix: 1 },
      { role: "assistant" as const, content: "B" },
      { role: "user" as const, content: "C" },
    ],
    question: "C",
    requiredContext: true as const,
    reserve: 4_500,
  };
  const fits = createWindowBudget({ tokens: 202, outputTokens: 32 }).fit(request);
  expect(fits).toMatchObject({ ok: true, messages: request.messages, estimated: 42 });
  expect(createWindowBudget({ tokens: 201, outputTokens: 32 }).fit(request)).toMatchObject({
    ok: false,
    error: { kind: "too-long" },
  });
});

test("a larger window keeps all 64 retained identities and Chinese text byte-for-byte", () => {
  const context = contextWithHistory(64);
  const messages = context.messages.map((message) => ({
    ...message,
    content: message.content.replace("review assignments", "审阅任务：李明负责，周五截止 📝"),
  }));
  const fit = createWindowBudget({ tokens: 65_536, outputTokens: 2_048 }).fit({
    instructions: "Fill from the Transcript.",
    messages,
    question: QUESTION,
    requiredContext: true,
    reserve: 4_500,
  });
  expect(fit).toMatchObject({ ok: true, messages });
  expect(messages[0]?.content).toContain('"id":"P1_F1"');
  expect(messages[0]?.content).toContain('"id":"P1_F64"');
});

function engineRequest(facts: number, support: "tools" | "structured-output" | "none") {
  const context = contextWithHistory(facts);
  const model = scriptedModel(
    (call) => ({
      text: call.json
        ? JSON.stringify({ answer: "No new facts.", citations: [] })
        : "No new facts.",
    }),
    { generate: () => ({ text: QUESTION }) },
  );
  const quickModel = vi.fn(async () => model);
  const searchDocuments = vi.fn(async () => ({ text: "", passageCount: 0 }));
  const request: AnswerRequest = {
    ...context,
    instructions: (_mode, options) => `Fill from the Transcript.\n${options?.passages ?? ""}`,
    model,
    quickModel,
    documents: { documentCount: 1, searchDocuments, cite: () => "Recorded." },
    tools: [],
    toolSet: "check",
    outputKind: "meeting-fill",
    support,
    window: WINDOW,
    signal: new AbortController().signal,
  };
  return { request, model, quickModel, searchDocuments };
}

async function generate(request: AnswerRequest): Promise<AnswerEngineEvent[]> {
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate(request)) events.push(event);
  return events;
}

test.each(["tools", "structured-output", "none"] as const)(
  "oversized Meeting facts fail before any model request on the %s route",
  async (support) => {
    const { request, model, quickModel } = engineRequest(32, support);
    const events = await generate(request);

    expect(events).toEqual([
      { type: "failed", error: expect.objectContaining({ kind: "too-long" }) },
    ]);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(quickModel).not.toHaveBeenCalled();
  },
);

test.each(["tools", "structured-output", "none"] as const)(
  "a fitting %s request keeps the full Meeting input exactly once",
  async (support) => {
    const { request, model, quickModel } = engineRequest(1, support);
    const events = await generate(request);

    expect(events.at(-1)).toEqual({ type: "finished" });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(support === "tools" ? 0 : 1);
    expect(quickModel).toHaveBeenCalledTimes(support === "tools" ? 0 : 1);
    expect(promptOf(model).filter((message) => message.role !== "system")).toEqual(
      request.messages.map((message) => ({ role: message.role, text: message.content })),
    );
  },
);

test("a Meeting request with no searchable Documents still refuses required input before generation", async () => {
  const { request, model, quickModel } = engineRequest(32, "tools");
  request.documents = { ...request.documents, documentCount: 0 };
  expect(await generate(request)).toEqual([
    { type: "failed", error: expect.objectContaining({ kind: "too-long" }) },
  ]);
  expect(model.doStreamCalls).toHaveLength(0);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(quickModel).not.toHaveBeenCalled();
});

test.each([
  { kind: "ordinary Answer", toolSet: "answer" as const },
  { kind: "untagged memo", toolSet: "check" as const },
])("$kind keeps its existing optional-context trimming", async ({ toolSet }) => {
  const { request, model } = engineRequest(32, "tools");
  delete request.meetingFacts;
  request.toolSet = toolSet;
  const events = await generate(request);

  expect(events.at(-1)).toEqual({ type: "finished" });
  expect(model.doStreamCalls).toHaveLength(1);
  const sent = promptOf(model).filter((message) => message.role !== "system");
  expect(sent).not.toEqual(
    request.messages.map((message) => ({ role: message.role, text: message.content })),
  );
  expect(sent.at(-1)?.text).toContain(QUESTION);
  expect(sent.map((message) => message.text).join("\n")).not.toContain("FIRST_CURRENT_CUE");
});

test.each(["notes", "sections", "memo"] as const)(
  "the core's %s request applies the explicit Transcript cap only when untagged",
  async (mode) => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock();
    const capture = createFakeCapture({ now: () => clock.now().getTime() });
    const said = `FIRST_EXPLICIT_CUE ${"meeting detail ".repeat(90).trimEnd()} LAST_EXPLICIT_CUE`;
    const host = inProcessTranscriber({ lines: [said], maxSpeechMs: 500 });
    const model = scriptedModel(() => ({ text: "Unexpected model request." }));
    const models = scriptedModels(model);
    const requests: AnswerRequest[] = [];
    const core = startCore(dataDir, {
      now: clock.now,
      audioCapture: capture,
      transcriber: host.transcriber,
      transcriptionModelSource: NO_TRANSCRIPTION_FILES,
      transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
      createChatModel: models.createChatModel,
      ollamaModels: {
        describe: async () => ({
          digest: null,
          capabilities: ["completion", "tools"],
          contextLength: 512,
          parameters: null,
          support: "tools",
          chat: true,
          remote: false,
          settings: { numCtx: 512, outputTokens: 128, keepAlive: "0", think: false },
        }),
        loaded: async () => true,
        running: async () => true,
      },
      answerEngine: {
        async *generate(request) {
          requests.push(request);
          yield {
            type: "failed",
            error: { kind: "too-long", message: "The full part cannot fit." },
          };
        },
      },
    });
    await core.updateSettings({ device: { meetingNoticeAccepted: true } });
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
    await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
    await core.saveChatProvider({ kind: "ollama", modelId: "context-test" });
    const meeting = mode === "memo" ? await core.recordMemo() : await core.createMeeting();
    if (mode === "notes") {
      const client = await connectToMind(core, meeting.mindId);
      writeMind(client, [note("review assignments")]);
      await client.settled();
    }
    if (mode !== "memo") await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    for (let index = 0; index < 4; index++) {
      clock.advance(500);
      capture.push("microphone", 500);
    }
    await until(core, meeting.id, (transcript) => transcript.lines >= 1);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const request = requests[0];
    if (!request) throw new Error("The core did not send the Meeting part.");
    const sent = request.messages.map((message) => message.content).join("\n");
    expect(request.window?.tokens).toBe(512);
    if (mode === "memo") {
      expect(request.meetingFacts).toBeUndefined();
      expect(sent).not.toContain("FIRST_EXPLICIT_CUE");
    } else {
      expect(request.meetingFacts).toBe(true);
      expect(sent).toContain(said);
      expect(sent).toContain("<live-transcript>");
      expect(sent).toContain("### FACT P1_F1");
    }
    expect(model.doStreamCalls).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  },
);
