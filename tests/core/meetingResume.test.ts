/**
 * Resume after Stop (#3762), through the core's public interface as the Transcript sheet uses it:
 * the same Meeting records on, in the same Note and Transcript, every line and part of audio
 * already saved kept as it was, through a quit or a crash on either side of the Resume.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Meeting } from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder } from "../helpers/core";
import {
  transcriptFileLines as fileLines,
  meetingNow as meetingOf,
  audioPartsOf as partsOf,
  savedCues,
  stoppedMeeting,
  transcribingCore,
  transcriptRead,
  until,
} from "../helpers/transcription";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const transcriptFile = (dataDir: string, meetingId: string) =>
  join(dataDir, "Transcripts", `${meetingId}.vtt`);

/** A call of 9 seconds from both sides, stopped, its Transcript saved and read: what Resume starts from. */
async function stoppedCall(dataDir: string) {
  const recording = await transcribingCore(dataDir);
  const started = await recording.core.createMeeting();
  await recording.core.startMeeting({ meetingId: started.id });
  recording.record(9 * SECOND);
  await until(recording.core, started.id, (transcript) => transcript.lines >= 4);
  const { meeting, document } = await stoppedMeeting(recording.core, dataDir, started.id);
  return { ...recording, meeting, document, lines: await savedCues(recording.core, started.id) };
}

describe("Resume after Stop (#3762)", { timeout: 60_000 }, () => {
  // protects=Resume after Stop records more of the same Meeting: the same Note and Transcript Document and file, every line of the first stretch kept exactly and first, the new ones after them as Me and Them, the time going on from where it stopped, both stretches' audio on disk and playable, and Stop again saves it again; fails_when=a second Meeting or Transcript Document is made, an earlier line changes or goes, the time starts again from 0, or the first stretch's audio goes; no_claim=the sheet's Resume button, which the window's spec covers.
  test("stop, Resume, stop again: one Meeting and one Transcript, its first lines as they were and the new ones after them", async () => {
    const dataDir = await createTempDataFolder();
    const { core, clock, record, meeting, document, lines } = await stoppedCall(dataDir);
    expect(meeting).toMatchObject({ status: "stopped", recordedMs: 9 * SECOND });

    clock.advance(MINUTE);
    const resumed = await core.resumeMeeting(meeting.id);
    expect(resumed).toMatchObject({
      id: meeting.id,
      mindId: meeting.mindId,
      status: "recording",
      stoppedAt: null,
      recordedMs: 9 * SECOND,
      recordingSince: "2026-10-06T09:01:09.000Z",
      gaps: [],
      fill: null,
      audio: { kept: true, expiresAt: null, deletedAt: null },
      transcript: { documentId: document.id, savedPath: null, separating: false },
    });
    record(6 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= lines.length + 2);
    // While it records, the file holds every earlier line first, as it was.
    expect(fileLines(dataDir, meeting.id).slice(0, lines.length)).toEqual(lines);

    expect(await core.stopMeeting(meeting.id)).toMatchObject({
      status: "stopped",
      recordedMs: 15 * SECOND,
      stoppedAt: "2026-10-06T09:01:15.000Z",
      gaps: [],
      audio: { kept: true, expiresAt: "2026-10-07T09:01:15.000Z", deletedAt: null },
    });
    const all = await savedCues(core, meeting.id);
    expect((await meetingOf(core, meeting.id)).transcript).toMatchObject({
      documentId: document.id,
      savedPath: transcriptFile(dataDir, meeting.id),
    });
    expect(all.slice(0, lines.length)).toEqual(lines);
    const added = all.slice(lines.length);
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(added.every((cue) => cue.startMs >= 9 * SECOND && cue.endMs <= 15 * SECOND)).toBe(true);
    expect(new Set(added.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));

    // One Meeting in the Note, and one Transcript Document, which holds the whole file.
    expect(
      (await core.listMeetings()).filter((each) => each.mindId === meeting.mindId),
    ).toHaveLength(1);
    expect(
      (await core.listDocuments())
        .filter((each) => each.kind === "transcript")
        .map((each) => each.id),
    ).toEqual([document.id]);
    await transcriptRead(core, dataDir, meeting.id, document.id);
    expect(partsOf(dataDir, meeting.id)).toEqual([
      "microphone@0+9",
      "system@0+9",
      "microphone@9+6",
      "system@9+6",
    ]);
    for (const fromMs of [SECOND, 10 * SECOND]) {
      const played = await core.readMeetingAudio({
        meetingId: meeting.id,
        fromMs,
        toMs: fromMs + SECOND,
      });
      expect(played.samples.some((sample) => sample !== 0)).toBe(true);
    }
    core.close();
  });

  // protects=a quit or a kill between Stop and Resume leaves the Meeting as Stop left it (its time, audio, notes and saved Transcript, its file and Document's version), and Resume after the restart records on into the same Transcript; fails_when=the restart reopens, re-reads or rewrites the Transcript, changes the Meeting, or Resume after it starts another file; no_claim=a quit during Stop's own finishing, which tests/core/transcripts.test.ts covers.
  test.each(["quit", "kill"] as const)(
    "a %s between Stop and Resume leaves the Meeting as Stop left it, and Resume after the restart records on",
    async (end) => {
      const dataDir = await createTempDataFolder();
      const first = await stoppedCall(dataDir);
      const { meeting, document, lines } = first;
      const asStopped = ({ transcript, ...each }: Meeting) => ({
        status: each.status,
        pausedBy: each.pausedBy,
        recordedMs: each.recordedMs,
        stoppedAt: each.stoppedAt,
        gaps: each.gaps,
        audio: each.audio,
        fill: each.fill,
        transcript: transcript && {
          documentId: transcript.documentId,
          state: transcript.state,
          lines: transcript.lines,
          savedPath: transcript.savedPath,
          separating: transcript.separating,
        },
      });
      const before = asStopped(await meetingOf(first.core, meeting.id));
      const file = readFileSync(transcriptFile(dataDir, meeting.id), "utf8");
      const parts = partsOf(dataDir, meeting.id);
      if (end === "quit") first.core.close();

      const second = await transcribingCore(dataDir);
      expect(asStopped(await meetingOf(second.core, meeting.id))).toEqual(before);
      expect(readFileSync(transcriptFile(dataDir, meeting.id), "utf8")).toBe(file);
      expect(partsOf(dataDir, meeting.id)).toEqual(parts);
      expect(
        (await second.core.listDocuments()).find((each) => each.id === document.id)?.contentHash,
      ).toBe(document.contentHash);

      second.clock.advance(10 * MINUTE);
      await second.core.resumeMeeting(meeting.id);
      second.record(6 * SECOND);
      await until(second.core, meeting.id, (transcript) => transcript.lines >= lines.length + 2);
      await second.core.stopMeeting(meeting.id);
      const all = await savedCues(second.core, meeting.id);
      expect(all.slice(0, lines.length)).toEqual(lines);
      expect(all.length).toBeGreaterThanOrEqual(lines.length + 2);
      expect(await meetingOf(second.core, meeting.id)).toMatchObject({
        recordedMs: 15 * SECOND,
        transcript: { documentId: document.id },
      });
      second.core.close();
    },
  );

  // protects=a quit while a resumed call records is recovered as any recording is: paused, interrupted, its time and both stretches' audio and lines kept, and Stop then saves the whole Transcript, the rest read from the recording; fails_when=the restart finds the Transcript closed to new lines, loses the second stretch's lines or audio, or Stop saves it without them; no_claim=a hard crash right after Resume, which the next test covers.
  test("quitting while a resumed call records keeps both stretches: it waits, paused, and Stop saves them all", async () => {
    const dataDir = await createTempDataFolder();
    const first = await stoppedCall(dataDir);
    const { meeting, document, lines } = first;
    await first.core.resumeMeeting(meeting.id);
    first.record(6 * SECOND);
    await until(first.core, meeting.id, (transcript) => transcript.lines >= lines.length + 2);
    first.core.close();

    const second = await transcribingCore(dataDir);
    expect(await meetingOf(second.core, meeting.id)).toMatchObject({
      status: "paused",
      pausedBy: "interrupted",
      recordedMs: 15 * SECOND,
      transcript: { documentId: document.id, savedPath: null },
    });
    expect(partsOf(dataDir, meeting.id)).toEqual([
      "microphone@0+9",
      "system@0+9",
      "microphone@9+6",
      "system@9+6",
    ]);
    expect(fileLines(dataDir, meeting.id).slice(0, lines.length)).toEqual(lines);

    await second.core.stopMeeting(meeting.id);
    const all = await savedCues(second.core, meeting.id);
    expect(all.slice(0, lines.length)).toEqual(lines);
    expect(all.at(-1)?.endMs).toBeGreaterThanOrEqual(13 * SECOND);
    second.core.close();
  });

  // protects=a crash right after Resume, before a new line, leaves the Transcript's file with every line it had, and the Meeting waits, paused, to record on into the same Document; fails_when=the restart finds fewer lines, a Transcript closed to new lines, or a second Document; no_claim=the audio of a crash mid-stretch, which tests/core/meetings.test.ts covers.
  test("killed right after Resume, the Transcript keeps every line and the Meeting records on into it", async () => {
    const dataDir = await createTempDataFolder();
    const first = await stoppedCall(dataDir);
    const { meeting, document, lines } = first;
    await first.core.resumeMeeting(meeting.id);

    // Killed: never closed.
    const second = await transcribingCore(dataDir);
    expect(await meetingOf(second.core, meeting.id)).toMatchObject({
      status: "paused",
      pausedBy: "interrupted",
      recordedMs: 9 * SECOND,
      transcript: { documentId: document.id, savedPath: null },
    });
    expect(fileLines(dataDir, meeting.id)).toEqual(lines);

    second.clock.advance(MINUTE);
    await second.core.resumeMeeting(meeting.id);
    second.record(6 * SECOND);
    await until(second.core, meeting.id, (transcript) => transcript.lines >= lines.length + 2);
    await second.core.stopMeeting(meeting.id);
    const all = await savedCues(second.core, meeting.id);
    expect(all.slice(0, lines.length)).toEqual(lines);
    expect(all.length).toBeGreaterThanOrEqual(lines.length + 2);
    expect(
      (await second.core.listDocuments())
        .filter((each) => each.kind === "transcript")
        .map((each) => each.id),
    ).toEqual([document.id]);
    second.core.close();
  });

  // protects=Resume after the User deleted a stopped call's audio records on: the earlier lines stay as they were, the new ones follow with their own audio, kept for a day and playable as any recording's, and the earlier stretch's stays gone; the Meeting says where the audio kept starts, and an earlier line's audio is refused in plain words in English and Chinese rather than played as silence, while a stretch reaching into the new audio plays; fails_when=Resume is refused, an earlier line goes, the earlier audio comes back, an earlier line plays as silence, or the new audio can't be played; no_claim=audio past its day, which tests/core/meetings.test.ts covers, and the Transcript view's play affordance, which the window covers.
  test("with its audio deleted, a stopped call records on: its lines stay, and only the new audio is there", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record, meeting, lines } = await stoppedCall(dataDir);
    expect((await core.deleteMeetingAudio(meeting.id)).audio).toEqual({
      kept: false,
      expiresAt: null,
      deletedAt: "2026-10-06T09:00:09.000Z",
      keptUntilDeleted: false,
    });

    await core.resumeMeeting(meeting.id);
    record(6 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= lines.length + 2);
    await core.stopMeeting(meeting.id);
    const all = await savedCues(core, meeting.id);
    expect(all.slice(0, lines.length)).toEqual(lines);
    expect(all.length).toBeGreaterThanOrEqual(lines.length + 2);
    expect(partsOf(dataDir, meeting.id)).toEqual(["microphone@9+6", "system@9+6"]);
    expect((await meetingOf(core, meeting.id)).audio).toEqual({
      kept: true,
      expiresAt: "2026-10-07T09:00:15.000Z",
      deletedAt: "2026-10-06T09:00:09.000Z",
      keptUntilDeleted: false,
      keptFromMs: 9 * SECOND,
    });
    const played = await core.readMeetingAudio({
      meetingId: meeting.id,
      fromMs: 10 * SECOND,
      toMs: 11 * SECOND,
    });
    expect(played.samples.some((sample) => sample !== 0)).toBe(true);

    // The lines before the Resume had their audio deleted: none plays as silence.
    const [first] = lines;
    if (!first) throw new Error("No line was saved.");
    expect(first.endMs).toBeLessThanOrEqual(9 * SECOND);
    for (const source of [undefined, "system", "microphone"] as const) {
      await expect(
        core.readMeetingAudio({
          meetingId: meeting.id,
          fromMs: first.startMs,
          toMs: first.endMs,
          ...(source && { source }),
        }),
      ).rejects.toMatchObject({ wording: { key: "error.meeting.audioGoneBefore" } });
    }
    expect(translate("en", "error.meeting.audioGoneBefore")).toBe(
      "This part of the Meeting’s audio was deleted.",
    );
    expect(translate("zh-CN", "error.meeting.audioGoneBefore")).toBe("会议这一段的音频已删除。");
    // Played from just before the Resume, it reaches the new audio.
    const across = await core.readMeetingAudio({
      meetingId: meeting.id,
      fromMs: 8 * SECOND,
      toMs: 10 * SECOND,
    });
    expect(across.samples.slice(0, 16_000).every((sample) => sample === 0)).toBe(true);
    expect(across.samples.slice(16_000).some((sample) => sample !== 0)).toBe(true);

    // Deleted again, nothing is kept, and nothing says where it starts.
    expect((await core.deleteMeetingAudio(meeting.id)).audio).not.toHaveProperty("keptFromMs");
    core.close();
  });

  // protects=a call whose audio was never deleted plays from its first line and says nothing of where its audio starts, after Resume too (#3762); fails_when=a Meeting with all its audio marks its first lines as having none
  test("a call whose audio was never deleted has all of it, from its first line", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record, meeting, lines } = await stoppedCall(dataDir);
    expect(meeting.audio).not.toHaveProperty("keptFromMs");
    await core.resumeMeeting(meeting.id);
    record(4 * SECOND);
    await core.stopMeeting(meeting.id);
    expect((await meetingOf(core, meeting.id)).audio).not.toHaveProperty("keptFromMs");
    const [first] = lines;
    const played = await core.readMeetingAudio({
      meetingId: meeting.id,
      fromMs: first?.startMs ?? 0,
      toMs: first?.endMs ?? SECOND,
    });
    expect(played.samples.some((sample) => sample !== 0)).toBe(true);
    core.close();
  });

  // protects=a stopped call whose Transcript files couldn't be read refuses Resume, in plain words in English and Chinese, and stays as it was, its file untouched: recording on would write the file again without the lines it holds; fails_when=Resume goes ahead and rewrites the file, or the refusal has no words; no_claim=how a damaged file is shown, which the Transcript's own view covers.
  test("a Transcript that couldn't be read refuses Resume rather than lose its lines", async () => {
    const dataDir = await createTempDataFolder();
    const first = await stoppedCall(dataDir);
    const { meeting } = first;
    first.core.close();
    writeFileSync(join(dataDir, "Transcripts", `${meeting.id}.json`), "{ not json");
    const file = readFileSync(transcriptFile(dataDir, meeting.id), "utf8");

    const second = await transcribingCore(dataDir);
    await expect(second.core.resumeMeeting(meeting.id)).rejects.toMatchObject({
      wording: { key: "error.meeting.resumeTranscriptUnreadable" },
    });
    expect(translate("en", "error.meeting.resumeTranscriptUnreadable")).toBe(
      "Recording can’t resume: it would lose lines already in this meeting’s Transcript.",
    );
    expect(translate("zh-CN", "error.meeting.resumeTranscriptUnreadable")).toBe(
      "无法继续录制：继续录制会丢失这场会议转写稿中已有的内容。",
    );
    expect(await meetingOf(second.core, meeting.id)).toMatchObject({
      status: "stopped",
      recordedMs: 9 * SECOND,
    });
    expect(second.capture.running).toBe(false);
    expect(readFileSync(transcriptFile(dataDir, meeting.id), "utf8")).toBe(file);
    second.core.close();
  });
});
