import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { CaptureHealth, Core, Meeting } from "../../src/core";
import { meetingFolder } from "../../src/core/meetings/audioFiles";
import { createTempDataFolder } from "../helpers/core";
import { type LogEntry, recordingLog } from "../helpers/log";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

async function meetingOf(core: Core, meetingId: string): Promise<Meeting> {
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  if (!meeting) throw new Error(`No Meeting ${meetingId}.`);
  return meeting;
}

/** Waits, with real time, until the Meeting's capture health is as `ready` wants it. */
function untilHealth(
  core: Core,
  meetingId: string,
  ready: (health: CaptureHealth) => boolean,
): Promise<CaptureHealth> {
  return vi.waitFor(
    async () => {
      const { health } = await meetingOf(core, meetingId);
      if (!ready(health)) throw new Error(`Not yet: ${JSON.stringify(health)}`);
      return health;
    },
    { timeout: 20_000, interval: 20 },
  );
}

const fieldsOf = (entries: LogEntry[], event: string) =>
  entries.filter((entry) => entry.event === event).map((entry) => entry.fields);

const AT = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

describe("A Meeting's capture health", { timeout: 60_000 }, () => {
  test("a slow engine: how fast it transcribed, and live text falling behind, show in the details and the log", async () => {
    const dataDir = await createTempDataFolder();
    const { log, entries } = recordingLog();
    // Decoding takes twice as long as the speech, in stretches of 0.3 seconds.
    const { core, record } = await transcribingCore(dataDir, {
      engine: { realTimeFactor: 2, maxSpeechMs: 300 },
      log,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.state === "live");

    record(1500);
    const measured = await untilHealth(core, meeting.id, (health) => health.measuredMs >= 500);
    expect(measured.realTimeFactor).toBeGreaterThanOrEqual(1.5);
    expect(measured.keepsUp).toBe(false);

    record(40 * SECOND);
    const behind = await untilHealth(core, meeting.id, (health) =>
      health.events.some((event) => event.kind === "behind"),
    );
    expect(behind.events).toEqual([{ kind: "behind", at: AT, atMs: expect.any(Number) }]);

    await core.pauseMeeting(meeting.id);
    expect(fieldsOf(entries, "capture.behind")).toEqual([
      { meetingId: meeting.id, atMs: behind.events[0]?.atMs },
    ]);
    const summary = fieldsOf(entries, "capture.health").at(-1);
    expect(summary).toMatchObject({ meetingId: meeting.id, behind: 1, audioLostMs: 0 });
    expect(summary?.realTimeFactor).toBeGreaterThanOrEqual(1.5);
  });

  test("a part that can't be saved is lost audio, in the details and the log, after the save problem has gone", async () => {
    const dataDir = await createTempDataFolder();
    const { log, entries } = recordingLog();
    const { core, record } = await transcribingCore(dataDir, { log });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    record(10 * SECOND, ["microphone"]);

    // A file stands where the Meeting's folder was: the next part can't be written.
    const folder = meetingFolder(dataDir, meeting.id);
    renameSync(folder, `${folder}-aside`);
    writeFileSync(folder, "");
    record(10 * SECOND, ["microphone"]);
    expect((await meetingOf(core, meeting.id)).saveError).not.toBeNull();
    rmSync(folder);
    renameSync(`${folder}-aside`, folder);
    record(10 * SECOND, ["microphone"]);

    const after = await meetingOf(core, meeting.id);
    expect(after.saveError).toBeNull();
    expect(after.health.events).toEqual([
      {
        kind: "audioLost",
        at: "2026-10-06T09:00:20.000Z",
        atMs: 10 * SECOND,
        source: "microphone",
        cause: "error",
        durationMs: 10 * SECOND,
      },
    ]);
    expect(fieldsOf(entries, "capture.audioLost")).toEqual([
      {
        meetingId: meeting.id,
        atMs: 10 * SECOND,
        source: "microphone",
        cause: "error",
        durationMs: 10 * SECOND,
      },
    ]);
  });

  test("killed mid-recording: the audio saved before is recovered, and the part being written is lost", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir);
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    first.record(34 * SECOND);
    writeFileSync(
      join(meetingFolder(dataDir, meeting.id), "microphone-0000030000.wav.writing"),
      "",
    );

    // Killed: never closed.
    const { log, entries } = recordingLog();
    const second = await transcribingCore(dataDir, { log });
    const { health } = await meetingOf(second.core, meeting.id);
    expect(health.events).toEqual([
      { kind: "audioRecovered", at: AT, atMs: 30 * SECOND, parts: 6, durationMs: 30 * SECOND },
      {
        kind: "audioLost",
        at: AT,
        atMs: 30 * SECOND,
        source: "microphone",
        cause: "closed",
        durationMs: 10 * SECOND,
      },
    ]);
    expect(fieldsOf(entries, "capture.audioRecovered")).toEqual([
      { meetingId: meeting.id, atMs: 30 * SECOND, parts: 6, durationMs: 30 * SECOND },
    ]);
    expect(fieldsOf(entries, "capture.audioLost")).toHaveLength(1);
  });

  test("a fallback to the cloud and back: each switch, with why, in the details and the log", async () => {
    const dataDir = await createTempDataFolder();
    const { log, entries } = recordingLog();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { failover: { toCloudAfter: 2, backAfter: 4 } },
      log,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(11 * SECOND);

    const health = await untilHealth(
      core,
      meeting.id,
      (each) => each.events.filter((event) => event.kind === "switched").length === 2,
    );
    expect(health.events).toEqual([
      expect.objectContaining({ kind: "switched", from: "local", to: "cloud", reason: "behind" }),
      expect.objectContaining({ kind: "switched", from: "cloud", to: "local", reason: "failed" }),
    ]);
    expect(fieldsOf(entries, "capture.switched")).toEqual([
      {
        meetingId: meeting.id,
        atMs: expect.any(Number),
        from: "local",
        to: "cloud",
        reason: "behind",
      },
      {
        meetingId: meeting.id,
        atMs: expect.any(Number),
        from: "cloud",
        to: "local",
        reason: "failed",
      },
    ]);
  });

  test("the transcription process crashing: its restart, and the gap it left", async () => {
    const dataDir = await createTempDataFolder();
    const { log, entries } = recordingLog();
    const { core, record, engineHost } = await transcribingCore(dataDir, { log });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(5 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);

    engineHost.crash();
    record(3 * SECOND);
    const health = await untilHealth(core, meeting.id, (each) =>
      each.events.some((event) => event.kind === "restarted"),
    );
    const restarted = health.events.find((event) => event.kind === "restarted");
    if (restarted?.kind !== "restarted") throw new Error("No restart.");
    // What it had heard and not yet transcribed: a gap, transcribed again after Stop.
    expect(restarted.gapMs).toBeGreaterThan(0);
    expect(fieldsOf(entries, "capture.restarted")).toEqual([
      { meetingId: meeting.id, atMs: restarted.atMs, gapMs: restarted.gapMs },
    ]);
  });

  test("speech the engine can't read is marked as not transcribed, and the stream goes on", async () => {
    const dataDir = await createTempDataFolder();
    const { log, entries } = recordingLog();
    const { core, record } = await transcribingCore(dataDir, { engine: { failing: [2] }, log });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(7 * SECOND, ["microphone"]);

    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    const health = await untilHealth(core, meeting.id, (each) => each.events.length > 0);
    // The second stretch: from a quarter of a second before the detector heard it, at 2 s, to 4 s.
    expect(health.events).toEqual([
      { kind: "notTranscribed", at: AT, atMs: 1750, durationMs: 2250 },
    ]);
    expect(fieldsOf(entries, "capture.notTranscribed")).toEqual([
      { meetingId: meeting.id, atMs: 1750, durationMs: 2250 },
    ]);
  });

  test("waits with the Meeting's Note in Recently deleted, and goes once it is deleted permanently", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { engine: { failing: [1] } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(3 * SECOND);
    await untilHealth(core, meeting.id, (each) => each.events.length > 0);
    const path = join(dataDir, "meetings", `${meeting.id}.health.json`);
    expect(JSON.parse(readFileSync(path, "utf8")).events).toHaveLength(1);

    await core.deleteMind(meeting.mindId);
    expect(JSON.parse(readFileSync(path, "utf8")).events).toHaveLength(1);

    await core.deletePermanently([{ kind: "mind", id: meeting.mindId }]);
    expect(() => readFileSync(path)).toThrow();
  });
});

describe("What capture health keeps", { timeout: 60_000 }, () => {
  // What the Meeting says: none of it may reach the log or the health record.
  const SAID = [
    "The codeword for the merger is zanzibar-lantern.",
    "My salary is 98,765 a year.",
    "Northwind signs on Friday.",
  ];
  const WORDS = ["codeword", "merger", "zanzibar", "lantern", "salary", "98,765", "Northwind"];
  const KINDS = new Set([
    "audioLost",
    "audioRecovered",
    "restarted",
    "behind",
    "notTranscribed",
    "switched",
    "microphone",
    "system",
    "full",
    "denied",
    "error",
    "closed",
    "stalled",
    "local",
    "cloud",
    "failed",
    "user",
  ]);
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

  /** Only numbers, times and kinds: no text, and no audio, which would be a long list of numbers. */
  function onlyNumbersTimesAndKinds(value: unknown, where: string): void {
    if (typeof value === "number" || typeof value === "boolean" || value === null) return;
    if (typeof value === "string") {
      expect(ISO.test(value) || KINDS.has(value), `${where}: ${value}`).toBe(true);
      return;
    }
    if (Array.isArray(value)) {
      expect(where, "only the events are a list").toMatch(/\.events$/);
      for (const [index, each] of value.entries()) {
        onlyNumbersTimesAndKinds(each, `${where}[${index}]`);
      }
      return;
    }
    expect(typeof value, where).toBe("object");
    for (const [key, each] of Object.entries(value as object)) {
      onlyNumbersTimesAndKinds(each, `${where}.${key}`);
    }
  }

  test("no transcript text and no audio reaches the log or the health record", async () => {
    const dataDir = await createTempDataFolder();
    const { log, entries } = recordingLog();
    const { core, record, engineHost } = await transcribingCore(dataDir, {
      engine: {
        lines: SAID,
        maxSpeechMs: 6000,
        failing: [3],
        realTimeFactor: 0.2,
        failover: { toCloudAfter: 1, backAfter: 2 },
      },
      log,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    await until(core, meeting.id, (transcript) => transcript.state === "live");
    record(16 * SECOND, ["microphone"]);
    await untilHealth(
      core,
      meeting.id,
      (health) => health.events.filter((event) => event.kind === "switched").length === 2,
    );

    // The engine's process crashes, and a part can't be saved.
    engineHost.crash();
    const folder = meetingFolder(dataDir, meeting.id);
    renameSync(folder, `${folder}-aside`);
    writeFileSync(folder, "");
    record(10 * SECOND, ["microphone"]);
    rmSync(folder);
    renameSync(`${folder}-aside`, folder);
    record(4 * SECOND, ["microphone"]);
    await untilHealth(core, meeting.id, (health) =>
      health.events.some((event) => event.kind === "restarted"),
    );
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");

    // The words were transcribed, into the Transcript only.
    expect(readFileSync(saved.savedPath as string, "utf8")).toContain("zanzibar-lantern");
    const { health } = await meetingOf(core, meeting.id);
    expect(new Set(health.events.map((event) => event.kind))).toEqual(
      new Set(["switched", "notTranscribed", "audioLost", "restarted"]),
    );

    const logged = entries.map((entry) => JSON.stringify(entry));
    for (const text of [...SAID, ...WORDS]) {
      expect(
        logged.filter((line) => line.includes(text)),
        text,
      ).toEqual([]);
    }
    for (const entry of entries.filter((each) => each.event.startsWith("capture."))) {
      for (const [key, value] of Object.entries(entry.fields ?? {})) {
        if (key === "meetingId") expect(value).toBe(meeting.id);
        else onlyNumbersTimesAndKinds(value, `${entry.event}.${key}`);
      }
    }

    const file = readFileSync(join(dataDir, "meetings", `${meeting.id}.health.json`), "utf8");
    for (const text of [...SAID, ...WORDS]) expect(file, text).not.toContain(text);
    onlyNumbersTimesAndKinds(JSON.parse(file), "file");
    onlyNumbersTimesAndKinds(health, "health");
  });
});
