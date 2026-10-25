import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AudioCapture, AudioSink } from "../../src/core";
import {
  createMicrophone,
  type MicrophoneDevice,
  startMicrophone,
} from "../../src/renderer/capture/microphone";
import { createMicrophoneRelay } from "../../src/shared/capture";
import { createTempDataFolder, manualClock, nextTurn, startCore } from "../helpers/core";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES } from "../helpers/transcription";

const TICK_MS = 100;
const RATE = 16_000;
const FRAME = (RATE * TICK_MS) / 1000;
const TONE = Int16Array.from({ length: FRAME }, (_, i) => Math.round(6000 * Math.sin(i / 7)));

/**
 * A capture that works as the desktop app's does: what the core asks goes through the main
 * process's relay to the page's own rule and queue (`startMicrophone`), whose microphone opens
 * only once the page has loaded and is granted; the microphone gives frames only while open.
 * Each start of the capture is a new page, which loads when the test says.
 */
function windowCapture() {
  const pages: {
    opens: number;
    isOpen(): boolean;
    load(): void;
  }[] = [];
  let sink: AudioSink | null = null;
  const capture: AudioCapture = {
    systemAudio: true,
    start(request, given) {
      sink = given;
      let isOpen = false;
      const page = { opens: 0, isOpen: () => isOpen, load: () => {} };
      const device: MicrophoneDevice = {
        isOpen: () => isOpen,
        async open(stillWanted) {
          page.opens++;
          if (!stillWanted()) return;
          isOpen = true;
          given.state("microphone", "recording");
        },
        async close() {
          isOpen = false;
        },
      };
      const microphone = createMicrophone(device);
      const relay = createMicrophoneRelay({
        start: (message) => void startMicrophone(microphone, message),
        microphone: (on) => void microphone.set(on),
      });
      const loaded = new Promise<void>((resolve) => {
        page.load = resolve;
      });
      void loaded.then(() => relay.start({ microphone: true, systemAudio: request.systemAudio }));
      pages.push(page);
      return {
        setMicrophone: (on) => relay.set(on),
        stop: async () => {
          await microphone.stop();
          isOpen = false;
          if (sink === given) sink = null;
        },
      };
    },
    openSettings: async () => {},
  };
  return {
    capture,
    pages,
    page: () => pages.at(-1) as (typeof pages)[number],
    tick() {
      if (pages.at(-1)?.isOpen()) sink?.audio("microphone", TONE);
      sink?.audio("system", TONE);
    },
  };
}

async function call() {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const window = windowCapture();
  const engine = inProcessTranscriber();
  const microphoneSamples = { sent: 0 };
  const core = startCore(dataDir, {
    audioCapture: window.capture,
    transcriber: {
      ...engine.transcriber,
      push(stream, samples) {
        if (stream.includes(":microphone")) microphoneSamples.sent += samples.length;
        engine.transcriber.push(stream, samples);
      },
    },
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    now: clock.now,
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  const { id } = await core.createMeeting();
  const settle = async () => {
    for (let turn = 0; turn < 4; turn++) await nextTurn();
  };
  const play = async (seconds: number) => {
    for (let at = 0; at < seconds * 1000; at += TICK_MS) {
      clock.advance(TICK_MS);
      window.tick();
      await nextTurn();
    }
  };
  const microphone = (paused: boolean) =>
    core.setMeetingMicrophone({ meetingId: id, paused }).then(settle);
  return { core, id, window, microphoneSamples, settle, play, microphone };
}

async function expectResumed(played: Awaited<ReturnType<typeof call>>) {
  const { window, microphoneSamples, play, microphone } = played;
  expect(window.page().opens).toBe(0);
  expect(window.page().isOpen()).toBe(false);
  await play(1);
  const before = microphoneSamples.sent;

  await microphone(false);
  expect(window.page().opens).toBe(1);
  expect(window.page().isOpen()).toBe(true);
  await vi.waitFor(
    async () => {
      await play(1);
      expect(microphoneSamples.sent).toBeGreaterThan(before);
    },
    { timeout: 10_000, interval: 50 },
  );
  expect(window.page().opens).toBe(1);
}

describe("Resume my mic, for every way a capture can start with the microphone paused", () => {
  test("paused before the capture page has loaded", async () => {
    const played = await call();
    await played.core.startMeeting({ meetingId: played.id });
    await played.microphone(true);
    played.window.page().load();
    await played.settle();
    await expectResumed(played);
  });

  test("paused, then Pause recording and Resume recording", async () => {
    const played = await call();
    await played.core.startMeeting({ meetingId: played.id });
    played.window.page().load();
    await played.settle();
    expect(played.window.page().isOpen()).toBe(true);
    await played.play(1);
    await played.microphone(true);
    expect(played.window.page().isOpen()).toBe(false);

    await played.core.pauseMeeting(played.id);
    await played.core.resumeMeeting(played.id);
    expect(played.window.pages).toHaveLength(2);
    played.window.page().load();
    await played.settle();
    await expectResumed(played);
  });

  test("paused, then the computer sleeps and wakes", async () => {
    const played = await call();
    await played.core.startMeeting({ meetingId: played.id });
    played.window.page().load();
    await played.settle();
    await played.play(1);
    await played.microphone(true);

    played.core.systemSleeping();
    played.core.systemAwake();
    expect(played.window.pages).toHaveLength(2);
    played.window.page().load();
    await played.settle();
    await expectResumed(played);
  });

  test("not paused, a capture starts with the microphone open, once", async () => {
    const played = await call();
    await played.core.startMeeting({ meetingId: played.id });
    played.window.page().load();
    await played.settle();
    expect(played.window.page().opens).toBe(1);
    expect(played.window.page().isOpen()).toBe(true);
    await played.play(2);
    expect(played.microphoneSamples.sent).toBeGreaterThan(0);
  });
});
