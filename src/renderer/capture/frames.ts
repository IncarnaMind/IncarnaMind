/**
 * Turns a track's audio, at the rate and channels its device gives, into the Meeting's 16 kHz
 * mono frames of 100 ms (ADR-0015). The channels are averaged, and the rate is changed with a
 * windowed-sinc filter whose cutoff is under the lower of the two Nyquist frequencies, so no
 * sound above what 16 kHz holds folds back into the speech.
 */

export const FRAME_SAMPLE_RATE = 16_000;
/** 100 ms at 16 kHz. */
const FRAME = 1600;
/** The filter's zero crossings on each side of its centre. */
const ZERO_CROSSINGS = 16;
/** Its cutoff, as a share of the lower Nyquist frequency: room for the window's slope. */
const CUTOFF = 0.9;

export interface Frames {
  /** Takes one block of a track's audio: an array of samples per channel, each as long. */
  push(channels: readonly Float32Array[], sampleRate: number): void;
  /** Sends what it holds, however short; the track's audio has ended. */
  flush(): void;
}

export function createFrames(send: (frame: Float32Array) => void): Frames {
  let resampler: Resampler | null = null;
  let rate = 0;
  let frame = new Float32Array(FRAME);
  let filled = 0;

  const add = (samples: Float32Array) => {
    let at = 0;
    while (at < samples.length) {
      const taken = Math.min(samples.length - at, FRAME - filled);
      frame.set(samples.subarray(at, at + taken), filled);
      filled += taken;
      at += taken;
      if (filled === FRAME) {
        send(frame);
        frame = new Float32Array(FRAME);
        filled = 0;
      }
    }
  };

  return {
    push(channels, sampleRate) {
      const mono = mixed(channels);
      if (mono.length === 0) return;
      if (!resampler || sampleRate !== rate) {
        if (resampler) add(resampler.end());
        resampler = createResampler(sampleRate, FRAME_SAMPLE_RATE);
        rate = sampleRate;
      }
      add(resampler.push(mono));
    },
    flush() {
      if (resampler) add(resampler.end());
      resampler = null;
      if (filled > 0) send(frame.slice(0, filled));
      frame = new Float32Array(FRAME);
      filled = 0;
    },
  };
}

function mixed(channels: readonly Float32Array[]): Float32Array {
  const [first] = channels;
  if (!first || channels.length === 1) return first ?? new Float32Array(0);
  const out = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
  }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / channels.length;
  return out;
}

interface Resampler {
  /** Takes the next samples and returns the ones it can make from what it has so far. */
  push(samples: Float32Array): Float32Array;
  /** Returns the rest, as if silence followed, and starts again. */
  end(): Float32Array;
}

interface Kernel {
  /** Where its first tap sits, from the input sample before the output's position. */
  first: number;
  taps: Float32Array;
}

function createResampler(from: number, to: number): Resampler {
  if (from === to) return { push: (samples) => samples, end: () => new Float32Array(0) };
  // In cycles per input sample.
  const cutoff = 0.5 * CUTOFF * Math.min(1, to / from);
  const half = ZERO_CROSSINGS / (2 * cutoff);
  // An output's position falls between input samples at one of `to / gcd(from, to)` phases.
  const kernels = new Map<number, Kernel>();
  const kernelAt = (phase: number): Kernel => {
    const known = kernels.get(phase);
    if (known) return known;
    const offset = phase / to;
    const first = Math.ceil(offset - half);
    const taps = new Float32Array(Math.floor(offset + half) - first + 1);
    let sum = 0;
    for (let j = 0; j < taps.length; j++) {
      const distance = first + j - offset;
      const x = 2 * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = distance / half;
      const blackman = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      taps[j] = sinc * blackman;
      sum += taps[j] ?? 0;
    }
    for (let j = 0; j < taps.length; j++) taps[j] = (taps[j] ?? 0) / sum;
    const kernel = { first, taps };
    kernels.set(phase, kernel);
    return kernel;
  };

  // `held` keeps the input from sample `start` on; `taken` samples have come in all told.
  let held = new Float32Array(0);
  let start = 0;
  let taken = 0;
  let made = 0;

  const make = (ending: boolean): Float32Array => {
    const out: number[] = [];
    const last = ending ? Math.ceil((taken * to) / from) : Number.POSITIVE_INFINITY;
    while (made < last) {
      const position = made * from;
      const before = Math.floor(position / to);
      const kernel = kernelAt(position - before * to);
      const from0 = before + kernel.first;
      if (!ending && from0 + kernel.taps.length > taken) break;
      let sum = 0;
      for (let j = 0; j < kernel.taps.length; j++) {
        const index = from0 + j;
        if (index < 0 || index >= taken) continue;
        sum += (kernel.taps[j] ?? 0) * (held[index - start] ?? 0);
      }
      out.push(sum);
      made += 1;
    }
    const keepFrom = Math.max(start, Math.floor((made * from) / to) + Math.ceil(-half));
    held = held.slice(keepFrom - start);
    start = keepFrom;
    return Float32Array.from(out);
  };

  return {
    push(samples) {
      const next = new Float32Array(held.length + samples.length);
      next.set(held);
      next.set(samples, held.length);
      held = next;
      taken += samples.length;
      return make(false);
    },
    end() {
      const rest = make(true);
      held = new Float32Array(0);
      start = 0;
      taken = 0;
      made = 0;
      return rest;
    },
  };
}
