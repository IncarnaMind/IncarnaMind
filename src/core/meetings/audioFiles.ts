/**
 * A Meeting's audio on disk: the data folder's meetings/<id>/, one WAV file
 * per source for every 10 seconds, written as each fills. The files are the
 * record of what was captured: each is written whole under a temporary name,
 * flushed and renamed into place, so a crash leaves only whole files and at
 * most the part still filling is lost. A file's name says its source and where
 * it starts in the Meeting's time, so nothing else is needed to find it again.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { MEETING_SAMPLE_RATE } from "../adapters";
import type { AudioSource } from "../api";

/** Samples in a whole part: 10 seconds. */
export const PART_SAMPLES = MEETING_SAMPLE_RATE * 10;

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const PART_NAME = /^(microphone|system)-(\d{10})\.wav$/;
const WRITING_SUFFIX = ".writing";

/** One saved part of a Meeting's audio. */
export interface AudioPart {
  source: AudioSource;
  /** Where it starts, in the Meeting's time (ms of recording before it). */
  offsetMs: number;
  durationMs: number;
  /** The WAV file: 16-bit PCM, mono, `MEETING_SAMPLE_RATE`. */
  path: string;
}

export const meetingFolder = (dataDir: string, meetingId: string) =>
  join(dataDir, "meetings", meetingId);

const partName = (source: AudioSource, offsetMs: number) =>
  `${source}-${String(Math.max(0, Math.round(offsetMs))).padStart(10, "0")}.wav`;

/** A canonical WAV header for 16-bit mono PCM at `MEETING_SAMPLE_RATE`. */
export function wavHeader(samples: number): Uint8Array {
  const data = samples * BYTES_PER_SAMPLE;
  const header = new DataView(new ArrayBuffer(WAV_HEADER_BYTES));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) header.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  header.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, MEETING_SAMPLE_RATE, true);
  header.setUint32(28, MEETING_SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  header.setUint16(32, BYTES_PER_SAMPLE, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, data, true);
  return new Uint8Array(header.buffer);
}

/**
 * Writes one part, whole, and flushed to the disk before it takes its name,
 * so a crash or a power cut never leaves half a part. Synchronous: a part is
 * 320 KB every 10 seconds, and nothing can come between it and a crash.
 */
export function writePart(
  folder: string,
  source: AudioSource,
  offsetMs: number,
  samples: Int16Array,
): AudioPart {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, partName(source, offsetMs));
  const writing = path + WRITING_SUFFIX;
  const fd = openSync(writing, "w");
  try {
    writeSync(fd, wavHeader(samples.length));
    writeSync(fd, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(writing, path);
  // The rename must reach the disk too, or a power cut can undo it. Windows can't flush a folder.
  if (process.platform !== "win32") {
    const dir = openSync(folder, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  return { source, offsetMs, durationMs: msOf(samples.length), path };
}

export const msOf = (samples: number) => (samples * 1000) / MEETING_SAMPLE_RATE;

/**
 * The parts saved in a Meeting's folder, in time order, microphone before
 * system at the same time. Files being written when IncarnaMind stopped are
 * left out (`removeUnfinished` deletes them).
 */
export function listParts(folder: string): AudioPart[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const parts: AudioPart[] = [];
  for (const name of names) {
    const match = PART_NAME.exec(name);
    if (!match) continue;
    const path = join(folder, name);
    const samples = Math.max(0, (statSync(path).size - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE);
    parts.push({
      source: match[1] as AudioSource,
      offsetMs: Number(match[2]),
      durationMs: msOf(samples),
      path,
    });
  }
  return parts.sort((a, b) => a.offsetMs - b.offsetMs || a.source.localeCompare(b.source));
}

/**
 * Deletes what a crash left half written, and returns the parts lost: each
 * as long as its header says it was to be, or a whole part if the header
 * wasn't written.
 */
export function removeUnfinished(folder: string): Omit<AudioPart, "path">[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const lost: Omit<AudioPart, "path">[] = [];
  for (const name of names.filter((each) => each.endsWith(WRITING_SUFFIX))) {
    const path = join(folder, name);
    const match = PART_NAME.exec(name.slice(0, -WRITING_SUFFIX.length));
    if (match) {
      lost.push({
        source: match[1] as AudioSource,
        offsetMs: Number(match[2]),
        durationMs: msOf(intendedSamples(path) ?? PART_SAMPLES),
      });
    }
    rmSync(path, { force: true });
  }
  return lost;
}

/** The samples a part's WAV header says it holds, if its header was written. */
function intendedSamples(path: string): number | null {
  try {
    const fd = openSync(path, "r");
    try {
      const header = Buffer.alloc(WAV_HEADER_BYTES);
      if (readSync(fd, header, 0, WAV_HEADER_BYTES, 0) < WAV_HEADER_BYTES) return null;
      if (header.toString("latin1", 36, 40) !== "data") return null;
      return header.readUInt32LE(40) / BYTES_PER_SAMPLE;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Deletes a Meeting's audio, and its folder. */
export function removeAudio(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
}

/**
 * A stretch of a Meeting's audio, `fromMs` to `toMs` of its time, with every source mixed into
 * one: what plays when the User clicks a word of its Transcript (#138). A stretch no part covers
 * is silence. Null when no part of the folder is there to read.
 */
export function readStretch(
  folder: string,
  fromMs: number,
  toMs: number,
): Float32Array<ArrayBuffer> | null {
  const parts = listParts(folder);
  if (parts.length === 0) return null;
  const first = Math.round((fromMs * MEETING_SAMPLE_RATE) / 1000);
  const length = Math.max(0, Math.round((toMs * MEETING_SAMPLE_RATE) / 1000) - first);
  const mixed = new Float32Array(length);
  for (const part of parts) {
    const start = Math.round((part.offsetMs * MEETING_SAMPLE_RATE) / 1000);
    const samples = Math.round((part.durationMs * MEETING_SAMPLE_RATE) / 1000);
    const from = Math.max(first, start);
    const to = Math.min(first + length, start + samples);
    if (to <= from) continue;
    const bytes = Buffer.alloc((to - from) * BYTES_PER_SAMPLE);
    const file = openSync(part.path, "r");
    try {
      readSync(file, bytes, 0, bytes.length, WAV_HEADER_BYTES + (from - start) * BYTES_PER_SAMPLE);
    } finally {
      closeSync(file);
    }
    for (let at = 0; at < to - from; at++) {
      const index = from - first + at;
      mixed[index] = Math.max(
        -1,
        Math.min(1, (mixed[index] ?? 0) + bytes.readInt16LE(at * 2) / 32768),
      );
    }
  }
  return mixed;
}

/** How much of a recording is mixed and written at a time: a part's length. */
const WRITE_MS = 10_000;

/**
 * Writes a Meeting's audio as one WAV file at `path`, as Save recording… does (#687): every source
 * mixed into one, mono, 16 kHz, 16-bit, `durationMs` long, a stretch no part covers silent. It is
 * written beside `path` under another name and takes it once whole, so a recording stopped
 * between stretches (`stopped`), its audio gone or a failure leaves nothing behind. Whether it
 * was written.
 */
export async function writeRecording(
  folder: string,
  durationMs: number,
  path: string,
  stopped: () => boolean,
): Promise<boolean> {
  const writing = path + WRITING_SUFFIX;
  const file = await open(writing, "w");
  let whole = false;
  try {
    await file.write(wavHeader(Math.round((durationMs * MEETING_SAMPLE_RATE) / 1000)));
    for (let fromMs = 0; fromMs < durationMs; fromMs += WRITE_MS) {
      if (stopped()) return false;
      const mixed = readStretch(folder, fromMs, Math.min(durationMs, fromMs + WRITE_MS));
      if (!mixed) return false;
      const samples = Int16Array.from(mixed, (sample) =>
        Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
      );
      await file.write(new Uint8Array(samples.buffer));
    }
    if (stopped()) return false;
    await file.sync();
    whole = true;
  } finally {
    await file.close();
    if (whole) {
      await rename(writing, path).catch(async (error: unknown) => {
        await rm(writing, { force: true });
        throw error;
      });
    } else await rm(writing, { force: true });
  }
  return true;
}
