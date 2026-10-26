import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { listParts, meetingFolder } from "../../src/core/meetings/audioFiles";
import { FAKE_LINES, FAKE_THEIR_LINES } from "../../src/core/transcription/fake";
import { askAndFinish, citingModel, onlyCitation, type ShownPassage } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { transcribingCore, transcriptOf, until } from "../helpers/transcription";

const SECOND = 1000;

async function documentOf(core: Core, documentId: string) {
  const document = (await core.listDocuments()).find((each) => each.id === documentId);
  if (!document) throw new Error(`No Document ${documentId}.`);
  return document;
}

describe("A Meeting's live Transcript", { timeout: 60_000 }, () => {
  test("a recorded stream gives a Transcript Document from its first line; a Question cites a time, and the check finds it", async () => {
    const dataDir = await createTempDataFolder();
    const quote = FAKE_LINES[1] as string;
    const { core, record } = await transcribingCore(dataDir, {
      model: citingModel({
        query: "launch",
        records: (passages: ShownPassage[]) => [
          { marker: 1, passage: passages[0]?.id, quote: `[0:01] ${quote}` },
        ],
        answer: "The launch moves to the eighteenth of November [^1].",
      }),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    expect((await transcriptOf(core, meeting.id)).state).toMatch(/preparing|live/);

    record(9 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    expect(live).toMatchObject({ state: "live", savedPath: null });
    const documentId = live.documentId as string;
    const document = await documentOf(core, documentId);
    expect(document).toMatchObject({
      kind: "transcript",
      name: "Transcript · Meeting, 6 October",
      path: join(dataDir, "Transcripts", `${meeting.id}.vtt`),
    });
    const vtt = readVtt(readFileSync(document.path, "utf8"));
    const said = (speaker: string) => vtt.cues.filter((cue) => cue.speaker === speaker);
    expect(said("Me").slice(0, 2)).toEqual([
      { startMs: 0, endMs: 2000, text: FAKE_LINES[0], speaker: "Me" },
      // A stretch is decoded from a quarter of a second before the detector heard it.
      { startMs: 1750, endMs: 4000, text: FAKE_LINES[1], speaker: "Me" },
    ]);
    expect(said("Them").map((cue) => cue.text)).toEqual(
      FAKE_THEIR_LINES.slice(0, said("Them").length),
    );
    expect(vtt.cues.length).toBe(said("Me").length + said("Them").length);

    // Searchable and citable while the Meeting records, though other Documents wait.
    await vi.waitFor(
      async () => {
        const found = await core.searchPassages("eighteenth of November", { mode: "keyword" });
        expect(found.map((passage) => passage.documentId)).toContain(documentId);
      },
      { timeout: 20_000, interval: 50 },
    );
    const mind = await core.createMind({ title: "Launch" });
    const client = await connectToMind(core, mind.id);
    const { answerId } = await askAndFinish(core, client, mind.id, "When does the launch move to?");
    expect(onlyCitation(client, answerId)).toMatchObject({
      documentId,
      location: { kind: "time", from: 1750, to: 4000, speaker: "Me" },
      quote,
      check: "found",
    });

    // At Stop it is finished in the Library's own folder: kept there, never written to a folder
    // the User has to choose (#763).
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const path = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    expect(saved.savedPath).toBe(path);
    expect(readFileSync(path, "utf8")).toMatch(/^WEBVTT\n\n00:00:00\.000 --> 00:00:02\.000\n/);
    expect(
      existsSync(join(dataDir, "Documents", "IncarnaMind", "Transcript · Meeting, 6 October.vtt")),
    ).toBe(false);
    await vi.waitFor(async () => expect((await documentOf(core, documentId)).path).toBe(path));
    // Still a Document in the Library after a restart.
    core.close();
    expect(await documentOf(startCore(dataDir), documentId)).toMatchObject({
      path,
      fileStatus: "available",
      kind: "transcript",
    });
  });

  test("the engine's process crashes mid-meeting: it starts again, the gap is marked, and filled from the audio at Stop", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record, engineHost } = await transcribingCore(dataDir);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(5 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);

    engineHost.crash();
    record(3 * SECOND);
    await vi.waitFor(() => expect(engineHost.started).toBe(2), { timeout: 10_000 });
    const path = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() => expect(readFileSync(path, "utf8")).toMatch(/^NOTE gap .* restarted$/m), {
      timeout: 10_000,
    });
    const gap = readVtt(readFileSync(path, "utf8")).gaps[0];
    expect(gap?.reason).toBe("restarted");
    record(6 * SECOND);
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "live" && transcript.lines >= 4,
    );

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(final.gaps).toEqual([]);
    expect(
      final.cues.some((cue) => cue.startMs >= (gap?.fromMs ?? 0) && cue.startMs < (gap?.toMs ?? 0)),
    ).toBe(true);
  });

  test("live text that falls behind says so, and the rest is transcribed from the audio after Stop", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { engine: { decodeMs: 30 } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.state === "live");

    // Forty seconds arrive at once: far more than the engine has decoded.
    record(40 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.state === "behind");

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(final.cues.length).toBeGreaterThanOrEqual(19);
    expect(final.cues.at(-1)?.endMs).toBeGreaterThanOrEqual(38 * SECOND);
    // What was transcribed from the audio after Stop is labelled by its source too.
    const late = final.cues.filter((cue) => cue.startMs >= 30 * SECOND);
    expect(new Set(late.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
  });

  // protects=a stretch with no audio on disk is said to have none captured, and "its audio was deleted" only when the audio was deleted; a stretch under a second is not listed; fails_when=audio that was never saved is said to be deleted, or a gap of under a second is listed; no_claim=the capture's own stalls, which the fake capture has none of (#1343).
  test.each([
    ["never saved", false, "uncaptured"],
    ["deleted", true, "lost"],
  ] as const)(
    "audio %s: the stretch with none is a gap that says which",
    async (_what, deleted, reason) => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, { engine: { decodeMs: 30 } });
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.state === "live");
      record(5 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      record(40 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.state === "behind");
      // What 5 to 25 seconds had in them is gone, as the User's deleting it, or a capture that never made it, leaves it.
      for (const part of listParts(meetingFolder(dataDir, meeting.id))) {
        if (part.offsetMs >= 5 * SECOND && part.offsetMs < 25 * SECOND) rmSync(part.path);
      }
      if (deleted) await core.deleteMeetingAudio(meeting.id);

      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const { gaps } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(gaps.length).toBeGreaterThan(0);
      expect(new Set(gaps.map((gap) => gap.reason))).toEqual(new Set([reason]));
      expect(gaps.every((gap) => gap.toMs - gap.fromMs >= 1000)).toBe(true);
    },
  );

  test("a line whose words hold control characters is kept as one line, and the file reads back (#981)", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { lines: ["The launch\nmoves to the\u0007 eighteenth.\n\nDone", "Next\tline."] },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(5 * SECOND, ["microphone"]);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    if (!live.documentId) throw new Error("The Transcript has no Document yet.");
    const document = await documentOf(core, live.documentId);
    const file = readFileSync(document.path, "utf8");

    const cues = readVtt(file).cues;
    expect(cues.slice(0, 2).map((cue) => cue.text)).toEqual([
      "The launch moves to the eighteenth. Done",
      "Next line.",
    ]);
    // No blank line inside a cue, which would end it.
    expect(file).not.toMatch(/-->[^\n]*\n[^\n]*\n\n[^\n]*\n\n/);
    expect(cues.length).toBe(live.lines);
  });

  test("a Meeting where nothing was said saves no Transcript", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(5 * SECOND, []);
    await core.stopMeeting(meeting.id);
    const transcript = await until(core, meeting.id, (each) => each.state === "empty");
    expect(transcript).toMatchObject({ documentId: null, lines: 0, savedPath: null });
  });

  test("IncarnaMind closes while recording: what was recorded after live text got is transcribed once the Meeting stops", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir, { engine: { decodeMs: 30 } });
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    await until(first.core, meeting.id, (transcript) => transcript.state === "live");
    first.record(20 * SECOND);
    first.core.close();

    const second = await transcribingCore(dataDir);
    const recovered = (await second.core.listMeetings())[0];
    expect(recovered).toMatchObject({ status: "paused", pausedBy: "interrupted" });
    await second.core.stopMeeting(meeting.id);
    const saved = await until(
      second.core,
      meeting.id,
      (transcript) => transcript.state === "saved",
    );
    const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(final.cues.at(-1)?.endMs).toBeGreaterThanOrEqual(18 * SECOND);
  });

  test("audio that waited for a slow engine goes to it when it starts, and live text doesn't fall behind for it", async () => {
    const dataDir = await createTempDataFolder();
    const loaded = Promise.withResolvers<void>();
    const { core, record } = await transcribingCore(dataDir, { loads: loaded.promise });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    // Fifty seconds while the engine starts: more than live text may lag, less than is kept for it.
    record(50 * SECOND);
    expect((await transcriptOf(core, meeting.id)).state).toBe("preparing");
    loaded.resolve();
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "live" && transcript.lines >= 20,
    );
    record(5 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 22);
    expect(live.state).toBe("live");
  });

  test("a Meeting in a Mind with no title yet names its Transcript plainly", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    const mind = await core.createMind({ title: "" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });
    record(3 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.documentId !== null);
    expect((await documentOf(core, live.documentId as string)).name).toBe("Transcript");
  });

  test("IncarnaMind closing while a Transcript is being finished leaves it to finish at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir, { engine: { decodeMs: 30 } });
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    await until(first.core, meeting.id, (transcript) => transcript.state === "live");
    first.record(40 * SECOND);
    await first.core.stopMeeting(meeting.id);
    expect((await transcriptOf(first.core, meeting.id)).state).toBe("finishing");
    first.core.close();
    // Nothing reaches the closed core; the next start finishes what was left.
    const second = await transcribingCore(dataDir);
    const saved = await until(
      second.core,
      meeting.id,
      (transcript) => transcript.state === "saved",
    );
    expect(readVtt(readFileSync(saved.savedPath as string, "utf8")).cues.length).toBeGreaterThan(
      10,
    );
  });

  test("a Chinese interface names the Transcript 转写稿", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { lines: ["发布日期推迟到十一月十八日。"] },
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(3 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.documentId !== null);
    expect((await documentOf(core, live.documentId as string)).name).toBe("转写稿 · 会议，10月6日");
  });
});

describe("Who said each line (#941)", { timeout: 60_000 }, () => {
  /** The lines in the Transcript's file now, in the order it keeps them. */
  async function linesOf(core: Core, meetingId: string) {
    const { documentId } = await transcriptOf(core, meetingId);
    if (!documentId) throw new Error("The Transcript has no Document yet.");
    const document = await documentOf(core, documentId);
    return readVtt(readFileSync(document.path, "utf8")).cues;
  }

  test("the microphone's lines read Me and the computer sound's read Them, from the first line, in time order", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder());
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(7 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);

    const lines = await linesOf(core, meeting.id);
    expect(lines.slice(0, 2).map((line) => line.speaker)).toEqual(["Me", "Them"]);
    const said = (speaker: string) => lines.filter((line) => line.speaker === speaker);
    expect(said("Me")[0]?.text).toBe(FAKE_LINES[0]);
    expect(said("Them")[0]?.text).toBe(FAKE_THEIR_LINES[0]);
    expect(lines.every((line) => line.speaker === "Me" || line.speaker === "Them")).toBe(true);
    expect(lines.map((line) => line.startMs)).toEqual(
      lines.map((line) => line.startMs).sort((a, b) => a - b),
    );
  });

  test("both sides speaking at once give two lines, not one merged line", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder());
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(6 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);

    const lines = await linesOf(core, meeting.id);
    const overlapping = lines.filter((mine) =>
      lines.some(
        (theirs) =>
          mine.speaker === "Me" &&
          theirs.speaker === "Them" &&
          mine.startMs < theirs.endMs &&
          theirs.startMs < mine.endMs,
      ),
    );
    expect(overlapping.length).toBeGreaterThanOrEqual(2);
    expect(lines.map((line) => line.startMs)).toEqual(
      lines.map((line) => line.startMs).sort((a, b) => a - b),
    );
  });

  test("a meeting with the microphone only reads Speaker ? and never Them", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder());
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    record(5 * SECOND, ["microphone"]);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);

    const lines = await linesOf(core, meeting.id);
    expect(lines.map((line) => line.speaker)).toEqual(lines.map(() => "Speaker ?"));
    expect(lines[0]?.text).toBe(FAKE_LINES[0]);
  });

  test("the computer's sound that only gives silence, as a macOS that isn't allowing it does, reads Speaker ? until some sound comes", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      capture: { system: "silent" },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(5 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);

    const lines = await linesOf(core, meeting.id);
    expect(lines.map((line) => line.speaker)).toEqual(lines.map(() => "Speaker ?"));
  });

  test("the computer's sound turned down by the system gives Speaker ? too: nobody else is heard apart", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      capture: { system: "denied" },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(5 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);

    const lines = await linesOf(core, meeting.id);
    expect(lines.map((line) => line.speaker)).toEqual(lines.map(() => "Speaker ?"));
  });

  test("speech being transcribed shows greyed with whose it is", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: { maxSpeechMs: 20_000 },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(5 * SECOND);

    const live = await until(core, meeting.id, (transcript) => transcript.partial !== null);
    const { partial } = live;
    if (!partial) throw new Error("Nothing was being transcribed.");
    expect(partial.speaker === "Me" ? FAKE_LINES : FAKE_THEIR_LINES).toContain(partial.text);
    expect(["Me", "Them"]).toContain(partial.speaker);
  });

  test("a line of the microphone that repeats the computer sound's in the same second is dropped, and the same words said alone are kept", async () => {
    const same = ["The launch moves to the eighteenth of November."];
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: { lines: same, theirLines: same },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    // Both say it together: the microphone's copy is the echo of the other side's.
    record(4 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 1);
    // Then the User says it alone: that is theirs to keep.
    record(2 * SECOND, ["system"]);
    record(4 * SECOND, ["microphone"]);
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "live" && transcript.lines >= 2,
    );
    await vi.waitFor(async () =>
      expect((await linesOf(core, meeting.id)).some((line) => line.speaker === "Me")).toBe(true),
    );

    const lines = await linesOf(core, meeting.id);
    const together = lines.filter((line) => line.startMs < 4 * SECOND);
    expect(together.map((line) => line.speaker)).toEqual(together.map(() => "Them"));
    expect(together.length).toBeGreaterThanOrEqual(1);
    // A stretch is decoded from a quarter of a second before the detector heard it.
    const alone = lines.filter((line) => line.speaker === "Me");
    expect(alone.length).toBeGreaterThanOrEqual(1);
    expect(alone.every((line) => line.startMs >= 5 * SECOND)).toBe(true);
  });
});

describe("Pausing my microphone, in the Transcript", { timeout: 60_000 }, () => {
  const PAUSED_AT = 6 * SECOND;
  const RESUMED_AT = 14 * SECOND;

  /** A call both sides speak in, whose microphone is paused after six seconds and, if asked, on again after fourteen. */
  async function pausedCall(dataDir: string, { resumes }: { resumes: boolean }) {
    const call = await transcribingCore(dataDir);
    const meeting = await call.core.createMeeting();
    await call.core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    await until(call.core, meeting.id, (transcript) => transcript.state === "live");
    call.record(PAUSED_AT);
    await until(call.core, meeting.id, (transcript) => transcript.lines >= 4);
    await call.core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
    call.record(RESUMED_AT - PAUSED_AT);
    if (resumes) {
      await call.core.setMeetingMicrophone({ meetingId: meeting.id, paused: false });
      call.record(6 * SECOND);
    }
    return { ...call, meeting };
  }

  test("no Me line comes for the stretch, the other side's lines go on, and it is marked once the microphone is on again", async () => {
    const { core, meeting } = await pausedCall(await createTempDataFolder(), { resumes: true });
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { cues, gaps } = readVtt(readFileSync(saved.savedPath as string, "utf8"));

    expect(gaps).toEqual([{ fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" }]);
    const mine = cues.filter((cue) => cue.speaker === "Me");
    const theirs = cues.filter((cue) => cue.speaker === "Them");
    expect(mine.some((cue) => cue.startMs < PAUSED_AT)).toBe(true);
    expect(mine.every((cue) => cue.endMs <= PAUSED_AT || cue.startMs >= RESUMED_AT)).toBe(true);
    expect(mine.some((cue) => cue.startMs >= RESUMED_AT)).toBe(true);
    expect(
      theirs.filter((cue) => cue.startMs >= PAUSED_AT && cue.endMs <= RESUMED_AT).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("the stretch is open while it lasts, and stopping closes it at the end of the recording", async () => {
    const { core, meeting } = await pausedCall(await createTempDataFolder(), { resumes: false });
    expect((await core.listMeetings())[0]?.microphonePausedAtMs).toBe(PAUSED_AT);

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { gaps } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(gaps).toEqual([{ fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" }]);
    expect((await core.listMeetings())[0]?.microphonePausedAtMs).toBeNull();
  });

  test("quitting with the call paused too marks the stretch up to where the recording stopped", async () => {
    const dataDir = await createTempDataFolder();
    const { core, meeting } = await pausedCall(dataDir, { resumes: false });
    await core.pauseMeeting(meeting.id);
    core.close();
    const { gaps } = readVtt(
      readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8"),
    );
    expect(gaps).toEqual([{ fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" }]);
  });

  test("quitting with it paused marks the stretch up to then", async () => {
    const dataDir = await createTempDataFolder();
    const { core, meeting } = await pausedCall(dataDir, { resumes: false });
    core.close();
    const { gaps } = readVtt(
      readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8"),
    );
    expect(gaps).toEqual([{ fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" }]);
  });

  test("Stop says the Transcript is saved only once its finished text is read, so the notes are filled from it (#763)", async () => {
    const dataDir = await createTempDataFolder();
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"word ".repeat(300)}`);
    const { core, record } = await transcribingCore(dataDir, { engine: { lines } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(100 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 40);
    const documentId = live.documentId as string;

    // When the Meeting says "saved", the Document's finished version must already be read: a
    // ready status comes before saved, never after it.
    const order: string[] = [];
    core.on("document.status", (document) => {
      if (document.id === documentId) order.push(document.status);
    });
    core.on("meetings.changed", (meetings) => {
      const saved = meetings.some(
        (each) => each.id === meeting.id && each.transcript?.state === "saved",
      );
      if (saved && !order.includes("saved")) order.push("saved");
    });

    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (transcript) => transcript.state === "saved");
    await vi.waitFor(() => expect(order).toContain("saved"));
    expect(order).toContain("ready");
    expect(order.indexOf("saved")).toBeGreaterThan(order.lastIndexOf("ready"));
  });
});
