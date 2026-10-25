/**
 * ASCEND (CC BY-SA 4.0): two people talking, in Mandarin with English words and sentences
 * mixed in, as Hong Kong students do. The corpus is cut into utterances; each file's name says
 * the session, the speaker and when in the session the utterance starts, so a session can be
 * laid out again as one conversation.
 */
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";
import { monoSamples } from "../lib/wav";
import { audioOf, readRows, text } from "./parquet";
import { type Clip, overlayClips } from "./tracks";
import type { Reference } from "./types";

const NAME = /^ses(\d+)_spk(\d+)_L\d+_([\d.]+)_([\d.]+)\.wav$/;

export interface AscendSession {
  clips: Clip[];
  reference: Reference;
  length: number;
  speakers: number;
}

export async function ascendSession(path: string, session: number): Promise<AscendSession> {
  const meta = await readRows(path, ["transcription", "session_id"]);
  const rows = meta.flatMap((row, index) => (Number(row.session_id) === session ? [index] : []));
  if (rows.length === 0) throw new Error(`${path} has no session ${session}.`);
  const from = rows[0] as number;
  const to = (rows[rows.length - 1] as number) + 1;
  const audio = await readRows(path, ["audio"], { from, to });
  const clips: Clip[] = [];
  const segments: Reference["segments"] = [];
  audio.forEach((row, offset) => {
    if (Number(meta[from + offset]?.session_id) !== session) return;
    const { bytes, name } = audioOf(row.audio);
    const match = NAME.exec(name);
    if (!match) throw new Error(`${name} isn't named as ASCEND's utterances are.`);
    const start = Number(match[3]);
    const samples = monoSamples(bytes, name);
    clips.push({ start, samples });
    segments.push({
      start,
      end: start + samples.length / MEETING_SAMPLE_RATE,
      speaker: `spk${match[2]}`,
      text: text(meta[from + offset]?.transcription),
      track: "conversation",
    });
  });
  segments.sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
  const end = Math.max(...segments.map((segment) => segment.end));
  const length = Math.ceil((end + 0.5) * MEETING_SAMPLE_RATE);
  return {
    clips,
    reference: { format: 1, segments },
    length,
    speakers: new Set(segments.map((segment) => segment.speaker)).size,
  };
}

export const conversationTrack = (session: AscendSession) =>
  overlayClips(session.clips, session.length);
