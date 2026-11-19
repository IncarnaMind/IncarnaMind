import { create } from "zustand";
import { core } from "./core";

/**
 * Playing a stopped Meeting's audio from a word of its Transcript (#138): stretches of it read
 * from the core as they are needed, played one after the other through Web Audio. The speaker
 * review listens to just the computer sound for the line. One plays at a time, in one window.
 */

/** How much is read from the core at a time. */
const STRETCH_MS = 20_000;
/** The next stretch is asked for while this much of the one playing is left. */
const AHEAD_MS = 5_000;
/** How often the place shown moves on. */
const TICK_MS = 100;

interface TranscriptClip {
  startMs: number;
  endMs: number;
  source: "system";
}

export interface TranscriptPlayback {
  meetingId: string;
  /** The view it was started from, which shows its player and stops it when it goes. */
  owner: string;
  /** Where in the Meeting's time it is, in ms. */
  positionMs: number;
  /** How long the Meeting's audio is. */
  durationMs: number;
  clip?: TranscriptClip;
  playing: boolean;
  /** Why it stopped, when its audio couldn't be read: an error from the core. */
  failure: unknown;
}

interface Engine {
  context: AudioContext;
  /** The Meeting's time at the context's time `startedAt`. */
  fromMs: number;
  startedAt: number;
  /** Where in the Meeting's time what is scheduled so far ends. */
  queuedToMs: number;
  sources: AudioBufferSourceNode[];
  timer: ReturnType<typeof setInterval>;
  reading: boolean;
  buffering: boolean;
}

let engine: Engine | null = null;

interface PlayerState {
  playback: TranscriptPlayback | null;
  play(
    meetingId: string,
    fromMs: number,
    durationMs: number,
    owner: string,
    clip?: TranscriptClip,
  ): Promise<void>;
  toggle(): Promise<void>;
  stop(): void;
}

const placeOf = (running: Engine) =>
  running.fromMs + (running.context.currentTime - running.startedAt) * 1000;

function close(running: Engine | null): void {
  if (!running) return;
  clearInterval(running.timer);
  for (const source of running.sources) source.stop();
  void running.context.close();
}

export const useTranscriptPlayer = create<PlayerState>((set, get) => {
  function reachedEnd(running: Engine, endMs: number): void {
    const playback = get().playback;
    if (engine !== running || !playback) return;
    set({ playback: { ...playback, positionMs: endMs, playing: false } });
    void running.context.suspend();
  }

  /** Reads the next stretch and puts it after what is already scheduled. */
  async function queue(
    running: Engine,
    meetingId: string,
    endMs: number,
    audioSource?: TranscriptClip["source"],
  ): Promise<void> {
    if (running.reading || running.queuedToMs >= endMs) return;
    running.reading = true;
    try {
      const stretch = await core.readMeetingAudio({
        meetingId,
        fromMs: running.queuedToMs,
        toMs: Math.min(endMs, running.queuedToMs + STRETCH_MS),
        ...(audioSource && { source: audioSource }),
      });
      if (engine !== running) return;
      running.queuedToMs = stretch.toMs;
      // Less than a sample: nothing to play, and a buffer can't be empty.
      if (stretch.samples.length === 0) {
        if (audioSource) reachedEnd(running, endMs);
        return;
      }
      const buffer = running.context.createBuffer(1, stretch.samples.length, stretch.sampleRate);
      buffer.copyToChannel(stretch.samples, 0);
      const source = running.context.createBufferSource();
      source.buffer = buffer;
      source.connect(running.context.destination);
      if (audioSource && stretch.toMs >= endMs) {
        source.addEventListener("ended", () => reachedEnd(running, endMs), { once: true });
      }
      source.start(running.startedAt + (stretch.fromMs - running.fromMs) / 1000);
      running.sources.push(source);
    } catch (failure) {
      if (engine !== running) return;
      console.error(`The audio of Meeting ${meetingId} couldn't be read to play it.`, failure);
      close(running);
      engine = null;
      const playback = get().playback;
      if (playback) set({ playback: { ...playback, playing: false, failure } });
    } finally {
      running.reading = false;
    }
  }

  return {
    playback: null,

    async play(meetingId, fromMs, durationMs, owner, clip) {
      const endMs = clip ? Math.min(clip.endMs, durationMs) : durationMs;
      const start = Math.max(0, clip?.startMs ?? 0, Math.min(fromMs, endMs));
      if (clip && endMs <= start) return;
      close(engine);
      engine = null;
      const playback = { meetingId, owner, positionMs: start, durationMs, clip };
      set({ playback: { ...playback, playing: true, failure: null } });
      let context: AudioContext;
      try {
        context = new AudioContext();
      } catch (failure) {
        console.error("The window couldn't play sound.", failure);
        set({ playback: { ...playback, playing: false, failure } });
        return;
      }
      const running: Engine = {
        context,
        fromMs: start,
        startedAt: context.currentTime,
        queuedToMs: start,
        sources: [],
        reading: false,
        buffering: clip !== undefined,
        timer: setInterval(() => {
          if (engine !== running) return;
          const playback = get().playback;
          if (!playback?.playing) return;
          const positionMs = Math.min(placeOf(running), endMs);
          if (positionMs >= endMs) {
            reachedEnd(running, endMs);
            return;
          }
          set({ playback: { ...playback, positionMs } });
          if (running.queuedToMs - positionMs < AHEAD_MS)
            void queue(running, meetingId, endMs, clip?.source);
        }, TICK_MS),
      };
      engine = running;
      if (clip) await context.suspend();
      if (engine !== running) return;
      await queue(running, meetingId, endMs, clip?.source);
      running.buffering = false;
      if (clip && engine === running && get().playback?.playing) await context.resume();
    },

    async toggle() {
      const playback = get().playback;
      if (!playback || !engine) {
        if (playback && !playback.failure) {
          const { meetingId, positionMs, durationMs, owner, clip } = playback;
          await get().play(meetingId, positionMs, durationMs, owner, clip);
        }
        return;
      }
      const { meetingId, clip, durationMs, owner } = playback;
      const endMs = clip ? Math.min(clip.endMs, durationMs) : durationMs;
      // Shown at once; the sound follows as the context gets there.
      if (playback.playing) {
        const positionMs = Math.min(placeOf(engine), endMs);
        set({ playback: { ...playback, positionMs, playing: false } });
        await engine.context.suspend();
      } else if (playback.positionMs >= endMs) {
        await get().play(meetingId, clip?.startMs ?? 0, durationMs, owner, clip);
      } else {
        set({ playback: { ...playback, playing: true } });
        if (!engine.buffering) await engine.context.resume();
      }
    },

    stop() {
      close(engine);
      engine = null;
      set({ playback: null });
    },
  };
});
