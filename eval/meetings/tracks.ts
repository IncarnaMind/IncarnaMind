import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";

export interface Clip {
  /** Seconds from the start of the recording. */
  start: number;
  samples: Float32Array;
}

const sampleAt = (seconds: number) => Math.round(seconds * MEETING_SAMPLE_RATE);

/**
 * Silence the length of the recording with each clip written at its time. Clips cut from one
 * recording agree wherever they overlap, so a later one simply replaces the earlier.
 */
export function placeClips(clips: readonly Clip[], length: number): Float32Array {
  const out = new Float32Array(length);
  for (const clip of clips) {
    const at = sampleAt(clip.start);
    out.set(clip.samples.subarray(0, Math.max(0, length - at)), at);
  }
  return out;
}

export function overlayClips(clips: readonly Clip[], length: number): Float32Array {
  const out = new Float32Array(length);
  for (const clip of clips) {
    const at = sampleAt(clip.start);
    const count = Math.min(clip.samples.length, length - at);
    for (let i = 0; i < count; i++)
      out[at + i] = (out[at + i] as number) + (clip.samples[i] as number);
  }
  return out;
}

/** The tracks added up, turned down as a whole only if the sum would clip. */
export function mixTracks(tracks: readonly Float32Array[]): Float32Array {
  const length = tracks.reduce((most, track) => Math.max(most, track.length), 0);
  const out = new Float32Array(length);
  for (const track of tracks) {
    for (let i = 0; i < track.length; i++) out[i] = (out[i] as number) + (track[i] as number);
  }
  let peak = 0;
  for (const sample of out) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0.99) {
    const gain = Math.fround(0.99 / peak);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * gain;
  }
  return out;
}

const FADE_SECONDS = 0.01;

/**
 * The track with everything outside the turns, widened by `margin` seconds each side, silenced
 * (with 10 ms fades), so that nobody's voice leaks into another person's track.
 */
export function gateTurns(
  track: Float32Array,
  turns: readonly { start: number; end: number }[],
  margin: number,
): Float32Array {
  const gain = new Float32Array(track.length);
  const fade = sampleAt(FADE_SECONDS);
  for (const turn of turns) {
    const from = Math.max(0, sampleAt(turn.start - margin));
    const to = Math.min(track.length, sampleAt(turn.end + margin));
    for (let i = Math.max(0, from - fade); i < Math.min(track.length, to + fade); i++) {
      const ramp = Math.min(1, (i - (from - fade)) / fade, (to + fade - i) / fade);
      if (ramp > (gain[i] as number)) gain[i] = Math.fround(ramp);
    }
  }
  const out = new Float32Array(track.length);
  for (let i = 0; i < track.length; i++) out[i] = (track[i] as number) * (gain[i] as number);
  return out;
}

export function onlineTracks(bySpeaker: ReadonlyMap<string, Float32Array>, me: string) {
  const mic = bySpeaker.get(me);
  if (!mic) throw new Error(`No track for ${me}.`);
  const others = [...bySpeaker.keys()]
    .filter((speaker) => speaker !== me)
    .sort()
    .map((speaker) => bySpeaker.get(speaker) as Float32Array);
  return { mic, system: mixTracks(others) };
}
