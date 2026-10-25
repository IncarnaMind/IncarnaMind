/**
 * The AMI Meeting Corpus (CC BY 4.0) as the Hugging Face copy keeps it, at a pinned revision
 * (eval/meetings/sources.json): Kaldi's segments and text for the meetings of its eval split, and
 * for each meeting a tar of the segments cut from each participant's own headset. The room
 * recordings are the full meetings of the single distant microphone, from another copy.
 */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";
import { tarEntries } from "../lib/tar";
import { monoSamples, wavHeader } from "../lib/wav";
import { audioOf, readRows } from "./parquet";
import { type Clip, placeClips } from "./tracks";
import type { Reference, Segment } from "./types";

export interface AmiUtterance {
  meeting: string;
  headset: string;
  speaker: string;
  start: number;
  end: number;
  text: string;
  /** The segment's file in the meeting's tar. */
  file: string;
}

const UTTERANCE = /^AMI_([A-Za-z0-9]+)_H(\d+)_([A-Za-z0-9]+)_(\d{7})_(\d{7})$/;

/** Kaldi's `text` file: one utterance a line, its id then its words. */
export function amiUtterances(text: string): AmiUtterance[] {
  const out: AmiUtterance[] = [];
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const id = line.slice(0, space);
    const words = line.slice(space + 1).trim();
    const match = UTTERANCE.exec(id);
    if (!match || words === "") continue;
    const [, meeting, headset, speaker, from, to] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    out.push({
      meeting,
      headset,
      speaker,
      start: Number(from) / 100,
      end: Number(to) / 100,
      text: words,
      file: `${meeting}/eval_ami_${meeting.toLowerCase()}_h${headset}_${speaker.toLowerCase()}_${from}_${to}.wav`,
    });
  }
  return out;
}

export const ofMeeting = (utterances: readonly AmiUtterance[], meeting: string) =>
  utterances
    .filter((utterance) => utterance.meeting === meeting)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));

export function talkTimes(utterances: readonly AmiUtterance[]): [string, number][] {
  const seconds = new Map<string, number>();
  for (const { speaker, start, end } of utterances) {
    seconds.set(speaker, (seconds.get(speaker) ?? 0) + (end - start));
  }
  return [...seconds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function amiReference(
  utterances: readonly AmiUtterance[],
  trackOf: (speaker: string) => Segment["track"],
): Reference {
  return {
    format: 1,
    segments: utterances.map(({ start, end, speaker, text }) => ({
      start,
      end,
      speaker,
      text,
      track: trackOf(speaker),
    })),
  };
}

export async function headsetTracks(
  tarPath: string,
  utterances: readonly AmiUtterance[],
): Promise<{ bySpeaker: Map<string, Float32Array>; length: number }> {
  const wanted = new Map(utterances.map((utterance) => [utterance.file, utterance]));
  const clips = new Map<string, Clip[]>();
  for await (const entry of tarEntries(createReadStream(tarPath).pipe(createGunzip()))) {
    const utterance = entry.isFile ? wanted.get(entry.name) : undefined;
    if (!utterance) continue;
    const parts: Uint8Array[] = [];
    for await (const part of entry.content) parts.push(part);
    const list = clips.get(utterance.speaker) ?? [];
    list.push({ start: utterance.start, samples: monoSamples(Buffer.concat(parts), entry.name) });
    clips.set(utterance.speaker, list);
    wanted.delete(entry.name);
  }
  if (wanted.size > 0) {
    throw new Error(`${tarPath} lacks ${wanted.size} segments, such as ${[...wanted.keys()][0]}.`);
  }
  const end = Math.max(...utterances.map((utterance) => utterance.end));
  const length = Math.ceil((end + 0.5) * MEETING_SAMPLE_RATE);
  return {
    bySpeaker: new Map([...clips].map(([speaker, list]) => [speaker, placeClips(list, length)])),
    length,
  };
}

export async function roomRecording(path: string, row: number, meeting: string) {
  const [first] = await readRows(path, ["audio"], { from: row, to: row + 1 });
  const { bytes, name } = audioOf(first?.audio);
  if (name !== `${meeting}.Array1-01.wav`) throw new Error(`Row ${row} of ${path} is ${name}.`);
  const header = wavHeader(bytes, name);
  if (header.channels !== 1 || header.rate !== MEETING_SAMPLE_RATE || header.float) {
    throw new Error(`${name} isn't mono 16-bit ${MEETING_SAMPLE_RATE} Hz audio.`);
  }
  return { bytes, seconds: header.dataBytes / (2 * MEETING_SAMPLE_RATE) };
}
