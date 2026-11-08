import { create } from "zustand";
import { core } from "./core";

/**
 * Playing a stopped Meeting's audio from a word of its Transcript (#138): stretches of it read
 * from the core as they are needed, the microphone and the computer's sound mixed, played one
 * after the other through Web Audio. One plays at a time, in one window.
 */

/** How much is read from the core at a time. */
const STRETCH_MS = 20_000;
/** The next stretch is asked for while this much of the one playing is left. */
const AHEAD_MS = 5_000;
/** How often the place shown moves on. */
const TICK_MS = 100;

export interface TranscriptPlayback {
  meetingId: string;
  /** The view it was started from, which shows its player and stops it when it goes. */
  owner: string;
  /** Where in the Meeting's time it is, in ms. */
  positionMs: number;
  /** How long the Meeting's audio is. */
  durationMs: number;
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
}

let engine: Engine | null = null;

interface PlayerState {
  playback: TranscriptPlayback | null;
  play(meetingId: string, fromMs: number, durationMs: number, owner: string): Promise<void>;
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
  /** Reads the next stretch and puts it after what is already scheduled. */
  async function queue(running: Engine, meetingId: string, durationMs: number): Promise<void> {
    if (running.reading || running.queuedToMs >= durationMs) return;
    running.reading = true;
    try {
      const stretch = await core.readMeetingAudio({
        meetingId,
        fromMs: running.queuedToMs,
        toMs: Math.min(durationMs, running.queuedToMs + STRETCH_MS),
      });
      if (engine !== running) return;
      running.queuedToMs = stretch.toMs;
      // Less than a sample: nothing to play, and a buffer can't be empty.
      if (stretch.samples.length === 0) return;
      const buffer = running.context.createBuffer(1, stretch.samples.length, stretch.sampleRate);
      buffer.copyToChannel(stretch.samples, 0);
      const source = running.context.createBufferSource();
      source.buffer = buffer;
      source.connect(running.context.destination);
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

    async play(meetingId, fromMs, durationMs, owner) {
      close(engine);
      engine = null;
      const start = Math.max(0, Math.min(fromMs, durationMs));
      const playback = { meetingId, owner, positionMs: start, durationMs };
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
        timer: setInterval(() => {
          if (engine !== running) return;
          const playback = get().playback;
          if (!playback?.playing) return;
          const positionMs = Math.min(placeOf(running), durationMs);
          set({ playback: { ...playback, positionMs } });
          if (positionMs >= durationMs) {
            void context.suspend();
            set({ playback: { ...playback, positionMs, playing: false } });
          } else if (running.queuedToMs - positionMs < AHEAD_MS) {
            void queue(running, meetingId, durationMs);
          }
        }, TICK_MS),
      };
      engine = running;
      await queue(running, meetingId, durationMs);
    },

    async toggle() {
      const playback = get().playback;
      if (!playback || !engine) {
        if (playback && !playback.failure) {
          const { meetingId, positionMs, durationMs, owner } = playback;
          await get().play(meetingId, positionMs, durationMs, owner);
        }
        return;
      }
      // Shown at once; the sound follows as the context gets there.
      if (playback.playing) {
        const positionMs = Math.min(placeOf(engine), playback.durationMs);
        set({ playback: { ...playback, positionMs, playing: false } });
        await engine.context.suspend();
      } else if (playback.positionMs >= playback.durationMs) {
        await get().play(playback.meetingId, 0, playback.durationMs, playback.owner);
      } else {
        set({ playback: { ...playback, playing: true } });
        await engine.context.resume();
      }
    },

    stop() {
      close(engine);
      engine = null;
      set({ playback: null });
    },
  };
});
