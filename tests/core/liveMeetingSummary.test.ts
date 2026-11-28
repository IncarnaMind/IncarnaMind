import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { CoreAdapters } from "../../src/core/adapters";
import { readVtt, writeVtt } from "../../src/core/documents/formats/vtt";
import { TranslatableError } from "../../src/core/errors";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { openDatabase } from "../../src/core/storage";
import { agentsAdapter } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";
import { startLiveAgentMeeting } from "../helpers/liveAgentMeeting";
import { transcribingCore, until } from "../helpers/transcription";

const monday = "The launch is on Monday.";
const friday = "Correction, the launch is on Friday.";

function launchReply(text: string, quote: string, id: number | null, source = 1) {
  return JSON.stringify({
    summary: text,
    changes: [{ id, kind: "decision", status: "active", text, quotes: [{ source, quote }] }],
    ...(id !== null && { unchanged: [] }),
  });
}

const setup = (
  run: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>,
  grant = true,
  lines = [monday, friday],
) => startLiveAgentMeeting(run, grant, lines);

test("the first summary covers both confirmed lines of a short call in one request", async () => {
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async () =>
    launchReply("Launch on Friday.", friday, null, 2),
  );
  const { core, meeting, push, summary } = await setup(run);
  try {
    push(4500);
    await until(core, meeting.id, (state) => state.lines >= 2);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({
        state: "ready",
        text: "Launch on Friday.",
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.lastCall?.[0].prompt).toContain(monday);
    expect(run.mock.lastCall?.[0].prompt).toContain(friday);
  } finally {
    core.close();
  }
});

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
          quotes: [{ source: 1, quote: closing ? friday : "the launch is on Monday" }],
        },
        ...(closing
          ? []
          : [
              {
                id: null,
                kind: "action",
                status: "cancelled",
                text: withdrawn,
                quotes: [{ source: 1, quote: withdrawn }],
              },
            ]),
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
  const action = (text: string, source: number) => ({
    id: null,
    kind: "action",
    status: "active",
    text,
    quotes: [{ source, quote: text }],
  });
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) => {
    const { utterances } = JSON.parse(prompt) as {
      utterances: { line: number; text: string }[];
    };
    const quoteLine = utterances.find((entry) => entry.text.includes(quoteAction));
    const next = utterances.find((entry) => entry.text.includes(cartonAction));
    return JSON.stringify({
      summary: next ? "The departments will prepare carton counts." : "Lee will compare quotes.",
      changes:
        next && quoteLine
          ? [action(quoteAction, quoteLine.line), action(cartonAction, next.line)]
          : [action(quoteAction, quoteLine?.line ?? 1)],
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

test("restoring access while a stopped meeting's cancelled request settles waits for Retry", async () => {
  const cancelled = Promise.withResolvers<string>();
  const answer = launchReply("Launch on Monday.", monday, null);
  const run = vi
    .fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>()
    .mockImplementationOnce(() => cancelled.promise)
    .mockResolvedValue(answer);
  const { core, pairing, meeting, push, summary } = await setup(run);
  try {
    push(2500);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (state) => state.state === "saved");
    await core.updateAgent(pairing.id, { folderIds: [] });
    expect(run.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await core.updateAgent(pairing.id, { folderIds: pairing.folderIds });
    cancelled.resolve(answer);
    await new Promise<void>((done) => setImmediate(done));
    expect((await summary())?.state).toBe("failed");
    expect(run).toHaveBeenCalledTimes(1);
    await core.retryMeetingSummary(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    cancelled.resolve(answer);
    core.close();
  }
});

test.each([
  { change: "switch", hasNewSpeech: false },
  { change: "switch", hasNewSpeech: true },
  { change: "revoke and restore", hasNewSpeech: true },
])(
  "while Stop saves the Transcript ($change, new speech: $hasNewSpeech)",
  async ({ change, hasNewSpeech }) => {
    const finished = Promise.withResolvers<void>();
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) =>
      prompt.includes(friday)
        ? launchReply("Launch on Friday.", friday, 1)
        : launchReply("Launch on Monday.", monday, null),
    );
    const { core, pairing, adapters, meeting, push, summary } = await startLiveAgentMeeting(
      run,
      true,
      hasNewSpeech ? [monday, friday] : [monday],
      "claude-code",
    );
    const finish = adapters.transcriber.finish.bind(adapters.transcriber);
    vi.spyOn(adapters.transcriber, "finish").mockImplementation(async (stream) => {
      await finished.promise;
      await finish(stream);
    });
    try {
      const { pairing: codex } = await core.connectAgent({
        client: "codex",
        name: "Other AI",
        folderIds: pairing.folderIds,
      });
      push(2500);
      await vi.waitFor(async () => expect((await summary())?.text).toBe("Launch on Monday."));
      const warm = await summary();
      if (hasNewSpeech) {
        push(2000);
        await until(core, meeting.id, (state) => state.lines === 2);
      }
      const atStop = await core.stopMeeting(meeting.id);
      expect(atStop.transcript?.state).toBe("finishing");
      expect(atStop.summary).toEqual(warm);
      if (change === "switch") {
        await core.updateSettings({ user: { language: "zh-CN" } });
        await core.updateSettings({ device: { meetingNotesAgentId: codex.id } });
        await core.updateSettings({ device: { meetingSummaryRoute: codex.id } });
      } else {
        await core.updateAgent(pairing.id, { folderIds: [] });
        await vi.waitFor(async () => {
          const available = await core.listAgentsToAsk(meeting.mindId);
          expect(available.some((agent) => agent.id === pairing.id)).toBe(false);
        });
        await core.updateAgent(pairing.id, { folderIds: pairing.folderIds });
      }
      finished.resolve();
      await until(core, meeting.id, (state) => state.state === "saved");
      await new Promise<void>((done) => setImmediate(done));

      const final = await vi.waitFor(async () => {
        const value = await summary();
        expect(value).toMatchObject({ ...warm, state: hasNewSpeech ? "failed" : "ready" });
        return value;
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0].client).toBe("claude-code");
      if (hasNewSpeech) {
        expect(final?.retryAgentId).toBe(pairing.id);
        if (change === "switch") {
          await expect(core.retryMeetingSummary(meeting.id)).rejects.toThrow();
          await core.updateSettings({
            device: { meetingNotesAgentId: pairing.id, meetingSummaryRoute: pairing.id },
          });
        }
        expect((await summary())?.state).toBe("failed");
        expect(run).toHaveBeenCalledTimes(1);
        await core.retryMeetingSummary(meeting.id);
        await vi.waitFor(async () =>
          expect(await summary()).toMatchObject({ state: "ready", text: "Launch on Friday." }),
        );
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.lastCall?.[0].client).toBe("claude-code");
      } else {
        expect(final?.retryAgentId).toBeUndefined();
      }
    } finally {
      finished.resolve();
      core.close();
    }
  },
);

test("sharing a stopped meeting after a refusal lets its owner choose when to retry", async () => {
  const run = vi.fn(async () => launchReply("Launch on Monday.", monday, null));
  const { core, pairing, meeting, push, summary } = await setup(run);
  try {
    await core.updateAgent(pairing.id, { folderIds: [] });
    push(2500);
    await until(core, meeting.id, (state) => state.lines > 0);
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (state) => state.state === "saved");
    await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
    await core.updateAgent(pairing.id, { folderIds: pairing.folderIds });
    expect(await core.listAgentsToAsk(meeting.mindId)).toContainEqual(
      expect.objectContaining({ id: pairing.id }),
    );
    expect(run).not.toHaveBeenCalled();
    await core.retryMeetingSummary(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
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
      ? launchReply("Unrelated Friday decision.", friday, null, 2)
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

// protects=a call's summary finished at Stop goes on with the lines a Resume brings, from where it was, and is ready again once the next Stop's Transcript is saved (#3762); fails_when=it stays as the first Stop left it, or is made again from nothing; no_claim=the summary's wording.
test("a call resumed after Stop has its summary go on with the new lines", async () => {
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) => {
    const { utterances } = JSON.parse(prompt) as {
      utterances: { line: number; text: string }[];
    };
    const revised = utterances.find((entry) => entry.text.includes(friday));
    return revised
      ? launchReply("Launch on Friday.", friday, 1, revised.line)
      : launchReply("Launch on Monday.", monday, null);
  });
  const { core, meeting, push, summary } = await setup(run);
  try {
    push(2500);
    await until(core, meeting.id, (state) => state.lines >= 1);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({ state: "ready", text: "Launch on Monday." }),
    );

    expect((await core.resumeMeeting(meeting.id)).summary).toMatchObject({
      state: "updating",
      text: "Launch on Monday.",
    });
    push(4500);
    await until(core, meeting.id, (state) => state.lines >= 3);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () =>
      expect(await summary()).toMatchObject({ state: "ready", text: "Launch on Friday." }),
    );
    const last = run.mock.lastCall?.[0].prompt ?? "";
    expect(last).toContain(friday);
    expect(last).toContain("Launch on Monday.");
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

const zhOpening = "北桥项目的内审定于周二。由陈琳发出议程。唐敏周五清点门卡。";
const zhCancel =
  "取消周二的北桥项目内审和原议程。北桥项目内审最终改到周四，周二不举行。由陈琳向所有参会人确认这一改动。";
const zhUnrelated = "办公室门禁读卡器偶尔会重复刷卡，目前先观察，不作决定。";

const zhOpeningReply = JSON.stringify({
  summary: "北桥项目内审定于周二，陈琳负责发议程，唐敏周五清点门卡。",
  changes: [
    {
      id: null,
      kind: "decision",
      status: "active",
      text: "北桥项目的内审定于周二。",
      quotes: [{ source: 1, quote: "北桥项目的内审定于周二。" }],
    },
    {
      id: null,
      kind: "action",
      status: "active",
      text: "陈琳发出议程。",
      quotes: [{ source: 1, quote: "由陈琳发出议程。" }],
    },
    {
      id: null,
      kind: "action",
      status: "active",
      text: "唐敏周五清点门卡。",
      quotes: [{ source: 1, quote: "唐敏周五清点门卡。" }],
    },
  ],
});

const zhReconciledCancelReply = JSON.stringify({
  summary: "北桥项目内审改到周四，原议程已取消，陈琳向所有参会人确认这一改动。",
  changes: [
    {
      id: 1,
      kind: "decision",
      status: "active",
      text: "北桥项目内审改到周四，周二不举行。",
      quotes: [{ source: 1, quote: "北桥项目内审最终改到周四，周二不举行。" }],
    },
    {
      id: 2,
      kind: "action",
      status: "cancelled",
      text: "陈琳发出原议程（已取消）。",
      quotes: [{ source: 1, quote: "取消周二的北桥项目内审和原议程。" }],
    },
    {
      id: null,
      kind: "action",
      status: "active",
      text: "陈琳向所有参会人确认内审改到周四。",
      quotes: [{ source: 1, quote: "由陈琳向所有参会人确认这一改动。" }],
    },
  ],
  unchanged: [3],
});

// Simulates the #3472 failure when active-item reconciliation is omitted from instructions.
const zhUnreconciledCancelReply = JSON.stringify({
  summary: "北桥项目内审改到周四，原议程已取消，陈琳向所有参会人确认这一改动。",
  changes: [
    {
      id: 1,
      kind: "decision",
      status: "active",
      text: "北桥项目内审改到周四，周二不举行。",
      quotes: [{ source: 1, quote: "北桥项目内审最终改到周四，周二不举行。" }],
    },
    {
      id: null,
      kind: "action",
      status: "active",
      text: "陈琳向所有参会人确认内审改到周四。",
      quotes: [{ source: 1, quote: "由陈琳向所有参会人确认这一改动。" }],
    },
  ],
});

const asksForReconciliation = (instructions?: string) =>
  !!instructions?.includes("unchanged (an array of numeric IDs)") &&
  !!instructions?.includes("When a deliverable is explicitly withdrawn");

async function startTimedMeeting(
  run: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>,
  lines: string[],
) {
  const dir = await createTempDataFolder();
  const { core, capture, clock, record } = await transcribingCore(dir, {
    engine: { lines, maxSpeechMs: 3000 },
    adapters: { agents: await agentsAdapter(dir), summarizeWithMeetingAgent: run },
  });
  const folder = await core.createLibraryGroup({ name: "Audit", description: "" });
  await core.setAgentsEnabled(true);
  const { pairing } = await core.connectAgent({
    name: "Codex",
    client: "codex",
    folderIds: [folder.id],
  });
  await core.updateSettings({
    device: {
      meetingNoticeAccepted: true,
      meetingNotesAgentId: pairing.id,
      meetingSummaryRoute: pairing.id,
    },
  });
  const meeting = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  const speakTurn = async (afterInterval: boolean) => {
    if (afterInterval) {
      for (let gap = 0; gap < 60_000; gap += 5_000) {
        clock.advance(5_000);
        capture.push("microphone", 5_000, true);
        await nextTurn();
        await nextTurn();
      }
    }
    record(2_000, ["microphone"]);
    clock.advance(1_000);
    capture.push("microphone", 1_000, true);
  };
  const summary = async () => (await core.listMeetings()).find((m) => m.id === meeting.id)?.summary;
  return { core, meeting, speakTurn, summary };
}

// protects=every cancellation timing sends active-item reconciliation and enforces unchanged accounting so no withdrawn action stays open after Stop (#3472)
// fails_when=before-stop or in-flight-at-stop runs without active-item review, makes extra calls, or leaves the agenda action active
test.each(["before-stop", "in-flight-at-stop", "after-stop"] as const)(
  "reconciles a withdrawn action regardless of Stop timing (%s) (#3472)",
  async (timing) => {
    const hold = timing === "in-flight-at-stop" ? Promise.withResolvers<void>() : null;
    let cancelStarted = false;
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
      async ({ instructions, prompt }) => {
        if (!prompt.includes(zhCancel)) return zhOpeningReply;
        cancelStarted = true;
        if (hold) await hold.promise;
        return asksForReconciliation(instructions)
          ? zhReconciledCancelReply
          : zhUnreconciledCancelReply;
      },
    );
    const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
      zhOpening,
      zhCancel,
    ]);
    try {
      await speakTurn(false);
      await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(3));
      const warm = await summary();
      if (timing === "after-stop") {
        await speakTurn(false);
        await until(core, meeting.id, (state) => state.lines >= 2);
      } else {
        await speakTurn(true);
        await until(core, meeting.id, (state) => state.lines >= 2);
        if (timing === "before-stop") {
          await vi.waitFor(async () =>
            expect((await summary())?.throughMs).toBeGreaterThan(warm?.throughMs ?? 0),
          );
        } else {
          await vi.waitFor(() => expect(cancelStarted).toBe(true));
        }
      }

      const atStop = await core.stopMeeting(meeting.id);
      expect(atStop.summary?.text).toBeTruthy();
      if (hold) {
        await until(core, meeting.id, (state) => state.state === "saved");
        hold.resolve();
      }
      await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
      expect(await summary()).toMatchObject({
        state: "ready",
        items: [
          { id: 1, kind: "decision", status: "active", text: expect.stringContaining("周四") },
          { id: 2, kind: "action", status: "cancelled" },
          { id: 3, kind: "action", status: "active", text: "唐敏周五清点门卡。" },
          { id: 4, kind: "action", status: "active", text: expect.stringContaining("陈琳") },
        ],
      });
      expect(run).toHaveBeenCalledTimes(2);
      expect(asksForReconciliation(run.mock.calls[1]?.[0].instructions)).toBe(true);
      const sources = await core.getMeetingSummaryItemSources(meeting.id, 2);
      expect(sources?.sources.map((source) => source.text)).toEqual([
        "由陈琳发出议程。",
        "取消周二的北桥项目内审和原议程。",
      ]);
    } finally {
      hold?.resolve();
      core.close();
    }
  },
);

test("a live cancellation followed by unrelated speech cancels the action while its quote is in view (#3472)", async () => {
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
    async ({ instructions, prompt }) => {
      if (prompt.includes(zhCancel)) {
        return asksForReconciliation(instructions)
          ? zhReconciledCancelReply
          : zhUnreconciledCancelReply;
      }
      if (prompt.includes(zhUnrelated)) {
        return JSON.stringify({
          summary: "北桥项目内审改到周四，原议程已取消，读卡器问题继续观察。",
          changes: [],
          unchanged: [1, 3, 4],
        });
      }
      return zhOpeningReply;
    },
  );
  const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
    zhOpening,
    zhCancel,
    zhUnrelated,
  ]);
  try {
    await speakTurn(false);
    await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(3));
    await speakTurn(true);
    await vi.waitFor(async () =>
      expect((await summary())?.items?.find((item) => item.id === 2)?.status).toBe("cancelled"),
    );
    await speakTurn(false);
    await until(core, meeting.id, (state) => state.lines >= 3);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    expect((await summary())?.items).toMatchObject([
      { id: 1, status: "active" },
      { id: 2, status: "cancelled" },
      { id: 3, status: "active" },
      { id: 4, status: "active" },
    ]);
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    core.close();
  }
});

test("a long meeting split across multiple Stop batches reconciles a cancellation in an earlier batch (#3472)", async () => {
  const filler = `无关背景说明：${"各部门同步了常规进展，暂无新增决定。".repeat(360)}`;
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
    async ({ instructions, prompt }) => {
      if (prompt.includes(zhCancel)) {
        return asksForReconciliation(instructions)
          ? zhReconciledCancelReply
          : zhUnreconciledCancelReply;
      }
      if (prompt.includes("无关背景说明")) {
        return JSON.stringify({
          summary: "北桥项目内审改到周四，原议程已取消，其余部门同步了常规进展。",
          changes: [],
          unchanged: [1, 3, 4],
        });
      }
      return zhOpeningReply;
    },
  );
  const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
    zhOpening,
    zhCancel,
    filler,
    filler,
    filler,
  ]);
  try {
    await speakTurn(false);
    await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(3));
    // All remaining turns arrive within 60s so Stop splits them across at least two 12,000-char batches.
    for (let i = 0; i < 4; i++) await speakTurn(false);
    await until(core, meeting.id, (state) => state.lines >= 5);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
    const batchWithCancel = run.mock.calls.find(([req]) => req.prompt.includes(zhCancel));
    expect(asksForReconciliation(batchWithCancel?.[0].instructions)).toBe(true);
    expect((await summary())?.items).toMatchObject([
      { id: 1, status: "active" },
      { id: 2, status: "cancelled" },
      { id: 3, status: "active" },
      { id: 4, status: "active" },
    ]);
  } finally {
    core.close();
  }
});

test("a cancellation processed live after resuming a stopped meeting is reconciled before the second Stop (#3472)", async () => {
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
    async ({ instructions, prompt }) => {
      if (!prompt.includes(zhCancel)) return zhOpeningReply;
      return asksForReconciliation(instructions)
        ? zhReconciledCancelReply
        : zhUnreconciledCancelReply;
    },
  );
  const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [zhOpening, zhCancel]);
  try {
    await speakTurn(false);
    await until(core, meeting.id, (state) => state.lines >= 1);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));

    await core.resumeMeeting(meeting.id);
    await speakTurn(true);
    await vi.waitFor(async () =>
      expect((await summary())?.items?.find((item) => item.id === 2)?.status).toBe("cancelled"),
    );
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    expect((await summary())?.items).toMatchObject([
      { id: 1, status: "active" },
      { id: 2, status: "cancelled" },
      { id: 3, status: "active" },
      { id: 4, status: "active" },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    core.close();
  }
});

test.each(["before-stop", "in-flight-at-stop"] as const)(
  "rejects a live reply that omits an active item, keeps the warm overview, and recovers at Stop (%s) (#3472)",
  async (timing) => {
    const hold = timing === "in-flight-at-stop" ? Promise.withResolvers<void>() : null;
    let cancelCalls = 0;
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
      async ({ prompt }) => {
        if (!prompt.includes(zhCancel)) return zhOpeningReply;
        cancelCalls++;
        if (cancelCalls === 1) {
          if (hold) await hold.promise;
          return zhUnreconciledCancelReply;
        }
        return zhReconciledCancelReply;
      },
    );
    const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
      zhOpening,
      zhCancel,
    ]);
    try {
      await speakTurn(false);
      await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(3));
      const warmText = (await summary())?.text;
      await speakTurn(true);
      await until(core, meeting.id, (state) => state.lines >= 2);
      if (timing === "before-stop") {
        await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
        expect((await summary())?.text).toBe(warmText);
      } else {
        await vi.waitFor(() => expect(cancelCalls).toBe(1));
      }

      const atStop = await core.stopMeeting(meeting.id);
      expect(atStop.summary?.text).toBe(warmText);
      if (hold) {
        await until(core, meeting.id, (state) => state.state === "saved");
        hold.resolve();
      }
      await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
      expect((await summary())?.items?.find((item) => item.id === 2)?.status).toBe("cancelled");
      expect(cancelCalls).toBe(2);
    } finally {
      hold?.resolve();
      core.close();
    }
  },
);

test("when every attempt omits an active item, the meeting stays retryable instead of ready with an open action (#3472)", async () => {
  let fixed = false;
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async ({ prompt }) => {
    if (!prompt.includes(zhCancel)) return zhOpeningReply;
    return fixed ? zhReconciledCancelReply : zhUnreconciledCancelReply;
  });
  const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [zhOpening, zhCancel]);
  try {
    await speakTurn(false);
    await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(3));
    await speakTurn(true);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (state) => state.state === "saved");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect((await summary())?.state).toBe("failed");

    fixed = true;
    await core.retryMeetingSummary(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    expect((await summary())?.items?.find((item) => item.id === 2)?.status).toBe("cancelled");
  } finally {
    core.close();
  }
});

test("once all prior items are closed, later updates return to the two-key contract (#3472)", async () => {
  const openAction = "Avery will send the agenda.";
  const cancelAction = "Cancel the agenda; nobody needs to send it.";
  const tail = "Thanks everyone, see you next week.";
  const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
    async ({ instructions, prompt }) => {
      if (prompt.includes(cancelAction)) {
        expect(asksForReconciliation(instructions)).toBe(true);
        return JSON.stringify({
          summary: "The agenda was cancelled.",
          changes: [
            {
              id: 1,
              kind: "action",
              status: "cancelled",
              text: "Agenda cancelled.",
              quotes: [{ source: 1, quote: "Cancel the agenda" }],
            },
          ],
          unchanged: [],
        });
      }
      if (prompt.includes(tail)) {
        expect(instructions).toContain("two keys");
        return JSON.stringify({ summary: "The agenda was cancelled.", changes: [] });
      }
      return JSON.stringify({
        summary: "Avery will send the agenda.",
        changes: [
          {
            id: null,
            kind: "action",
            status: "active",
            text: openAction,
            quotes: [{ source: 1, quote: openAction }],
          },
        ],
      });
    },
  );
  const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
    openAction,
    cancelAction,
    tail,
  ]);
  try {
    await speakTurn(false);
    await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(1));
    await speakTurn(true);
    await vi.waitFor(async () => expect((await summary())?.items?.[0]?.status).toBe("cancelled"));
    await speakTurn(false);
    await until(core, meeting.id, (state) => state.lines >= 3);
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
    expect((await summary())?.items).toEqual([
      { id: 1, kind: "action", status: "cancelled", text: "Agenda cancelled." },
    ]);
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    core.close();
  }
});

test.each([
  {
    name: "English",
    promptLine: "Could every team report how many crates it needs?",
    uptake: "We will go back and count them.",
    budget: "That will let us finalize the budget.",
    repeat: "We will go back and count them.",
    summaryText: "Each team will count how many crates it needs.",
    firstAction: "Each team will count and report how many crates it needs.",
    secondAction: "Finalize the budget from the counts.",
  },
  {
    name: "Chinese",
    promptLine: "各组能不能报一下需要多少个箱子？",
    uptake: "我们回去数一下。",
    budget: "这样就能定下预算。",
    repeat: "我们回去数一下。",
    summaryText: "各组将回去统计所需箱子数量并据此定下预算。",
    firstAction: "各组回去统计并上报所需箱子数量。",
    secondAction: "根据各组箱子数量定下预算。",
  },
])(
  "a multi-turn $name commitment with two numbered excerpts resolves repeated confirmations to their exact turns (#3472)",
  async ({ promptLine, uptake, budget, repeat, summaryText, firstAction, secondAction }) => {
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(async () =>
      JSON.stringify({
        summary: summaryText,
        changes: [
          {
            id: null,
            kind: "action",
            status: "active",
            text: firstAction,
            quotes: [
              { source: 1, quote: promptLine },
              { source: 2, quote: uptake },
            ],
          },
          {
            id: null,
            kind: "action",
            status: "active",
            text: secondAction,
            quotes: [
              { source: 3, quote: budget },
              { source: 4, quote: repeat },
            ],
          },
        ],
      }),
    );
    const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
      promptLine,
      uptake,
      budget,
      repeat,
    ]);
    try {
      for (let i = 0; i < 4; i++) await speakTurn(false);
      await until(core, meeting.id, (state) => state.lines >= 4);
      await core.stopMeeting(meeting.id);
      await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
      const crateSources = await core.getMeetingSummaryItemSources(meeting.id, 1);
      expect(crateSources?.sources.map((source) => source.text)).toEqual([promptLine, uptake]);
      expect(crateSources?.sources[1]?.startMs).toBeGreaterThan(
        crateSources?.sources[0]?.startMs ?? 0,
      );
      const budgetSources = await core.getMeetingSummaryItemSources(meeting.id, 2);
      expect(budgetSources?.sources.map((source) => source.text)).toEqual([budget, repeat]);
      expect(budgetSources?.sources[1]?.startMs).toBeGreaterThan(
        crateSources?.sources[1]?.startMs ?? 0,
      );
    } finally {
      core.close();
    }
  },
);

test.each([
  {
    name: "English (stitched)",
    opening: "Northbridge review is scheduled for Tuesday.",
    request: "Can each team report how many crates it needs?",
    confirm: "Yes, we will count them back at the office.",
    followUpSummary: "Teams will count required crates.",
    followUpText: "Each team will count required crates.",
    badQuotes: (request: string, confirm: string) => [
      { source: 1, quote: `${request} ${confirm}` },
    ],
  },
  {
    name: "Chinese (stitched)",
    opening: "北桥项目复盘定在周二。",
    request: "各组能报一下需要多少个箱子吗？",
    confirm: "可以，我们回办公室数一下。",
    followUpSummary: "各组将统计所需箱子数量。",
    followUpText: "各组回办公室统计所需箱子数量。",
    badQuotes: (request: string, confirm: string) => [{ source: 1, quote: `${request}${confirm}` }],
  },
  {
    name: "English (wrong source)",
    opening: "Northbridge review is scheduled for Tuesday.",
    request: "Can each team report how many crates it needs?",
    confirm: "Yes, we will count them back at the office.",
    followUpSummary: "Teams will count required crates.",
    followUpText: "Each team will count required crates.",
    badQuotes: (request: string, confirm: string) => [
      { source: 2, quote: request },
      { source: 2, quote: confirm },
    ],
  },
  {
    name: "Chinese (wrong source)",
    opening: "北桥项目复盘定在周二。",
    request: "各组能报一下需要多少个箱子吗？",
    confirm: "可以，我们回办公室数一下。",
    followUpSummary: "各组将统计所需箱子数量。",
    followUpText: "各组回办公室统计所需箱子数量。",
    badQuotes: (request: string, confirm: string) => [
      { source: 2, quote: request },
      { source: 2, quote: confirm },
    ],
  },
])(
  "an invalid numbered excerpt is rejected atomically while preserving the warm summary for recovery at Stop: $name (#3472)",
  async ({ opening, request, confirm, followUpSummary, followUpText, badQuotes }) => {
    let followUpCalls = 0;
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
      async ({ prompt }) => {
        if (!prompt.includes(request)) {
          return JSON.stringify({
            summary: opening,
            changes: [
              {
                id: null,
                kind: "decision",
                status: "active",
                text: opening,
                quotes: [{ source: 1, quote: opening }],
              },
            ],
          });
        }
        followUpCalls++;
        return JSON.stringify({
          summary: followUpSummary,
          changes: [
            {
              id: null,
              kind: "action",
              status: "active",
              text: followUpText,
              quotes:
                followUpCalls === 1
                  ? badQuotes(request, confirm)
                  : [
                      { source: 1, quote: request },
                      { source: 2, quote: confirm },
                    ],
            },
          ],
          unchanged: [1],
        });
      },
    );
    const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
      opening,
      request,
      confirm,
    ]);
    try {
      await speakTurn(false);
      await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(1));
      await speakTurn(true);
      await speakTurn(false);
      await until(core, meeting.id, (state) => state.lines >= 3);
      await vi.waitFor(async () => expect((await summary())?.state).toBe("failed"));
      expect((await summary())?.text).toBe(opening);

      await core.stopMeeting(meeting.id);
      await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
      expect((await summary())?.items).toHaveLength(2);
      const sources = await core.getMeetingSummaryItemSources(meeting.id, 2);
      expect(sources?.sources.map((source) => source.text)).toEqual([request, confirm]);
      expect(followUpCalls).toBe(2);
    } finally {
      core.close();
    }
  },
);

test.each([
  {
    name: "English to Chinese",
    firstLine: "We agreed to ship the release on Friday.",
    firstItem: "Ship the release on Friday.",
    secondLine: "下面我们改用中文讨论。由陈琳在周四前通知所有客户。",
    secondOverview: "发布会定在周五，陈琳将在周四前通知所有客户。",
    secondItem: "陈琳在周四前通知所有客户。",
    expectedSecondLanguage: "Chinese",
  },
  {
    name: "Chinese to English",
    firstLine: "大家决定本周五正式发版。",
    firstItem: "本周五正式发版。",
    secondLine: "Let us switch to English now. Maya will notify all customers by Thursday.",
    secondOverview: "The release ships on Friday and Maya will notify all customers by Thursday.",
    secondItem: "Maya will notify all customers by Thursday.",
    expectedSecondLanguage: "English",
  },
])(
  "a mid-meeting language switch ($name) updates the overview and new items without rewriting prior items (#3472)",
  async ({
    firstLine,
    firstItem,
    secondLine,
    secondOverview,
    secondItem,
    expectedSecondLanguage,
  }) => {
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
      async ({ prompt }) => {
        if (!prompt.includes(secondLine)) {
          return JSON.stringify({
            summary: firstItem,
            changes: [
              {
                id: null,
                kind: "decision",
                status: "active",
                text: firstItem,
                quotes: [{ source: 1, quote: firstLine }],
              },
            ],
          });
        }
        return JSON.stringify({
          summary: secondOverview,
          changes: [
            {
              id: null,
              kind: "action",
              status: "active",
              text: secondItem,
              quotes: [{ source: 1, quote: secondLine }],
            },
          ],
          unchanged: [1],
        });
      },
    );
    const { core, meeting, speakTurn, summary } = await startTimedMeeting(run, [
      firstLine,
      secondLine,
    ]);
    try {
      await speakTurn(false);
      await vi.waitFor(async () => expect((await summary())?.items).toHaveLength(1));
      await speakTurn(true);
      await until(core, meeting.id, (state) => state.lines >= 2);
      await core.stopMeeting(meeting.id);
      await vi.waitFor(async () => expect((await summary())?.state).toBe("ready"));
      expect(await summary()).toMatchObject({
        state: "ready",
        text: secondOverview,
        items: [
          { id: 1, kind: "decision", status: "active", text: firstItem },
          { id: 2, kind: "action", status: "active", text: secondItem },
        ],
      });
      const secondCall = run.mock.calls[1]?.[0];
      expect(JSON.parse(secondCall?.prompt ?? "")).toHaveProperty(
        "language",
        expectedSecondLanguage,
      );
      expect(secondCall?.instructions).toContain(
        `Write summary and any newly added items in ${expectedSecondLanguage}`,
      );
      expect((await core.getMeetingSummaryItemSources(meeting.id, 1))?.sources[0]?.text).toBe(
        firstLine,
      );
      expect((await core.getMeetingSummaryItemSources(meeting.id, 2))?.sources[0]?.text).toBe(
        secondLine,
      );
    } finally {
      core.close();
    }
  },
);

test.each([
  {
    name: "English",
    myLine: "I will send the updated contract by Friday.",
    theirLine: "I will confirm the invoice on Monday.",
    summaryText:
      "Me will send the updated contract by Friday and Them will confirm the invoice on Monday.",
    myAction: "Me will send the updated contract by Friday.",
    theirAction: "Them will confirm the invoice on Monday.",
  },
  {
    name: "Chinese",
    myLine: "我周五前把更新后的合同发过去。",
    theirLine: "我周一确认发票金额。",
    summaryText: "我将在周五前发送更新后的合同，对方将在周一确认发票金额。",
    myAction: "我周五前发送更新后的合同。",
    theirAction: "对方周一确认发票金额。",
  },
])(
  "a call-style $name meeting preserves Me and Them speaker labels and resolves numbered sources (#3472)",
  async ({ myLine, theirLine, summaryText, myAction, theirAction }) => {
    const run = vi.fn<NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>>(
      async ({ prompt }) => {
        const { utterances } = JSON.parse(prompt) as {
          utterances: { line: number; speaker: string | null; text: string }[];
        };
        const mine = utterances.find((entry) => entry.text === myLine);
        const theirs = utterances.find((entry) => entry.text === theirLine);
        return JSON.stringify({
          summary: summaryText,
          changes: [
            ...(mine
              ? [
                  {
                    id: null,
                    kind: "action",
                    status: "active",
                    text: myAction,
                    quotes: [{ source: mine.line, quote: myLine }],
                  },
                ]
              : []),
            ...(theirs
              ? [
                  {
                    id: null,
                    kind: "action",
                    status: "active",
                    text: theirAction,
                    quotes: [{ source: theirs.line, quote: theirLine }],
                  },
                ]
              : []),
          ],
        });
      },
    );
    const dir = await createTempDataFolder();
    const { core, capture, clock, record } = await transcribingCore(dir, {
      engine: { lines: [myLine], theirLines: [theirLine], maxSpeechMs: 3000 },
      adapters: { agents: await agentsAdapter(dir), summarizeWithMeetingAgent: run },
    });
    try {
      const folder = await core.createLibraryGroup({ name: "Call", description: "" });
      await core.setAgentsEnabled(true);
      const { pairing } = await core.connectAgent({
        name: "Codex",
        client: "codex",
        folderIds: [folder.id],
      });
      await core.updateSettings({
        device: {
          meetingNoticeAccepted: true,
          meetingNotesAgentId: pairing.id,
          meetingSummaryRoute: pairing.id,
        },
      });
      const meeting = await core.createMeeting({ folderId: folder.id });
      await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
      record(2_000, ["microphone"]);
      clock.advance(1_000);
      capture.push("microphone", 1_000, true);
      record(2_000, ["system"]);
      clock.advance(1_000);
      capture.push("system", 1_000, true);
      await until(core, meeting.id, (state) => state.lines >= 2);
      await core.stopMeeting(meeting.id);
      await vi.waitFor(async () =>
        expect(
          (await core.listMeetings()).find((item) => item.id === meeting.id)?.summary?.state,
        ).toBe("ready"),
      );
      const sent = JSON.parse(run.mock.calls[0]?.[0].prompt ?? "") as {
        utterances: { line: number; speaker: string | null; text: string }[];
      };
      expect(sent.utterances).toEqual([
        { line: 1, text: myLine, speaker: "Me" },
        { line: 2, text: theirLine, speaker: "Them" },
      ]);
      expect(run.mock.calls[0]?.[0].instructions).toContain(
        "In call transcripts labelled Me and Them, preserve who owns a commitment (Me vs. Them) in the output language.",
      );
      expect(
        (await core.listMeetings()).find((item) => item.id === meeting.id)?.summary?.items,
      ).toEqual([
        { id: 1, kind: "action", status: "active", text: myAction },
        { id: 2, kind: "action", status: "active", text: theirAction },
      ]);
      expect((await core.getMeetingSummaryItemSources(meeting.id, 1))?.sources[0]?.text).toBe(
        myLine,
      );
      expect((await core.getMeetingSummaryItemSources(meeting.id, 2))?.sources[0]?.text).toBe(
        theirLine,
      );
    } finally {
      core.close();
    }
  },
);
