import { expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { wavSamples } from "../../src/core/meetings/fakeCapture";
import type { CloudConnect } from "../../src/core/transcription/cloud/socket";
import { clockTime } from "../../src/shared/clock";
import { speakerOf, withSpeakerChosen } from "../../src/shared/speakers";
import { citationOf, mindCitations } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { savedCues, stoppedMeeting, transcribingCore, until } from "../helpers/transcription";

const FILE_ID = "23eff26c-91de-4f9f-ac46-5e69099def33";
const JOB_ID = "a47825e2-2fe8-4e0f-b970-b89735e7c72f";
const COMPUTER = 2345;
const MICROPHONE = 6789;
const RECORDING_MS = 12_000;
const SONIOX = "https://stt-rt.soniox.com";

const remoteLines = [
  "The review starts on Tuesday.",
  "I sent the updated budget.",
  "The dispatch pickup comes first.",
  "We still need the door code.",
  "I will ring the courier.",
].map((text, index) => ({
  text,
  start_ms: 200 + index * 2_100,
  end_ms: 1_500 + index * 2_100,
  speaker: index < 3 ? "1" : "2",
  is_final: true,
}));

function liveSoniox() {
  const streams: { sample: number; hear(message: object): void }[] = [];
  const cloud: CloudConnect = (_url, _key, events) => {
    const stream = {
      sample: 0,
      hear: (message: object) => events.message(JSON.stringify(message)),
    };
    streams.push(stream);
    queueMicrotask(() => events.open());
    return {
      send(data) {
        if (data === "") {
          stream.hear({ finished: true, final_audio_proc_ms: RECORDING_MS });
        } else if (typeof data !== "string" && data.byteLength >= 2 && !stream.sample) {
          stream.sample = new DataView(data.buffer, data.byteOffset).getInt16(0, true);
        }
      },
      close() {},
    };
  };
  return { cloud, streams };
}

function asyncSoniox({
  holdTranscript = false,
  holdDeletion,
  submit,
}: {
  holdTranscript?: boolean;
  holdDeletion?: Promise<void>;
  submit?: "lost" | "refused";
}) {
  const calls: string[] = [];
  const uploads: Int16Array[] = [];
  const fetchingTranscript = Promise.withResolvers<void>();
  const deleting = Promise.withResolvers<void>();
  let read = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.soniox.com");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "DELETE") {
      deleting.resolve();
      await holdDeletion;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/files") {
      if (!(init?.body instanceof FormData)) throw new Error("Audio must be a file upload.");
      expect([...init.body.keys()].sort()).toEqual(["client_reference_id", "file"]);
      const file = init.body.get("file");
      if (!(file instanceof Blob)) throw new Error("No audio was uploaded.");
      uploads.push(wavSamples(new Uint8Array(await file.arrayBuffer())));
      return Response.json({ id: FILE_ID }, { status: 201 });
    }
    if (url.pathname === "/v1/transcriptions") {
      if (init?.method !== "POST") return Response.json({ transcriptions: [] });
      if (submit === "lost") throw new Error("The response to the submission was lost.");
      if (submit === "refused") return new Response(null, { status: 402 });
      return Response.json({ id: JOB_ID, file_id: FILE_ID }, { status: 201 });
    }
    if (url.pathname === `/v1/transcriptions/${JOB_ID}`) {
      return Response.json({ id: JOB_ID, status: "completed" });
    }
    if (url.pathname !== `/v1/transcriptions/${JOB_ID}/transcript`) {
      throw new Error("Unexpected Soniox request.");
    }
    fetchingTranscript.resolve();
    if (holdTranscript && !read) {
      read = true;
      const signal = init?.signal;
      if (!signal) throw new Error("This request must be cancellable.");
      signal.throwIfAborted();
      await new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
    return Response.json({
      id: JOB_ID,
      tokens: remoteLines.map((line, index) => ({
        ...line,
        speaker: index < 2 ? "A" : "B",
      })),
    });
  });
  return {
    fetch,
    calls,
    uploads,
    fetchingTranscript: fetchingTranscript.promise,
    deleting: deleting.promise,
  };
}

async function recordedReview(options: Parameters<typeof asyncSoniox>[0] = {}) {
  const dataDir = await createTempDataFolder();
  const remote = asyncSoniox(options);
  const live = liveSoniox();
  const { core, record, clock } = await transcribingCore(dataDir, {
    transcriptionReviewFetch: remote.fetch,
    cloud: live.cloud,
    capture: {
      recording: new Int16Array(RECORDING_MS * 16).fill(COMPUTER),
      microphoneRecording: new Int16Array(RECORDING_MS * 16).fill(MICROPHONE),
    },
  });
  try {
    await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key-0123456789" });
    await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    const { id } = await core.createMeeting();
    await core.startMeeting({ meetingId: id, systemAudio: true });
    await until(core, id, (transcript) => transcript.cloud === "soniox");
    record(RECORDING_MS);
    const tracks = await vi.waitFor(() => {
      const microphone = live.streams.find((stream) => stream.sample === MICROPHONE);
      const computer = live.streams.find((stream) => stream.sample === COMPUTER);
      if (!microphone || !computer) throw new Error("Waiting for the two distinct live tracks.");
      return { microphone, computer };
    });
    tracks.microphone.hear({
      tokens: [
        {
          text: "This private microphone sentence stays here.",
          start_ms: 200,
          end_ms: 1500,
          is_final: true,
        },
        { text: "<end>", is_final: true },
      ],
    });
    for (const line of remoteLines) {
      tracks.computer.hear({ tokens: [line, { text: "<end>", is_final: true }] });
    }
    await until(core, id, (transcript) => transcript.lines === remoteLines.length + 1);
    const { document } = await stoppedMeeting(core, dataDir, id);
    return { core, id, document, remote, clock, cues: await savedCues(core, id) };
  } catch (error) {
    core.close();
    throw error;
  }
}

const exportNote = async (core: Core, id: string) =>
  new TextDecoder().decode((await core.exportMind(id, { format: "markdown" })).data);

test("only a confirmed review sends the computer track once and applying it preserves the original Citation", async () => {
  const { core, id, document, remote, cues } = await recordedReview();
  try {
    expect(remote.calls).toEqual([]);
    const quote = await core.getMeetingSpeakerReview(id);
    expect(quote).toMatchObject({ available: true, reason: null, durationMs: RECORDING_MS });
    expect(quote.estimatedUsd).toBeCloseTo((0.1 * RECORDING_MS) / 3_600_000, 9);
    expect(remote.calls).toEqual([]);
    const beforeCost = await core.getCostSummary();

    const line = cues.find((cue) => cue.text === "The dispatch pickup comes first.");
    if (!line?.speaker) throw new Error("Missing the misattributed line.");
    expect(line.speaker).toBe("Speaker 1");
    const note = await core.createMind({ title: "Dispatch" });
    const client = await connectToMind(core, note.id);
    writeMind(client, [
      { type: "paragraph", content: [await citationOf(core, document, line.text)] },
    ]);
    await client.settled();
    const original = mindCitations(client);
    expect(original).toMatchObject([
      {
        documentId: document.id,
        contentHash: document.contentHash,
        quote: line.text,
        check: "found",
        location: { kind: "time", from: line.startMs, to: line.endMs, speaker: "Speaker 1" },
      },
    ]);
    expect(await exportNote(core, note.id)).toContain(`Speaker 1 · ${clockTime(line.startMs)}`);

    const input = { meetingId: id, confirmed: true } as const;
    const [first, second] = await Promise.all([
      core.reviewMeetingSpeakers(input),
      core.reviewMeetingSpeakers(input),
    ]);
    expect(second).toEqual(first);
    expect(await core.getMeetingSpeakerReview(id)).toMatchObject({
      available: true,
      cached: true,
      estimatedUsd: 0,
    });
    expect(await core.reviewMeetingSpeakers({ ...input, reuseOnly: true })).toEqual(first);
    expect(first).toEqual({
      documentId: document.id,
      contentHash: document.contentHash,
      suggestions: [
        {
          startMs: line.startMs,
          endMs: line.endMs,
          text: line.text,
          fileLabel: "Speaker 1",
          currentLabel: "Speaker 1",
          suggestedLabel: "Speaker 2",
        },
      ],
    });
    expect(remote.calls.filter((call) => call.startsWith("POST "))).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
    ]);
    expect(remote.calls.slice(-2)).toEqual([
      `DELETE /v1/transcriptions/${JOB_ID}`,
      `DELETE /v1/files/${FILE_ID}`,
    ]);
    expect(remote.uploads).toHaveLength(1);
    expect(remote.uploads[0]?.length).toBe(RECORDING_MS * 16);
    expect(remote.uploads[0]?.every((sample) => sample === COMPUTER)).toBe(true);
    const stretch = { meetingId: id, fromMs: 0, toMs: RECORDING_MS };
    const systemPlayback = await core.readMeetingAudio({ ...stretch, source: "system" });
    expect(systemPlayback.samples.length).toBe(remote.uploads[0]?.length);
    expect(
      systemPlayback.samples.every(
        (sample, index) => sample * 32768 === remote.uploads[0]?.[index],
      ),
    ).toBe(true);
    const mixed = await core.readMeetingAudio(stretch);
    expect(mixed.samples.length).toBe(RECORDING_MS * 16);
    expect(mixed.samples.every((sample) => sample * 32768 === COMPUTER + MICROPHONE)).toBe(true);
    const usd = (summary: typeof beforeCost) =>
      summary.spent.find((money) => money.currency === "USD")?.amount ?? 0;
    expect(usd(await core.getCostSummary()) - usd(beforeCost)).toBeCloseTo(quote.estimatedUsd, 9);
    expect((await core.listDocuments()).find((each) => each.id === document.id)?.speakers).toEqual(
      document.speakers,
    );

    const changed = await core.setTranscriptSpeakers({
      documentId: first.documentId,
      expectedContentHash: first.contentHash,
      expectedSpeakers: document.speakers,
      speakers: withSpeakerChosen(
        document.speakers,
        [],
        { startMs: line.startMs, label: line.speaker },
        { label: "Speaker 2" },
        false,
      ),
    });
    expect(speakerOf(changed.speakers, line.startMs, line.speaker)).toBe("Speaker 2");
    expect(changed.contentHash).toBe(document.contentHash);
    await expect(core.reviewMeetingSpeakers({ ...input, reuseOnly: true })).rejects.toMatchObject({
      wording: { key: "error.meeting.reviewChanged" },
    });
    expect(remote.uploads).toHaveLength(1);
    expect(await savedCues(core, id)).toEqual(cues);
    expect(mindCitations(client)).toEqual(original);
    expect(await exportNote(core, note.id)).toContain(`Speaker 2 · ${clockTime(line.startMs)}`);
  } finally {
    core.close();
  }
});

test.each(["cancel", "delete audio", "revoke"] as const)(
  "%s stops a review without changing the Transcript",
  async (action) => {
    const { core, id, document, remote, cues } = await recordedReview({ holdTranscript: true });
    try {
      const rejection = expect(
        core.reviewMeetingSpeakers({ meetingId: id, confirmed: true }),
      ).rejects.toMatchObject({ wording: { key: "error.meeting.reviewCancelled" } });
      await remote.fetchingTranscript;
      const previous = [...remote.calls];
      if (action === "cancel") {
        await core.cancelMeetingSpeakerReview(id);
      } else if (action === "revoke") {
        await core.revokeConsent("transcription", SONIOX);
      } else {
        const meeting = await core.deleteMeetingAudio(id);
        expect(meeting.audio.kept).toBe(false);
        expect(await core.getMeetingSpeakerReview(id)).toMatchObject({
          available: false,
          reason: "audio",
        });
      }
      await rejection;
      expect(remote.calls.slice(previous.length)).toEqual(
        action === "revoke"
          ? []
          : [`DELETE /v1/transcriptions/${JOB_ID}`, `DELETE /v1/files/${FILE_ID}`],
      );
      if (action === "delete audio") {
        await expect(
          core.reviewMeetingSpeakers({ meetingId: id, confirmed: true }),
        ).rejects.toMatchObject({ wording: { key: "error.meeting.audioGone" } });
        expect(remote.uploads).toHaveLength(1);
      }
      expect(
        (await core.listDocuments()).find((each) => each.id === document.id)?.speakers,
      ).toEqual(document.speakers);
      expect(await savedCues(core, id)).toEqual(cues);
    } finally {
      core.close();
    }
  },
);

test("a Cancel waits for the old review to exit before the user can retry", async () => {
  const cleanup = Promise.withResolvers<void>();
  const { core, id, remote } = await recordedReview({
    holdTranscript: true,
    holdDeletion: cleanup.promise,
  });
  const input = { meetingId: id, confirmed: true } as const;
  try {
    const first = core.reviewMeetingSpeakers(input).catch((error: unknown) => error);
    await remote.fetchingTranscript;
    let canceled = false;
    const stopping = core.cancelMeetingSpeakerReview(id).then(() => {
      canceled = true;
    });
    await remote.deleting;
    expect(canceled).toBe(false);
    cleanup.resolve();
    await stopping;
    expect(await first).toMatchObject({ wording: { key: "error.meeting.reviewCancelled" } });
    expect((await core.reviewMeetingSpeakers(input)).suggestions).toHaveLength(1);
    expect(remote.uploads).toHaveLength(2);
  } finally {
    cleanup.resolve();
    core.close();
  }
});

test.each([
  { submit: "lost", refunded: false },
  { submit: "refused", refunded: true },
] as const)(
  "a $submit submission response has a refund of $refunded",
  async ({ submit, refunded }) => {
    const { core, id, remote } = await recordedReview({ submit });
    try {
      const estimated = (await core.getMeetingSpeakerReview(id)).estimatedUsd;
      const spent = async () =>
        (await core.getCostSummary()).spent.find((money) => money.currency === "USD")?.amount ?? 0;
      const before = await spent();
      await expect(
        core.reviewMeetingSpeakers({ meetingId: id, confirmed: true }),
      ).rejects.toMatchObject({ wording: { key: "error.meeting.reviewFailed" } });
      expect((await spent()) - before).toBeCloseTo(refunded ? 0 : estimated, 9);
      expect(remote.calls.filter((call) => call === "POST /v1/transcriptions")).toHaveLength(1);
      if (submit === "refused") expect(remote.calls.at(-1)).toBe(`DELETE /v1/files/${FILE_ID}`);
    } finally {
      core.close();
    }
  },
);

test("an unresolved upload receipt only retries while Soniox could still have audio", async () => {
  const { core, id, remote, clock } = await recordedReview({ submit: "lost" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await expect(
      core.reviewMeetingSpeakers({ meetingId: id, confirmed: true }),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.reviewFailed" } });
    const attempts = () => remote.calls.filter((call) => call === "GET /v1/transcriptions").length;
    expect(attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts()).toBe(2);
    clock.advance(32 * 24 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts()).toBe(2);
  } finally {
    core.close();
    vi.useRealTimers();
  }
});

test.each([
  { reason: "cap", key: "error.meeting.reviewCap" },
  { reason: "soniox", key: "error.meeting.reviewService" },
] as const)(
  "a stale quote never allows an upload after the $reason restriction changes",
  async ({ reason, key }) => {
    const { core, id, remote } = await recordedReview();
    try {
      expect(await core.getMeetingSpeakerReview(id)).toMatchObject({ available: true });
      if (reason === "cap") {
        await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: 0.00001 } } });
      } else {
        await core.revokeConsent("transcription", SONIOX);
      }
      expect(await core.getMeetingSpeakerReview(id)).toMatchObject({ available: false, reason });
      await expect(
        core.reviewMeetingSpeakers({ meetingId: id, confirmed: true }),
      ).rejects.toMatchObject({ wording: { key } });
      expect(remote.calls).toEqual([]);
    } finally {
      core.close();
    }
  },
);

test("applying a finished review from an earlier speaker revision preserves a hand edit", async () => {
  const { core, id, document, cues } = await recordedReview();
  try {
    const result = await core.reviewMeetingSpeakers({ meetingId: id, confirmed: true });
    const suggestion = result.suggestions[0];
    if (!suggestion) throw new Error("No meeting speaker correction was suggested.");
    const targeted = { startMs: suggestion.startMs, label: suggestion.fileLabel };
    const edited = await core.setTranscriptSpeakers({
      documentId: document.id,
      speakers: withSpeakerChosen(document.speakers, [], targeted, { name: "Riley" }, true),
    });
    await expect(
      core.setTranscriptSpeakers({
        documentId: result.documentId,
        expectedContentHash: result.contentHash,
        expectedSpeakers: document.speakers,
        speakers: withSpeakerChosen(
          document.speakers,
          [],
          targeted,
          { label: suggestion.suggestedLabel },
          false,
        ),
      }),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.reviewChanged" } });
    const kept = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(kept?.speakers).toEqual(edited.speakers);
    expect(kept?.speakers?.labels[suggestion.currentLabel]).toBe("Riley");
    expect(await savedCues(core, id)).toEqual(cues);
  } finally {
    core.close();
  }
});
