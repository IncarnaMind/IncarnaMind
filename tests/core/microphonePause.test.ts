import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AudioCapture, AudioSink } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { listParts, meetingFolder } from "../../src/core/meetings/audioFiles";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import { isTheirs } from "../../src/shared/speakers";
import { createTempDataFolder, manualClock, nextTurn, startCore } from "../helpers/core";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const RATE = 16_000;
const TICK_MS = 100;
const FRAME = (RATE * TICK_MS) / 1000;
const SECONDS = 16;
const FIXTURES = join(__dirname, "..", "fixtures", "echo");

/** A recorded voice from the fixtures: our own 16-bit mono WAV files, with a 44-byte header. */
const clip = (name: string): Int16Array => {
  const bytes = readFileSync(join(FIXTURES, `${name}.wav`));
  return new Int16Array(
    bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.byteLength),
  );
};

/** The call's sound for `SECONDS`, with each clip placed where it starts, in seconds. */
function timeline(...voices: [Int16Array, number][]): Int16Array {
  const out = new Int16Array(SECONDS * RATE);
  for (const [samples, at] of voices) out.set(samples, at * RATE);
  return out;
}

/** The other side speaks three times; the User answers, talks to someone in the room, and answers again. */
const SYSTEM = timeline([clip("en-far"), 0], [clip("en-far"), 6], [clip("en-far"), 12]);
const MICROPHONE = timeline([clip("en-near"), 1], [clip("zh-near"), 7], [clip("en-near"), 12]);
const PAUSED_AT = 5500;
const RESUMED_AT = 11_500;

/**
 * A Meeting played from the fixtures into the real capture pipeline, with a transcriber that
 * remembers what it was sent. `pause` pauses the microphone from `PAUSED_AT` to `RESUMED_AT`.
 * A capture that `leaks` goes on sending microphone frames, as ones already on their way do.
 * The engine starts `at` the start of the call, as a model that loads slowly does at 14 s, or
 * only after Stop, when what was left is transcribed from the audio on disk. With `route`, the
 * streams go to the pretend cloud service the User chose, with their key; its connections drop
 * after `cloudDropsAfterMs` of audio, and `holdFinish` keeps the microphone's finished streams
 * from answering until the call is over, as a service slow to say its last words does.
 */
async function playCall({
  pause,
  leaks = false,
  at: engineStarts = "start",
  route,
  cloudDropsAfterMs,
  holdFinish = false,
}: {
  pause: boolean;
  leaks?: boolean;
  at?: "start" | "14 s" | "stop";
  route?: "soniox";
  cloudDropsAfterMs?: number;
  holdFinish?: boolean;
}) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const start = clock.now().toISOString();
  const captured: { sink: AudioSink | null } = { sink: null };
  const microphone = { on: true, switches: [] as boolean[] };
  const capture: AudioCapture = {
    systemAudio: true,
    start(_request, given) {
      captured.sink = given;
      given.state("microphone", "recording");
      given.state("system", "recording");
      return {
        setMicrophone(on) {
          microphone.on = on;
          microphone.switches.push(on);
          if (on) given.state("microphone", "recording");
        },
        stop: async () => {
          captured.sink = null;
        },
      };
    },
    openSettings: async () => {},
  };
  let ready = () => {};
  const loads = new Promise<void>((resolve) => {
    ready = resolve;
  });
  if (engineStarts === "start") ready();
  const engine = inProcessTranscriber(
    { ...(cloudDropsAfterMs !== undefined && { cloud: { dropAfterMs: cloudDropsAfterMs } }) },
    async () => {
      await loads;
      return createFakeSpeechEngine();
    },
  );
  const pushed: Record<string, Int16Array[]> = {};
  const opened: string[] = [];
  const finished: { stream: string; atMs: number; pushesBefore: number }[] = [];
  const dropped: { stream: string; atMs: number }[] = [];
  let answerFinishes = () => {};
  const finishesMayAnswer = new Promise<void>((resolve) => {
    answerFinishes = resolve;
  });
  const pushesTo = (stream: string) => pushed[stream]?.length ?? 0;
  const callTime = () => Date.parse(clock.now().toISOString()) - Date.parse(start);
  const core = startCore(dataDir, {
    audioCapture: capture,
    transcriber: {
      ...engine.transcriber,
      push(stream, samples) {
        pushed[stream] = [...(pushed[stream] ?? []), samples.slice()];
        engine.transcriber.push(stream, samples);
      },
      open(stream, cloud) {
        opened.push(stream);
        engine.transcriber.open(stream, cloud);
      },
      finish(stream) {
        finished.push({ stream, atMs: callTime(), pushesBefore: pushesTo(stream) });
        const answer = engine.transcriber.finish(stream);
        return holdFinish ? answer.then(() => finishesMayAnswer) : answer;
      },
      drop(stream) {
        dropped.push({ stream, atMs: callTime() });
        engine.transcriber.drop(stream);
      },
    },
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    now: clock.now,
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  if (route) {
    await core.setTranscriptionKey({ route, apiKey: "soniox-test-key-0123456789" });
    await core.updateSettings({ device: { transcriptionRoute: route } });
  }
  const { id } = await core.createMeeting();
  await core.startMeeting({ meetingId: id, systemAudio: true });
  const live = () => until(core, id, (transcript) => transcript.state === "live");
  if (route) await until(core, id, (transcript) => transcript.cloud === route);
  else if (engineStarts === "start") await live();

  let heardByCapture = 0;
  for (let tick = 0; tick * TICK_MS < SECONDS * 1000; tick++) {
    const at = tick * TICK_MS;
    if (engineStarts === "14 s" && at === 14_000) {
      ready();
      await live();
    }
    if (pause && at === PAUSED_AT) await core.setMeetingMicrophone({ meetingId: id, paused: true });
    if (pause && at === RESUMED_AT) {
      await core.setMeetingMicrophone({ meetingId: id, paused: false });
    }
    clock.advance(TICK_MS);
    const from = tick * FRAME;
    if (microphone.on || leaks) {
      captured.sink?.audio("microphone", MICROPHONE.slice(from, from + FRAME));
      if (microphone.on) heardByCapture += FRAME;
    }
    captured.sink?.audio("system", SYSTEM.slice(from, from + FRAME));
    await nextTurn();
  }
  answerFinishes();
  await core.stopMeeting(id);
  ready();
  const saved = await until(core, id, (transcript) => transcript.state === "saved");
  if (!saved.savedPath) throw new Error("The Transcript wasn't saved.");
  const transcript = readVtt(readFileSync(saved.savedPath, "utf8"));
  const parts = listParts(meetingFolder(dataDir, id));
  return {
    core,
    id,
    pushed,
    opened,
    finished,
    dropped,
    microphone,
    heardByCapture,
    transcript,
    parts,
  };
}

type Played = Awaited<ReturnType<typeof playCall>>;

const streamsOf = (played: Played, source: "microphone" | "system") =>
  Object.entries(played.pushed)
    .filter(([stream]) => new RegExp(`:${source}(:\\d+)?$`).test(stream))
    .map(([, frames]) => frames);

const samplesIn = (frames: readonly Int16Array[]) =>
  frames.reduce((sum, each) => sum + each.length, 0);

const hashOf = (frames: readonly Int16Array[]) => {
  const hash = createHash("sha256");
  for (const each of frames) hash.update(each);
  return hash.digest("hex");
};

const partsHash = (played: Played, source: "microphone" | "system") =>
  played.parts
    .filter((part) => part.source === source)
    .map(
      (part) =>
        `${part.offsetMs}+${part.durationMs}:${hashOf([new Int16Array(readFileSync(part.path).buffer.slice(44))])}`,
    );

/** Whether the engine heard it as it was recorded, or only from the audio on disk after Stop. */
const heardLive = (played: Played) =>
  Object.keys(played.pushed).every((stream) => !stream.includes("catch-up"));

const said = (played: Played, speaker: string) =>
  played.transcript.cues.filter((cue) => cue.speaker === speaker);

const isMicrophone = (stream: string) => /:microphone(:\d+)?$/.test(stream);

function expectFirstStreamFinishedAtThePause(played: Played) {
  const first = Object.keys(played.pushed).find(isMicrophone);
  const finish = played.finished.find((each) => each.stream === first);
  expect(first).toBeDefined();
  expect(finish).toBeDefined();
  expect(finish?.atMs).toBeGreaterThanOrEqual(PAUSED_AT);
  expect(finish?.atMs).toBeLessThan(RESUMED_AT);
  expect(played.pushed[first ?? ""]?.length).toBe(finish?.pushesBefore);
}

describe("Pausing the microphone, in the capture pipeline, with recorded voices", () => {
  test("nothing from the microphone reaches the audio, the transcriber or the Transcript for the stretch, and the other side is recorded and transcribed as before", async () => {
    const baseline = await playCall({ pause: false });
    const paused = await playCall({ pause: true });

    expect(heardLive(paused)).toBe(true);
    expect(paused.microphone.switches).toEqual([false, true]);

    const micParts = paused.parts.filter((part) => part.source === "microphone");
    expect(micParts.length).toBeGreaterThan(0);
    for (const part of micParts) {
      const overlaps = part.offsetMs < RESUMED_AT && part.offsetMs + part.durationMs > PAUSED_AT;
      expect(overlaps).toBe(false);
    }
    expect(micParts.reduce((sum, part) => sum + part.durationMs, 0)).toBe(
      (paused.heardByCapture / RATE) * 1000,
    );

    const sentMicrophone = streamsOf(paused, "microphone").flat();
    expect(samplesIn(sentMicrophone)).toBeLessThanOrEqual(paused.heardByCapture + FRAME);
    expect(samplesIn(sentMicrophone)).toBeGreaterThanOrEqual(paused.heardByCapture - FRAME);
    expect(streamsOf(paused, "microphone").length).toBe(2);
    expectFirstStreamFinishedAtThePause(paused);

    const me = said(paused, "Me");
    expect(me.length).toBeGreaterThan(0);
    for (const line of me) {
      expect(line.startMs >= RESUMED_AT || line.endMs <= PAUSED_AT).toBe(true);
    }
    expect(me.some((line) => line.startMs >= RESUMED_AT)).toBe(true);
    expect(said(baseline, "Me").some((line) => line.startMs >= 6000 && line.endMs <= 11_000)).toBe(
      true,
    );
    expect(paused.transcript.gaps).toEqual([
      { fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" },
    ]);

    expect(partsHash(paused, "system")).toEqual(partsHash(baseline, "system"));
    expect(hashOf(streamsOf(paused, "system").flat())).toBe(
      hashOf(streamsOf(baseline, "system").flat()),
    );
    expect(said(paused, "Them")).toEqual(said(baseline, "Them"));
    expect(said(paused, "Them").length).toBeGreaterThanOrEqual(3);
  });

  test("frames already on their way when the microphone is paused are dropped", async () => {
    const quiet = await playCall({ pause: true });
    const leaky = await playCall({ pause: true, leaks: true });

    expect(partsHash(leaky, "microphone")).toEqual(partsHash(quiet, "microphone"));
    expect(samplesIn(streamsOf(leaky, "microphone").flat())).toBe(
      samplesIn(streamsOf(quiet, "microphone").flat()),
    );
    expect(said(leaky, "Me")).toEqual(said(quiet, "Me"));
    expect(leaky.transcript.gaps).toEqual(quiet.transcript.gaps);
  });

  test("with the engine still starting, what is held for it has no microphone for the stretch either", async () => {
    const early = await playCall({ pause: true });
    const late = await playCall({ pause: true, at: "14 s" });

    expect(heardLive(late)).toBe(true);
    expect(streamsOf(late, "microphone").length).toBe(2);
    expect(samplesIn(streamsOf(late, "microphone").flat())).toBe(
      samplesIn(streamsOf(early, "microphone").flat()),
    );
    for (const line of said(late, "Me")) {
      expect(line.startMs >= RESUMED_AT || line.endMs <= PAUSED_AT).toBe(true);
    }
    expect(said(late, "Me").length).toBeGreaterThan(0);
  });

  test("what is transcribed after Stop, from the audio on disk, has no microphone for the stretch either", async () => {
    const baseline = await playCall({ pause: false, at: "stop" });
    const afterwards = await playCall({ pause: true, at: "stop" });

    expect(Object.keys(afterwards.pushed).every((stream) => stream.includes("catch-up"))).toBe(
      true,
    );
    expect(streamsOf(afterwards, "microphone").length).toBe(2);
    expect(samplesIn(streamsOf(afterwards, "microphone").flat())).toBe(afterwards.heardByCapture);
    for (const line of said(afterwards, "Me")) {
      expect(line.startMs >= RESUMED_AT || line.endMs <= PAUSED_AT).toBe(true);
    }
    expect(said(afterwards, "Me").length).toBeGreaterThan(0);
    expect(afterwards.transcript.gaps).toEqual([
      { fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" },
    ]);
    expect(said(afterwards, "Them")).toEqual(said(baseline, "Them"));
  });
  test("sent to a cloud service, no microphone audio goes for the stretch either: its connection is finished at the pause and opened again at the resume", async () => {
    const paused = await playCall({ pause: true, route: "soniox" });

    expect(Object.keys(paused.pushed).every((stream) => paused.opened.includes(stream))).toBe(true);
    expect(paused.opened.filter(isMicrophone).length).toBe(2);
    expectFirstStreamFinishedAtThePause(paused);
    expect(paused.opened.filter((stream) => stream.endsWith(":system")).length).toBe(1);
    const sentMicrophone = samplesIn(streamsOf(paused, "microphone").flat());
    expect(sentMicrophone).toBeLessThanOrEqual(paused.heardByCapture + FRAME);
    expect(sentMicrophone).toBeGreaterThanOrEqual(paused.heardByCapture - FRAME);
    expect(paused.microphone.switches).toEqual([false, true]);

    const me = said(paused, "Me");
    expect(me.some((line) => line.endMs <= PAUSED_AT)).toBe(true);
    expect(me.some((line) => line.startMs >= RESUMED_AT)).toBe(true);
    for (const line of me) {
      expect(line.startMs >= RESUMED_AT || line.endMs <= PAUSED_AT).toBe(true);
    }
    expect(paused.transcript.gaps).toEqual([
      { fromMs: PAUSED_AT, toMs: RESUMED_AT, reason: "muted" },
    ]);
    // The fake service numbers voices by its own count of lines, so the labels may differ.
    expect(paused.transcript.cues.filter((cue) => isTheirs(cue.speaker)).length).toBe(
      (await playCall({ pause: false, route: "soniox" })).transcript.cues.filter((cue) =>
        isTheirs(cue.speaker),
      ).length,
    );
  });
  test("a cloud connection lost while the microphone's finished stream waits for its last words drops that stream too, and Stop still saves", async () => {
    const lost = await playCall({
      pause: true,
      route: "soniox",
      cloudDropsAfterMs: 8000,
      holdFinish: true,
    });

    const first = Object.keys(lost.pushed).find(isMicrophone);
    const drop = lost.dropped.find((each) => each.stream === first);
    expect(drop).toBeDefined();
    expect(drop?.atMs).toBeGreaterThanOrEqual(PAUSED_AT);
    expect(drop?.atMs).toBeLessThan(RESUMED_AT);
    expect(lost.transcript.gaps).toContainEqual({
      fromMs: PAUSED_AT,
      toMs: RESUMED_AT,
      reason: "muted",
    });
    for (const line of said(lost, "Me")) {
      expect(line.startMs >= RESUMED_AT || line.endMs <= PAUSED_AT).toBe(true);
    }
    expect(said(lost, "Me").some((line) => line.endMs <= PAUSED_AT)).toBe(true);
  });
});

describe("Pausing the microphone just after it was heard", () => {
  test("the computer's sound stamped ahead of the microphone doesn't carry the microphone's stream past the press: no audio stamped after it reaches the transcriber, and no Me line runs into the stretch", async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock();
    const capture = createFakeCapture({ now: () => clock.now().getTime() });
    const engine = inProcessTranscriber();
    const sent: Record<string, number> = {};
    const finished: string[] = [];
    const core = startCore(dataDir, {
      audioCapture: capture,
      transcriber: {
        ...engine.transcriber,
        push(stream, samples) {
          sent[stream] = (sent[stream] ?? 0) + samples.length;
          engine.transcriber.push(stream, samples);
        },
        finish(stream) {
          finished.push(stream);
          return engine.transcriber.finish(stream);
        },
      },
      transcriptionModelSource: NO_TRANSCRIPTION_FILES,
      now: clock.now,
    });
    await core.updateSettings({ device: { meetingNoticeAccepted: true } });
    await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
    const { id } = await core.createMeeting();
    await core.startMeeting({ meetingId: id, systemAudio: true });
    await until(core, id, (transcript) => transcript.state === "live");

    // As a busy computer does: the core is slow with the microphone's first frame, so the
    // computer's sound is heard 10 ms after it and stays stamped 10 ms ahead of the microphone.
    clock.advance(30);
    capture.push("microphone", 30);
    clock.advance(10);
    capture.push("system", 30);
    await nextTurn();
    for (let tick = 1; tick <= 30; tick++) {
      clock.advance(tick === 1 ? 90 : 100);
      capture.push("microphone", 100);
      capture.push("system", 100);
      await nextTurn();
    }
    // The microphone was last heard up to 3,030 ms, mid-way through one of the engine's 20 ms frames.
    clock.advance(6);
    const pressedAt = 3036;
    await core.setMeetingMicrophone({ meetingId: id, paused: true });
    clock.advance(1000);
    capture.push("system", 1000);
    await nextTurn();
    await core.stopMeeting(id);
    const saved = await until(core, id, (transcript) => transcript.state === "saved");
    const { cues, gaps } = readVtt(readFileSync(saved.savedPath ?? "", "utf8"));

    const microphone = Object.keys(sent).filter(isMicrophone);
    expect(microphone).toHaveLength(1);
    expect(finished).toEqual(expect.arrayContaining(microphone));
    expect(sent[microphone[0] ?? ""]).toBeLessThanOrEqual((pressedAt * RATE) / 1000);
    expect(gaps.map((gap) => [gap.fromMs, gap.reason])).toEqual([[pressedAt, "muted"]]);
    const me = cues.filter((cue) => cue.speaker === "Me");
    expect(me.length).toBeGreaterThan(0);
    expect(me.filter((cue) => cue.endMs > pressedAt)).toEqual([]);
  });
});

const SPEECH_LEVEL = 4000;
// Whatever is captured while the microphone is paused is louder than anything else, so any of it
// that gets through shows.
const PAUSED_LEVEL = 12_000;

interface StampedCall {
  /** Moves the clock to `ms` into the call. */
  to(ms: number): void;
  /** The microphone's next frame: `ms` of sound captured up to `capturedTo` ms into the call, now by default. */
  hear(ms: number, frame?: { capturedTo?: number; level?: number }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

// A Meeting in a room whose capture stamps each frame with when it was captured, so a frame can
// arrive after the moment it was captured in, as what a capture flushes when it closes does.
async function stampedCall(script: (call: StampedCall) => Promise<void>) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const startedAt = clock.now().getTime();
  const elapsed = () => clock.now().getTime() - startedAt;
  let sink: AudioSink | null = null;
  const capture: AudioCapture = {
    systemAudio: false,
    start(_request, given) {
      sink = given;
      given.state("microphone", "recording");
      return {
        setMicrophone(on) {
          if (on) given.state("microphone", "recording");
        },
        stop: async () => {},
      };
    },
    openSettings: async () => {},
  };
  const engine = inProcessTranscriber();
  const sent: Int16Array[] = [];
  const finished: string[] = [];
  const core = startCore(dataDir, {
    audioCapture: capture,
    transcriber: {
      ...engine.transcriber,
      push(stream, samples) {
        if (isMicrophone(stream)) sent.push(samples.slice());
        engine.transcriber.push(stream, samples);
      },
      finish(stream) {
        finished.push(stream);
        return engine.transcriber.finish(stream);
      },
    },
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    now: clock.now,
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  const { id } = await core.createMeeting();
  await core.startMeeting({ meetingId: id, systemAudio: false });
  await until(core, id, (transcript) => transcript.state === "live");

  let made = 0;
  let stopped = false;
  await script({
    to(ms) {
      clock.advance(ms - elapsed());
    },
    async hear(ms, { capturedTo = elapsed(), level = SPEECH_LEVEL } = {}) {
      const samples = new Int16Array((ms * RATE) / 1000);
      for (let i = 0; i < samples.length; i++) {
        samples[i] =
          level === SPEECH_LEVEL
            ? Math.round(level * Math.sin((2 * Math.PI * 440 * (made + i)) / RATE))
            : level;
      }
      made += samples.length;
      sink?.audio("microphone", samples, startedAt + capturedTo);
      await nextTurn();
    },
    pause: async () => {
      await core.setMeetingMicrophone({ meetingId: id, paused: true });
    },
    resume: async () => {
      await core.setMeetingMicrophone({ meetingId: id, paused: false });
    },
    async stop() {
      stopped = true;
      await core.stopMeeting(id);
    },
  });
  if (!stopped) await core.stopMeeting(id);
  const saved = await until(core, id, (transcript) => transcript.state === "saved");
  const parts = listParts(meetingFolder(dataDir, id))
    .filter((part) => part.source === "microphone")
    .map((part) => {
      const bytes = readFileSync(part.path);
      return {
        ...part,
        samples: new Int16Array(
          bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.byteLength),
        ),
      };
    });
  const { gaps } = readVtt(readFileSync(saved.savedPath ?? "", "utf8"));
  return { sent, finished, parts, gaps };
}

const loudest = (frames: readonly Int16Array[]) =>
  frames.reduce((most, frame) => frame.reduce((max, v) => Math.max(max, Math.abs(v)), most), 0);

const msIn = (frames: readonly Int16Array[]) => (samplesIn(frames) * 1000) / RATE;

async function speak(call: StampedCall, fromMs: number, toMs: number) {
  for (let at = fromMs + 100; at <= toMs; at += 100) {
    call.to(at);
    await call.hear(100);
  }
}

describe("Microphone frames are kept by when they were captured, not when they arrive", () => {
  test("a frame captured while the microphone was paused but heard after the resume reaches neither the transcriber nor the disk", async () => {
    const call = await stampedCall(async (call) => {
      await speak(call, 0, 1000);
      await call.pause();
      call.to(2000);
      await call.resume();
      await speak(call, 2000, 2300);
      await call.hear(100, { capturedTo: 1500, level: PAUSED_LEVEL });
      await speak(call, 2300, 3000);
    });

    expect(call.gaps).toEqual([{ fromMs: 1000, toMs: 2000, reason: "muted" }]);
    expect(loudest(call.sent)).toBeLessThanOrEqual(SPEECH_LEVEL);
    expect(msIn(call.sent)).toBe(2000);
    expect(call.finished.filter(isMicrophone).length).toBeGreaterThanOrEqual(2);
    expect(loudest(call.parts.map((part) => part.samples))).toBeLessThanOrEqual(SPEECH_LEVEL);
    expect(call.parts.reduce((sum, part) => sum + part.durationMs, 0)).toBe(2000);
  });

  test("a pause and a resume quicker than the capture's round trip: what it flushes as it closes the microphone arrives after the resume and is dropped", async () => {
    const call = await stampedCall(async (call) => {
      await speak(call, 0, 1000);
      await call.pause();
      call.to(1030);
      await call.resume();
      call.to(1060);
      await call.hear(20, { capturedTo: 1020, level: PAUSED_LEVEL });
      call.to(1100);
      await call.hear(70);
      await speak(call, 1100, 2000);
    });

    expect(call.gaps).toEqual([{ fromMs: 1000, toMs: 1030, reason: "muted" }]);
    expect(loudest(call.sent)).toBeLessThanOrEqual(SPEECH_LEVEL);
    expect(msIn(call.sent)).toBe(1970);
    expect(loudest(call.parts.map((part) => part.samples))).toBeLessThanOrEqual(SPEECH_LEVEL);
  });

  test("what is flushed late at Stop, captured while the microphone was paused, doesn't go out with the rest, nor after", async () => {
    const call = await stampedCall(async (call) => {
      await speak(call, 0, 1000);
      await call.pause();
      call.to(2000);
      await call.resume();
      await speak(call, 2000, 2200);
      call.to(2210);
      await call.hear(100, { capturedTo: 1900, level: PAUSED_LEVEL });
      await call.stop();
      await call.hear(100, { capturedTo: 1950, level: PAUSED_LEVEL });
    });

    expect(loudest(call.sent)).toBeLessThanOrEqual(SPEECH_LEVEL);
    expect(msIn(call.sent)).toBe(1200);
    expect(loudest(call.parts.map((part) => part.samples))).toBeLessThanOrEqual(SPEECH_LEVEL);
  });

  test("no more is dropped than was captured while paused: speech just before the press and just after the resume reaches the transcriber and the disk", async () => {
    const call = await stampedCall(async (call) => {
      await speak(call, 0, 1000);
      await call.pause();
      call.to(1950);
      await call.resume();
      // Captured from 1,900 ms: its last 50 ms count.
      await speak(call, 1900, 3000);
    });

    expect(msIn(call.sent)).toBe(2050);
    expect(call.parts.reduce((sum, part) => sum + part.durationMs, 0)).toBe(2050);
    for (const part of call.parts) {
      expect(part.offsetMs + part.durationMs <= 1000 || part.offsetMs >= 1950).toBe(true);
    }
    expect(call.parts.some((part) => part.offsetMs === 1950)).toBe(true);
  });
});
