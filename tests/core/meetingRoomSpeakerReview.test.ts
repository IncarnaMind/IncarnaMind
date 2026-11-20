import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { RoomSpeakerReviewer } from "../../src/core/adapters";
import { wavSamples } from "../../src/core/meetings/fakeCapture";
import { SPEAKER_UNKNOWN, speakerOf, withSpeakerChosen } from "../../src/shared/speakers";
import { createTempDataFolder } from "../helpers/core";
import { savedCues, stoppedMeeting, transcribingCore, until } from "../helpers/transcription";

async function recordRoom(reviewer: RoomSpeakerReviewer) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, { roomSpeakerReviewer: reviewer });
  try {
    const { id } = await core.createMeeting();
    await core.startMeeting({ meetingId: id, systemAudio: false });
    record(12_000, ["microphone"]);
    await until(core, id, (tr) => tr.lines >= 4);
    const { document, meeting } = await stoppedMeeting(core, dataDir, id);
    const cues = await savedCues(core, id);
    return { core, id, document, meeting, cues };
  } catch (error) {
    core.close();
    throw error;
  }
}

test("a confirmed room review uses retained microphone audio and changes only the chosen line", async () => {
  const separate = vi.fn<RoomSpeakerReviewer["separate"]>();
  const { core, id, document, meeting, cues } = await recordRoom({
    downloadBytes: () => 154315111,
    separate,
  });
  try {
    await core.setLocalOnly(true);
    expect(await core.getMeetingSpeakerReview(id)).toMatchObject({
      available: true,
      estimatedUsd: 0,
      roomDownloadBytes: 154315111,
    });
    expect(separate).not.toHaveBeenCalled();
    const path = meeting.transcript?.savedPath;
    if (!path) throw new Error("Expected a saved transcript.");
    const original = readFileSync(path);
    const fileLines = cues.map((cue) => ({ ...cue, label: cue.speaker ?? SPEAKER_UNKNOWN }));
    separate.mockImplementation(async (meetingId, audio) => {
      expect(meetingId).toBe(id);
      expect(
        wavSamples(new Uint8Array(await audio.arrayBuffer())).some((sample) => sample !== 0),
      ).toBe(true);
      return cues.map((cue, i) => ({ startMs: cue.startMs, endMs: cue.endMs, voice: i % 2 }));
    });
    const input = { meetingId: id, confirmed: true, onDevice: true } as const;
    const [review, same] = await Promise.all([
      core.reviewMeetingSpeakers(input),
      core.reviewMeetingSpeakers(input),
    ]);
    expect(same).toEqual(review);
    expect(separate).toHaveBeenCalledTimes(1);
    expect(review.source).toBe("microphone");
    const first = review.suggestions[0];
    if (!first) throw new Error("Expected a suggestion for the unknown room voice.");
    const current = (await core.listDocuments()).find((entry) => entry.id === document.id);
    expect(current?.speakers).toEqual(document.speakers);
    expect(first.currentLabel).toBe(SPEAKER_UNKNOWN);
    const audio = await core.readMeetingAudio({
      meetingId: id,
      source: "microphone",
      fromMs: first.startMs,
      toMs: first.endMs,
    });
    expect(audio.samples.some((sample) => sample !== 0)).toBe(true);
    const next = withSpeakerChosen(
      document.speakers,
      fileLines,
      { startMs: first.startMs, label: first.fileLabel },
      { label: first.suggestedLabel },
      false,
    );
    const saved = await core.setTranscriptSpeakers({
      documentId: document.id,
      speakers: next,
      expectedSpeakers: document.speakers,
      expectedContentHash: review.contentHash,
    });
    expect(speakerOf(saved.speakers, first.startMs, first.fileLabel)).toBe(first.suggestedLabel);
    expect(saved.contentHash).toBe(document.contentHash);
    expect(readFileSync(path)).toEqual(original);
  } finally {
    core.close();
  }
});

test("deleting a room recording cancels the check and prevents another one", async () => {
  const started = Promise.withResolvers<void>();
  const { core, id } = await recordRoom({
    downloadBytes: () => 0,
    separate: async (_id, _audio, signal) => {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  });
  try {
    const review = expect(
      core.reviewMeetingSpeakers({ meetingId: id, confirmed: true, onDevice: true }),
    ).rejects.toMatchObject({ wording: { key: "error.meeting.reviewCancelled" } });
    await started.promise;
    await core.deleteMeetingAudio(id);
    await review;
    expect(await core.getMeetingSpeakerReview(id)).toMatchObject({
      available: false,
      reason: "audio",
    });
  } finally {
    core.close();
  }
});

test("a room review skips a shared sentence and refuses a transcript with five known speakers before inference", async () => {
  const separate = vi.fn<RoomSpeakerReviewer["separate"]>();
  const { core, id, document, cues } = await recordRoom({ downloadBytes: () => 0, separate });
  try {
    const shared = cues[0];
    if (!shared?.speaker || cues.length < 5) throw new Error("Expected five or more room lines.");
    const handoff = shared.startMs + (shared.endMs - shared.startMs) * 0.6;
    separate.mockResolvedValue([
      { startMs: shared.startMs, endMs: handoff, voice: 0 },
      { startMs: handoff, endMs: shared.endMs, voice: 1 },
      ...cues.slice(1).map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, voice: 0 })),
    ]);
    const input = { meetingId: id, onDevice: true, confirmed: true } as const;
    const review = await core.reviewMeetingSpeakers(input);
    expect(review.suggestions.length).toBeGreaterThan(0);
    expect(review.suggestions.some((suggestion) => suggestion.startMs === shared.startMs)).toBe(
      false,
    );
    let speakers = document.speakers ?? { labels: {}, lines: {} };
    for (const [index, cue] of cues.slice(0, 5).entries()) {
      speakers = withSpeakerChosen(
        speakers,
        [],
        { startMs: cue.startMs, label: cue.speaker ?? SPEAKER_UNKNOWN },
        { label: `Speaker ${index + 1}` },
        false,
      );
    }
    await core.setTranscriptSpeakers({ documentId: document.id, speakers });
    expect(await core.getMeetingSpeakerReview(id)).toMatchObject({
      available: false,
      reason: "people",
    });
    await expect(core.reviewMeetingSpeakers(input)).rejects.toMatchObject({
      wording: { key: "meetings.review.unavailable.people" },
    });
    expect(separate).toHaveBeenCalledTimes(1);
  } finally {
    core.close();
  }
});

test("a model that merges two distinct saved speakers cannot propose reassigning either person's lines", async () => {
  const separate = vi.fn<RoomSpeakerReviewer["separate"]>();
  const { core, id, document, cues } = await recordRoom({ downloadBytes: () => 0, separate });
  try {
    let speakers = document.speakers ?? { labels: {}, lines: {} };
    for (const [index, cue] of cues.entries()) {
      speakers = withSpeakerChosen(
        speakers,
        [],
        { startMs: cue.startMs, label: cue.speaker ?? SPEAKER_UNKNOWN },
        { label: index < 3 ? "Speaker 1" : index === 3 ? "Speaker 2" : "Speaker 3" },
        false,
      );
    }
    await core.setTranscriptSpeakers({ documentId: document.id, speakers });
    separate.mockResolvedValue(
      cues.map((cue, i) => ({ startMs: cue.startMs, endMs: cue.endMs, voice: i < 4 ? 0 : 1 })),
    );
    const review = await core.reviewMeetingSpeakers({
      meetingId: id,
      onDevice: true,
      confirmed: true,
    });
    expect(review).toMatchObject({ uncertainSpeakers: true, suggestions: [] });
  } finally {
    core.close();
  }
});
