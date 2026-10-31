import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, Core, Meeting } from "../../src/core";
import { hashBytes } from "../../src/core/documents/files";
import { listParts, meetingFolder } from "../../src/core/meetings/audioFiles";
import { FAKE_LINES } from "../../src/core/transcription/fake";
import { citationState } from "../../src/shared/citations";
import { createTempDataFolder } from "../helpers/core";
import { transcribingCore, until } from "../helpers/transcription";

/*
 * Deleting a Meeting's Note (#1253): Delete never erases the Meeting. The Note, its Transcript
 * Document and its audio wait in Recently deleted together, and Undo or Restore brings back the
 * whole Meeting: its bar's lines, its Transcript, which Citations point into, and its audio.
 */

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

const NAMES = {
  en: { note: "Meeting, 6 October", transcript: "Transcript · Meeting, 6 October" },
  "zh-CN": { note: "会议，10月6日", transcript: "转写稿 · 会议，10月6日" },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

const meetingOf = async (core: Core, meetingId: string): Promise<Meeting | undefined> =>
  (await core.listMeetings()).find((each) => each.id === meetingId);

/** The parts on disk, as "source@offset" in seconds. */
const partsOf = (dataDir: string, meetingId: string) =>
  listParts(meetingFolder(dataDir, meetingId)).map(
    (part) => `${part.source}@${part.offsetMs / SECOND}`,
  );

/** Every part is a WAV a player opens: 16-bit mono PCM at 16 kHz, its samples all there. */
function expectPlayable(dataDir: string, meetingId: string): void {
  const parts = listParts(meetingFolder(dataDir, meetingId));
  expect(parts.length).toBeGreaterThan(0);
  for (const part of parts) {
    const wav = readFileSync(part.path);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.length).toBe(44 + (part.durationMs / SECOND) * 16_000 * 2);
  }
}

/** A Citation of the Transcript's second line, as an Answer leaves it in another Note. */
function citationOf(documentId: string, contentHash: string): Partial<CitationAttributes> {
  return {
    documentId,
    contentHash,
    location: { kind: "time", from: 1750, to: 4000, speaker: "Me" },
    quote: FAKE_LINES[1] as string,
    check: "found",
    checkReason: null,
  };
}

async function recordedMeeting(language: keyof typeof NAMES) {
  const dataDir = await createTempDataFolder();
  const recording = await transcribingCore(dataDir);
  await recording.core.updateSettings({ user: { language } });
  const meeting = await recording.core.createMeeting();
  await recording.core.startMeeting({ meetingId: meeting.id });
  recording.record(9 * SECOND);
  await until(recording.core, meeting.id, (transcript) => transcript.lines >= 4);
  return { ...recording, dataDir, meeting };
}

/** What the Library shows of the Transcript, if it is there. */
const transcriptIn = async (core: Core, documentId: string) =>
  (await core.listDocuments()).find((each) => each.id === documentId);

/** Waits until the Transcript Document holds its file as it is now, read and ready. */
async function transcriptRead(core: Core, dataDir: string, meetingId: string, documentId: string) {
  const file = join(dataDir, "Transcripts", `${meetingId}.vtt`);
  return vi.waitFor(
    async () => {
      const document = await transcriptIn(core, documentId);
      expect(document).toMatchObject({
        status: "ready",
        contentHash: hashBytes(readFileSync(file)),
      });
      return document as NonNullable<typeof document>;
    },
    { timeout: 20_000, interval: 20 },
  );
}

/** Stops the Meeting and waits for all Stop does: the Transcript saved and read, the notes tried. */
async function stopped(core: Core, dataDir: string, meetingId: string) {
  await core.stopMeeting(meetingId);
  const { documentId } = await until(core, meetingId, (transcript) => transcript.state === "saved");
  const document = await transcriptRead(core, dataDir, meetingId, documentId as string);
  await vi.waitFor(async () => expect((await meetingOf(core, meetingId))?.fill?.state).toBe("off"));
  return { meeting: (await meetingOf(core, meetingId)) as Meeting, document };
}

for (const language of ["en", "zh-CN"] as const) {
  describe(`Deleting a Meeting's Note (${language})`, { timeout: 60_000 }, () => {
    test("a stopped Meeting comes back whole with Undo: its lines, its Transcript, Citations into it, and its audio", async () => {
      const { core, dataDir, meeting } = await recordedMeeting(language);
      const { meeting: before, document } = await stopped(core, dataDir, meeting.id);
      const documentId = document.id;
      expect(document.name).toBe(NAMES[language].transcript);
      const citation = citationOf(documentId, document.contentHash);
      const parts = partsOf(dataDir, meeting.id);
      expect(parts).toContain("microphone@0");

      await core.deleteMind(meeting.mindId);

      // One thing waits in Recently deleted, the Note; the Transcript and the audio wait with it.
      expect(await core.listMeetings()).toEqual([]);
      expect((await core.listDeleted()).map((item) => [item.kind, item.name])).toEqual([
        ["mind", NAMES[language].note],
      ]);
      expect(await transcriptIn(core, documentId)).toBeUndefined();
      expect(citationState(citation, await core.listDocuments()).check).toBe("cant-check");
      expect(partsOf(dataDir, meeting.id)).toEqual(parts);

      // Undo, as the Undo line and ⌘Z do.
      const restored = await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });

      expect(restored).toEqual({ audioLost: [] });
      expect(await meetingOf(core, meeting.id)).toMatchObject({
        mindId: meeting.mindId,
        status: "stopped",
        recordedMs: before.recordedMs,
        audio: { kept: true, expiresAt: before.audio.expiresAt, deletedAt: null },
        transcript: { state: "saved", documentId, lines: before.transcript?.lines },
        fill: { state: "off" },
      });
      expect(await core.listDeleted()).toEqual([]);
      expect(await transcriptIn(core, documentId)).toMatchObject({
        name: NAMES[language].transcript,
        path: join(dataDir, "Transcripts", `${meeting.id}.vtt`),
      });
      expect(citationState(citation, await core.listDocuments())).toMatchObject({
        check: "found",
        documentId,
        changedAfterCited: false,
      });
      const found = await core.searchPassages("eighteenth of November", { mode: "keyword" });
      expect(found.map((passage) => passage.documentId)).toContain(documentId);
      expect(partsOf(dataDir, meeting.id)).toEqual(parts);
      expectPlayable(dataDir, meeting.id);
    });

    test("a Meeting recording stops at Delete, and Restore from Recently deleted brings it back stopped, its Transcript finished", async () => {
      const { core, capture, dataDir, meeting } = await recordedMeeting(language);
      const live = (await meetingOf(core, meeting.id)) as Meeting;
      expect(live.status).toBe("recording");
      const documentId = live.transcript?.documentId as string;
      expect(await transcriptIn(core, documentId)).toBeDefined();

      await core.deleteMind(meeting.mindId);

      expect(capture.running).toBe(false);
      expect(await core.listMeetings()).toEqual([]);
      const [item] = await core.listDeleted();
      expect(item).toMatchObject({ kind: "mind", id: meeting.mindId, name: NAMES[language].note });
      expect(await core.listDeleted()).toHaveLength(1);
      expect(partsOf(dataDir, meeting.id)).toEqual(["microphone@0", "system@0"]);

      // Restore, as Recently deleted's own button does: the window stays as it is.
      expect(await core.restore([{ kind: "mind", id: meeting.mindId }])).toEqual({
        audioLost: [],
      });

      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      expect(saved).toMatchObject({ documentId, lines: expect.any(Number) });
      expect(await meetingOf(core, meeting.id)).toMatchObject({
        status: "stopped",
        recordedMs: 9 * SECOND,
        audio: { kept: true, expiresAt: "2026-10-07T09:00:09.000Z", deletedAt: null },
      });
      // Its notes are filled in once its Transcript is saved, as after Stop; here no model is set.
      await vi.waitFor(async () =>
        expect((await meetingOf(core, meeting.id))?.fill).toMatchObject({
          state: "off",
          problem: { kind: "no-model" },
        }),
      );
      // Its Document is the finished file, every line said up to Delete in it.
      const document = await transcriptRead(core, dataDir, meeting.id, documentId);
      expect(document.name).toBe(NAMES[language].transcript);
      expect(saved.lines).toBeGreaterThanOrEqual(live.transcript?.lines ?? 0);
      expect(partsOf(dataDir, meeting.id)).toEqual(["microphone@0", "system@0"]);
      expectPlayable(dataDir, meeting.id);
    });
  });
}

describe("A deleted Meeting's audio", { timeout: 60_000 }, () => {
  test("is kept for its day in Recently deleted, then deleted as it would be, which Restore doesn't call a failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { core, clock, dataDir, meeting } = await recordedMeeting("en");
    await stopped(core, dataDir, meeting.id);
    await core.deleteMind(meeting.mindId);

    clock.advance(23 * HOUR);
    vi.advanceTimersByTime(60 * SECOND);
    expect(partsOf(dataDir, meeting.id)).toContain("microphone@0");
    clock.advance(2 * HOUR);
    vi.advanceTimersByTime(60 * SECOND);
    expect(existsSync(meetingFolder(dataDir, meeting.id))).toBe(false);

    expect(await core.restore([{ kind: "mind", id: meeting.mindId }])).toEqual({ audioLost: [] });
    expect((await meetingOf(core, meeting.id))?.audio).toEqual({
      kept: false,
      expiresAt: null,
      deletedAt: "2026-10-07T10:00:09.000Z",
    });
    expect((await meetingOf(core, meeting.id))?.transcript?.state).toBe("saved");
  });

  test("goes when the Note is deleted permanently, with its Transcript", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stopped(core, dataDir, meeting.id);
    const vtt = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await core.deleteMind(meeting.mindId);
    expect(existsSync(meetingFolder(dataDir, meeting.id))).toBe(true);
    expect(existsSync(vtt)).toBe(true);

    await core.deletePermanently([{ kind: "mind", id: meeting.mindId }]);

    expect(existsSync(meetingFolder(dataDir, meeting.id))).toBe(false);
    expect(existsSync(vtt)).toBe(false);
    expect(await core.listDeleted()).toEqual([]);
    await expect(core.restore([{ kind: "document", id: document.id }])).rejects.toMatchObject({
      wording: { key: "error.restore.deletedPermanently" },
    });
  });

  test("no longer on this computer when the Note comes back is said, and the Meeting says it is gone", async () => {
    const { core, clock, dataDir, meeting } = await recordedMeeting("en");
    await stopped(core, dataDir, meeting.id);
    await core.deleteMind(meeting.mindId);
    // Something outside IncarnaMind removed it while the Note waited.
    rmSync(meetingFolder(dataDir, meeting.id), { recursive: true });
    clock.advance(HOUR);

    expect(await core.restore([{ kind: "mind", id: meeting.mindId }])).toEqual({
      audioLost: [meeting.mindId],
    });
    expect(await meetingOf(core, meeting.id)).toMatchObject({
      status: "stopped",
      audio: { kept: false, expiresAt: null, deletedAt: "2026-10-06T10:00:09.000Z" },
      transcript: { state: "saved" },
    });
  });
});
