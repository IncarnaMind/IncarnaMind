/**
 * After the call, a Meeting's speakers told apart from its audio while it is kept (#138), as
 * DESIGN.md › Speakers words them: in a call the microphone stays "Me", and the other side is
 * "Them" while one voice speaks and "Speaker 1, 2…" when several do; in a room every voice is
 * "Speaker 1, 2…". When the pass can't tell the voices apart, every line keeps the label of
 * where it came from.
 *
 * While the Meeting records, what is saved of the side to tell apart is clustered again now and
 * then, kept in memory only, so at Stop only what came after the last run is left to cluster,
 * and its voices join the earlier ones by voiceprint (#2839). Fixed short windows lost lines'
 * speakers; clustering everything so far again held them.
 */
import { numberedVoice, SPEAKER_ME, SPEAKER_THEM, SPEAKER_UNKNOWN } from "../../shared/speakers";
import type { ClusteredVoices, Logger, SpeakerSeparator, VoiceTurn } from "../adapters";
import type { AudioSource } from "../api";
import type { Cue } from "../documents/formats/vtt";
import type { SpeakerModel } from "../transcription/speakerModel";
import { joinedTurns } from "../transcription/voiceprints";
import type { AudioPart } from "./audioFiles";

/** Less of the lines' speech than this in a voice, and the pass is taken as having failed. */
const MIN_COVERED = 0.5;

/** A call has the computer's sound: its lines say "Me" or "Them". */
export const isCall = (cues: readonly Cue[]) =>
  cues.some((cue) => cue.speaker === SPEAKER_ME || cue.speaker === SPEAKER_THEM);

/** The source whose voices the pass tells apart: the other side in a call, the room otherwise. */
export const sourceToSeparate = (call: boolean): AudioSource => (call ? "system" : "microphone");

const overlap = (cue: Cue, turn: VoiceTurn) =>
  Math.max(0, Math.min(cue.endMs, turn.endMs) - Math.max(cue.startMs, turn.startMs));

const distance = (cue: Cue, turn: VoiceTurn) =>
  Math.max(0, turn.startMs - cue.endMs, cue.startMs - turn.endMs);

/**
 * The lines with the voices the pass found, or null when too little of their speech has a
 * voice to trust it. Each line takes the voice it overlaps most, and a line no voice overlaps
 * takes the nearest one's, so no line is left with the label the others lost.
 */
export function labelled(
  cues: readonly Cue[],
  turns: readonly VoiceTurn[],
  call: boolean,
): Cue[] | null {
  const label = call ? SPEAKER_THEM : SPEAKER_UNKNOWN;
  let speech = 0;
  let covered = 0;
  const voices = cues.map((cue) => {
    if (cue.speaker !== label) return null;
    speech += cue.endMs - cue.startMs;
    const shared = new Map<number, number>();
    for (const turn of turns) {
      const ms = overlap(cue, turn);
      if (ms > 0) shared.set(turn.voice, (shared.get(turn.voice) ?? 0) + ms);
    }
    covered += Math.min(
      cue.endMs - cue.startMs,
      [...shared.values()].reduce((a, b) => a + b, 0),
    );
    return [...shared].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  });
  if (speech === 0 || covered / speech < MIN_COVERED) return null;
  const names = new Map<number, string>();
  for (const voice of voices) {
    if (voice !== null && !names.has(voice)) names.set(voice, numberedVoice(names.size + 1));
  }
  if (call && names.size < 2) return [...cues];
  const named = turns.filter((turn) => names.has(turn.voice));
  const nearest = (cue: Cue) =>
    named.reduce<VoiceTurn | null>(
      (best, turn) => (!best || distance(cue, turn) < distance(cue, best) ? turn : best),
      null,
    )?.voice ?? -1;
  return cues.map((cue, at) => {
    if (cue.speaker !== label) return cue;
    const name = names.get(voices[at] ?? nearest(cue));
    return name ? { ...cue, speaker: name } : cue;
  });
}

/** During the call, what is recorded is clustered again once this much more of it is saved… */
const AGAIN_AFTER_MS = 60_000;
/** …or a quarter as much again as was clustered, when that is more: a run's time grows with it. */
const AGAIN_SHARE = 1 / 4;
/** Audio is saved a part at a time: until the part a run waits for is, the parts are looked at again this often. */
const LOOK_AGAIN_MS = 1_000;

const dueAfter = (doneMs: number) => doneMs + Math.max(AGAIN_AFTER_MS, doneMs * AGAIN_SHARE);

const lengthOf = (parts: readonly AudioPart[]) =>
  parts.reduce((sum, part) => sum + part.durationMs, 0);

const requestParts = (parts: readonly AudioPart[]) =>
  parts.map((part) => ({ path: part.path, offsetMs: part.offsetMs }));

interface DuringCall {
  source: AudioSource;
  /** The last run that finished, and the parts it clustered. */
  done: { parts: ReadonlySet<string>; clustered: ClusteredVoices } | null;
  /** How much audio the last run was given, finished or not. */
  doneMs: number;
  /** When to look at the saved parts again, in the Meeting's time. */
  nextMs: number;
  running: AbortController | null;
  /** From Stop: the stretches the pass joins, the last of them what came after `done`. */
  stretches: Promise<ClusteredVoices[] | null> | null;
}

export interface SpeakerPassOptions {
  separator: SpeakerSeparator;
  model: SpeakerModel;
  partsOf(meetingId: string): AudioPart[];
  log: Logger;
}

export function createSpeakerPass(options: SpeakerPassOptions) {
  const { separator, model, log } = options;
  // One pass at a time: each holds about a gigabyte per hour of audio while it runs. A run
  // during a call gives way to any pass after Stop.
  let queue: Promise<unknown> = Promise.resolve();
  let afterStop = 0;
  const calls = new Map<string, DuringCall>();
  let closed = false;

  const sourceParts = (meetingId: string, source: AudioSource) =>
    options.partsOf(meetingId).filter((part) => part.source === source);

  async function clustered(parts: readonly AudioPart[], signal?: AbortSignal) {
    const files = await model.files();
    signal?.throwIfAborted();
    return separator.cluster({
      parts: requestParts(parts),
      model: files,
      ...(signal && { signal }),
    });
  }

  function queued<T>(work: () => Promise<T>): Promise<T> {
    afterStop++;
    for (const call of calls.values()) call.running?.abort();
    const result = queue.then(work);
    queue = result.then(
      () => {
        afterStop--;
      },
      () => {
        afterStop--;
      },
    );
    return result;
  }

  function runDuring(meetingId: string, call: DuringCall, parts: AudioPart[]) {
    const running = new AbortController();
    call.running = running;
    const audioMs = lengthOf(parts);
    const started = Date.now();
    void clustered(parts, running.signal)
      .then(
        (result) => {
          if (running.signal.aborted) return;
          call.done = { parts: new Set(parts.map((part) => part.path)), clustered: result };
          call.doneMs = audioMs;
          log.info("speakers.clusteredDuringCall", {
            meetingId,
            audioMs,
            ms: Date.now() - started,
          });
        },
        (error: unknown) => {
          if (running.signal.aborted) return;
          // Tried again once as much more is recorded: the pass after Stop says if it still fails.
          call.doneMs = audioMs;
          log.warn("speakers.duringCallFailed", {
            meetingId,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (call.running === running) call.running = null;
      });
  }

  async function tellApart(
    meetingId: string,
    cues: readonly Cue[],
    during: DuringCall | null,
  ): Promise<Cue[] | null> {
    const call = isCall(cues);
    const source = sourceToSeparate(call);
    const parts = sourceParts(meetingId, source);
    if (parts.length === 0) return null;
    const stretches = (during?.source === source && (await during.stretches)) || [
      await clustered(parts),
    ];
    const turns = joinedTurns(stretches);
    const result = labelled(cues, turns, call);
    log.info("speakers.separated", {
      meetingId,
      voices: new Set(turns.map((turn) => turn.voice)).size,
      kept: result === null,
      stretches: stretches.length,
    });
    return result;
  }

  return {
    /** A Meeting starts recording: the models download now if they haven't. */
    prepare(): void {
      model.ensure();
    },
    /**
     * The Meeting records `source`, the side whose voices the pass tells apart, up to `atMs` in
     * its time: what is saved of it is clustered again when enough more is. Another side drops
     * what was clustered of the one before.
     */
    recording(meetingId: string, source: AudioSource, atMs: number): void {
      if (closed) return;
      let call = calls.get(meetingId);
      if (call?.stretches) return;
      if (!call || call.source !== source) {
        call?.running?.abort();
        call = { source, done: null, doneMs: 0, nextMs: 0, running: null, stretches: null };
        calls.set(meetingId, call);
      }
      if (call.running || afterStop > 0 || atMs < call.nextMs) return;
      const parts = sourceParts(meetingId, source);
      const short = dueAfter(call.doneMs) - lengthOf(parts);
      if (short > 0) {
        // Audio is saved no faster than the Meeting's time goes.
        call.nextMs = atMs + Math.max(LOOK_AGAIN_MS, short);
        return;
      }
      call.nextMs = 0;
      runDuring(meetingId, call, parts);
    },
    /**
     * The Meeting stopped: a run under way stops, and what was saved after the last finished
     * one is clustered now. With no finished run, the whole recording is clustered at `run`.
     */
    stopped(meetingId: string): void {
      const call = calls.get(meetingId);
      if (!call || call.stretches) return;
      call.running?.abort();
      call.running = null;
      const done = call.done;
      if (!done) {
        calls.delete(meetingId);
        return;
      }
      call.stretches = queued(async () => {
        const tail = sourceParts(meetingId, call.source).filter(
          (part) => !done.parts.has(part.path),
        );
        if (tail.length === 0) return [done.clustered];
        const started = Date.now();
        const rest = await clustered(tail);
        log.info("speakers.tailClustered", {
          meetingId,
          audioMs: lengthOf(tail),
          ms: Date.now() - started,
        });
        return [done.clustered, rest];
      }).catch((error: unknown) => {
        log.warn("speakers.tailFailed", {
          meetingId,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    },
    /**
     * The Transcript's lines relabelled, or null when the pass can't tell the voices apart: the
     * labels stay. From what was clustered during the call when there is any, else the whole
     * recording at once. Rejects when the pass couldn't run: the models couldn't be downloaded,
     * or the audio couldn't be read or separated.
     */
    run(meetingId: string, cues: readonly Cue[]): Promise<Cue[] | null> {
      const during = calls.get(meetingId) ?? null;
      calls.delete(meetingId);
      during?.running?.abort();
      return queued(() => tellApart(meetingId, cues, during));
    },
    /** What was clustered of the Meeting during its call goes: its pass won't use it. */
    forget(meetingId: string): void {
      calls.get(meetingId)?.running?.abort();
      calls.delete(meetingId);
    },
    close(): void {
      closed = true;
      for (const call of calls.values()) call.running?.abort();
      calls.clear();
    },
  };
}

export type SpeakerPass = ReturnType<typeof createSpeakerPass>;
