/** ASCEND (CC BY-SA 4.0) records each participant on a separate microphone. */
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";
import { monoSamples } from "../lib/wav";
import { audioOf, readRows, text } from "./parquet";
import { type Clip, overlayClips } from "./tracks";
import type { Reference } from "./types";

const NAME = /^ses(\d+)_spk(\d+)_L(\d+)_([\d.]+)_([\d.]+)\.wav$/;

interface Utterance extends Clip {
  line: number;
  text: string;
}

interface SpeakerTrack {
  speaker: number;
  utterances: Utterance[];
}

export interface AscendSession {
  clips: Clip[];
  reference: Reference;
  length: number;
  speakers: number;
}

export async function ascendSpeaker(
  path: string,
  session: number,
  speaker: number,
): Promise<SpeakerTrack> {
  const meta = await readRows(path, ["transcription", "session_id", "original_speaker_id"]);
  const indices = meta.flatMap((row, i) =>
    Number(row.session_id) === session && Number(row.original_speaker_id) === speaker ? [i] : [],
  );
  const first = indices[0];
  const last = indices.at(-1);
  if (first === undefined || last === undefined)
    throw new Error(`No ASCEND speaker ${speaker} in session ${session} of ${path}.`);
  const audio = await readRows(path, ["audio"], { from: first, to: last + 1 });
  const utterances = indices.map((index) => {
    const { bytes, name } = audioOf(audio[index - first]?.audio);
    const match = NAME.exec(name);
    if (!match || Number(match[1]) !== session || Number(match[2]) !== speaker)
      throw new Error(
        `Unexpected ASCEND utterance ${name} for speaker ${speaker} in session ${session}.`,
      );
    return {
      line: Number(match[3]),
      start: Number(match[4]),
      samples: monoSamples(bytes, name),
      text: text(meta[index]?.transcription),
    };
  });
  return { speaker, utterances };
}

export function ascendSession(left: SpeakerTrack, right: SpeakerTrack): AscendSession {
  const lines = (track: SpeakerTrack) => track.utterances.map((turn) => turn.line);
  const a = lines(left);
  const b = lines(right);
  // Session numbers repeat across pairs. Only partners have interleaved source line numbers.
  if (
    left.speaker === right.speaker ||
    Math.max(Math.min(...a), Math.min(...b)) >= Math.min(Math.max(...a), Math.max(...b))
  )
    throw new Error(
      `ASCEND speakers ${left.speaker} and ${right.speaker} have no interleaved dialogue.`,
    );
  const clips = [...left.utterances, ...right.utterances];
  const segments = [left, right]
    .flatMap(({ speaker, utterances }) =>
      utterances.map(({ start, samples, text }) => ({
        start,
        end: start + samples.length / MEETING_SAMPLE_RATE,
        speaker: `spk${speaker}`,
        text,
        track: "conversation" as const,
      })),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
  const end = Math.max(...segments.map((segment) => segment.end));
  return {
    clips,
    reference: { format: 1, segments },
    length: Math.ceil((end + 0.5) * MEETING_SAMPLE_RATE),
    speakers: 2,
  };
}

export const conversationTrack = (session: AscendSession) =>
  overlayClips(session.clips, session.length);
