import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type AnswerAnalysis,
  type AnswerSteps,
  type AnswerToolCall,
  type AskInConversationInput,
  type ConversationAnswer,
  type ConversationAskResult,
  type ConversationContent,
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type MarkedFigure,
} from "../../src/core";
import {
  mergeStoredAnalyses,
  mergeStoredCitations,
  mergeStoredFigures,
  mergeStoredSteps,
  mergeStoredToolCalls,
  PHASES,
} from "../../src/core/conversations/storedJson";
import { openDatabase } from "../../src/core/storage";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { answerJudged, citingModel } from "../helpers/citations";
import {
  createTempDataFolder,
  manualClock,
  nextTurn,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { controlledModel, promptOf, scriptedModels, streamingModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

type Asked = Extract<ConversationAskResult, { asked: true }>;

function answerEndings(core: Core) {
  const ended = new Map<string, "finished" | "failed" | Error>();
  const waiting = new Map<string, () => void>();
  const end = (answerId: string, how: "finished" | "failed" | Error) => {
    ended.set(answerId, how);
    waiting.get(answerId)?.();
  };
  core.on("answer.finished", ({ answerId, conversationId }) => {
    if (!conversationId) end(answerId, "finished");
    else {
      answerJudged(core, conversationId, answerId).then(
        () => end(answerId, "finished"),
        (error: unknown) =>
          end(answerId, error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
  core.on("answer.failed", ({ answerId }) => end(answerId, "failed"));
  return (answerId: string) =>
    new Promise<"finished" | "failed">((resolve, reject) => {
      const settle = () => {
        const how = ended.get(answerId) ?? "failed";
        if (how instanceof Error) reject(how);
        else resolve(how);
      };
      if (ended.has(answerId)) settle();
      else waiting.set(answerId, settle);
    });
}

async function setUp(model: MockLanguageModelV4, overrides: Partial<CoreAdapters> = {}) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const adapters = {
    createChatModel: scriptedModels(model).createChatModel,
    now: clock.now,
    ...overrides,
  };
  const core = startCore(dataDir, adapters);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, dataDir, clock, ended: answerEndings(core), adapters };
}

async function ask(
  core: Core,
  ended: (answerId: string) => Promise<"finished" | "failed">,
  input: AskInConversationInput,
): Promise<Asked> {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect(await ended(result.answerId)).toBe("finished");
  return result;
}

const answerOf = (content: ConversationContent, answerId: string): ConversationAnswer => {
  const answer = content.messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No such Answer.");
  return answer;
};

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at first and third quarter moon.";
const PDF = buildPdf([{ lines: ["Tides and the Moon", SPRING, NEAP] }]);

const UNKNOWN_TOP_LEVEL = {
  callHelpForm: true,
  closingLine: "Ask whether the harbourmaster confirmed the tide table.",
  futureConfig: { schema: 2, flags: ["form-fact", "closing-line"], nested: { ok: true } },
};

const UNKNOWN_PHASE_BEFORE = {
  phase: "pre-flight-future",
  at: "2026-03-01T00:00:00.050Z",
  futureGate: "local-check",
};

const UNKNOWN_PHASE_BETWEEN = {
  phase: "cross-checking-future",
  at: "2026-03-01T00:00:00.500Z",
  futurePass: { count: 2, strict: true },
};

const UNKNOWN_PHASE_AFTER = {
  phase: "post-settle-future",
  at: "2026-03-01T00:00:09.900Z",
  futureTail: [1, 2],
};

function readRawRow(dataDir: string, id: string) {
  const [row] = queryDatabase<{
    steps: string | null;
    citations: string;
    figures: string;
    analyses: string;
    tool_calls: string;
    focus: string | null;
    scope: string | null;
    quotes: string | null;
  }>(
    dataDir,
    `SELECT steps, citations, figures, analyses, tool_calls, focus, scope, quotes
     FROM conversation_messages WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error(`Missing row ${id}`);
  return row;
}

function injectUnknownSteps(
  dataDir: string,
  answerId: string,
  options: { streaming?: boolean } = {},
) {
  const raw = readRawRow(dataDir, answerId);
  const current = raw.steps ? (JSON.parse(raw.steps) as Record<string, unknown>) : {};
  const currentPhases = Array.isArray(current.phases)
    ? (current.phases as Record<string, unknown>[])
    : [];
  const firstKnown = currentPhases[0] ?? {
    phase: "loading",
    at: "2026-03-01T00:00:00.100Z",
  };
  const restKnown = currentPhases.slice(1);
  const nextSteps: Record<string, unknown> = {
    ...current,
    ...UNKNOWN_TOP_LEVEL,
    // A known value in a shape this version cannot read: dropped on read and when saved.
    readShare: "unreadable-shape",
    phases: [
      UNKNOWN_PHASE_BEFORE,
      { ...firstKnown, futurePhaseMeta: "kept-on-known-phase" },
      UNKNOWN_PHASE_BETWEEN,
      ...restKnown,
      ...(options.streaming ? [] : [UNKNOWN_PHASE_AFTER]),
    ],
    reasoning: {
      summary: "Checked the lunar cycle.",
      ms: 120,
      futureReasoningField: { tokens: 42 },
    },
    coverage: {
      kind: "main",
      used: [{ id: "doc-1", name: "Tides", futureUsedField: "primary" }],
      rest: ["doc-2"],
      futureCoverageField: "top-ranked",
    },
    writtenFrom: {
      documents: 1,
      total: 2,
      futureWrittenFromField: "scoped",
    },
    stillReading: {
      count: 1,
      name: "Harbour.pdf",
      futureStillReadingField: 85,
    },
    sent: {
      documents: ["doc-1"],
      transcript: true,
      futureSentField: "whole-text",
    },
    uncitedChecks: [
      {
        sentence: "The harbour opens at dawn.",
        check: "unsupported",
        verdict: "The passage does not mention dawn.",
        judgedAt: "2026-03-01T00:00:02.000Z",
        futureUncitedField: "kept-on-uncited",
      },
    ],
  };
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.run("UPDATE conversation_messages SET steps = ? WHERE id = ?", [
    JSON.stringify(nextSteps),
    answerId,
  ]);
  db.close();
}

function assertUnknownStepsCarried(
  dataDir: string,
  answerId: string,
  inMemory: ConversationAnswer,
  options: { expectTrailingUnknownPhase?: boolean; expectUncitedPreserved?: boolean } = {},
) {
  const { expectTrailingUnknownPhase = true, expectUncitedPreserved = true } = options;
  expect(() => structuredClone(inMemory)).not.toThrow();
  const inMemoryRecord = (inMemory.steps ?? {}) as unknown as Record<string, unknown>;
  expect(inMemoryRecord.callHelpForm).toBeUndefined();
  expect(inMemoryRecord.closingLine).toBeUndefined();
  expect(inMemoryRecord.futureConfig).toBeUndefined();
  expect(inMemoryRecord.readShare).toBeUndefined();
  expect(
    inMemory.steps?.phases.some(
      (each) =>
        (each.phase as string) === UNKNOWN_PHASE_BEFORE.phase ||
        (each.phase as string) === UNKNOWN_PHASE_BETWEEN.phase ||
        (each.phase as string) === UNKNOWN_PHASE_AFTER.phase,
    ),
  ).toBe(false);

  const rawSteps = readRawRow(dataDir, answerId).steps;
  if (!rawSteps) throw new Error("Expected stored steps JSON.");
  const stored = JSON.parse(rawSteps) as Record<string, unknown>;
  expect(stored.callHelpForm).toEqual(UNKNOWN_TOP_LEVEL.callHelpForm);
  expect(stored.closingLine).toEqual(UNKNOWN_TOP_LEVEL.closingLine);
  expect(stored.futureConfig).toEqual(UNKNOWN_TOP_LEVEL.futureConfig);
  expect(stored).not.toHaveProperty("readShare");

  const phases = stored.phases as Record<string, unknown>[];
  expect(phases[0]).toEqual(UNKNOWN_PHASE_BEFORE);
  expect(phases[1]).toMatchObject({ futurePhaseMeta: "kept-on-known-phase" });
  expect(phases[2]).toEqual(UNKNOWN_PHASE_BETWEEN);
  if (expectTrailingUnknownPhase) {
    expect(phases.at(-1)).toEqual(UNKNOWN_PHASE_AFTER);
  }

  if (stored.reasoning !== null) {
    expect(stored.reasoning).toMatchObject({
      summary: "Checked the lunar cycle.",
      ms: 120,
      futureReasoningField: { tokens: 42 },
    });
  }
  if (stored.coverage !== undefined) {
    expect(stored.coverage).toMatchObject({
      kind: "main",
      used: [{ id: "doc-1", name: "Tides", futureUsedField: "primary" }],
      rest: ["doc-2"],
      futureCoverageField: "top-ranked",
    });
  }
  if (stored.writtenFrom !== undefined) {
    expect(stored.writtenFrom).toMatchObject({
      documents: 1,
      total: 2,
      futureWrittenFromField: "scoped",
    });
  }
  if (stored.stillReading !== undefined) {
    expect(stored.stillReading).toMatchObject({
      count: 1,
      name: "Harbour.pdf",
      futureStillReadingField: 85,
    });
  }
  if (stored.sent !== undefined) {
    expect(stored.sent).toMatchObject({
      futureSentField: "whole-text",
    });
  }
  if (
    expectUncitedPreserved &&
    Array.isArray(stored.uncitedChecks) &&
    stored.uncitedChecks.length > 0
  ) {
    expect(stored.uncitedChecks[0]).toMatchObject({
      futureUncitedField: "kept-on-uncited",
    });
  }
}

describe("Stored Answers keep values and phases this version does not know (#3072)", {
  timeout: 60_000,
}, () => {
  // protects=an Answer whose stored steps hold unknown top-level values, unknown sub-object fields, unknown phases in their place, and a malformed known value keeps all unknown parts to the byte and drops the malformed known value across a restart, Check again, and Check the rest, while never exposing unknown values in memory or sending them to a model; fails_when=any save path drops an unknown value or phase, changes an unknown phase's position relative to the known phases before it, keeps a malformed known value, or leaks an unknown value into getConversation or a follow-up prompt; no_claim=behaviour of versions built before #3072.
  test("holds across a restart, Check again, and Check the rest, without exposing unknown values in memory or prompts", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, pageFrom: 1, pageTo: 1, quote: SPRING },
        { marker: 2, passage: passages[0]?.id, pageFrom: 1, pageTo: 1, quote: NEAP },
      ],
      answer: "Spring tides come at new and full moon [^1]. Neap tides come at quarter moon [^2].",
    });
    const { core, dataDir, ended, adapters } = await setUp(model);
    const sources = await createSourceFolder();
    await addAndProcess(core, [await writeSourceFile(sources, "Tides.pdf", PDF)]);

    const { conversation, answerId } = await ask(core, ended, {
      text: "When are spring and neap tides?",
    });
    const initial = answerOf(await core.getConversation(conversation.id), answerId);
    expect(initial.citations).toHaveLength(2);

    // 1. Restart save path (recovering a streaming Answer and a checking Citation).
    core.close();
    injectUnknownSteps(dataDir, answerId);
    const db1 = openDatabase(join(dataDir, DATABASE_FILE));
    db1.run("UPDATE conversation_messages SET status = 'streaming', citations = ? WHERE id = ?", [
      JSON.stringify(
        initial.citations.map((citation, idx) => ({
          ...citation,
          check: idx === 0 ? "checking" : "not-checked",
          checkReason: idx === 0 ? null : "budget",
          futureCitationField: `cit-${idx + 1}`,
          cells: [
            { name: "Tide", value: "Spring", futureCellField: `cell-a-${idx}` },
            { name: "Phase", value: "New moon", futureCellField: `cell-b-${idx}` },
          ],
        })),
      ),
      answerId,
    ]);
    db1.close();

    const afterRestartCore = startCore(dataDir, adapters);
    await nextTurn();
    const afterRestart = answerOf(
      await afterRestartCore.getConversation(conversation.id),
      answerId,
    );
    expect(afterRestart.status).toBe("stopped");
    assertUnknownStepsCarried(dataDir, answerId, afterRestart);

    // Also test the checking-Citation startup recovery when status is already stopped.
    afterRestartCore.close();
    const db2 = openDatabase(join(dataDir, DATABASE_FILE));
    const currentCits = JSON.parse(readRawRow(dataDir, answerId).citations) as Record<
      string,
      unknown
    >[];
    db2.run("UPDATE conversation_messages SET citations = ? WHERE id = ?", [
      JSON.stringify(
        currentCits.map((citation, idx) => ({
          ...citation,
          check: idx === 0 ? "checking" : "not-checked",
          checkReason: idx === 0 ? null : "budget",
        })),
      ),
      answerId,
    ]);
    db2.close();

    const reopened = startCore(dataDir, adapters);
    const afterCitRecovery = answerOf(await reopened.getConversation(conversation.id), answerId);
    expect(afterCitRecovery.citations.map((c) => c.check)).toEqual(["not-checked", "not-checked"]);
    assertUnknownStepsCarried(dataDir, answerId, afterCitRecovery);
    // In memory, QuoteCell has only { name, value } without futureCellField.
    expect(afterCitRecovery.citations[0]?.cells).toEqual([
      { name: "Tide", value: "Spring" },
      { name: "Phase", value: "New moon" },
    ]);

    // 2. Check the rest (estimateAnswerCheck + checkAnswerAgain with a budget limit).
    const estimate = await reopened.estimateAnswerCheck({
      conversationId: conversation.id,
      answerId,
    });
    expect(estimate).not.toBeNull();
    await reopened.checkAnswerAgain({
      conversationId: conversation.id,
      answerId,
      limit: { amount: 1, currency: "USD" },
    });
    const afterCheckRest = answerOf(await reopened.getConversation(conversation.id), answerId);
    expect(afterCheckRest.citations.map((c) => c.check)).toEqual(["found", "found"]);
    assertUnknownStepsCarried(dataDir, answerId, afterCheckRest, {
      expectUncitedPreserved: false,
    });

    // 3. Check again (re-injecting not-checked on citation 1 and uncitedChecks with an unknown field).
    reopened.close();
    injectUnknownSteps(dataDir, answerId);
    const db3 = openDatabase(join(dataDir, DATABASE_FILE));
    const citsBeforeAgain = JSON.parse(readRawRow(dataDir, answerId).citations) as Record<
      string,
      unknown
    >[];
    db3.run("UPDATE conversation_messages SET citations = ? WHERE id = ?", [
      JSON.stringify(
        citsBeforeAgain.map((citation, idx) =>
          idx === 0 ? { ...citation, check: "not-checked", checkReason: "stopped" } : citation,
        ),
      ),
      answerId,
    ]);
    db3.close();

    const forCheckAgain = startCore(dataDir, adapters);
    await forCheckAgain.checkAnswerAgain({ conversationId: conversation.id, answerId });
    const afterCheckAgain = answerOf(
      await forCheckAgain.getConversation(conversation.id),
      answerId,
    );
    expect(afterCheckAgain.citations.map((c) => c.check)).toEqual(["found", "found"]);
    assertUnknownStepsCarried(dataDir, answerId, afterCheckAgain, {
      expectUncitedPreserved: false,
    });

    // Verify unknown Citation and QuoteCell fields survived Check the rest and Check again in storage.
    const storedCitations = JSON.parse(readRawRow(dataDir, answerId).citations) as Record<
      string,
      unknown
    >[];
    expect(storedCitations[0]).toMatchObject({
      futureCitationField: "cit-1",
      cells: [
        { name: "Tide", value: "Spring", futureCellField: "cell-a-0" },
        { name: "Phase", value: "New moon", futureCellField: "cell-b-0" },
      ],
    });

    // Follow-up Question in the same conversation: unknown values in steps are never sent to the model.
    await ask(forCheckAgain, answerEndings(forCheckAgain), {
      conversationId: conversation.id,
      text: "What about neap tides?",
    });
    const sentPrompt = promptOf(model, model.doStreamCalls.length - 1);
    expect(sentPrompt).not.toContain("closingLine");
    expect(sentPrompt).not.toContain("harbourmaster");
    expect(sentPrompt).not.toContain("callHelpForm");
    expect(sentPrompt).not.toContain("pre-flight-future");
    forCheckAgain.close();
  });

  // protects=an Answer whose stored steps gain unknown values and unknown phases while streaming keeps them in their exact place relative to the known phases before them when the Answer settles at the end or settles at Stop; fails_when=writeAnswer overwrites stored steps with only in-memory AnswerSteps on settle at end or settle at Stop, or misorders an unknown phase relative to newly appended known phases; no_claim=none beyond protects.
  test("holds across a settle at the end and a settle at Stop, keeping unknown phases in their place before newly appended phases", async () => {
    // 1. Settle at the end.
    const endControl = controlledModel();
    const endSetup = await setUp(endControl.model);
    const endAsked = await endSetup.core.askInConversation({ text: "Explain spring tides." });
    if (!endAsked.asked) throw new Error("Not asked.");
    await endControl.requested();
    endControl.push("Spring tides happen ");
    await vi.waitFor(async () =>
      expect(
        answerOf(await endSetup.core.getConversation(endAsked.conversation.id), endAsked.answerId)
          .text,
      ).toBe("Spring tides happen "),
    );

    injectUnknownSteps(endSetup.dataDir, endAsked.answerId, { streaming: true });
    endControl.push("at new and full moon.");
    endControl.finish();
    expect(await endSetup.ended(endAsked.answerId)).toBe("finished");

    const settledAtEnd = answerOf(
      await endSetup.core.getConversation(endAsked.conversation.id),
      endAsked.answerId,
    );
    expect(settledAtEnd.status).toBe("done");
    assertUnknownStepsCarried(endSetup.dataDir, endAsked.answerId, settledAtEnd, {
      expectTrailingUnknownPhase: false,
    });
    endSetup.core.close();

    // 2. Settle at Stop.
    const stopControl = controlledModel();
    const stopSetup = await setUp(stopControl.model);
    const stopAsked = await stopSetup.core.askInConversation({ text: "Explain neap tides." });
    if (!stopAsked.asked) throw new Error("Not asked.");
    await stopControl.requested();
    stopControl.push("Neap tides happen ");
    await vi.waitFor(async () =>
      expect(
        answerOf(
          await stopSetup.core.getConversation(stopAsked.conversation.id),
          stopAsked.answerId,
        ).text,
      ).toBe("Neap tides happen "),
    );

    injectUnknownSteps(stopSetup.dataDir, stopAsked.answerId, { streaming: true });
    await stopSetup.core.stopConversationAnswer({
      conversationId: stopAsked.conversation.id,
      answerId: stopAsked.answerId,
    });
    expect(await stopSetup.ended(stopAsked.answerId)).toBe("finished");

    const settledAtStop = answerOf(
      await stopSetup.core.getConversation(stopAsked.conversation.id),
      stopAsked.answerId,
    );
    expect(settledAtStop.status).toBe("stopped");
    assertUnknownStepsCarried(stopSetup.dataDir, stopAsked.answerId, settledAtStop, {
      expectTrailingUnknownPhase: false,
    });
    stopSetup.core.close();
  });

  // protects=the reverse direction: values and phases this version writes (such as pressed, careful, readPassages, uncitedChecks, and checking-claims) survive a save by code that does not name them and are read back intact by this version through the core; fails_when=an older reader/writer using mergeStoredSteps drops a newer known step key or phase that isn't in its known set; no_claim=versions built before #3072.
  test("the other direction: values and phases this version writes are read back intact after a save by code that does not name them", async () => {
    const { core, dataDir, ended } = await setUp(streamingModel("Spring tides rise highest."));
    const { conversation, answerId } = await ask(core, ended, {
      text: "Which tides rise highest?",
    });

    // This version writes values and phases it knows.
    const fullSteps: AnswerSteps = {
      sentAt: "2026-03-01T00:00:00.000Z",
      finishedAt: "2026-03-01T00:00:02.000Z",
      phases: [
        { phase: "loading", at: "2026-03-01T00:00:00.100Z" },
        { phase: "searching", at: "2026-03-01T00:00:00.300Z" },
        { phase: "writing", at: "2026-03-01T00:00:00.600Z" },
        { phase: "checking-claims", at: "2026-03-01T00:00:01.200Z" },
      ],
      reasoning: { summary: "Compared spring and neap ranges.", ms: 250 },
      firstWordMs: 500,
      careful: true,
      pressed: "say",
      readPassages: ["passage-1", "passage-2"],
      uncitedChecks: [
        {
          sentence: "Spring tides rise highest.",
          check: "unsupported",
          verdict: "No passage states the height.",
          judgedAt: "2026-03-01T00:00:01.800Z",
        },
      ],
    };
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("UPDATE conversation_messages SET steps = ? WHERE id = ?", [
      JSON.stringify(fullSteps),
      answerId,
    ]);

    // Simulate a save by an older version that only knew basic step keys and basic phases
    // (before pressed, careful, readPassages, uncitedChecks, and checking-claims existed).
    const olderKnownKeys = new Set(["sentAt", "finishedAt", "phases", "reasoning", "firstWordMs"]);
    const olderKnownPhases: Record<string, true> = {
      loading: true,
      searching: true,
      writing: true,
    };
    const rawBeforeOlderSave = readRawRow(dataDir, answerId).steps;
    const olderInMemorySteps: AnswerSteps = {
      sentAt: fullSteps.sentAt,
      finishedAt: fullSteps.finishedAt,
      phases: fullSteps.phases.filter((p) => Object.hasOwn(olderKnownPhases, p.phase)),
      reasoning: fullSteps.reasoning,
      firstWordMs: fullSteps.firstWordMs,
    };
    const savedByOlder = mergeStoredSteps(
      rawBeforeOlderSave,
      olderInMemorySteps,
      () => olderInMemorySteps,
      { stepKeys: olderKnownKeys, phases: olderKnownPhases },
    );
    db.run("UPDATE conversation_messages SET steps = ? WHERE id = ?", [savedByOlder, answerId]);
    db.close();

    // Now this version reads the Answer back through the core's public interface.
    const readBack = answerOf(await core.getConversation(conversation.id), answerId);
    expect(readBack.steps).toEqual(fullSteps);
    expect(Object.keys(PHASES)).toContain("checking-claims");
    core.close();
  });

  // protects=every other stored JSON column on an Answer and Question (citations and nested location/quotedWords/unstated/cells, figures and nested inputs/show/unitStatement, analyses and nested range/figure inputs/versions/end/output/markers, tool_calls and nested connector/error/mindChange.selfCheck/command.window, Question focus/scope/quotes) preserves unknown fields at each nesting level across every save path that touches it; fails_when=any save path drops an extra field at any nesting level of citations, figures, analyses, tool_calls, or Question JSON columns; no_claim=none beyond protects.
  test("carries unknown fields at every nesting level of Citations, figures, Analyses, Tool calls, and Question JSON columns", async () => {
    const { core, dataDir, ended, adapters } = await setUp(
      streamingModel("The tide rises 4.2m [^1] [=1]."),
    );
    const { conversation, answerId } = await ask(core, ended, {
      text: "How high does the tide rise?",
    });
    const content = await core.getConversation(conversation.id);
    const questionId = content.messages.find((m) => m.kind === "question")?.id;
    if (!questionId) throw new Error("Missing Question.");

    // Seed Question JSON columns with extra fields at each nesting level.
    const rawFocus = {
      selection: "Spring tides",
      blockIds: ["b-1"],
      pictures: ["pic-1"],
      futureFocusField: { cursorOffset: 12 },
    };
    const rawScope = {
      folderIds: [],
      tagIds: [],
      documentIds: ["doc-1"],
      futureScopeField: "include-pinned",
    };
    const rawQuotes = [
      {
        documentId: "doc-1",
        documentName: "Tides",
        quote: SPRING,
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "page", from: 1, to: 1, futureQuoteLocField: "top-half" },
        table: { header: ["Tide"], rows: [["Spring"]], futureQuoteTableField: "grid" },
        futureQuoteField: "highlighted",
      },
    ];

    // Seed Answer citations, figures, analyses, tool_calls with extra fields at each nesting level.
    const rawCitations = [
      {
        marker: 1,
        passageId: "p-1",
        documentId: "doc-1",
        documentName: "Tides",
        contentHash: "hash-1",
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "page", from: 1, to: 1, futureLocField: "column-2" },
        quote: SPRING,
        check: "checking",
        checkReason: null,
        quotedWords: {
          answer: [{ text: "4.2m", found: true, futurePieceField: "exact" }],
          closest: null,
          futureQuotedWordsField: "checked-once",
        },
        unstated: {
          covered: "tide",
          uncovered: "4.2m",
          missing: ["4.2m"],
          futureUnstatedField: "numeric-gap",
        },
        cells: [
          { name: "Tide", value: "Spring", futureCellField: "col-0" },
          { name: "Height", value: "4.2m", futureCellField: "col-1" },
        ],
        futureCitationField: "top-level-cit",
      },
    ];

    const rawFigures = [
      {
        marker: 1,
        label: "Tide range",
        formula: "high - low",
        inputs: [
          {
            name: "high",
            label: "High tide",
            citation: {
              passageId: "p-1",
              documentId: "doc-1",
              documentName: "Tides",
              contentHash: "hash-1",
              pageFrom: 1,
              pageTo: 1,
              location: { kind: "page", from: 1, to: 1, futureInputLocField: "box-1" },
              quote: SPRING,
              check: "found",
              checkReason: null,
              futureInputCitationField: "input-cit-extra",
            },
            number: {
              chars: "4.2",
              at: 0,
              value: 4.2,
              scale: 1,
              scaleWord: null,
              unit: { kind: "unit", unit: "m" },
              decimals: 1,
              approximate: false,
              reading: null,
              futureNumberField: "decimal-dot",
            },
            cell: { sheet: "Sheet1", ref: "B2", stored: 4.2, futureCellField: "formula-cached" },
            unitStatement: {
              citation: {
                passageId: "p-1",
                documentId: "doc-1",
                documentName: "Tides",
                contentHash: "hash-1",
                pageFrom: 1,
                pageTo: 1,
                location: null,
                quote: "Units in metres",
                check: "found",
                checkReason: null,
                futureUnitCitField: "header-cit",
              },
              scale: 1,
              scaleWord: null,
              currency: null,
              futureUnitStatementField: "row-header",
            },
            futureFigureInputField: "first-input",
          },
        ],
        value: 4.2,
        unit: { kind: "unit", unit: "m" },
        approximate: false,
        shown: "4.2m",
        show: { language: "en", as: null, decimals: 1, scale: null, futureShowField: "compact" },
        literals: [],
        engine: 1,
        written: null,
        futureFigureField: "top-level-fig",
      },
    ];

    const rawAnalyses = [
      {
        number: 1,
        title: "Tide summary",
        language: "python",
        code: "print(4.2)",
        inputs: [
          {
            kind: "range",
            name: "tides",
            citation: {
              passageId: "p-1",
              documentId: "doc-1",
              documentName: "Tides",
              contentHash: "hash-1",
              pageFrom: 1,
              pageTo: 1,
              location: null,
              quote: "Tide table",
              check: "found",
              checkReason: null,
              futureRangeCitField: "range-cit",
            },
            range: "A1:B10",
            rows: 9,
            columns: 2,
            rowCount: 9,
            cut: false,
            setAside: { struck: [2], hidden: [], futureSetAsideField: "archived-row" },
            sha256: "sha-range",
            table: {
              number: 1,
              rows: [{ row: 1, unit: 1, quote: "Tide" }],
              futureTableField: "pdf-grid",
            },
            futureRangeInputField: "range-input-extra",
          },
        ],
        versions: { python: "3.12", packages: {}, futureVersionsField: "cpython" },
        codeSha256: "sha-code",
        outputSha256: "sha-out",
        end: { kind: "ok", futureEndField: "exit-0" },
        output: { figures: [], tables: [], charts: [], pictures: [], futureOutputField: "stdout" },
        ms: 45,
        ranAt: "2026-03-01T00:00:01.000Z",
        markers: { figures: [], tables: [], charts: [], futureMarkersField: "placed" },
        futureAnalysisField: "top-level-analysis",
      },
    ];

    const rawToolCalls = [
      {
        id: "call-mind",
        tool: "edit_mind",
        source: "minds",
        input: { text: "Updated note" },
        status: "done",
        resultCount: null,
        connector: { id: "conn-1", name: "Local", futureConnectorField: "stdio" },
        error: { kind: "unknown", message: "none", futureErrorField: "retried" },
        mindChange: {
          mindId: "mind-1",
          created: false,
          request: "req-1",
          proposals: 1,
          selfCheck: {
            request: "req-1",
            checkable: 2,
            cited: 2,
            sent: 2,
            checked: 1,
            failed: 0,
            running: true,
            blocked: { reason: "local-mode", count: 1, futureBlockedField: "offline" },
            futureSelfCheckField: "check-meta",
          },
          futureMindChangeField: "change-meta",
        },
        futureToolCallField: "call-1-extra",
      },
      {
        id: "call-cmd",
        tool: "run_command",
        source: "commands",
        input: { command: "check" },
        status: "done",
        resultCount: null,
        command: {
          command: "check",
          run: "run-1",
          items: [],
          window: { changed: true, running: true, futureWindowField: "main-win" },
          futureCommandField: "cmd-meta",
        },
        futureToolCallField: "call-2-extra",
      },
    ];

    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("UPDATE conversation_messages SET focus = ?, scope = ?, quotes = ? WHERE id = ?", [
      JSON.stringify(rawFocus),
      JSON.stringify(rawScope),
      JSON.stringify(rawQuotes),
      questionId,
    ]);
    db.run(
      "UPDATE conversation_messages SET citations = ?, figures = ?, analyses = ?, tool_calls = ? WHERE id = ?",
      [
        JSON.stringify(rawCitations),
        JSON.stringify(rawFigures),
        JSON.stringify(rawAnalyses),
        JSON.stringify(rawToolCalls),
        answerId,
      ],
    );
    db.close();

    // 1. Restart core: startup recovery updates citations (checking -> not-checked) and tool_calls (running: true -> ended).
    const reopened = startCore(dataDir, adapters);
    const afterRestartContent = await reopened.getConversation(conversation.id);
    const questionInMemory = afterRestartContent.messages.find((m) => m.kind === "question");
    expect(questionInMemory?.kind === "question" && questionInMemory.focus).toEqual({
      selection: "Spring tides",
      blockIds: ["b-1"],
      pictures: ["pic-1"],
    });
    expect(questionInMemory?.kind === "question" && questionInMemory.scope).toEqual({
      folderIds: [],
      tagIds: [],
      documentIds: ["doc-1"],
    });
    expect(
      questionInMemory?.kind === "question" &&
        (questionInMemory.quotes[0] as unknown as Record<string, unknown>)?.futureQuoteField,
    ).toBeUndefined();

    // Verify startup recovery kept all unknown fields in citations and tool_calls while updating known fields.
    const rowAfterRestart = readRawRow(dataDir, answerId);
    const citsAfterRestart = JSON.parse(rowAfterRestart.citations) as Record<string, unknown>[];
    expect(citsAfterRestart[0]).toMatchObject({
      check: "not-checked",
      futureCitationField: "top-level-cit",
      location: { futureLocField: "column-2" },
      quotedWords: {
        answer: [{ futurePieceField: "exact" }],
        futureQuotedWordsField: "checked-once",
      },
      unstated: { futureUnstatedField: "numeric-gap" },
      cells: [{ futureCellField: "col-0" }, { futureCellField: "col-1" }],
    });

    const callsAfterRestart = JSON.parse(rowAfterRestart.tool_calls) as Record<string, unknown>[];
    expect(callsAfterRestart[0]).toMatchObject({
      futureToolCallField: "call-1-extra",
      connector: { futureConnectorField: "stdio" },
      error: { futureErrorField: "retried" },
      mindChange: {
        futureMindChangeField: "change-meta",
        selfCheck: {
          checked: 1,
          failed: 1,
          futureSelfCheckField: "check-meta",
          blocked: { futureBlockedField: "offline" },
        },
      },
    });
    expect(
      (
        (callsAfterRestart[0]?.mindChange as Record<string, unknown>)?.selfCheck as Record<
          string,
          unknown
        >
      )?.running,
    ).toBeUndefined();
    expect(callsAfterRestart[1]).toMatchObject({
      status: "failed",
      futureToolCallField: "call-2-extra",
    });

    // 2. Verify mergeStoredCitations, mergeStoredFigures, mergeStoredAnalyses, and mergeStoredToolCalls
    // preserve every extra field when writeAnswer / writeCitations / writeToolCalls saves updated records.
    const inMemoryAnswer = answerOf(afterRestartContent, answerId);
    const mergedCitationsJson = mergeStoredCitations(
      rowAfterRestart.citations,
      inMemoryAnswer.citations.map((c) => ({ ...c, check: "found" })),
    );
    expect(JSON.parse(mergedCitationsJson)[0]).toMatchObject({
      check: "found",
      futureCitationField: "top-level-cit",
      location: { futureLocField: "column-2" },
      quotedWords: {
        answer: [{ futurePieceField: "exact" }],
        futureQuotedWordsField: "checked-once",
      },
      unstated: { futureUnstatedField: "numeric-gap" },
      cells: [{ futureCellField: "col-0" }, { futureCellField: "col-1" }],
    });

    const cleanFigures: MarkedFigure[] = (
      JSON.parse(JSON.stringify(rawFigures)) as MarkedFigure[]
    ).map((fig) => ({
      marker: fig.marker,
      label: "Updated tide range",
      formula: fig.formula,
      inputs: fig.inputs.map((inp) => ({
        name: inp.name,
        label: inp.label,
        citation: {
          passageId: inp.citation.passageId,
          documentId: inp.citation.documentId,
          documentName: inp.citation.documentName,
          contentHash: inp.citation.contentHash,
          pageFrom: inp.citation.pageFrom,
          pageTo: inp.citation.pageTo,
          location: { kind: "page", from: 1, to: 1 },
          quote: inp.citation.quote,
          check: "found",
          checkReason: null,
        },
        number: {
          chars: inp.number.chars,
          at: inp.number.at,
          value: inp.number.value,
          scale: inp.number.scale,
          scaleWord: inp.number.scaleWord,
          unit: inp.number.unit,
          decimals: inp.number.decimals,
          approximate: inp.number.approximate,
          reading: inp.number.reading,
        },
        cell: inp.cell
          ? { sheet: inp.cell.sheet, ref: inp.cell.ref, stored: inp.cell.stored }
          : null,
        unitStatement: inp.unitStatement
          ? {
              citation: {
                passageId: inp.unitStatement.citation.passageId,
                documentId: inp.unitStatement.citation.documentId,
                documentName: inp.unitStatement.citation.documentName,
                contentHash: inp.unitStatement.citation.contentHash,
                pageFrom: inp.unitStatement.citation.pageFrom,
                pageTo: inp.unitStatement.citation.pageTo,
                location: null,
                quote: inp.unitStatement.citation.quote,
                check: "found",
                checkReason: null,
              },
              scale: inp.unitStatement.scale,
              scaleWord: inp.unitStatement.scaleWord,
              currency: inp.unitStatement.currency,
            }
          : null,
      })),
      value: fig.value,
      unit: fig.unit,
      approximate: fig.approximate,
      shown: fig.shown,
      show: {
        language: fig.show.language,
        as: fig.show.as,
        decimals: fig.show.decimals,
        scale: fig.show.scale,
      },
      literals: fig.literals,
      engine: fig.engine,
      written: fig.written,
    }));
    const mergedFigures = JSON.parse(
      mergeStoredFigures(rowAfterRestart.figures, cleanFigures),
    ) as Record<string, unknown>[];
    expect(mergedFigures[0]).toMatchObject({
      label: "Updated tide range",
      futureFigureField: "top-level-fig",
      show: { futureShowField: "compact" },
      inputs: [
        {
          futureFigureInputField: "first-input",
          citation: {
            futureInputCitationField: "input-cit-extra",
            location: { futureInputLocField: "box-1" },
          },
          number: { futureNumberField: "decimal-dot" },
          cell: { futureCellField: "formula-cached" },
          unitStatement: {
            futureUnitStatementField: "row-header",
            citation: { futureUnitCitField: "header-cit" },
          },
        },
      ],
    });

    const cleanAnalyses: AnswerAnalysis[] = [
      {
        number: 1,
        title: "Updated tide summary",
        language: "python",
        code: "print(4.2)",
        inputs: [
          {
            kind: "range",
            name: "tides",
            citation: {
              passageId: "p-1",
              documentId: "doc-1",
              documentName: "Tides",
              contentHash: "hash-1",
              pageFrom: 1,
              pageTo: 1,
              location: null,
              quote: "Tide table",
              check: "found",
              checkReason: null,
            },
            range: "A1:B10",
            rows: 9,
            columns: 2,
            rowCount: 9,
            cut: false,
            setAside: { struck: [2], hidden: [] },
            sha256: "sha-range",
            table: { number: 1, rows: [{ row: 1, unit: 1, quote: "Tide" }] },
          },
        ],
        versions: {
          language: "python",
          languageVersion: "3.14.2",
          runtime: "Pyodide 314.0.7",
          packages: {},
          helper: "sha-helper",
          app: "0.1.0",
        },
        codeSha256: "sha-code",
        outputSha256: "sha-out",
        end: { kind: "done" },
        output: noAnalysisOutput(),
        ms: 50,
        ranAt: "2026-03-01T00:00:01.000Z",
        markers: { figures: [], tables: [], charts: [] },
      },
    ];
    const mergedAnalyses = JSON.parse(
      mergeStoredAnalyses(rowAfterRestart.analyses, cleanAnalyses),
    ) as Record<string, unknown>[];
    expect(mergedAnalyses[0]).toMatchObject({
      title: "Updated tide summary",
      ms: 50,
      futureAnalysisField: "top-level-analysis",
      versions: { futureVersionsField: "cpython" },
      end: { futureEndField: "exit-0" },
      output: { futureOutputField: "stdout" },
      markers: { futureMarkersField: "placed" },
      inputs: [
        {
          futureRangeInputField: "range-input-extra",
          citation: { futureRangeCitField: "range-cit" },
          setAside: { futureSetAsideField: "archived-row" },
          table: { futureTableField: "pdf-grid" },
        },
      ],
    });

    const cleanToolCalls: AnswerToolCall[] = [
      {
        id: "call-mind",
        tool: "edit_mind",
        source: "minds",
        input: { text: "Updated note" },
        status: "done",
        resultCount: null,
        connector: { id: "conn-1", name: "Local" },
        error: { kind: "unknown", message: "none" },
        mindChange: {
          mindId: "mind-1",
          created: false,
          request: "req-1",
          proposals: 1,
          selfCheck: {
            request: "req-1",
            checkable: 2,
            cited: 2,
            sent: 2,
            checked: 2,
            failed: 0,
            blocked: { reason: "local-mode", count: 1 },
          },
        },
      },
    ];
    const mergedCalls = JSON.parse(
      mergeStoredToolCalls(JSON.stringify(rawToolCalls), cleanToolCalls),
    ) as Record<string, unknown>[];
    expect(mergedCalls[0]).toMatchObject({
      futureToolCallField: "call-1-extra",
      connector: { futureConnectorField: "stdio" },
      error: { futureErrorField: "retried" },
      mindChange: {
        futureMindChangeField: "change-meta",
        selfCheck: {
          checked: 2,
          futureSelfCheckField: "check-meta",
          blocked: { futureBlockedField: "offline" },
        },
      },
    });

    // 3. Conversation operations (rename, move, delete, restore) leave Question and Answer stored JSON intact.
    await reopened.renameConversation(conversation.id, "Tide heights");
    const folder = await reopened.createLibraryGroup({ name: "Marine", description: "" });
    await reopened.moveToFolder({ conversationIds: [conversation.id], folderId: folder.id });
    await reopened.deleteConversation(conversation.id);
    const deleted = (await reopened.listDeleted()).find((item) => item.id === conversation.id);
    if (!deleted) throw new Error("Expected deleted conversation.");
    await reopened.restore([{ kind: "conversation", id: deleted.id }]);

    const questionRowAfter = readRawRow(dataDir, questionId);
    expect(JSON.parse(questionRowAfter.focus ?? "null")).toEqual(rawFocus);
    expect(JSON.parse(questionRowAfter.scope ?? "null")).toEqual(rawScope);
    expect(JSON.parse(questionRowAfter.quotes ?? "null")).toEqual(rawQuotes);

    const answerRowAfter = readRawRow(dataDir, answerId);
    expect(JSON.parse(answerRowAfter.figures)).toEqual(rawFigures);
    expect(JSON.parse(answerRowAfter.analyses)).toEqual(rawAnalyses);
    reopened.close();
  });
});
