/**
 * After the call, a Meeting's speakers told apart from its audio while it is kept (#138), as
 * DESIGN.md › Speakers words them: in a call the microphone stays "Me", and the other side is
 * "Them" while one voice speaks and "Speaker 1, 2…" when several do; in a room every voice is
 * "Speaker 1, 2…". When the pass can't tell the voices apart, every line keeps the label of
 * where it came from.
 */
import {
  lineKey,
  numberedVoice,
  SPEAKER_ME,
  SPEAKER_THEM,
  SPEAKER_UNKNOWN,
} from "../../shared/speakers";
import type { Logger, SpeakerSeparator, VoiceTurn } from "../adapters";
import type { AudioSource, TranscriptSpeakers } from "../api";
import type { Cue, WordTime } from "../documents/formats/vtt";
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

const ONE_WORD =
  /^\s*(?:[\p{Script=Latin}\p{N}]+(?:['’][\p{Script=Latin}\p{N}]+)*|\p{Script=Han})[\p{P}\s]*$/u;
const STARTS_INSIDE_WORD = /[\p{Script=Latin}\p{N}]{2}/u;

function adjacentWords(text: string, before: WordTime, after: WordTime): boolean {
  return (
    !STARTS_INSIDE_WORD.test(text.slice(Math.max(0, before.at - 1), before.at + 1)) &&
    !STARTS_INSIDE_WORD.test(text.slice(after.at - 1, after.at + 1)) &&
    ONE_WORD.test(text.slice(before.at, after.at))
  );
}

function speakerCuts(cue: Cue, turns: readonly VoiceTurn[], used: Set<string>): WordTime[] {
  if (!cue.speaker || !cue.words?.length) return [];
  const own = turns.filter((turn) => overlap(cue, turn) > 0);
  const cuts: WordTime[] = [];
  for (const [index, next] of own.entries()) {
    const previous = own[index - 1];
    if (!previous || previous.voice === next.voice) continue;
    if (previous.endMs > next.startMs) return [];
    const boundary = (previous.endMs + next.startMs) / 2;
    const at = cue.words.findIndex((word) => word.ms >= boundary);
    const before = cue.words[at - 2];
    const left = cue.words[at - 1];
    const right = cue.words[at];
    const after = cue.words[at + 1];
    if (
      !before ||
      !left ||
      !right ||
      !after ||
      right.at <= 0 ||
      right.at >= cue.text.length ||
      before.ms < previous.startMs ||
      left.ms > previous.endMs ||
      right.ms < next.startMs ||
      after.ms >= Math.min(cue.endMs, next.endMs)
    )
      return [];
    if (
      own.some(
        (turn) =>
          (turn.voice !== previous.voice && turn.startMs <= left.ms && left.ms < turn.endMs) ||
          (turn.voice !== next.voice && turn.startMs <= right.ms && right.ms < turn.endMs),
      )
    )
      return [];
    // An unaligned word or a long pause leaves the speaker boundary ambiguous.
    if (
      right.ms - left.ms > 1000 ||
      !adjacentWords(cue.text, before, left) ||
      !adjacentWords(cue.text, left, right) ||
      !adjacentWords(cue.text, right, after)
    )
      return [];
    const key = lineKey(right.ms, cue.speaker);
    if (used.has(key)) return [];
    cuts.push(right);
  }
  for (const cut of cuts) used.add(lineKey(cut.ms, cue.speaker));
  return cuts;
}

/** Keep post-call attribution in the same metadata as a manual split. */
export function speakerLabels(
  cues: readonly Cue[],
  turns: readonly VoiceTurn[],
  call: boolean,
): TranscriptSpeakers | null {
  const source = call ? SPEAKER_THEM : SPEAKER_UNKNOWN;
  const used = new Set(
    cues.flatMap((cue) => (cue.speaker ? [lineKey(Math.round(cue.startMs), cue.speaker)] : [])),
  );
  const ordered = turns.toSorted((a, b) => a.startMs - b.startMs);
  const lines = cues.map((cue) => {
    const cuts = cue.speaker === source ? speakerCuts(cue, ordered, used) : [];
    const parts = [{ at: 0, ms: cue.startMs }, ...cuts];
    return {
      cue,
      cuts,
      parts: parts.map(({ ms }, at) => ({
        ...cue,
        startMs: ms,
        endMs: parts[at + 1]?.ms ?? cue.endMs,
      })),
    };
  });
  const labelledParts = labelled(
    lines.flatMap(({ parts }) => parts),
    ordered,
    call,
  );
  if (!labelledParts) return null;
  const speakers: TranscriptSpeakers = { labels: {}, lines: {} };
  let at = 0;
  for (const { cue, cuts, parts } of lines) {
    const label = cue.speaker;
    const who = labelledParts.slice(at, at + parts.length);
    at += parts.length;
    if (!label) continue;
    const start = lineKey(Math.round(cue.startMs), label);
    const first = who[0]?.speaker;
    if (first && first !== label) speakers.lines[start] = first;
    const changes = cuts.filter((_cut, index) => who[index]?.speaker !== who[index + 1]?.speaker);
    if (changes.length === 0) continue;
    speakers.splits ??= {};
    speakers.splits[start] = { text: cue.text, parts: changes };
    for (const [index, cut] of cuts.entries()) {
      const next = who[index + 1]?.speaker;
      if (next && next !== label && who[index]?.speaker !== next) {
        speakers.lines[lineKey(cut.ms, label)] = next;
      }
    }
  }
  return speakers;
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

  async function tellApart(
    meetingId: string,
    cues: readonly Cue[],
  ): Promise<TranscriptSpeakers | null> {
    const call = isCall(cues);
    const source = sourceToSeparate(call);
    const parts = options.partsOf(meetingId).filter((part) => part.source === source);
    if (parts.length === 0) return null;
    const turns = await separator.separate({
      parts: parts.map((part) => ({ path: part.path, offsetMs: part.offsetMs })),
      model: await model.files(),
    });
    const result = speakerLabels(cues, turns, call);
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
     * Speaker labels and splits for the Transcript, or null when the pass can't tell the voices
     * apart. Rejects when the pass couldn't run: the models couldn't be downloaded, or the
     * audio couldn't be read or separated.
     */
    run(meetingId: string, cues: readonly Cue[]): Promise<TranscriptSpeakers | null> {
      const result = queue.then(() => tellApart(meetingId, cues));
      queue = result.catch(() => {});
      return result;
    },
  };
}

export type SpeakerPass = ReturnType<typeof createSpeakerPass>;
