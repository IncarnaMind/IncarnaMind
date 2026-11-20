import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { CoreAdapters } from "../../src/core/adapters";
import type { Meeting } from "../../src/core/api";
import { readVtt, writeVtt } from "../../src/core/documents/formats/vtt";
import { TranslatableError } from "../../src/core/errors";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { openDatabase } from "../../src/core/storage";
import { createFakeCloud } from "../../src/core/transcription/fakeCloud";
import { agentsAdapter } from "../helpers/agents";
import {
  createMemoryKeychain,
  createTempDataFolder,
  manualClock,
  startCore,
} from "../helpers/core";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const release = "The release review is next Friday.";
const question = "Should Nora compare the draft agendas?";
const reply = "Maybe, once the team sends both.";
const unavailable = { wording: { key: "error.meeting.summaryCandidateUnavailable" } };
const awaitingAgent = (run: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>) => vi.fn(run);

async function record(
  lines: string[],
  model: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>,
) {
  const dir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const { transcriber } = inProcessTranscriber(
    {},
    undefined,
    createFakeCloud({ voices: 1, lines }),
  );
  const adapters = {
    now: clock.now,
    keychain: createMemoryKeychain(),
    agents: await agentsAdapter(dir),
    audioCapture: capture,
    transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    summarizeWithMeetingAgent: model,
  };
  const core = startCore(dir, adapters);
  const folder = await core.createLibraryGroup({ name: "Planning", description: "" });
  await core.setAgentsEnabled(true);
  const { pairing } = await core.connectAgent({
    name: "Codex",
    client: "codex",
    folderIds: [folder.id],
  });
  await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key-0123456789" });
  await core.updateSettings({
    device: {
      meetingNoticeAccepted: true,
      meetingNotesAgentId: pairing.id,
      meetingSummaryRoute: pairing.id,
      transcriptionRoute: "soniox",
    },
  });
  const meeting = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  await until(core, meeting.id, (m) => m.cloud === "soniox");
  await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
  const push = (millis: number) => {
    for (let i = 0; i < millis; i += 500) {
      clock.advance(500);
      capture.push("system", 500);
    }
  };
  return { core, dir, adapters, meeting, push, route: pairing.id };
}

const generatedDecision = { id: 1, kind: "decision", status: "active", text: release } as const;

type SummaryAdapter = NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>;

async function recordPair(
  review: SummaryAdapter = async () => JSON.stringify([[question, reply]]),
) {
  const model = awaitingAgent(async (request) => {
    if (request.purpose === "candidate-review") return review(request);
    return JSON.stringify(
      request.prompt.includes(reply)
        ? { summary: release, changes: [], unchanged: [1] }
        : { summary: release, changes: [{ ...generatedDecision, id: null, quote: release }] },
    );
  });
  const fixture = await record([release, question, reply], model);
  const { core, meeting, push } = fixture;
  try {
    push(2500);
    await vi.waitFor(async () =>
      expect((await core.listMeetings())[0]?.summary?.items).toEqual([generatedDecision]),
    );
    expect(await core.canReviewMeetingSummaryCandidates(meeting.id)).toBe(false);
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    await expect(core.reviewMeetingSummaryCandidates(meeting.id)).rejects.toMatchObject({
      wording: { key: "error.meeting.summaryCandidateReviewNotReady" },
    });
    push(4000);
    await until(core, meeting.id, (m) => m.lines >= 3);
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (transcript) => transcript.state === "saved");
    await vi.waitFor(async () =>
      expect((await core.listMeetings())[0]?.summary?.state).toBe("ready"),
    );
    expect(await core.canReviewMeetingSummaryCandidates(meeting.id)).toBe(true);
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
    expect(model).toHaveBeenCalledTimes(2);
    return { ...fixture, model };
  } catch (error) {
    core.close();
    throw error;
  }
}

const reviewUnavailable = { wording: { key: "error.meeting.summaryCandidateReviewUnavailable" } };

test("accepting a reviewed exchange is local, idempotent, undoable and survives a restart", async () => {
  const { core, dir, adapters, meeting, model, route } = await recordPair();
  await core.updateSettings({ device: { meetingSummaryRoute: "different-pairing" } });
  expect(await core.canReviewMeetingSummaryCandidates(meeting.id)).toBe(false);
  await expect(core.reviewMeetingSummaryCandidates(meeting.id)).rejects.toMatchObject(
    reviewUnavailable,
  );
  expect(model).toHaveBeenCalledTimes(2);
  await core.updateSettings({ device: { meetingSummaryRoute: route } });
  expect(await core.canReviewMeetingSummaryCandidates(meeting.id)).toBe(true);
  const [first, second] = await Promise.all([
    core.reviewMeetingSummaryCandidates(meeting.id),
    core.reviewMeetingSummaryCandidates(meeting.id),
  ]);
  expect(first).toEqual(second);
  const [candidate] = first;
  if (!candidate) throw new Error("The fixture needs a review candidate.");
  const request = model.mock.calls.find(([call]) => call.purpose === "candidate-review")?.[0];
  expect(JSON.parse(request?.prompt ?? "")).toMatchObject({
    utterances: [{ text: release }, { text: question }, { text: reply }],
    finalItems: [expect.objectContaining({ text: release })],
  });
  const priorStatus = (await core.listMeetings())[0]?.summary;
  expect(priorStatus).toMatchObject({
    candidatesReviewed: true,
    candidateCount: 1,
    items: [generatedDecision],
  });
  expect(priorStatus).not.toHaveProperty("candidates");
  expect(candidate.sources.map(({ text }) => text)).toEqual([question, reply]);
  await core.updateSettings({ device: { meetingSummaryRoute: null } });
  expect(await core.canReviewMeetingSummaryCandidates(meeting.id)).toBe(false);
  expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([candidate]);

  const promoted = {
    id: 2,
    kind: "action",
    status: "active",
    text: `${question}\n${reply}`,
    corrected: true,
  } as const;
  try {
    const added = await Promise.all([
      core.addMeetingSummaryCandidate(meeting.id, candidate.id),
      core.addMeetingSummaryCandidate(meeting.id, candidate.id),
    ]);
    for (const result of added) {
      expect(result.summary?.items).toEqual([generatedDecision, promoted]);
      expect(result.summary).not.toHaveProperty("candidates");
      expect(result.summary?.candidateCount).toBeUndefined();
    }
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    const sources = await core.getMeetingSummaryItemSources(meeting.id, promoted.id);
    expect(sources?.sources).toEqual(candidate.sources);

    const undone = await core.undoAddMeetingSummaryCandidate(meeting.id, candidate.id);
    expect(undone.summary?.items).toEqual([generatedDecision]);
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([candidate]);
    expect(await core.getMeetingSummaryItemSources(meeting.id, promoted.id)).toBeNull();

    const redone = await core.addMeetingSummaryCandidate(meeting.id, candidate.id);
    const restoredAction = { ...promoted, id: promoted.id + 1 };
    expect(redone.summary?.items).toEqual([generatedDecision, restoredAction]);
    await core.correctMeetingSummaryItem(meeting.id, restoredAction, {
      kind: "action",
      status: "done",
      text: "Nora filed the agenda comparison.",
    });
    await expect(
      core.undoAddMeetingSummaryCandidate(meeting.id, candidate.id),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.summaryItemChanged" } });
  } finally {
    core.close();
  }
  const reopened = startCore(dir, adapters);
  try {
    const items = (await reopened.listMeetings())[0]?.summary?.items;
    expect(items).toEqual([
      generatedDecision,
      {
        ...promoted,
        id: promoted.id + 1,
        status: "done",
        text: "Nora filed the agenda comparison.",
      },
    ]);
    expect(await reopened.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(
      (await reopened.getMeetingSummaryItemSources(meeting.id, promoted.id + 1))?.sources,
    ).toEqual(candidate.sources);
    expect(await reopened.reviewMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    reopened.close();
  }
});

test("a changed Transcript removes review access without leaking original lines in Meeting snapshots", async () => {
  const { core, meeting, model } = await recordPair();
  try {
    const [candidate] = await core.reviewMeetingSummaryCandidates(meeting.id);
    if (!candidate) throw new Error("The fixture needs a review candidate.");
    const [current] = await core.listMeetings();
    const documentId = current?.transcript?.documentId;
    const document = (await core.listDocuments()).find(({ id }) => id === documentId);
    if (!document?.path) throw new Error("The test needs a saved Transcript.");
    const transcript = readVtt(await readFile(document.path, "utf8"));
    const changed = writeVtt({
      ...transcript,
      cues: transcript.cues.map((cue) =>
        cue.text === question ? { ...cue, text: "Different words." } : cue,
      ),
    });
    const updates = vi.fn<(meetings: Meeting[]) => void>();
    const stopWatching = core.on("meetings.changed", updates);
    await writeFile(document.path, changed);
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    await expect(core.addMeetingSummaryCandidate(meeting.id, candidate.id)).rejects.toMatchObject(
      unavailable,
    );

    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) =>
      expect(listed.find(({ id }) => id === documentId)?.contentHash).toBe(sha256(changed)),
    );
    await waitForProcessing(core, [document.id]);
    await vi.waitFor(() => {
      expect(updates.mock.calls.length).toBeGreaterThan(0);
      expect(updates.mock.lastCall?.[0][0]?.summary?.candidatesReviewed).toBeUndefined();
    });
    stopWatching();
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    await expect(core.addMeetingSummaryCandidate(meeting.id, candidate.id)).rejects.toMatchObject(
      unavailable,
    );
    const snapshot = (await core.listMeetings())[0];
    expect(snapshot?.summary?.items).toEqual([generatedDecision]);
    expect(snapshot?.summary).not.toHaveProperty("candidates");
    expect(JSON.stringify(snapshot?.summary)).not.toContain(question);
    expect(JSON.stringify(snapshot?.summary)).not.toContain(reply);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    core.close();
  }
});

test("an explicit empty review is cached across reopen with no new sends", async () => {
  const { core, dir, adapters, meeting, model } = await recordPair(async () => "[]");
  try {
    expect(await core.reviewMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect((await core.listMeetings())[0]?.summary).toMatchObject({
      text: release,
      items: [generatedDecision],
      candidatesReviewed: true,
    });
    expect(await core.reviewMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    core.close();
  }
  const reopened = startCore(dir, adapters);
  try {
    expect((await reopened.listMeetings())[0]?.summary?.candidatesReviewed).toBe(true);
    expect(await reopened.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(await reopened.reviewMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    reopened.close();
  }
});

test("a saved legacy Transcript can be reviewed and its cached review reopened", async () => {
  const { core, dir, adapters, meeting, model } = await recordPair();
  try {
    await core.setAgentsEnabled(false);
  } finally {
    core.close();
  }
  const db = openDatabase(join(dir, DATABASE_FILE));
  try {
    db.run("UPDATE meetings SET transcript_document_id = NULL WHERE id = ?", [meeting.id]);
  } finally {
    db.close();
  }
  const first = startCore(dir, adapters);
  try {
    await first.setAgentsEnabled(true);
    expect(await first.canReviewMeetingSummaryCandidates(meeting.id)).toBe(true);
    expect(await first.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(2);
    const candidates = await first.reviewMeetingSummaryCandidates(meeting.id);
    expect(candidates.map(({ sources }) => sources.map(({ text }) => text))).toEqual([
      [question, reply],
    ]);
    expect((await first.listMeetings())[0]?.summary?.candidateCount).toBe(1);
    expect(model).toHaveBeenCalledTimes(3);
    await first.setAgentsEnabled(false);
  } finally {
    first.close();
  }
  const second = startCore(dir, adapters);
  try {
    expect(await second.canReviewMeetingSummaryCandidates(meeting.id)).toBe(false);
    expect((await second.listMeetings())[0]?.summary?.candidatesReviewed).toBe(true);
    expect(await second.getMeetingSummaryCandidates(meeting.id)).toHaveLength(1);
    expect(await second.reviewMeetingSummaryCandidates(meeting.id)).toHaveLength(1);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    second.close();
  }
});

test("disconnecting the selected agent aborts an active review before secret cleanup", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const replyFromAgent = Promise.withResolvers<string>();
  const { core, meeting, route, model, adapters } = await recordPair(async ({ signal }) => {
    started.resolve(signal);
    return replyFromAgent.promise;
  });
  const deleting = Promise.withResolvers<void>();
  const finishDeleting = Promise.withResolvers<void>();
  const deleteSecret = adapters.keychain.delete;
  const deleteSpy = vi.spyOn(adapters.keychain, "delete").mockImplementation(async (name) => {
    deleting.resolve();
    await finishDeleting.promise;
    await deleteSecret(name);
  });
  try {
    const pending = core.reviewMeetingSummaryCandidates(meeting.id);
    const cancelled = expect(pending).rejects.toMatchObject(reviewUnavailable);
    const signal = await started.promise;
    const disconnected = core.disconnectAgent(route);
    try {
      await deleting.promise;
      expect(signal.aborted).toBe(true);
      await cancelled;
      replyFromAgent.resolve(JSON.stringify([[question, reply]]));
      expect(await core.canReviewMeetingSummaryCandidates(meeting.id)).toBe(false);
      expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
      expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
      expect(model).toHaveBeenCalledTimes(3);
    } finally {
      finishDeleting.resolve();
      await disconnected;
      await cancelled;
    }
  } finally {
    replyFromAgent.resolve("[]");
    deleteSpy.mockRestore();
    core.close();
  }
});

test.each(["disable the route", "edit a visible item", "close the core"])(
  "an in-flight review is invalidated when they %s",
  async (change) => {
    const received = Promise.withResolvers<AbortSignal>();
    const releaseReply = Promise.withResolvers<string>();
    const { core, dir, adapters, meeting, model } = await recordPair(async ({ signal }) => {
      received.resolve(signal);
      return releaseReply.promise;
    });
    try {
      const pending = core.reviewMeetingSummaryCandidates(meeting.id);
      const cancelled = expect(pending).rejects.toMatchObject(reviewUnavailable);
      const signal = await received.promise;
      if (change === "disable the route") {
        await core.updateSettings({ device: { meetingSummaryRoute: null } });
      } else if (change === "edit a visible item") {
        await core.correctMeetingSummaryItem(meeting.id, generatedDecision, {
          kind: "decision",
          status: "active",
          text: "The release review is next Monday.",
        });
      } else {
        core.close();
      }
      await cancelled;
      expect(signal.aborted).toBe(true);
      releaseReply.resolve(JSON.stringify([[question, reply]]));
      if (change !== "close the core") {
        expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
        expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
      }
    } finally {
      releaseReply.resolve("[]");
      core.close();
    }
    const reopened = startCore(dir, adapters);
    try {
      expect((await reopened.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
      expect(await reopened.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
      expect(model).toHaveBeenCalledTimes(3);
    } finally {
      reopened.close();
    }
  },
);

test("a failed explicit review can be retried and sends the final edited items", async () => {
  let attempts = 0;
  const { core, meeting, model } = await recordPair(async () => {
    attempts++;
    if (attempts === 1) throw new Error("Provider unavailable.");
    if (attempts === 2)
      throw new TranslatableError({ key: "error.meeting.candidateReviewTooLong" });
    return "[]";
  });
  try {
    const manual = "The release review is now on Monday.";
    await core.correctMeetingSummaryItem(meeting.id, generatedDecision, {
      kind: "decision",
      status: "active",
      text: manual,
    });
    await expect(core.reviewMeetingSummaryCandidates(meeting.id)).rejects.toMatchObject({
      wording: { key: "error.meeting.candidateReviewFailed" },
    });
    expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
    await expect(core.reviewMeetingSummaryCandidates(meeting.id)).rejects.toMatchObject({
      wording: { key: "error.meeting.candidateReviewTooLong" },
    });
    expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
    expect(await core.reviewMeetingSummaryCandidates(meeting.id)).toEqual([]);
    const requests = model.mock.calls.filter(([request]) => request.purpose === "candidate-review");
    expect(requests).toHaveLength(3);
    for (const [request] of requests) {
      expect(JSON.parse(request.prompt)).toMatchObject({
        finalItems: [{ kind: "decision", status: "active", text: manual }],
      });
    }
    expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBe(true);
  } finally {
    core.close();
  }
});

test("a Transcript changed on disk during review cannot publish the old response", async () => {
  const received = Promise.withResolvers<void>();
  const releaseReply = Promise.withResolvers<string>();
  const { core, meeting, model } = await recordPair(async () => {
    received.resolve();
    return releaseReply.promise;
  });
  try {
    const pending = core.reviewMeetingSummaryCandidates(meeting.id);
    const stale = expect(pending).rejects.toMatchObject(reviewUnavailable);
    await received.promise;
    const [current] = await core.listMeetings();
    const document = (await core.listDocuments()).find(
      ({ id }) => id === current?.transcript?.documentId,
    );
    if (!document?.path) throw new Error("The test needs a finalized Transcript.");
    const transcript = readVtt(await readFile(document.path, "utf8"));
    await writeFile(
      document.path,
      writeVtt({
        ...transcript,
        cues: transcript.cues.map((cue) =>
          cue.text === question ? { ...cue, text: "The source changed during review." } : cue,
        ),
      }),
    );
    releaseReply.resolve(JSON.stringify([[question, reply]]));
    await stale;
    expect((await core.listMeetings())[0]?.summary?.candidatesReviewed).toBeUndefined();
    expect(await core.getMeetingSummaryCandidates(meeting.id)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    releaseReply.resolve("[]");
    core.close();
  }
});
