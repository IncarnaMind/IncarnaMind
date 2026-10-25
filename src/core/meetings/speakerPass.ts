/**
 * After the call, a Meeting's speakers told apart from its audio while it is kept (#138), as
 * DESIGN.md › Speakers words them: in a call the microphone stays "Me", and the other side is
 * "Them" while one voice speaks and "Speaker 1, 2…" when several do; in a room every voice is
 * "Speaker 1, 2…". When the pass can't tell the voices apart, every line keeps the label of
 * where it came from.
 */
import { numberedVoice, SPEAKER_ME, SPEAKER_THEM, SPEAKER_UNKNOWN } from "../../shared/speakers";
import type { Logger, SpeakerSeparator, VoiceTurn } from "../adapters";
import type { AudioSource } from "../api";
import type { Cue } from "../documents/formats/vtt";
import type { SpeakerModel } from "../transcription/speakerModel";
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

export interface SpeakerPassOptions {
  separator: SpeakerSeparator;
  model: SpeakerModel;
  partsOf(meetingId: string): AudioPart[];
  log: Logger;
}

export function createSpeakerPass(options: SpeakerPassOptions) {
  const { separator, model, log } = options;
  // One pass at a time: each holds about a gigabyte per hour of audio while it runs.
  let queue: Promise<unknown> = Promise.resolve();

  async function tellApart(meetingId: string, cues: readonly Cue[]): Promise<Cue[] | null> {
    const call = isCall(cues);
    const source = sourceToSeparate(call);
    const parts = options.partsOf(meetingId).filter((part) => part.source === source);
    if (parts.length === 0) return null;
    const turns = await separator.separate({
      parts: parts.map((part) => ({ path: part.path, offsetMs: part.offsetMs })),
      model: await model.files(),
    });
    const result = labelled(cues, turns, call);
    log.info("speakers.separated", {
      meetingId,
      voices: new Set(turns.map((turn) => turn.voice)).size,
      kept: result === null,
    });
    return result;
  }

  return {
    /** A Meeting starts recording: the models download now if they haven't. */
    prepare(): void {
      model.ensure();
    },
    /**
     * The Transcript's lines relabelled, or null when the pass can't tell the voices apart: the
     * labels stay. Rejects when the pass couldn't run: the models couldn't be downloaded, or the
     * audio couldn't be read or separated.
     */
    run(meetingId: string, cues: readonly Cue[]): Promise<Cue[] | null> {
      const result = queue.then(() => tellApart(meetingId, cues));
      queue = result.catch(() => {});
      return result;
    },
  };
}

export type SpeakerPass = ReturnType<typeof createSpeakerPass>;
