import { MockLanguageModelV4 } from "ai/test";
import { expect, test, vi } from "vitest";
import type { CoreAdapters } from "../../src/core/adapters";
import type { Meeting, MeetingSummaryItem } from "../../src/core/api";
import {
  meetingCandidateReviewPrompt,
  readMeetingCandidateReview,
  reviewCandidatesWithChat,
} from "../../src/core/meetings/candidateReview";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { candidateSurvives } from "../../src/core/meetings/summaryCandidates";
import { meetingSummaryPrompt } from "../../src/core/meetings/summaryModel";
import { meetingSummaryRoute } from "../../src/core/meetings/summaryRoute";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import { createTempDataFolder, startCore } from "../helpers/core";

const cue = (text: string, startMs: number) => ({
  text,
  startMs: startMs + 0.65,
  endMs: startMs + 800.45,
  speaker: "Participant",
});
const utterances = [
  cue("Before we finish, shall we sketch the label?", 0),
  cue("Maybe, once the drawings are back.", 1000),
  cue("Should we check the weight?", 2000),
];
const input = { utterances, items: [] };
const pair = ["sketch the label?", "once the drawings"];
const exact = utterances.map(({ text, startMs, endMs }) => ({
  text,
  startMs: Math.round(startMs),
  endMs: Math.round(endMs),
}));

test("review returns full original speech at its indexed time and keeps the most informative adjacent pair", () => {
  const rows = readMeetingCandidateReview(
    JSON.stringify([
      ["once the drawings"],
      pair,
      { excerpt: pair[0], excerpt_2: pair[1] },
      { excerpt: "check the weight" },
    ]),
    input,
  );
  expect(rows).toEqual([exact.slice(0, 2), exact.slice(2)]);
  expect(candidateSurvives({ sources: rows[0] ?? [] }, exact)).toBe(true);
  expect(candidateSurvives({ sources: rows[0] ?? [] }, exact.toReversed())).toBe(false);
  const last = exact[1];
  if (!last) throw new Error("Expected a second cue");
  const duplicateReply = [...utterances, { ...last, speaker: "Other" }];
  expect(candidateSurvives({ sources: rows[0] ?? [] }, duplicateReply)).toBe(false);
  expect(
    readMeetingCandidateReview(JSON.stringify([pair, [pair[0]]]), {
      ...input,
      utterances: duplicateReply,
    }),
  ).toEqual([exact.slice(0, 1)]);
});

test("one damaged or ambiguous member cannot turn into an item or hide an independently grounded suggestion", () => {
  const proposed = [
    "sketch the label",
    [],
    null,
    [" "],
    { excerpt: 42 },
    { excerpt: "check the weight", assignee: "Jo" },
    { excerpt_2: "Maybe" },
    { excerpt: "Maybe", excerpt_2: null },
    ["Maybe", "sketch the label"],
    ["sketch the label", "check the weight"],
    ["new wording"],
    ["check the weight", "yes", "yes"],
    ["duplicate"],
    pair,
  ];
  expect(
    readMeetingCandidateReview(JSON.stringify(proposed), {
      ...input,
      utterances: [...utterances, cue("duplicate", 5000), cue("duplicate", 6000)],
    }),
  ).toEqual([exact.slice(0, 2)]);
});

test("a nonempty list made entirely of malformed suggestions cannot be cached as a successful empty review", () => {
  const malformed = JSON.stringify([
    "a plain string",
    { excerpt_2: "not a suggestion" },
    { excerpt: "" },
    [],
    [5],
  ]);
  expect(() => readMeetingCandidateReview(malformed, input)).toThrow(
    expect.objectContaining({ wording: { key: "error.meeting.candidateReviewIncomplete" } }),
  );
  expect(readMeetingCandidateReview("[]", input)).toEqual([]);
});

test("wholly ungrounded excerpts report an incomplete review, while supported but ineligible quotes can resolve to empty", () => {
  const incomplete = { wording: { key: "error.meeting.candidateReviewIncomplete" } };
  for (const proposal of [
    [["well-formed words not in this meeting"]],
    [["check the weight", "sketch the label"]],
    [["sketch the label", "check the weight"], ["not in the transcript"]],
  ])
    expect(() => readMeetingCandidateReview(JSON.stringify(proposal), input)).toThrow(
      expect.objectContaining(incomplete),
    );
  expect(
    readMeetingCandidateReview(JSON.stringify([["sketch the label"]]), {
      ...input,
      established: ["sketch the label"],
    }),
  ).toEqual([]);
  expect(
    readMeetingCandidateReview('[["ambiguous"]]', {
      items: [],
      utterances: [cue("ambiguous", 0), cue("ambiguous", 2000)],
    }),
  ).toEqual([]);
  expect(readMeetingCandidateReview(JSON.stringify([["unknown"], pair]), input)).toEqual([
    exact.slice(0, 2),
  ]);
});

const fence = "```";
test.each([
  JSON.stringify([pair]),
  `${fence}json\n${JSON.stringify([pair])}\n${fence}`,
  `${fence}\r\n${JSON.stringify([pair])}\r\n${fence}`,
])("plain JSON or one complete JSON fence resolves literal speech", (raw) => {
  expect(readMeetingCandidateReview(raw, input)).toEqual([exact.slice(0, 2)]);
});
test.each([
  "{}",
  '{"changes":[]}',
  "[] trailing",
  `${fence}js\n[]\n${fence}`,
  `before\n${fence}json\n[]\n${fence}`,
  `${fence}json\n[]\n${fence}\n${fence}\n[]\n${fence}`,
  `${fence}json\n[]`,
  `${fence}json\n[]\n${fence}\``,
])("unreadable review reports the problem without substituting empty suggestions", (raw) => {
  expect(() => readMeetingCandidateReview(raw, input)).toThrow(
    expect.objectContaining({ wording: { key: "error.meeting.candidateReviewIncomplete" } }),
  );
});

test("a repeated generic assent cannot suppress a separate request or different work on the same turn", () => {
  const received = [
    cue("Could we ask later?", 0),
    cue("yes, perhaps.", 1000),
    cue("yes, publish the notice. Maybe ask for feedback.", 2000),
  ];
  const rows = readMeetingCandidateReview(
    JSON.stringify([
      ["Could we ask later?", "yes"],
      ["Maybe ask for feedback"],
      ["publish the notice"],
    ]),
    { items: [], utterances: received, established: ["yes", "publish the notice"] },
  );
  expect(rows.map((r) => r.map((s) => s.text))).toEqual([
    received.slice(0, 2).map((s) => s.text),
    received.slice(2).map((s) => s.text),
  ]);
});

test("only final visible item fields and the complete sequence of confirmed speech reach the selected AI", () => {
  const item: MeetingSummaryItem = {
    id: 4,
    kind: "action",
    status: "active",
    text: "User's localized task",
    corrected: true,
  };
  const { prompt } = meetingCandidateReviewPrompt({
    ...input,
    language: "English",
    items: [item],
    established: ["Private local evidence"],
  });
  expect(JSON.parse(prompt)).toEqual({
    language: "English",
    finalItems: [{ id: 4, kind: "action", status: "active", text: item.text }],
    utterances: utterances.map(({ speaker, text }) => ({ speaker, text })),
  });
});

function prepared(finish: "stop" | "length" = "stop", room = 16_384) {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify([pair]) }],
      finishReason: { unified: finish, raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    },
  });
  const prepareModel = vi.fn(async () => ({
    model,
    capabilities: resolveCapabilities({}),
    window: { tokens: room, outputTokens: 4096 },
  }));
  return { model, prepareModel, describeModel: () => undefined };
}
const choice = { providerId: "approved", modelId: "selected" };
test("an explicit review uses the selected model once and preserves transcript size and output allowance", async () => {
  const chat = prepared();
  const raw = await reviewCandidatesWithChat(chat, choice, input, new AbortController().signal);
  expect(readMeetingCandidateReview(raw, input)).toEqual([exact.slice(0, 2)]);
  expect(chat.prepareModel).toHaveBeenCalledExactlyOnceWith(choice, "chat", "task", {
    background: true,
  });
  expect(chat.model.doGenerateCalls).toHaveLength(1);
  expect(chat.model.doGenerateCalls[0]?.maxOutputTokens).toBe(4096);
  expect(chat.model.doGenerateCalls[0]?.tools?.length ?? 0).toBe(0);
  expect(chat.model.doGenerateCalls[0]?.prompt.at(-1)?.content).toEqual([
    { type: "text", text: meetingCandidateReviewPrompt(input).prompt },
  ]);
});
test("a full transcript that exceeds the selected model's window is rejected before sending any part", async () => {
  const chat = prepared("stop", 4352);
  const large = { ...input, utterances: [cue("正文".repeat(4_000), 0)] };
  await expect(
    reviewCandidatesWithChat(chat, choice, large, new AbortController().signal),
  ).rejects.toMatchObject({ wording: { key: "error.meeting.candidateReviewTooLong" } });
  expect(chat.model.doGenerateCalls).toHaveLength(0);
});
test("an incomplete provider reply never becomes a saved empty review", async () => {
  const chat = prepared("length");
  await expect(
    reviewCandidatesWithChat(chat, choice, input, new AbortController().signal),
  ).rejects.toMatchObject({ wording: { key: "error.meeting.candidateReviewIncomplete" } });
  expect(chat.model.doGenerateCalls).toHaveLength(1);
});

test("a connected client receives the explicit review separately from a normal summary and a revoked review is discarded", async () => {
  const core = startCore(await createTempDataFolder(), { audioCapture: createFakeCapture() });
  const created = await core.createMeeting();
  core.close();
  const meeting: Meeting = {
    ...created,
    status: "stopped",
    transcript: {
      documentId: "checked-document",
      state: "saved",
      lines: 3,
      partials: [],
      cloud: null,
      fellBack: null,
      model: null,
      savedPath: null,
      separating: false,
      problem: null,
    },
  };
  const run = vi
    .fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>()
    .mockResolvedValue(JSON.stringify([pair]));
  const grant = "one-connected-client";
  let connected = true;
  const prepareModel = vi.fn(async () => {
    throw new Error("Unexpected built-in model request");
  });
  const route = meetingSummaryRoute({
    settings: () => ({ meetingNotesAgentId: grant, meetingSummaryRoute: grant }),
    model: () => null,
    chat: { describeModel: () => undefined, canPrepareMeetingSummary: () => false, prepareModel },
    get: () => meeting,
    documentPresent: () => true,
    insideWall: () => false,
    client: () => (connected ? "codex" : null),
    agent: run,
  });
  const signal = new AbortController().signal;
  await route.generate(meeting, grant, { previous: null, utterances }, signal);
  expect(run.mock.calls[0]?.[0]).toEqual({
    client: "codex",
    ...meetingSummaryPrompt({ previous: null, utterances }),
    signal,
  });
  expect(await route.reviewCandidates(meeting, grant, input, signal)).toEqual([exact.slice(0, 2)]);
  expect(run.mock.calls[1]?.[0]).toEqual({
    client: "codex",
    purpose: "candidate-review",
    ...meetingCandidateReviewPrompt(input),
    signal,
  });
  run.mockImplementationOnce(async () => {
    connected = false;
    return JSON.stringify([pair]);
  });
  await expect(route.reviewCandidates(meeting, grant, input, signal)).rejects.toMatchObject({
    wording: { key: "error.meeting.summaryUnavailable" },
  });
  await expect(route.reviewCandidates(meeting, grant, input, signal)).rejects.toMatchObject({
    wording: { key: "error.meeting.summaryUnavailable" },
  });
  expect(run).toHaveBeenCalledTimes(3);
  expect(prepareModel).not.toHaveBeenCalled();
});
