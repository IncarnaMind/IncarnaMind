import { describe, expect, test } from "vitest";
import { createFrames, FRAME_SAMPLE_RATE } from "../../src/renderer/capture/frames";

function tone(hz: number, rate: number, seconds: number, level = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = level * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Pushes `channels` in blocks of `sizes` (repeated), as a device gives them, and flushes. */
function capture(channels: Float32Array[], rate: number, sizes: number[] = [rate / 100]) {
  const frames: Float32Array[] = [];
  const into = createFrames((frame) => frames.push(frame.slice()));
  const length = channels[0]?.length ?? 0;
  for (let at = 0, n = 0; at < length; n++) {
    const size = Math.min(sizes[n % sizes.length] ?? length, length - at);
    into.push(
      channels.map((channel) => channel.slice(at, at + size)),
      rate,
    );
    at += size;
  }
  into.flush();
  const all = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    all.set(frame, at);
    at += frame.length;
  }
  return { frames, all };
}

/**
 * The largest difference from `hz` at `level` between `from` and `to`, by default away from the
 * edges, where the filter can't see past the audio's start or end.
 */
function deviation(
  samples: Float32Array,
  hz: number,
  from = 200,
  to = samples.length - 200,
): number {
  const level = 0.5;
  let worst = 0;
  for (let i = from; i < to; i++) {
    const expected = level * Math.sin((2 * Math.PI * hz * i) / FRAME_SAMPLE_RATE);
    worst = Math.max(worst, Math.abs((samples[i] ?? 0) - expected));
  }
  return worst;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 200; i < samples.length - 200; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / (samples.length - 400));
}

describe("the capture's frames", () => {
  test.each([
    [48_000, 3000],
    [44_100, 3000],
    [96_000, 3000],
    [22_050, 3000],
    [8_000, 1000],
  ])("a voice's pitch and level at %i Hz come out at 16 kHz, in frames of 100 ms", (rate, high) => {
    const { frames, all } = capture([tone(440, rate, 1)], rate);
    expect(all.length).toBe(FRAME_SAMPLE_RATE);
    expect(frames.slice(0, -1).every((frame) => frame.length === 1600)).toBe(true);
    expect(deviation(all, 440)).toBeLessThan(0.005);
    expect(deviation(capture([tone(high, rate, 1)], rate).all, high)).toBeLessThan(0.01);
  });

  test.each([
    [48_000, 12_000],
    [44_100, 10_000],
    [96_000, 30_000],
  ])(
    "at %i Hz, a %i Hz sound that 16 kHz can't hold doesn't fold back into the speech",
    (rate, hz) => {
      expect(rms(capture([tone(hz, rate, 1)], rate).all)).toBeLessThan(0.5 * 0.01);
    },
  );

  test("how the device cuts its blocks doesn't change what comes out", () => {
    const voice = tone(440, 44_100, 1);
    const whole = capture([voice], 44_100, [voice.length]).all;
    const cut = capture([voice], 44_100, [441, 1, 97, 1024, 3]).all;
    expect(cut.length).toBe(whole.length);
    let worst = 0;
    for (let i = 0; i < whole.length; i++)
      worst = Math.max(worst, Math.abs((cut[i] ?? 0) - (whole[i] ?? 0)));
    expect(worst).toBeLessThan(1e-6);
  });

  test("two channels are mixed to one", () => {
    const voice = tone(440, 48_000, 1);
    expect(deviation(capture([voice, voice], 48_000).all, 440)).toBeLessThan(0.005);
    const opposite = voice.map((sample) => -sample);
    expect(rms(capture([voice, opposite], 48_000).all)).toBe(0);
  });

  test("16 kHz goes through as it came", () => {
    const voice = tone(440, 16_000, 0.35);
    const { frames, all } = capture([voice], 16_000, [160]);
    expect(frames.map((frame) => frame.length)).toEqual([1600, 1600, 1600, 800]);
    expect(all).toEqual(voice);
  });

  test("a device that changes its rate part way keeps the time and the voice", () => {
    const frames: Float32Array[] = [];
    const into = createFrames((frame) => frames.push(frame.slice()));
    into.push([tone(440, 48_000, 0.5)], 48_000);
    into.push([tone(440, 44_100, 0.5)], 44_100);
    into.flush();
    const all = Float32Array.from(frames.flatMap((frame) => [...frame]));
    expect(all.length).toBe(FRAME_SAMPLE_RATE);
    expect(deviation(all, 440, 200, 7700)).toBeLessThan(0.005);
    expect(deviation(all, 440, 8300, 15_800)).toBeLessThan(0.005);
  });

  test("flush sends what is held, once, and the next audio starts afresh", () => {
    const frames: Float32Array[] = [];
    const into = createFrames((frame) => frames.push(frame.slice()));
    into.push([tone(440, 48_000, 0.05)], 48_000);
    expect(frames).toEqual([]);
    into.flush();
    expect(frames.map((frame) => frame.length)).toEqual([800]);
    into.flush();
    expect(frames).toHaveLength(1);
    into.push([tone(440, 48_000, 0.1)], 48_000);
    into.flush();
    expect(frames.map((frame) => frame.length)).toEqual([800, 1600]);
  });
});
