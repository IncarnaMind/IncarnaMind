import { describe, expect, test } from "vitest";
import {
  createMicrophone,
  type MicrophoneDevice,
  startMicrophone,
} from "../../src/renderer/capture/microphone";
import { createMicrophoneRelay } from "../../src/shared/capture";

/** A promise a test settles by hand, as a permission prompt or a page that is still starting does. */
function gate() {
  let release = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

/**
 * A microphone that opens only once its gate is released, as the capture page's does while its
 * AudioContext loads or the User is asked. It records what was done to it. `careless` opens
 * whatever happens meanwhile; otherwise it leaves itself closed when it is no longer wanted by
 * the time it is granted, as the page's does.
 */
function fakeDevice({ careless = false } = {}) {
  const log: string[] = [];
  const gates: ReturnType<typeof gate>[] = [];
  let isOpen = false;
  const device: MicrophoneDevice = {
    isOpen: () => isOpen,
    async open(stillWanted) {
      log.push("open asked");
      const waiting = gate();
      gates.push(waiting);
      await waiting.open;
      if (!careless && !stillWanted()) {
        log.push("left closed");
        return;
      }
      isOpen = true;
      log.push("open");
    },
    async close() {
      isOpen = false;
      log.push("close");
    },
  };
  return {
    device,
    log,
    isOpen: () => isOpen,
    grant: (n: number) => gates[n]?.release(),
    asked: () => gates.length,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("The capture page's microphone, and a pause while it starts", () => {
  test("a pause that comes with the start opens nothing, and the microphone is never on", async () => {
    const fake = fakeDevice();
    const microphone = createMicrophone(fake.device);
    const started = microphone.start(true);
    const paused = microphone.set(false);
    await flush();
    fake.grant(0);
    await Promise.all([started, paused]);
    expect(fake.asked()).toBe(0);
    expect(fake.isOpen()).toBe(false);
    expect(fake.log).toEqual([]);
  });

  test("a pause while the open is being granted leaves the microphone closed, however the device behaves", async () => {
    for (const careless of [false, true]) {
      const fake = fakeDevice({ careless });
      const microphone = createMicrophone(fake.device);
      const started = microphone.start(true);
      await flush();
      expect(fake.asked()).toBe(1);

      const paused = microphone.set(false);
      fake.grant(0);
      await Promise.all([started, paused]);
      expect(fake.isOpen(), `careless: ${careless}`).toBe(false);
      // A careless device was on for the moment between its grant and the pause being looked at.
      expect(fake.log.at(-1)).toMatch(/left closed|close/);
    }
  });

  test("pause, resume and pause again during a slow start ends paused, and every pause is followed by a closed microphone", async () => {
    const fake = fakeDevice({ careless: true });
    const microphone = createMicrophone(fake.device);
    const started = microphone.start(true);
    await flush();

    const first = microphone.set(false);
    const resumed = microphone.set(true);
    const second = microphone.set(false);
    fake.grant(0);
    await Promise.all([started, first, resumed, second]);
    expect(fake.isOpen()).toBe(false);
    expect(fake.asked()).toBe(1);

    const on = microphone.set(true);
    await flush();
    fake.grant(1);
    await on;
    expect(fake.isOpen()).toBe(true);
    await microphone.set(false);
    expect(fake.isOpen()).toBe(false);
  });

  test("pause, then resume, during a slow start ends on, opened once", async () => {
    const fake = fakeDevice();
    const microphone = createMicrophone(fake.device);
    const started = microphone.start(true);
    await flush();
    const paused = microphone.set(false);
    const resumed = microphone.set(true);
    fake.grant(0);
    await Promise.all([started, paused, resumed]);
    expect(fake.isOpen()).toBe(true);
    expect(fake.asked()).toBe(1);
  });

  test("a default input that changes while it is paused opens nothing, and while it is on, opens it again", async () => {
    const fake = fakeDevice();
    const microphone = createMicrophone(fake.device);
    const started = microphone.start(true);
    await flush();
    fake.grant(0);
    await started;
    expect(fake.isOpen()).toBe(true);

    const reopened = microphone.reopen();
    await flush();
    fake.grant(1);
    await reopened;
    expect(fake.isOpen()).toBe(true);
    expect(fake.asked()).toBe(2);

    await microphone.set(false);
    await microphone.reopen();
    expect(fake.isOpen()).toBe(false);
    expect(fake.asked()).toBe(2);
  });

  test("a device that went while the call was paused isn't opened again by the change that follows the pause", async () => {
    const fake = fakeDevice();
    const microphone = createMicrophone(fake.device);
    const started = microphone.start(true);
    await flush();
    fake.grant(0);
    await started;
    const paused = microphone.set(false);
    const reopened = microphone.reopen();
    await Promise.all([paused, reopened]);
    expect(fake.isOpen()).toBe(false);
    expect(fake.asked()).toBe(1);
  });

  test("once the capture is stopped, nothing that was queued opens it", async () => {
    const fake = fakeDevice({ careless: true });
    const microphone = createMicrophone(fake.device);
    const started = microphone.start(true);
    await flush();
    const resumed = microphone.set(true);
    const stopped = microphone.stop();
    fake.grant(0);
    await Promise.all([started, resumed, stopped]);
    expect(fake.asked()).toBe(1);
    await microphone.set(true);
    expect(fake.asked()).toBe(1);
  });

  test("a start that is already paused opens nothing, and the resume after it opens the microphone once", async () => {
    const fake = fakeDevice();
    const microphone = createMicrophone(fake.device);
    await microphone.start(false);
    expect(fake.asked()).toBe(0);

    const resumed = microphone.set(true);
    await flush();
    expect(fake.asked()).toBe(1);
    fake.grant(0);
    await resumed;
    expect(fake.isOpen()).toBe(true);
    expect(fake.asked()).toBe(1);

    await microphone.set(true);
    expect(fake.asked()).toBe(1);
  });
});

describe("What the main process tells the capture page about the microphone", () => {
  function pageOf(fake: ReturnType<typeof fakeDevice>) {
    const microphone = createMicrophone(fake.device);
    const messages: string[] = [];
    const relay = createMicrophoneRelay({
      start: (request) => {
        messages.push(
          `start ${request.microphone ? "allowed" : "refused"} ${request.microphoneOn ? "on" : "paused"}`,
        );
        void startMicrophone(microphone, request);
      },
      microphone: (on) => {
        messages.push(on ? "on" : "off");
        void microphone.set(on);
      },
    });
    return { relay, messages };
  }

  test("a pause before the page started comes with its start, and the resume after it opens the microphone once", async () => {
    const fake = fakeDevice();
    const { relay, messages } = pageOf(fake);
    relay.set(false);
    relay.start({ microphone: true, systemAudio: true });
    await flush();
    expect(messages).toEqual(["start allowed paused"]);
    expect(fake.asked()).toBe(0);

    relay.set(true);
    await flush();
    expect(messages).toEqual(["start allowed paused", "on"]);
    expect(fake.asked()).toBe(1);
    fake.grant(0);
    await flush();
    expect(fake.isOpen()).toBe(true);
  });

  test("a microphone the OS refused isn't opened by a start or by a resume", async () => {
    const fake = fakeDevice();
    const { relay } = pageOf(fake);
    relay.start({ microphone: false, systemAudio: true });
    relay.set(false);
    relay.set(true);
    await flush();
    expect(fake.asked()).toBe(0);
  });

  test("a pause or a resume after the start goes on as it comes, and before it, only the last is kept", async () => {
    const fake = fakeDevice();
    const { relay, messages } = pageOf(fake);
    relay.set(false);
    relay.set(true);
    relay.start({ microphone: true, systemAudio: false });
    await flush();
    expect(messages).toEqual(["start allowed on"]);
    expect(fake.asked()).toBe(1);
    fake.grant(0);
    await flush();
    relay.set(false);
    await flush();
    expect(messages).toEqual(["start allowed on", "off"]);
    expect(fake.isOpen()).toBe(false);
  });
});
