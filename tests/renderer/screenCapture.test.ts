import { afterEach, expect, test, vi } from "vitest";
import { serveScreen } from "../../src/renderer/capture/screen";
import type { CaptureBridge } from "../../src/shared/capture";

function environment() {
  let start: (selection: number) => void = () => {};
  let stop: (selection: number) => void = () => {};
  let grab: (selection: number, id: number, preview: boolean) => void = () => {};
  const started = vi.fn();
  const frame = vi.fn();
  const ended = vi.fn();
  const bridge: Pick<
    CaptureBridge,
    | "onScreenStart"
    | "onScreenGrab"
    | "onScreenStop"
    | "screenSample"
    | "screenFrame"
    | "screenStarted"
    | "screenEnded"
  > = {
    onScreenStart: (cb) => {
      start = cb;
    },
    onScreenStop: (cb) => {
      stop = cb;
    },
    onScreenGrab: (cb) => {
      grab = cb;
    },
    screenStarted: started,
    screenSample: vi.fn(),
    screenFrame: frame,
    screenEnded: ended,
  };
  const media = vi.fn();
  const videos: {
    srcObject: unknown;
    onloadedmetadata: (() => void) | null;
    videoWidth: number;
    play: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: media } });
  vi.stubGlobal("document", {
    createElement: () => {
      const element = {
        srcObject: null,
        onloadedmetadata: null,
        videoWidth: 0,
        play: vi.fn(() => Promise.resolve()),
      };
      videos.push(element);
      return element;
    },
  });
  serveScreen(bridge);
  return { start, stop, grab, media, videos, started, frame, ended };
}

const stream = () => {
  const track = { stop: vi.fn(), getSettings: () => ({ displaySurface: "window" }) };
  return { track, captured: { getVideoTracks: () => [track], getTracks: () => [track] } };
};
afterEach(() => vi.unstubAllGlobals());

test("Stop releases a track that arrives after the user withdrew the selected window", async () => {
  const test = environment();
  const first = stream();
  const media = Promise.withResolvers<typeof first.captured>();
  test.media.mockReturnValue(media.promise);
  test.start(1);
  test.stop(1);
  media.resolve(first.captured);
  await vi.waitFor(() => expect(first.track.stop).toHaveBeenCalledOnce());
  expect(test.videos).toHaveLength(0);
  expect(test.started).not.toHaveBeenCalled();
  test.grab(1, 1, true);
  expect(test.frame).not.toHaveBeenCalled();
});

test.each(["metadata", "play"] as const)(
  "changing selection during %s never starts or captures the previous window",
  async (stage) => {
    const test = environment();
    const first = stream();
    const second = stream();
    test.media.mockResolvedValueOnce(first.captured).mockResolvedValueOnce(second.captured);
    test.start(1);
    await vi.waitFor(() => expect(test.videos).toHaveLength(1));
    const previous = test.videos[0];
    if (!previous) throw new Error("Missing first video");
    const play = Promise.withResolvers<void>();
    previous.play.mockReturnValue(play.promise);
    if (stage === "play") {
      previous.onloadedmetadata?.();
      await vi.waitFor(() => expect(previous.play).toHaveBeenCalledOnce());
    }
    test.start(2);
    await vi.waitFor(() => expect(test.videos).toHaveLength(2));
    expect(first.track.stop).toHaveBeenCalledOnce();
    previous.onloadedmetadata?.();
    play.resolve();
    test.videos[1]?.onloadedmetadata?.();
    await vi.waitFor(() => expect(test.started).toHaveBeenCalledWith(2, { started: true }));
    test.stop(1);
    test.grab(1, 7, false);
    expect(test.frame).not.toHaveBeenCalled();
    expect(test.started).toHaveBeenCalledTimes(1);
    expect(second.track.stop).not.toHaveBeenCalled();
    test.stop(2);
    expect(second.track.stop).toHaveBeenCalledOnce();
  },
);
