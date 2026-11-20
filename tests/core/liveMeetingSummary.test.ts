import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { CoreAdapters } from "../../src/core/adapters";
import { TranslatableError } from "../../src/core/errors";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { openDatabase } from "../../src/core/storage";
import { createFakeCloud } from "../../src/core/transcription/fakeCloud";
import { agentsAdapter } from "../helpers/agents";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const monday = "The launch is on Monday.";
const friday = "Correction, the launch is on Friday.";

function launchReply(text: string, quote: string, id: number | null) {
  return JSON.stringify({
    summary: text,
    changes: [{ id, kind: "decision", status: "active", text, quote }],
  });
}

async function setup(run: NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>, grant = true) {
  const dir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const { transcriber } = inProcessTranscriber(
    {},
    undefined,
    createFakeCloud({ voices: 1, lines: [monday, friday] }),
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
    expect(run).toHaveBeenCalledTimes(count);
  } finally {
    next.close();
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
