import { expect, test, vi } from "vitest";
import type { CaptureBridge } from "../../src/shared/capture";

test("a default input change during microphone permission is applied to the granted track", async () => {
  const permission = Promise.withResolvers<void>();
  const firstRequest = Promise.withResolvers<void>();
  const opened: string[] = [];
  const closed: string[] = [];
  let defaultInput = "laptop";
  const devices = Object.assign(new EventTarget(), {
    enumerateDevices: async () => [{ kind: "audioinput", deviceId: defaultInput }],
    async getUserMedia() {
      const deviceId = defaultInput;
      opened.push(deviceId);
      if (opened.length === 1) {
        firstRequest.resolve();
        await permission.promise;
      }
      const track = {
        readyState: "live",
        muted: false,
        getSettings: () => ({ deviceId }),
        stop: () => closed.push(deviceId),
      };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  });
  const onStart = vi.fn<CaptureBridge["onStart"]>();
  const onStop = vi.fn<CaptureBridge["onStop"]>();
  const stopped = Promise.withResolvers<void>();
  vi.stubGlobal("navigator", { mediaDevices: devices });
  vi.stubGlobal("window", {
    incarnamindCapture: {
      onStart,
      onStop,
      stopped: stopped.resolve,
      state: vi.fn(),
      onMicrophone: vi.fn(),
      onScreenStart: vi.fn(),
      onScreenStop: vi.fn(),
      onScreenGrab: vi.fn(),
    },
  });
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = new ReadableStream({ start: (stream) => stream.close() });
    },
  );

  try {
    await import("../../src/renderer/capture/capture");
    const start = onStart.mock.calls[0]?.[0];
    const stop = onStop.mock.calls[0]?.[0];
    if (!start || !stop) throw new Error("Expected the recording controls.");
    start({ microphone: true, microphoneOn: true, systemAudio: false });
    await firstRequest.promise;
    defaultInput = "headset";
    devices.dispatchEvent(new Event("devicechange"));
    permission.resolve();
    await vi.waitFor(() => expect(opened).toEqual(["laptop", "headset"]));
    expect(closed).toEqual(["laptop"]);
    stop();
    await stopped.promise;
    expect(closed).toEqual(["laptop", "headset"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
