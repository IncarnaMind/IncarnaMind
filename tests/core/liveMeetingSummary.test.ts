import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { CoreAdapters } from "../../src/core/adapters";
import { readVtt, writeVtt } from "../../src/core/documents/formats/vtt";
import { TranslatableError } from "../../src/core/errors";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { openDatabase } from "../../src/core/storage";
import { createFakeCloud } from "../../src/core/transcription/fakeCloud";
import { agentsAdapter } from "../helpers/agents";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const monday = "The launch is on Monday.";
const friday = "Correction, the launch is on Friday.";

function launchReply(text: string, quote: string, id: number | null) {
  return JSON.stringify({
    summary: text,
    changes: [{ id, kind: "decision", status: "active", text, quote }],
    ...(id !== null && { unchanged: [] }),
  });
}

async function setup(
  run: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>,
  grant = true,
  lines = [monday, friday],
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
    agents: await agentsAdapter(dir),
    audioCapture: capture,
    transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    summarizeWithMeetingAgent: run,
  };
  const core = startCore(dir, adapters);
  const folder = await core.createLibraryGroup({ name: "Launch", description: "" });
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
      meetingSummaryRoute: grant ? pairing.id : null,
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
  const summary = async () => (await core.listMeetings()).find((m) => m.id === meeting.id)?.summary;
  return { dir, core, pairing, adapters, meeting, push, summary };
}

// protects=an authorized participant can read a warm summary at Stop and receive the last correction later
test("a ready draft is returned by Stop while the last confirmed decision is still being summarized", async () => {
  let finish: (text: string) => void = () => {};
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) => {
    if (prompt.includes(friday))
      return new Promise((resolve) => {
        finish = resolve;
      });
    return launchReply("Launch on Monday.", monday, null);
  });
  const { dir, core, adapters, meeting, push, summary } = await setup(run);
  push(2500);
  await vi.waitFor(async () => expect((await summary())?.text).toBe("Launch on Monday."));
  push(2000);
  await until(core, meeting.id, (m) => m.lines >= 2);
  const stopped = await core.stopMeeting(meeting.id);
  expect(stopped.summary).toMatchObject({
    text: "Launch on Monday.",
    state: "updating",
    items: [{ id: 1, kind: "decision", status: "active", text: "Launch on Monday." }],
  });
  await vi.waitFor(() =>
    expect(run.mock.calls.some(([input]) => input.prompt.includes(friday))).toBe(true),
  );
  finish(launchReply("Launch on Friday.", friday, 1));
  await vi.waitFor(async () =>
    expect(await summary()).toMatchObject({ text: "Launch on Friday.", state: "ready" }),
  );
  expect(run.mock.calls.every(([input]) => input.client === "codex")).toBe(true);
  const count = run.mock.calls.length;
  core.close();
  const next = startCore(dir, adapters);
  try {
    expect((await next.listMeetings())[0]?.summary).toMatchObject({
      text: "Launch on Friday.",
      state: "ready",
      items: [{ id: 1, kind: "decision", status: "active", text: "Launch on Friday." }],
    });
    await next.deleteMeetingAudio(meeting.id);
    const sources = await next.getMeetingSummaryItemSources(meeting.id, 1);
    expect(sources?.sources.map((source) => source.text)).toEqual([monday, friday]);
    expect(sources?.sources[1]?.startMs).toBeGreaterThan(sources?.sources[0]?.startMs ?? 0);
    expect(await next.getMeetingSummaryItemSources(meeting.id, 999)).toBeNull();
    expect(run).toHaveBeenCalledTimes(count);
  } finally {
    next.close();
  }
});

test("original speech keeps its time through a repeat and does not follow relocated words", async () => {
  const run = vi.fn(async ({ prompt }: { prompt: string }) =>
    prompt.includes(friday)
      ? launchReply("Launch on Friday.", friday, 1)
      : launchReply("Launch on Monday.", monday, null),
  );
  const { core, meeting, push, summary } = await setup(run);
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.text).toBe("Launch on Monday."));
    push(2000);
    await until(core, meeting.id, (m) => m.lines >= 2);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    const item = (await summary())?.items?.[0];
    const source = await core.getMeetingSummaryItemSources(meeting.id, 1);
    if (!item || !source) throw new Error("The meeting has no sourced decision.");
    expect(source.sources.map(({ text }) => text)).toEqual([monday, friday]);
    await core.correctMeetingSummaryItem(meeting.id, item, {
      kind: item.kind,
      status: item.status,
      text: "My corrected launch wording.",
    });
    const document = (await core.listDocuments()).find(({ id }) => id === source.documentId);
    if (!document?.path) throw new Error("The meeting has no saved Transcript.");
    const file = document.path;
    const original = readVtt(await readFile(file, "utf8"));
    const [first, second] = original.cues;
    if (!first || !second) throw new Error("The saved Transcript has no launch exchange.");
    const echo = { ...first, startMs: 20_000, endMs: 20_500 };
    const rewrite = async (cues: typeof original.cues) => {
      const contents = writeVtt({ ...original, cues });
      await writeFile(file, contents);
      await core.reconcileDocuments();
      await waitForDocuments(core, (listed) =>
        expect(listed.find(({ id }) => id === document.id)?.contentHash).toBe(sha256(contents)),
      );
      await waitForProcessing(core, [document.id]);
    };

    await rewrite([first, second, echo]);
    const repeated = await core.getMeetingSummaryItemSources(meeting.id, item.id);
    expect(repeated?.sources).toEqual(source.sources);

    await rewrite([first, first, second, echo]);
    const coincident = await core.getMeetingSummaryItemSources(meeting.id, item.id);
    expect(coincident?.sources).toEqual(source.sources.slice(1));

    await rewrite([second, echo]);
    const relocated = await core.getMeetingSummaryItemSources(meeting.id, item.id);
    expect(relocated?.sources).toEqual(source.sources.slice(1));
    expect((await summary())?.items?.[0]).toMatchObject({
      id: item.id,
      text: "My corrected launch wording.",
      corrected: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    core.close();
  }
});

test("a closing update can keep a withdrawn action and publish the revised launch date", async () => {
  const withdrawn = "The banner order was cancelled";
  const opening = `${withdrawn} and the launch is on Monday.`;
  const run = vi.fn(async ({ prompt }: { prompt: string }) => {
    const closing = prompt.includes(friday);
    const date = closing ? friday : monday;
    return JSON.stringify({
      summary: date,
      changes: [
        {
          id: closing ? 1 : null,
          kind: "decision",
          status: "active",
          text: date,
          quote: closing ? friday : "the launch is on Monday",
        },
        ...(closing
          ? []
          : [{ id: null, kind: "action", status: "cancelled", text: withdrawn, quote: withdrawn }]),
      ],
      ...(closing && { unchanged: [2] }),
    });
  });
  const { core, meeting, push, summary } = await setup(run, true, [opening, friday]);
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.text).toBe(monday));
    push(2000);
    await until(core, meeting.id, (m) => m.lines >= 2);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toMatch(/ready|failed/));
    expect(await summary()).toMatchObject({
      state: "ready",
      text: friday,
      items: [
        { id: 1, status: "active", text: friday },
        { id: 2, status: "cancelled", text: withdrawn },
      ],
    });
    const source = await core.getMeetingSummaryItemSources(meeting.id, 2);
    expect(source?.sources.map((s) => s.text)).toEqual([withdrawn]);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    core.close();
  }
});

test("a repeated saved action does not hide the new action beside it after Stop or restart", async () => {
  const quoteAction = "Lee will compare moving quotes.";
  const cartonAction = "Each department will count its cartons.";
  const action = (text: string) => ({
    id: null,
    kind: "action",
    status: "active",
    text,
    quote: text,
  });
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) => {
    const next = prompt.includes(cartonAction);
    return JSON.stringify({
      summary: next ? "The departments will prepare carton counts." : "Lee will compare quotes.",
      changes: next ? [action(quoteAction), action(cartonAction)] : [action(quoteAction)],
      ...(next && { unchanged: [1] }),
    });
  });
  const { core, dir, adapters, meeting, push, summary } = await setup(run, true, [
    quoteAction,
    `${quoteAction} ${cartonAction}`,
  ]);
  const expected = [quoteAction, cartonAction].map((text, index) => ({
    id: index + 1,
    kind: "action",
    status: "active",
    text,
  }));
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.items).toEqual(expected.slice(0, 1)));
    push(2000);
    await until(core, meeting.id, (m) => m.lines >= 2);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toMatch(/ready|failed/));
    expect(await summary()).toMatchObject({ state: "ready", items: expected });
  } finally {
    core.close();
  }
  const calls = run.mock.calls.length;
  const reopened = startCore(dir, adapters);
  try {
    expect(
      (await reopened.listMeetings()).find((m) => m.id === meeting.id)?.summary?.items,
    ).toEqual(expected);
    expect(run).toHaveBeenCalledTimes(calls);
  } finally {
    reopened.close();
  }
});

// protects=revocation during a live request suppresses its late output and prevents a final background send
test("revoking folder access cancels the outstanding request and discards its late reply", async () => {
  let resolve: (v: string) => void = () => {};
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { core, pairing, meeting, push, summary } = await setup(run);
  try {
    push(2500);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await core.updateAgent(pairing.id, { folderIds: [] });
    expect(run.mock.calls[0]?.[0].signal.aborted).toBe(true);
    resolve(launchReply("Launch on Monday.", monday, null));
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (m) => m.state === "saved");
    expect((await summary())?.text).toBe("");
    await expect(core.retryMeetingSummary(meeting.id)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    core.close();
  }
});

test("choosing a notes agent alone keeps live and stopped transcription out of background runs", async () => {
  const run = vi.fn(async () => "unexpected");
  const { core, meeting, push, summary } = await setup(run, false);
  try {
    push(2500);
    await until(core, meeting.id, (m) => m.lines > 0);
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (m) => m.state === "saved");
    expect(await summary()).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  } finally {
    core.close();
  }
});

test.each([
  { problem: undefined, error: new Error("offline") },
  {
    problem: "codex-input-limit",
    error: new TranslatableError({ key: "error.meeting.codexSummaryTooLong" }),
  },
])(
  "a failed summary ($problem) keeps its reason and retries only when the User asks the same authorized AI",
  async ({ problem, error }) => {
    let online = false;
    const run = vi.fn(async () => {
      if (!online) throw error;
      return launchReply("Launch on Monday.", monday, null);
    });
    const { dir, core, adapters, meeting, push, summary } = await setup(run);
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (m) => m.state === "saved");
    await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
    core.close();
    const count = run.mock.calls.length;
    const reopened = startCore(dir, adapters);
    try {
      expect((await reopened.listMeetings())[0]?.summary?.problem).toBe(problem);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(count);
      online = true;
      await reopened.retryMeetingSummary(meeting.id);
      await vi.waitFor(async () =>
        expect((await reopened.listMeetings())[0]?.summary).toMatchObject({
          text: "Launch on Monday.",
          state: "ready",
        }),
      );
      expect(run).toHaveBeenCalledTimes(count + 1);
      expect((await reopened.listMeetings())[0]?.summary?.problem).toBeUndefined();
    } finally {
      reopened.close();
    }
  },
);

test("local corrections survive a failed final update, restart and an in-flight retry without entering model input", async () => {
  const first = Promise.withResolvers<string>();
  const retry = Promise.withResolvers<string>();
  const run = vi
    .fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>()
    .mockResolvedValueOnce(launchReply("Launch on Monday.", monday, null))
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => retry.promise);
  const { dir, core, adapters, meeting, push, summary } = await setup(run);
  const ai = { id: 1, kind: "decision", status: "active", text: "Launch on Monday." } as const;
  const draft = { kind: "action", status: "done", text: "My private correction." } as const;
  const changed = { ...draft, id: 1, corrected: true } as const;
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.items).toEqual([ai]));
    await expect(core.correctMeetingSummaryItem(meeting.id, ai, draft)).rejects.toMatchObject({
      wording: { key: "error.meeting.summaryItemUnavailable" },
    });
    push(2000);
    await until(core, meeting.id, (m) => m.lines >= 2);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const notified = vi.fn();
    const unsubscribe = core.on("meetings.changed", notified);
    const edited = await core.correctMeetingSummaryItem(meeting.id, ai, draft);
    unsubscribe();
    expect(edited.summary?.items).toEqual([changed]);
    expect(notified.mock.lastCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: meeting.id,
          summary: expect.objectContaining({ items: [changed] }),
        }),
      ]),
    );
    first.reject(new Error("offline"));
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({ state: "failed", items: [changed] }),
    );
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    core.close();
  }
  const reopened = startCore(dir, adapters);
  try {
    const current = () =>
      reopened.listMeetings().then((list) => list.find((m) => m.id === meeting.id));
    expect((await current())?.summary).toMatchObject({ state: "failed", items: [changed] });
    await expect(
      reopened.correctMeetingSummaryItem(meeting.id, changed, { ...draft, text: "  " }),
    ).rejects.toMatchObject({
      wording: { key: "error.meeting.summaryItemInvalid" },
    });
    const next = { ...draft, status: "cancelled", text: "Second private correction." } as const;
    const edits = await Promise.allSettled([
      reopened.correctMeetingSummaryItem(meeting.id, changed, next),
      reopened.correctMeetingSummaryItem(meeting.id, changed, {
        ...draft,
        text: "Stale private text.",
      }),
    ]);
    expect(edits.map((edit) => edit.status)).toEqual(["fulfilled", "rejected"]);
    expect(edits[1]).toMatchObject({
      reason: { wording: { key: "error.meeting.summaryItemChanged" } },
    });
    await reopened.retryMeetingSummary(meeting.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(JSON.parse(run.mock.calls[2]?.[0].prompt ?? "")).toMatchObject({ items: [ai] });
    const final = {
      kind: "decision",
      status: "active",
      text: "Final private correction.",
    } as const;
    await reopened.correctMeetingSummaryItem(
      meeting.id,
      { ...next, id: 1, corrected: true },
      final,
    );
    retry.resolve(launchReply("Launch on Friday.", friday, 1));
    const corrected = { ...final, id: 1, corrected: true } as const;
    await vi.waitFor(async () =>
      expect((await current())?.summary).toMatchObject({ state: "ready", items: [corrected] }),
    );
    const originalSpeech = await reopened.getMeetingSummaryItemSources(meeting.id, 1);
    expect(originalSpeech?.sources.map((source) => source.text)).toEqual([monday]);
    const reverted = await reopened.correctMeetingSummaryItem(meeting.id, corrected, {
      restoreGenerated: true,
      kind: "decision",
      status: "active",
      text: "Launch on Friday.",
    });
    expect(reverted.summary?.items).toEqual([{ ...ai, text: "Launch on Friday." }]);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [request] of run.mock.calls) expect(request.prompt).not.toContain("private");
  } finally {
    reopened.close();
  }
});

test("saving the same value as the AI keeps the manual correction through a later model update", async () => {
  const finish = Promise.withResolvers<string>();
  const run = vi
    .fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>()
    .mockResolvedValueOnce(launchReply("Launch on Monday.", monday, null))
    .mockImplementationOnce(() => finish.promise);
  const { core, meeting, push, summary } = await setup(run);
  const generated = { kind: "decision", status: "active", text: "Launch on Monday." } as const;
  const original = { ...generated, id: 1 };
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.items).toEqual([original]));
    push(2000);
    await until(core, meeting.id, (m) => m.lines >= 2);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const alternate = { ...generated, text: "Launch on Thursday." };
    await core.correctMeetingSummaryItem(meeting.id, original, alternate);
    const edited = await core.correctMeetingSummaryItem(
      meeting.id,
      { ...alternate, id: 1, corrected: true },
      generated,
    );
    const manual = { ...original, corrected: true } as const;
    expect(edited.summary?.items).toEqual([manual]);
    finish.resolve(launchReply("Launch on Friday.", friday, 1));
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({
        state: "ready",
        text: "Launch on Friday.",
        items: [manual],
      }),
    );
    const restoreMonday = await core.correctMeetingSummaryItem(meeting.id, manual, {
      ...generated,
      restoreGenerated: true,
    });
    expect(restoreMonday.summary?.items).toEqual([manual]);
    const fridayValue = { ...generated, text: "Launch on Friday." };
    const savedFriday = await core.correctMeetingSummaryItem(meeting.id, manual, fridayValue);
    const manualFriday = { ...fridayValue, id: 1, corrected: true } as const;
    expect(savedFriday.summary?.items).toEqual([manualFriday]);
    const restoreFriday = await core.correctMeetingSummaryItem(meeting.id, manualFriday, {
      ...fridayValue,
      restoreGenerated: true,
    });
    expect(restoreFriday.summary?.items).toEqual([{ ...fridayValue, id: 1 }]);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    finish.resolve("");
    core.close();
  }
});

test("a summary rebuilt for a replaced Transcript cannot assign a locally corrected ID to a different item", async () => {
  let replay = false;
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async () =>
    replay
      ? launchReply("Unrelated Friday decision.", friday, null)
      : launchReply("Launch on Monday.", monday, null),
  );
  const { dir, core, adapters, meeting, push, summary } = await setup(run);
  const original = {
    id: 1,
    kind: "decision",
    status: "active",
    text: "Launch on Monday.",
  } as const;
  const replacement = { kind: "action", status: "active", text: "Locally kept action." } as const;
  try {
    push(2500);
    await vi.waitFor(async () => expect((await summary())?.items).toEqual([original]));
    push(2000);
    await until(core, meeting.id, (m) => m.lines >= 2);
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (m) => m.state === "saved");
    await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
    await core.correctMeetingSummaryItem(meeting.id, original, replacement);
  } finally {
    core.close();
  }
  // A retry for a different source starts from an empty AI list, as it does after transcript replacement.
  const db = openDatabase(join(dir, DATABASE_FILE));
  try {
    db.run(
      "UPDATE meetings SET summary = json_set(summary, '$.documentId', 'earlier-transcript') WHERE id = ?",
      [meeting.id],
    );
  } finally {
    db.close();
  }
  replay = true;
  const reopened = startCore(dir, adapters);
  try {
    await reopened.retryMeetingSummary(meeting.id);
    await vi.waitFor(async () => {
      const saved = (await reopened.listMeetings()).find((m) => m.id === meeting.id)?.summary;
      expect(saved?.state).toBe("ready");
      expect(saved?.items).toEqual(
        expect.arrayContaining([
          { ...replacement, id: 1, corrected: true },
          { ...original, id: 2, text: "Unrelated Friday decision." },
        ]),
      );
      expect(saved?.items).toHaveLength(2);
    });
    const oldSource = await reopened.getMeetingSummaryItemSources(meeting.id, 1);
    const newSource = await reopened.getMeetingSummaryItemSources(meeting.id, 2);
    expect(oldSource?.sources.map((source) => source.text)).toEqual([monday]);
    expect(newSource?.sources.map((source) => source.text)).toEqual([friday]);
    const sent = JSON.parse(run.mock.lastCall?.[0].prompt ?? "");
    expect(sent.items).toBeUndefined();
    expect(sent.previous).toBeNull();
    expect(run.mock.lastCall?.[0].prompt).not.toContain(replacement.text);
  } finally {
    reopened.close();
  }
});

test("a silent call ends with no summary text and no model request", async () => {
  const run = vi.fn(async () => "unexpected");
  const { core, meeting, summary } = await setup(run);
  try {
    expect(await summary()).toMatchObject({ state: "preparing", text: "" });
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (m) => m.state === "empty");
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({ state: "ready", text: "" }),
    );
    expect(run).not.toHaveBeenCalled();
  } finally {
    core.close();
  }
});

test("opening an older stopped meeting keeps its original summary without sending a new request", async () => {
  const dir = await createTempDataFolder();
  const before = startCore(dir, { audioCapture: createFakeCapture() });
  const { id } = await before.createMeeting();
  before.close();
  const original = { text: "Keep the current launch date.", throughMs: 1_500, state: "ready" };
  const db = openDatabase(join(dir, DATABASE_FILE));
  try {
    db.run("UPDATE meetings SET status = 'stopped', summary = ? WHERE id = ?", [
      JSON.stringify({ route: "legacy-pairing", count: 1, digest: "legacy", summary: original }),
      id,
    ]);
  } finally {
    db.close();
  }
  const run = vi.fn(async () => "unexpected");
  const reopened = startCore(dir, { summarizeWithMeetingAgent: run });
  try {
    expect((await reopened.listMeetings()).find((meeting) => meeting.id === id)?.summary).toEqual(
      original,
    );
    expect(run).not.toHaveBeenCalled();
  } finally {
    reopened.close();
  }
});
