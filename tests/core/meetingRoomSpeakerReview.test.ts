import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { RoomSpeakerReviewer } from "../../src/core/adapters";
import { wavSamples } from "../../src/core/meetings/fakeCapture";
import {
  SPEAKER_ME,
  SPEAKER_UNKNOWN,
  speakerOf,
  withSpeakerChosen,
} from "../../src/shared/speakers";
import { createTempDataFolder } from "../helpers/core";
import { savedCues, stoppedMeeting, transcribingCore, until } from "../helpers/transcription";

async function recordRoom(reviewer: RoomSpeakerReviewer, duration = 12_000) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, { roomSpeakerReviewer: reviewer });
  try {
    const { id } = await core.createMeeting();
    await core.startMeeting({ meetingId: id, systemAudio: false });
    record(duration, ["microphone"]);
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
      wording: { key: "error.meeting.roomReviewPeople" },
    });
    expect(separate).toHaveBeenCalledTimes(1);
  } finally {
    core.close();
  }
});

test.each([SPEAKER_UNKNOWN, "Speaker 1"])(
  "marking one %s line as Me leaves another voice available for review",
  async (previous) => {
    const separate = vi.fn<RoomSpeakerReviewer["separate"]>();
    const { core, id, document, cues } = await recordRoom({ downloadBytes: () => 0, separate });
    try {
      const lines = cues.map((cue) => ({
        startMs: cue.startMs,
        label: cue.speaker ?? SPEAKER_UNKNOWN,
      }));
      const first = lines[0];
      const other = cues.at(-1);
      if (!first || !other) throw new Error("Expected both room voices.");
      const numbered = withSpeakerChosen(
        document.speakers,
        lines,
        lines.slice(0, -1),
        { label: previous },
        false,
      );
      const speakers = withSpeakerChosen(numbered, lines, first, { label: SPEAKER_ME }, false);
      await core.setTranscriptSpeakers({ documentId: document.id, speakers });
      separate.mockResolvedValue(
        cues.map((cue) => ({
          startMs: cue.startMs,
          endMs: cue.endMs,
          voice: cue === other ? 1 : 0,
        })),
      );
      const review = await core.reviewMeetingSpeakers({
        meetingId: id,
        onDevice: true,
        confirmed: true,
      });
      expect(review.uncertainSpeakers).toBeUndefined();
      expect(review.suggestions.map((s) => s.startMs)).toEqual([other.startMs]);
      expect(review.suggestions.every((s) => s.suggestedLabel !== SPEAKER_ME)).toBe(true);
      expect((await core.listDocuments()).find((d) => d.id === document.id)?.speakers).toEqual(
        speakers,
      );
    } finally {
      core.close();
    }
  },
);

test("a self-marked line without a clear voice permits suggestions for known speakers", async () => {
  const separate = vi.fn<RoomSpeakerReviewer["separate"]>();
  const { core, id, document, cues } = await recordRoom({ downloadBytes: () => 0, separate });
  try {
    const [mine, , anchor, extra] = cues;
    const last = cues.at(-1);
    if (!mine || !anchor || !extra || !last) throw new Error("Expected separated room turns.");
    const fileLine = (cue: typeof mine) => ({
      startMs: cue.startMs,
      label: cue.speaker ?? SPEAKER_UNKNOWN,
    });
    const marked = withSpeakerChosen(
      document.speakers,
      [],
      fileLine(mine),
      { label: SPEAKER_ME },
      false,
    );
    const speakers = withSpeakerChosen(marked, [], fileLine(anchor), { label: "Speaker 1" }, false);
    await core.setTranscriptSpeakers({ documentId: document.id, speakers });
    separate.mockResolvedValue(
      [anchor, extra, last].map((cue) => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        voice: cue === extra ? 1 : 0,
      })),
    );
    const review = await core.reviewMeetingSpeakers({
      meetingId: id,
      onDevice: true,
      confirmed: true,
    });
    expect(review.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startMs: last.startMs,
          suggestedLabel: "Speaker 1",
        }),
      ]),
    );
    expect(review.suggestions.every((row) => row.suggestedLabel === "Speaker 1")).toBe(true);
    expect(
      review.suggestions.some(
        (row) => row.startMs === mine.startMs || row.startMs === extra.startMs,
      ),
    ).toBe(false);
  } finally {
    core.close();
  }
});

test("a room with Me and four labels needs a current choice before checking the other people", async () => {
  const separate = vi.fn<RoomSpeakerReviewer["separate"]>();
  const { core, id, document, cues, meeting } = await recordRoom(
    { downloadBytes: () => 0, separate },
    28_000,
  );
  try {
    const [mine, one, two, three, four, other] = cues.filter((_, index) => index % 2 === 0);
    if (!mine || !one || !two || !three || !four || !other || !meeting.transcript?.savedPath)
      throw new Error("Expected six microphone lines and a saved Transcript.");
    const path = meeting.transcript.savedPath;
    const original = readFileSync(path);
    const labels = ["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"];
    let speakers = document.speakers;
    for (const [i, cue] of [mine, one, two, three, four].entries()) {
      speakers = withSpeakerChosen(
        speakers,
        [],
        { startMs: cue.startMs, label: cue.speaker ?? SPEAKER_UNKNOWN },
        { label: i === 0 ? SPEAKER_ME : `Speaker ${i}` },
        false,
      );
    }
    if (!speakers) throw new Error("Expected stored speaker choices.");
    await core.setTranscriptSpeakers({ documentId: document.id, speakers });
    const ask = () => core.getMeetingSpeakerReview(id);
    const input = { meetingId: id, onDevice: true, confirmed: true } as const;
    const first = (await ask()).selfMatch;
    expect(first?.labels).toEqual(labels);
    if (!first) throw new Error("Expected a choice of existing speakers.");
    await expect(core.reviewMeetingSpeakers(input)).rejects.toThrow();
    await expect(
      core.reviewMeetingSpeakers({
        ...input,
        selfMatch: { label: "Speaker 5", revision: first.revision },
      }),
    ).rejects.toThrow();
    speakers = { ...speakers, labels: { ...speakers.labels, "Speaker 1": "Dana" } };
    await core.setTranscriptSpeakers({ documentId: document.id, speakers });
    await expect(
      core.reviewMeetingSpeakers({
        ...input,
        selfMatch: { label: "Speaker 1", revision: first.revision },
      }),
    ).rejects.toThrow();
    expect(separate).not.toHaveBeenCalled();
    const fresh = (await ask()).selfMatch;
    if (!fresh) throw new Error("Expected the renamed speaker to be available.");
    const selfMatch = { label: "Speaker 1", revision: fresh.revision };
    separate.mockResolvedValue(
      [mine, one, two, three, four, other].map((cue, i) => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        voice: i === 0 ? 0 : Math.min(i - 1, 3),
      })),
    );
    const start = core.reviewMeetingSpeakers({ ...input, selfMatch });
    await expect(async () =>
      core.reviewMeetingSpeakers({ ...input, selfMatch: { ...selfMatch, label: "Speaker 2" } }),
    ).rejects.toThrow();
    const review = await start;
    expect(review.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startMs: other.startMs, suggestedLabel: "Speaker 4" }),
      ]),
    );
    expect(
      review.suggestions.every(
        (s) =>
          ![SPEAKER_ME, selfMatch.label].includes(s.currentLabel) &&
          ![SPEAKER_ME, selfMatch.label].includes(s.suggestedLabel),
      ),
    ).toBe(true);
    const conflict = await core.reviewMeetingSpeakers({
      ...input,
      selfMatch: { ...selfMatch, label: "Speaker 2" },
    });
    expect(conflict).toMatchObject({ uncertainSpeakers: true, suggestions: [] });
    separate.mockResolvedValue(
      [one, two, three, four, other].map((cue, i) => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        voice: Math.min(i, 3),
      })),
    );
    expect(await core.reviewMeetingSpeakers({ ...input, selfMatch })).toMatchObject({
      uncertainSpeakers: true,
      suggestions: [],
    });
    expect(readFileSync(path)).toEqual(original);
    expect((await core.listDocuments()).find((d) => d.id === document.id)?.speakers).toEqual(
      speakers,
    );
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
