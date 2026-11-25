/**
 * What a quit, a kill, the audio deleted by the User and its day passing do to a call's audio
 * parts and its Transcript's lines and file, at each point of a recording that Resume after Stop
 * (#3762) adds to: while it records, paused, while a resumed call records, and after the second
 * Stop. The other points are in tests/core/meetingResume.test.ts, tests/core/meetings.test.ts,
 * tests/core/transcripts.test.ts and tests/core/meetingAudioDay.test.ts.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Core, Meeting } from "../../src/core";
import { MEETING_AUDIO_KEPT_MS } from "../../src/core/api";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { createTempDataFolder } from "../helpers/core";
import {
  audioPartsOf,
  meetingNow,
  savedCues,
  stoppedMeeting,
  transcribingCore,
  transcriptFileLines,
  transcriptRead,
  until,
} from "../helpers/transcription";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = MEETING_AUDIO_KEPT_MS;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A call recording 9 seconds from both sides, each whole line of it in its Transcript's file: a
 * line for each two seconds of a side, the rest of the last one once its stretch ends.
 */
async function recordingCall(dataDir: string) {
  const call = await transcribingCore(dataDir);
  const meeting = await call.core.createMeeting();
  await call.core.startMeeting({ meetingId: meeting.id });
  call.record(9 * SECOND);
  await until(call.core, meeting.id, (transcript) => transcript.lines >= 8);
  return { ...call, meeting };
}

/** The call paused, the rest of its last lines written. */
async function pausedCall(dataDir: string) {
  const call = await recordingCall(dataDir);
  await call.core.pauseMeeting(call.meeting.id);
  await until(call.core, call.meeting.id, (transcript) => transcript.lines >= 10);
  return { ...call, lines: transcriptFileLines(dataDir, call.meeting.id) };
}

/** The call stopped, its Transcript saved and read: its lines, as Resume finds them. */
async function stoppedCall(dataDir: string) {
  const call = await recordingCall(dataDir);
  await stoppedMeeting(call.core, dataDir, call.meeting.id);
  return { ...call, lines: await savedCues(call.core, call.meeting.id) };
}

/** Records `ms` more of a call recording now, until its Transcript has `lines` lines. */
async function recordOn(
  call: { core: Core; record(ms: number): void },
  meetingId: string,
  ms: number,
  lines: number,
) {
  call.record(ms);
  await until(call.core, meetingId, (transcript) => transcript.lines >= lines);
}

/** Every line of `earlier` first, as it was, and each line after them from `fromMs` on. */
function keptThenAfter(all: readonly Cue[], earlier: readonly Cue[], fromMs: number) {
  expect(all.slice(0, earlier.length)).toEqual(earlier);
  const after = all.slice(earlier.length);
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((cue) => cue.startMs < fromMs)).toEqual([]);
}

/** Its audio of a line refused, as gone, in place of playing it as silence. */
async function audioRefused(core: Core, meetingId: string, line: Cue | undefined, key: string) {
  if (!line) throw new Error("No line.");
  await expect(
    core.readMeetingAudio({ meetingId, fromMs: line.startMs, toMs: line.endMs }),
  ).rejects.toMatchObject({ wording: { key } });
}

/** What Stop left of a Meeting that a restart must keep as it was. */
const asLeft = ({ transcript, ...meeting }: Meeting) => ({
  status: meeting.status,
  pausedBy: meeting.pausedBy,
  recordedMs: meeting.recordedMs,
  stoppedAt: meeting.stoppedAt,
  gaps: meeting.gaps,
  audio: meeting.audio,
  fill: meeting.fill,
  transcript: transcript && {
    documentId: transcript.documentId,
    state: transcript.state,
    lines: transcript.lines,
    savedPath: transcript.savedPath,
  },
});

describe("While it records", { timeout: 60_000 }, () => {
  // protects=killed while a call records, the Transcript keeps every line heard, those of the audio part still filling too, and the Meeting's time goes on after them, so Resume records after them and Stop saves them all in order, none doubled; the audio is kept up to its last whole part; fails_when=the time is cut back to the last part and the next stretch is recorded over lines already heard, doubling or interleaving them; no_claim=the audio parts alone, which tests/core/meetings.test.ts covers.
  test("killed, every line heard stays, and Resume records after them", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir);
    const { id } = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: id });
    // The last five seconds are still filling a part, and heard live: every whole line written.
    await recordOn(first, id, 15 * SECOND, 14);
    const heard = transcriptFileLines(dataDir, id);
    const heardTo = Math.max(...heard.map((cue) => cue.endMs));
    expect(heardTo).toBeGreaterThan(10 * SECOND);

    // Killed: never closed.
    const second = await transcribingCore(dataDir);
    expect(await meetingNow(second.core, id)).toMatchObject({
      status: "paused",
      pausedBy: "interrupted",
      recordedMs: heardTo,
    });
    expect(audioPartsOf(dataDir, id)).toEqual(["microphone@0+10", "system@0+10"]);
    expect(transcriptFileLines(dataDir, id)).toEqual(heard);

    second.clock.advance(MINUTE);
    await second.core.resumeMeeting(id);
    await recordOn(second, id, 6 * SECOND, heard.length + 2);
    await second.core.stopMeeting(id);
    keptThenAfter(await savedCues(second.core, id), heard, heardTo);
    second.core.close();
  });

  // protects=the audio deleted while a call records goes at once, the recording goes on, every line stays in the Transcript and its file, and only what is recorded after is kept and plays; a line before it doesn't play (#3762); fails_when=a line goes with the audio, the recording stops, or a line before the deletion plays as silence
  test("the audio deleted, every line stays and only what comes after is kept", async () => {
    const dataDir = await createTempDataFolder();
    const call = await recordingCall(dataDir);
    const { core, meeting } = call;
    const lines = transcriptFileLines(dataDir, meeting.id);
    expect((await core.deleteMeetingAudio(meeting.id)).audio).toMatchObject({ kept: false });
    expect(audioPartsOf(dataDir, meeting.id)).toEqual([]);
    expect(transcriptFileLines(dataDir, meeting.id).slice(0, lines.length)).toEqual(lines);

    await recordOn(call, meeting.id, 6 * SECOND, lines.length + 2);
    await core.stopMeeting(meeting.id);
    const all = await savedCues(core, meeting.id);
    expect(all.slice(0, lines.length)).toEqual(lines);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(["microphone@9+6", "system@9+6"]);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({
      kept: true,
      keptFromMs: 9 * SECOND,
    });
    await audioRefused(core, meeting.id, lines[0], "error.meeting.audioGoneBefore");
    core.close();
  });

  // protects=a day passing while a call records deletes none of its audio: it has no deadline until it pauses or stops, and then a day from there (#687); fails_when=the sweep deletes audio of a call still recording
  test("a day passing deletes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = await createTempDataFolder();
    const call = await recordingCall(dataDir);
    const { core, clock, meeting } = call;
    call.record(3 * SECOND);
    const parts = audioPartsOf(dataDir, meeting.id);
    expect(parts).toEqual(["microphone@0+10", "system@0+10"]);
    clock.advance(DAY + MINUTE);
    vi.advanceTimersByTime(MINUTE);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(parts);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({
      kept: true,
      expiresAt: null,
      deletedAt: null,
    });
    const stopped = await core.stopMeeting(meeting.id);
    expect(stopped.audio.expiresAt).toBe(
      new Date(Date.parse(stopped.stoppedAt ?? "") + DAY).toISOString(),
    );
    core.close();
  });
});

describe("Paused", { timeout: 60_000 }, () => {
  // protects=a quit or a kill while a call is paused leaves it paused by the User, its time, its audio parts and the lines in its Transcript's file as they were, and Resume records on after them; fails_when=the restart changes the pause, its time or its parts, loses a line, or Resume records over them
  test.each(["quit", "kill"] as const)("a %s leaves it paused as it was", async (end) => {
    const dataDir = await createTempDataFolder();
    const first = await pausedCall(dataDir);
    const { meeting, lines } = first;
    const parts = audioPartsOf(dataDir, meeting.id);
    expect(parts).toEqual(["microphone@0+9", "system@0+9"]);
    if (end === "quit") first.core.close();

    const second = await transcribingCore(dataDir);
    expect(await meetingNow(second.core, meeting.id)).toMatchObject({
      status: "paused",
      pausedBy: "user",
      recordedMs: 9 * SECOND,
    });
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(parts);
    expect(transcriptFileLines(dataDir, meeting.id)).toEqual(lines);

    await second.core.resumeMeeting(meeting.id);
    await recordOn(second, meeting.id, 6 * SECOND, lines.length + 2);
    await second.core.stopMeeting(meeting.id);
    keptThenAfter(await savedCues(second.core, meeting.id), lines, 9 * SECOND);
    second.core.close();
  });

  // protects=the audio deleted while a call is paused goes at once, its lines stay, and Resume records on with audio of its own, which plays while the lines before it don't (#3762); fails_when=a line goes, Resume is refused, or a line before the deletion plays as silence
  test("the audio deleted, its lines stay and Resume records on with new audio", async () => {
    const dataDir = await createTempDataFolder();
    const call = await pausedCall(dataDir);
    const { core, meeting, lines } = call;
    await core.deleteMeetingAudio(meeting.id);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual([]);

    await core.resumeMeeting(meeting.id);
    await recordOn(call, meeting.id, 6 * SECOND, lines.length + 2);
    await core.stopMeeting(meeting.id);
    keptThenAfter(await savedCues(core, meeting.id), lines, 9 * SECOND);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(["microphone@9+6", "system@9+6"]);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({ keptFromMs: 9 * SECOND });
    await audioRefused(core, meeting.id, lines[0], "error.meeting.audioGoneBefore");
    core.close();
  });

  // protects=a day after a call was paused its audio goes, its lines and file stay, and Resume records on with audio of its own, kept for a day from its own Stop (#687, #3762); fails_when=the lines go with the audio, Resume is refused, or the new audio falls under the old day
  test("a day after the pause, its audio goes, its lines stay, and Resume records on", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = await createTempDataFolder();
    const call = await pausedCall(dataDir);
    const { core, clock, meeting, lines } = call;
    clock.advance(DAY + MINUTE);
    vi.advanceTimersByTime(MINUTE);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({ kept: false });
    expect(audioPartsOf(dataDir, meeting.id)).toEqual([]);
    expect(transcriptFileLines(dataDir, meeting.id)).toEqual(lines);

    await core.resumeMeeting(meeting.id);
    await recordOn(call, meeting.id, 6 * SECOND, lines.length + 2);
    const stopped = await core.stopMeeting(meeting.id);
    keptThenAfter(await savedCues(core, meeting.id), lines, 9 * SECOND);
    vi.advanceTimersByTime(MINUTE);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(["microphone@9+6", "system@9+6"]);
    expect(stopped.audio).toMatchObject({
      kept: true,
      expiresAt: new Date(Date.parse(stopped.stoppedAt ?? "") + DAY).toISOString(),
      keptFromMs: 9 * SECOND,
    });
    core.close();
  });
});

describe("While a resumed call records", { timeout: 60_000 }, () => {
  // protects=the audio deleted while a call resumed after Stop records goes at once, both stretches' parts with it, every line of both stays, and only what comes after is kept and plays; lines before it don't (#3762); fails_when=a line goes, the first stretch's audio stays, or a line before the deletion plays as silence
  test("the audio deleted, every line of both stretches stays and only what comes after is kept", async () => {
    const dataDir = await createTempDataFolder();
    const call = await stoppedCall(dataDir);
    const { core, meeting, lines } = call;
    await core.resumeMeeting(meeting.id);
    // Two whole lines a side in the five seconds.
    await recordOn(call, meeting.id, 5 * SECOND, lines.length + 4);
    const before = transcriptFileLines(dataDir, meeting.id);
    await core.deleteMeetingAudio(meeting.id);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual([]);

    await recordOn(call, meeting.id, 4 * SECOND, before.length + 2);
    await core.stopMeeting(meeting.id);
    const all = await savedCues(core, meeting.id);
    expect(all.slice(0, lines.length)).toEqual(lines);
    expect(all.slice(0, before.length)).toEqual(before);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(["microphone@14+4", "system@14+4"]);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({
      kept: true,
      keptFromMs: 14 * SECOND,
    });
    await audioRefused(core, meeting.id, lines[0], "error.meeting.audioGoneBefore");
    core.close();
  });

  // protects=the day of the first Stop passing while the resumed call records deletes none of its audio: Resume took its deadline away, and the second Stop gives it a day of its own (#3762); fails_when=the sweep deletes audio under the first Stop's deadline while the call records again
  test("the first Stop's day passing deletes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = await createTempDataFolder();
    const call = await stoppedCall(dataDir);
    const { core, clock, meeting, lines } = call;
    expect((await meetingNow(core, meeting.id)).audio.expiresAt).not.toBeNull();
    clock.advance(MINUTE);
    await core.resumeMeeting(meeting.id);
    await recordOn(call, meeting.id, 6 * SECOND, lines.length + 2);
    const parts = audioPartsOf(dataDir, meeting.id);
    clock.advance(DAY);
    vi.advanceTimersByTime(MINUTE);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(parts);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({
      kept: true,
      expiresAt: null,
      deletedAt: null,
    });
    const stopped = await core.stopMeeting(meeting.id);
    expect(stopped.audio.expiresAt).toBe(
      new Date(Date.parse(stopped.stoppedAt ?? "") + DAY).toISOString(),
    );
    core.close();
  });
});

describe("After the second Stop", { timeout: 60_000 }, () => {
  /** Stopped, Resumed with 6 seconds more, and stopped again: its Transcript saved and read. */
  async function stoppedTwice(dataDir: string) {
    const call = await stoppedCall(dataDir);
    const { core, clock, meeting, lines } = call;
    clock.advance(10 * MINUTE);
    await core.resumeMeeting(meeting.id);
    await recordOn(call, meeting.id, 6 * SECOND, lines.length + 2);
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    return { ...call, document, all: await savedCues(core, meeting.id) };
  }

  // protects=a quit or a kill after the second Stop leaves the Meeting as that Stop left it: its time, audio and notes, both stretches' parts, its Transcript's file and its Document's version; fails_when=the restart reopens, re-reads or rewrites the Transcript, or loses a stretch's audio
  test.each(["quit", "kill"] as const)("a %s leaves it as it was", async (end) => {
    const dataDir = await createTempDataFolder();
    const first = await stoppedTwice(dataDir);
    const { meeting, document, all } = first;
    const before = asLeft(await meetingNow(first.core, meeting.id));
    const savedPath = before.transcript?.savedPath ?? "";
    const file = readFileSync(savedPath, "utf8");
    const parts = audioPartsOf(dataDir, meeting.id);
    expect(parts).toEqual(["microphone@0+9", "system@0+9", "microphone@9+6", "system@9+6"]);
    if (end === "quit") first.core.close();

    const second = await transcribingCore(dataDir);
    expect(asLeft(await meetingNow(second.core, meeting.id))).toEqual(before);
    expect(readFileSync(savedPath, "utf8")).toBe(file);
    expect(audioPartsOf(dataDir, meeting.id)).toEqual(parts);
    expect(await savedCues(second.core, meeting.id)).toEqual(all);
    expect(
      (await second.core.listDocuments()).find((each) => each.id === document.id)?.contentHash,
    ).toBe(document.contentHash);
    second.core.close();
  });

  // protects=the audio deleted after the second Stop takes both stretches' parts, and every line of both stays in the Transcript, its file unchanged; no line plays (#687, #3762); fails_when=a stretch's audio stays, a line goes, or a line plays as silence
  test("the audio deleted takes both stretches', and every line stays", async () => {
    const dataDir = await createTempDataFolder();
    const { core, meeting, all } = await stoppedTwice(dataDir);
    const savedPath = (await meetingNow(core, meeting.id)).transcript?.savedPath ?? "";
    const file = readFileSync(savedPath, "utf8");
    const deleted = await core.deleteMeetingAudio(meeting.id);
    expect(deleted.audio).toMatchObject({ kept: false });
    expect(deleted.audio).not.toHaveProperty("keptFromMs");
    expect(audioPartsOf(dataDir, meeting.id)).toEqual([]);
    expect(readFileSync(savedPath, "utf8")).toBe(file);
    expect(await savedCues(core, meeting.id)).toEqual(all);
    await audioRefused(core, meeting.id, all.at(-1), "error.meeting.audioGone");
    core.close();
  });

  // protects=a call's audio is kept a day from its second Stop, not its first: past the first's day it stays, past the second's it goes, both stretches' parts, while every line and its file stay (#687, #3762); fails_when=the audio goes a day after the first Stop, stays past the second's day, or its lines go with it
  test("its audio goes a day after the second Stop, and every line stays", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = await createTempDataFolder();
    const { core, clock, meeting, all, document } = await stoppedTwice(dataDir);
    const stopped = await meetingNow(core, meeting.id);
    const savedPath = stopped.transcript?.savedPath ?? "";
    const file = readFileSync(savedPath, "utf8");
    // Past the first Stop's day, ten minutes before the second's.
    clock.advance(DAY - 10 * MINUTE);
    vi.advanceTimersByTime(MINUTE);
    expect(audioPartsOf(dataDir, meeting.id)).toHaveLength(4);
    clock.advance(10 * MINUTE);
    vi.advanceTimersByTime(MINUTE);
    expect((await meetingNow(core, meeting.id)).audio).toMatchObject({
      kept: false,
      expiresAt: null,
    });
    expect(audioPartsOf(dataDir, meeting.id)).toEqual([]);
    expect(readFileSync(savedPath, "utf8")).toBe(file);
    expect(await savedCues(core, meeting.id)).toEqual(all);
    await transcriptRead(core, dataDir, meeting.id, document.id);
    core.close();
  });
});
