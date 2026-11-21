import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type AnswerSteps,
  type AskInConversationInput,
  type ConversationAnswer,
  type ConversationAskResult,
  type ConversationContent,
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type MarkedCitation,
} from "../../src/core";
import {
  mergeStoredSteps,
  PHASES,
  withStoredRawCells,
} from "../../src/core/conversations/storedJson";
import { isRecord } from "../../src/core/errors";
import { openDatabase } from "../../src/core/storage";
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
    // A known value in a shape this version cannot read: dropped on read and when steps are saved.
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
  options: {
    expectTrailingUnknownPhase?: boolean;
    expectUncitedPreserved?: boolean;
    stepsWritten?: boolean;
  } = {},
) {
  const {
    expectTrailingUnknownPhase = true,
    expectUncitedPreserved = true,
    stepsWritten = true,
  } = options;
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
  if (stepsWritten) {
    expect(stored).not.toHaveProperty("readShare");
  }

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
  // protects=an Answer whose stored steps hold unknown top-level values, unknown sub-object fields, unknown phases in their place, and a malformed known value keeps all unknown parts to the byte and drops the malformed known value across a restart, Check again, and Check the rest, while never exposing unknown values in memory or sending them to a model; fails_when=any save path drops an unknown value or phase, changes an unknown phase's position relative to the known phases before it, keeps a malformed known value when saving steps, or leaks an unknown value into getConversation or a follow-up prompt; no_claim=behaviour of versions built before #3072.
  test("holds across a restart, Check again, and Check the rest, without exposing unknown values in memory or prompts", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, pageFrom: 1, pageTo: 1, quote: SPRING },
        { marker: 2, passage: passages[0]?.id, pageFrom: 1, pageTo: 1, quote: NEAP },
      ],
      answer:
        "Spring tides come at new and full moon [^1]. Neap tides come at quarter moon [^2]. The harbour opens at dawn.",
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
    assertUnknownStepsCarried(dataDir, answerId, afterRestart, { stepsWritten: false });

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
    assertUnknownStepsCarried(dataDir, answerId, afterCitRecovery, { stepsWritten: false });
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
    assertUnknownStepsCarried(dataDir, answerId, afterCheckRest);

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
    assertUnknownStepsCarried(dataDir, answerId, afterCheckAgain);

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

  // protects=an Answer whose stored steps gain unknown values and unknown phases while streaming keeps them in their exact place relative to the known phases before them when the Answer settles at the end or settles at Stop, and Try again (regenerateConversationAnswer) replaces the row plainly without carrying old unknown values into the new Answer; fails_when=writeAnswer overwrites stored steps with only in-memory AnswerSteps on settle at end or settle at Stop, misorders an unknown phase relative to newly appended known phases, or carries a previous Answer's unknown values across regenerateConversationAnswer; no_claim=none beyond protects.
  test("holds across a settle at the end and a settle at Stop, and is cleared when the Answer is regenerated", async () => {
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

    // 2. Settle at Stop, then Try again (regenerateConversationAnswer) replaces the row plainly.
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

    // Regenerating the Answer replaces the row plainly: old unknown values do not carry into the new Answer.
    const regenPromise = stopSetup.core.regenerateConversationAnswer({
      conversationId: stopAsked.conversation.id,
      answerId: stopAsked.answerId,
    });
    await vi.waitFor(() => expect(stopControl.model.doStreamCalls).toHaveLength(2));
    stopControl.push("Neap tides have the smallest range.");
    stopControl.finish();
    await regenPromise;
    await vi.waitFor(async () =>
      expect(
        answerOf(
          await stopSetup.core.getConversation(stopAsked.conversation.id),
          stopAsked.answerId,
        ).status,
      ).toBe("done"),
    );
    const rawAfterRegen = JSON.parse(
      readRawRow(stopSetup.dataDir, stopAsked.answerId).steps ?? "{}",
    ) as Record<string, unknown>;
    expect(rawAfterRegen).not.toHaveProperty("callHelpForm");
    expect(rawAfterRegen).not.toHaveProperty("closingLine");
    expect(rawAfterRegen).not.toHaveProperty("futureConfig");
    stopSetup.core.close();
  });

  // protects=unknown values are carried only on an exact identity match (phase + at; coverage.used id; uncitedChecks sentence; Citation marker + documentId + quote and QuoteCell name + value), and any known optional key cleared by this version is removed from storage; fails_when=a positional or marker-only fallback attaches an unknown value to a different record, or a cleared known optional key comes back from the stored row; no_claim=none beyond protects.
  test("never attaches an unknown value to a different record at the same position or marker, and removes cleared known optional keys", () => {
    const rawSteps = JSON.stringify({
      sentAt: "2026-03-01T00:00:00.000Z",
      finishedAt: "2026-03-01T00:00:02.000Z",
      phases: [
        {
          phase: "loading",
          at: "2026-03-01T00:00:00.100Z",
          futurePhaseMeta: "belongs-to-t1-loading",
        },
      ],
      reasoning: { summary: "First thought", ms: 100, futureReasoningMeta: "kept" },
      readShare: 0.5,
      careful: true,
      textBehind: true,
      pressed: "say",
      stillReading: {
        count: 2,
        name: "Old.pdf",
        futureStillReadingMeta: "kept-on-still-reading",
      },
      sent: {
        documents: ["doc-1"],
        transcript: true,
        futureSentMeta: "kept-on-sent",
      },
      coverage: {
        kind: "main",
        used: [{ id: "doc-1", name: "Tides", futureUsedMeta: "belongs-to-doc-1" }],
        rest: [],
        futureCoverageMeta: "kept-on-coverage",
      },
      uncitedChecks: [
        {
          sentence: "First sentence.",
          check: "unsupported",
          verdict: "Not stated.",
          judgedAt: "2026-03-01T00:00:01.000Z",
          futureUncitedMeta: "belongs-to-first-sentence",
        },
      ],
      futureTopLevel: "kept",
    });

    // Save with:
    // - a different timestamp on the loading phase at index 0,
    // - a different document id in coverage.used at index 0,
    // - a different sentence in uncitedChecks at index 0,
    // - known optional keys cleared (readShare, careful, textBehind, pressed, stillReading.name, sent.transcript).
    const nextSteps: AnswerSteps = {
      sentAt: "2026-03-01T00:00:00.000Z",
      finishedAt: "2026-03-01T00:00:02.000Z",
      phases: [{ phase: "loading", at: "2026-03-01T00:00:00.999Z" }],
      reasoning: null,
      stillReading: { count: 2 },
      sent: { documents: ["doc-1"] },
      coverage: {
        kind: "main",
        used: [{ id: "doc-2", name: "Other" }],
        rest: [],
      },
      uncitedChecks: [
        {
          sentence: "Different sentence at index 0.",
          check: "contradicted",
          verdict: "Contradicted.",
          judgedAt: "2026-03-01T00:00:02.000Z",
        },
      ],
    };

    const merged = JSON.parse(mergeStoredSteps(rawSteps, nextSteps)) as Record<string, unknown>;
    expect(merged.futureTopLevel).toBe("kept");
    // Cleared top-level known optional keys are gone.
    expect(merged).not.toHaveProperty("readShare");
    expect(merged).not.toHaveProperty("careful");
    expect(merged).not.toHaveProperty("textBehind");
    expect(merged).not.toHaveProperty("pressed");
    expect(merged.reasoning).toBeNull();
    // Cleared nested known optional keys (stillReading.name, sent.transcript) are gone while unknown sibling keys stay.
    expect(merged.stillReading).toEqual({
      count: 2,
      futureStillReadingMeta: "kept-on-still-reading",
    });
    expect(merged.sent).toEqual({
      documents: ["doc-1"],
      futureSentMeta: "kept-on-sent",
    });
    // Non-matching items at the same index take nothing from the old items.
    expect((merged.phases as Record<string, unknown>[])[0]).toEqual({
      phase: "loading",
      at: "2026-03-01T00:00:00.999Z",
    });
    expect(
      ((merged.coverage as Record<string, unknown>).used as Record<string, unknown>[])[0],
    ).toEqual({
      id: "doc-2",
      name: "Other",
    });
    expect((merged.uncitedChecks as Record<string, unknown>[])[0]).toEqual({
      sentence: "Different sentence at index 0.",
      check: "contradicted",
      verdict: "Contradicted.",
      judgedAt: "2026-03-01T00:00:02.000Z",
    });

    // Citations: a different citation at marker 1 or a different cell at index 0 takes nothing.
    const rawCitations = JSON.stringify([
      {
        marker: 1,
        passageId: "p-1",
        documentId: "doc-1",
        documentName: "Tides",
        contentHash: "h-1",
        pageFrom: 1,
        pageTo: 1,
        location: null,
        quote: "Original quote",
        check: "found",
        checkReason: null,
        cells: [
          { name: "Tide", value: "Spring", futureCellMeta: "belongs-to-spring" },
          { name: "Range", value: "4.2m", futureCellMeta: "belongs-to-range" },
        ],
      },
    ]);
    const baseCitation: MarkedCitation = {
      marker: 1,
      passageId: "p-1",
      documentId: "doc-1",
      documentName: "Tides",
      contentHash: "h-1",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Different quote on the same marker",
      check: "found",
      checkReason: null,
      cells: [
        { name: "Tide", value: "Spring" },
        { name: "Range", value: "4.2m" },
      ],
    };
    // Different quote at marker 1 -> cell takes nothing.
    expect(withStoredRawCells(rawCitations, [baseCitation])[0]?.cells).toEqual([
      { name: "Tide", value: "Spring" },
      { name: "Range", value: "4.2m" },
    ]);
    // Same citation identity, but cell 0 has a different value -> cell 0 takes nothing while cell 1 keeps its unknown field.
    const sameCitDifferentCell0: MarkedCitation = {
      ...baseCitation,
      quote: "Original quote",
      cells: [
        { name: "Tide", value: "Neap" },
        { name: "Range", value: "4.2m" },
      ],
    };
    expect(withStoredRawCells(rawCitations, [sameCitDifferentCell0])[0]?.cells).toEqual([
      { name: "Tide", value: "Neap" },
      { name: "Range", value: "4.2m", futureCellMeta: "belongs-to-range" } as unknown as {
        name: string;
        value: string;
      },
    ]);
  });

  // protects=the reverse direction: values and phases this version writes (such as pressed, careful, readPassages, uncitedChecks, and checking-claims) survive a save by code that does not name them and are read back intact by this version through the core; fails_when=storedSteps fails to read back a known field or phase after an older version's save carried it as unknown JSON; no_claim=versions built before #3072.
  test("the other direction: values and phases this version writes are read back intact after a save by code that does not name them", async () => {
    const { core, dataDir, ended } = await setUp(streamingModel("Spring tides rise highest."));
    const { conversation, answerId } = await ask(core, ended, {
      text: "Which tides rise highest?",
    });

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

    // Simulate an earlier version that only knew { sentAt, finishedAt, phases (loading/searching/writing), reasoning, firstWordMs }
    // saving the row while carrying keys and phases it doesn't know.
    const olderKnownKeys = new Set(["sentAt", "finishedAt", "phases", "reasoning", "firstWordMs"]);
    const olderKnownPhases = new Set(["loading", "searching", "writing"]);
    const rawStored = JSON.parse(readRawRow(dataDir, answerId).steps ?? "{}") as Record<
      string,
      unknown
    >;
    const olderSaved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawStored)) {
      if (!olderKnownKeys.has(key)) olderSaved[key] = value;
    }
    olderSaved.sentAt = fullSteps.sentAt;
    olderSaved.finishedAt = fullSteps.finishedAt;
    olderSaved.reasoning = fullSteps.reasoning;
    olderSaved.firstWordMs = fullSteps.firstWordMs;
    olderSaved.phases = (rawStored.phases as Record<string, unknown>[]).map((entry) =>
      isRecord(entry) && typeof entry.phase === "string" && olderKnownPhases.has(entry.phase)
        ? { phase: entry.phase, at: entry.at }
        : entry,
    );
    db.run("UPDATE conversation_messages SET steps = ? WHERE id = ?", [
      JSON.stringify(olderSaved),
      answerId,
    ]);
    db.close();

    // This version reads the Answer back through the core's public interface.
    const readBack = answerOf(await core.getConversation(conversation.id), answerId);
    expect(readBack.steps).toEqual(fullSteps);
    expect(Object.keys(PHASES)).toContain("checking-claims");
    core.close();
  });

  // protects=every other stored JSON column on an Answer and Question (citations and nested location/quotedWords/unstated/cells, figures and nested inputs, analyses and nested inputs, tool_calls and nested mindChange.selfCheck/command.window, Question focus/scope/quotes) preserves unknown fields across startup recovery, Check again, and Conversation updates; fails_when=any save path drops an extra field on citations, figures, analyses, tool_calls, or Question JSON columns; no_claim=none beyond protects.
  test("carries unknown fields on Citations, figures, Analyses, Tool calls, and Question JSON columns across startup recovery and saves", async () => {
    const { core, dataDir, ended, adapters } = await setUp(
      streamingModel("The tide rises 4.2m [^1] [=1]."),
    );
    const { conversation, answerId } = await ask(core, ended, {
      text: "How high does the tide rise?",
    });
    const content = await core.getConversation(conversation.id);
    const questionId = content.messages.find((m) => m.kind === "question")?.id;
    if (!questionId) throw new Error("Missing Question.");

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
        inputs: [{ name: "high", futureFigureInputField: "first-input" }],
        futureFigureField: "top-level-fig",
      },
    ];

    const rawAnalyses = [
      {
        number: 1,
        title: "Tide summary",
        inputs: [{ kind: "range", name: "tides", futureRangeInputField: "range-input-extra" }],
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

    // 2. Conversation operations (rename, move, delete, restore) leave Question and Answer stored JSON intact.
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
