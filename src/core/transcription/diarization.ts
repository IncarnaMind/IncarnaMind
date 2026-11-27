/**
 * Telling the voices in a recording apart (#138), with sherpa-onnx-node's speaker diarization:
 * pyannote's segmentation model finds where each voice speaks, 3D-Speaker's CAM++ gives each
 * voice a voiceprint from its solo stretches, and the stretches are clustered into voices. Its
 * `process` holds its thread until it is done, so the desktop app runs it in a process of its
 * own (src/main/speakerProcess.ts).
 */
import { readFileSync, statSync } from "node:fs";
import type { SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import { MEETING_SAMPLE_RATE, type SpeakerModelFiles, type VoiceTurn } from "../adapters";
import { SHERPA } from "./sherpa";

/**
 * The engine joins stretches whose voiceprints are closer than this (a distance: 1 less how alike
 * they are). Kept low on purpose, so the engine splits a person rather than joins two: at 1.05,
 * which keeps a person whole over a long meeting, two voices only 0.2 alike came out as one
 * speaker in a short recording (#138).
 */
export const CLUSTER_THRESHOLD = 0.7;

/**
 * Voices whose solo voiceprints are at least this alike are taken for one person afterwards: the
 * engine's clustering splits people into several voices.
 */
export const SAME_PERSON = 0.65;
/**
 * A voiceprint from very little solo speech is rough and makes one person's fragments look less
 * alike. Rough voices (`soloSeconds < SOLID_SOLO_SECONDS`) attach to the nearest solid voice from
 * `ROUGH_PRINT_SAME` alike, rising evenly to `SAME_PERSON` at `SOLID_SOLO_SECONDS`, without
 * pulling solid voiceprints toward each other (#138).
 */
const ROUGH_PRINT_SAME = 0.3;
const SOLID_SOLO_SECONDS = 5;
/** A voice with less of the speech than this (or less than `MIN_SOLO_SECONDS` solo) is stray. */
const STRAY_SHARE = 0.02;
const MIN_SOLO_SECONDS = 0.5;
const MIN_SOLO_STRETCH_SECONDS = 0.3;
/** A voiceprint is taken from a voice's longest solo stretches, up to this much of them. */
const PRINT_SECONDS = 30;
/**
 * The engine clusters at most this much audio at once; a longer recording is cut into even
 * windows whose voices are then joined by voiceprint. Its clustering compares every stretch with
 * every other, so its memory grows with the square of the length: 2.1 GB for two hours at once.
 */
export const WINDOW_SECONDS = 60 * 60;

/** Matches speakerPass's MIN_COVERED so cue-span refinement never masks a broken separation. */
const MIN_REFINE_COVERED = 0.5;
const MIN_EMBED_SECONDS = 0.25;
const MIN_SHORT_SPAN_MS = 350;
const MAX_SHORT_SPAN_MS = 4500;
const MIN_GAP_MS = 400;
const GAP_CHUNK_MS = 3000;

const WAV_HEADER_BYTES = 44;
const SAMPLES_PER_MS = MEETING_SAMPLE_RATE / 1000;

const samplesIn = (bytes: number) => Math.max(0, Math.floor((bytes - WAV_HEADER_BYTES) / 2));

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

export interface SeparationRequest {
  parts: readonly { path: string; offsetMs: number }[];
  model: SpeakerModelFiles;
  spans?: readonly TimeSpan[];
}

interface PartSpan {
  /** Where it starts in the joined samples. */
  at: number;
  length: number;
  offsetMs: number;
}

// Read straight into one array, a part at a time: the whole recording is held once, not twice.
function joinParts(parts: SeparationRequest["parts"]): {
  samples: Float32Array;
  spans: PartSpan[];
} {
  const sorted = [...parts].sort((a, b) => a.offsetMs - b.offsetMs);
  const lengths = sorted.map((part) => samplesIn(statSync(part.path).size));
  const samples = new Float32Array(lengths.reduce((sum, length) => sum + length, 0));
  const spans: PartSpan[] = [];
  let at = 0;
  for (const [index, part] of sorted.entries()) {
    const bytes = readFileSync(part.path);
    const length = Math.min(lengths[index] ?? 0, samplesIn(bytes.byteLength));
    for (let i = 0; i < length; i++) {
      samples[at + i] = bytes.readInt16LE(WAV_HEADER_BYTES + i * 2) / 32768;
    }
    spans.push({ at, length, offsetMs: part.offsetMs });
    at += length;
  }
  return { samples: samples.subarray(0, at), spans };
}

function meetingTurns(
  segments: readonly { start: number; end: number; speaker: number }[],
  spans: readonly PartSpan[],
): { turns: VoiceTurn[]; voiceOf: Map<number, number> } {
  const voiceOf = new Map<number, number>();
  const turns: VoiceTurn[] = [];
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const voice = voiceOf.get(segment.speaker) ?? voiceOf.size;
    voiceOf.set(segment.speaker, voice);
    const from = segment.start * MEETING_SAMPLE_RATE;
    const to = segment.end * MEETING_SAMPLE_RATE;
    for (const span of spans) {
      const start = Math.max(from, span.at);
      const end = Math.min(to, span.at + span.length);
      if (end <= start) continue;
      const startMs = span.offsetMs + (start - span.at) / SAMPLES_PER_MS;
      const endMs = span.offsetMs + (end - span.at) / SAMPLES_PER_MS;
      const last = turns.at(-1);
      if (last && last.voice === voice && Math.abs(last.endMs - startMs) < 1) last.endMs = endMs;
      else turns.push({ startMs, endMs, voice });
    }
  }
  return { turns, voiceOf };
}

/**
 * The engine's segments (seconds of the joined samples, its own speaker numbers) in the
 * Meeting's time, cut where the recording paused, with voices numbered in the order first heard.
 */
export function toMeetingTime(
  segments: readonly { start: number; end: number; speaker: number }[],
  spans: readonly PartSpan[],
): VoiceTurn[] {
  return meetingTurns(segments, spans).turns;
}

export interface Segment {
  start: number;
  end: number;
  speaker: number;
}

interface Interval {
  start: number;
  end: number;
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return new Float32Array(vector.length);
  const scale = 1 / Math.sqrt(sum);
  return vector.map((value) => value * scale);
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
};

/**
 * The stretches where only `speaker` is active, dropping parts overlapped by another voice and
 * slivers under `MIN_SOLO_STRETCH_SECONDS`, so simultaneous speech does not blend voiceprints.
 */
export function soloIntervalsOf(segments: readonly Segment[], speaker: number): Interval[] {
  const own = segments
    .filter((segment) => segment.speaker === speaker)
    .sort((a, b) => a.start - b.start);
  const others: Interval[] = [];
  for (const segment of segments
    .filter((item) => item.speaker !== speaker)
    .sort((a, b) => a.start - b.start)) {
    const last = others.at(-1);
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end);
    else others.push({ start: segment.start, end: segment.end });
  }
  const solo: Interval[] = [];
  for (const segment of own) {
    let cursor = segment.start;
    for (const other of others) {
      if (other.end <= cursor) continue;
      if (other.start >= segment.end) break;
      if (other.start > cursor) solo.push({ start: cursor, end: other.start });
      cursor = Math.max(cursor, other.end);
      if (cursor >= segment.end) break;
    }
    if (cursor < segment.end) solo.push({ start: cursor, end: segment.end });
  }
  return solo.filter((interval) => interval.end - interval.start >= MIN_SOLO_STRETCH_SECONDS);
}

export interface Voice {
  print: Float32Array;
  seconds: number;
  /** Total non-overlapping speech in seconds, used to tell solid voiceprints from rough ones. */
  soloSeconds: number;
}

interface Group extends Voice {
  ids: number[];
}

function mergeGroup(into: Group, from: Group): void {
  const intoWeight = Math.max(MIN_SOLO_SECONDS, into.soloSeconds);
  const fromWeight = Math.max(MIN_SOLO_SECONDS, from.soloSeconds);
  const combined = new Float32Array(Math.max(into.print.length, from.print.length));
  for (let i = 0; i < combined.length; i++) {
    combined[i] = (into.print[i] ?? 0) * intoWeight + (from.print[i] ?? 0) * fromWeight;
  }
  into.print = normalize(combined);
  into.seconds += from.seconds;
  into.soloSeconds += from.soloSeconds;
  into.ids.push(...from.ids);
}

function absorb(into: Group, from: Group): void {
  into.seconds += from.seconds;
  into.ids.push(...from.ids);
}

function clusterGroups(
  initial: readonly Group[],
  neededFor: (a: Group, b: Group) => number,
): Group[] {
  let groups = [...initial];
  for (;;) {
    let best: { into: Group; from: Group; alike: number } | null = null;
    for (const [at, a] of groups.entries()) {
      for (const b of groups.slice(at + 1)) {
        const alike = cosine(a.print, b.print);
        if (alike >= neededFor(a, b) && (!best || alike > best.alike)) {
          best = { into: a, from: b, alike };
        }
      }
    }
    if (!best) break;
    mergeGroup(best.into, best.from);
    const gone = best.from;
    groups = groups.filter((group) => group !== gone);
  }
  return groups;
}

function nearestGroup(
  target: Group,
  candidates: readonly Group[],
): { group: Group; alike: number } | null {
  let best: { group: Group; alike: number } | null = null;
  for (const candidate of candidates) {
    const alike = cosine(target.print, candidate.print);
    if (!best || alike > best.alike) best = { group: candidate, alike };
  }
  return best;
}

function joinVoiceGroups(
  voices: ReadonlyMap<number, Voice>,
  samePerson = SAME_PERSON,
): { map: Map<number, number>; prints: Map<number, Float32Array> } {
  const rough = Math.min(samePerson, ROUGH_PRINT_SAME);
  const scaledNeeded = (soloSeconds: number) =>
    rough + (samePerson - rough) * (Math.min(soloSeconds, SOLID_SOLO_SECONDS) / SOLID_SOLO_SECONDS);

  const all: Group[] = [...voices].map(([id, voice]) => ({
    ids: [id],
    print: normalize(voice.print),
    seconds: voice.seconds,
    soloSeconds: voice.soloSeconds,
  }));
  let solids = all.filter((group) => group.soloSeconds >= SOLID_SOLO_SECONDS);
  const roughs = all.filter((group) => group.soloSeconds < SOLID_SOLO_SECONDS);

  if (solids.length === 0) {
    solids = clusterGroups(all, (a, b) => scaledNeeded(Math.min(a.soloSeconds, b.soloSeconds)));
  } else {
    solids = clusterGroups(solids, () => samePerson);
    let unattached: Group[] = [];
    for (const fragment of roughs) {
      const match = nearestGroup(fragment, solids);
      if (match && match.alike >= scaledNeeded(fragment.soloSeconds)) absorb(match.group, fragment);
      else unattached.push(fragment);
    }
    if (unattached.length > 1) {
      unattached = clusterGroups(unattached, (a, b) =>
        scaledNeeded(Math.min(a.soloSeconds, b.soloSeconds)),
      );
    }
    for (const group of unattached) {
      const match = nearestGroup(group, solids);
      if (match && match.alike >= samePerson) absorb(match.group, group);
      else solids.push(group);
    }
  }

  const speech = solids.reduce((sum, group) => sum + group.seconds, 0);
  const kept = solids.filter(
    (group) => group.seconds >= STRAY_SHARE * speech && group.soloSeconds >= MIN_SOLO_SECONDS,
  );
  const final = kept.length > 0 ? kept : solids;
  for (const stray of solids.filter((group) => !final.includes(group))) {
    const match = nearestGroup(stray, final);
    if (match) absorb(match.group, stray);
  }

  const map = new Map<number, number>();
  const prints = new Map<number, Float32Array>();
  for (const group of final) {
    const canonical = group.ids[0];
    if (canonical === undefined) continue;
    prints.set(canonical, group.print);
    for (const id of group.ids) map.set(id, canonical);
  }
  return { map, prints };
}

/**
 * Which voice each voice becomes once alike voices are one person: solid voices merge at
 * `samePerson`, rough fragments attach to the nearest solid without shifting its voiceprint, and
 * stray voices join the kept voice most like them.
 */
export function joinedVoices(
  voices: ReadonlyMap<number, Voice>,
  samePerson = SAME_PERSON,
): Map<number, number> {
  return joinVoiceGroups(voices, samePerson).map;
}

function voiceprintsOf(
  extractor: SpeakerEmbeddingExtractor,
  samples: Float32Array,
  segments: readonly Segment[],
): Map<number, Voice> {
  const bySpeaker = new Map<number, Segment[]>();
  for (const segment of segments) {
    const list = bySpeaker.get(segment.speaker);
    if (list) list.push(segment);
    else bySpeaker.set(segment.speaker, [segment]);
  }
  const voices = new Map<number, Voice>();
  for (const [speaker, own] of bySpeaker) {
    const solo = soloIntervalsOf(segments, speaker);
    const soloSeconds = solo.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const stretches = (soloSeconds >= MIN_SOLO_SECONDS ? solo : own)
      .slice()
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    const stream = extractor.createStream();
    let taken = 0;
    for (const stretch of stretches) {
      if (taken >= PRINT_SECONDS) break;
      const seconds = Math.min(stretch.end - stretch.start, PRINT_SECONDS - taken);
      const from = Math.max(0, Math.round(stretch.start * MEETING_SAMPLE_RATE));
      const to = Math.min(samples.length, from + Math.round(seconds * MEETING_SAMPLE_RATE));
      if (to <= from) continue;
      stream.acceptWaveform({
        samples: samples.subarray(from, to),
        sampleRate: MEETING_SAMPLE_RATE,
      });
      taken += (to - from) / MEETING_SAMPLE_RATE;
    }
    stream.inputFinished();
    voices.set(speaker, {
      print:
        taken > 0
          ? normalize(Float32Array.from(extractor.compute(stream, false)))
          : new Float32Array(0),
      seconds: own.reduce((sum, segment) => sum + segment.end - segment.start, 0),
      soloSeconds,
    });
  }
  return voices;
}

function mergeTimeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  const merged: TimeSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ startMs: span.startMs, endMs: span.endMs });
  }
  return merged;
}

function hasCleanHandoff(overlapping: readonly VoiceTurn[]): boolean {
  const voices = new Set(overlapping.map((turn) => turn.voice));
  if (voices.size < 2) return false;
  for (const [at, a] of overlapping.entries()) {
    for (const b of overlapping.slice(at + 1)) {
      if (a.voice !== b.voice && Math.min(a.endMs, b.endMs) > Math.max(a.startMs, b.startMs)) {
        return false;
      }
    }
  }
  return true;
}

function bestMatchingVoice(
  embedding: Float32Array,
  prints: ReadonlyMap<number, Float32Array>,
): number | null {
  let bestVoice: number | null = null;
  let bestAlike = -Infinity;
  for (const [voice, print] of prints) {
    const alike = cosine(embedding, print);
    if (alike > bestAlike) {
      bestAlike = alike;
      bestVoice = voice;
    }
  }
  return bestVoice;
}

function splitGap(startMs: number, endMs: number): TimeSpan[] {
  const duration = endMs - startMs;
  if (duration < MIN_GAP_MS) return [];
  const parts = duration > MAX_SHORT_SPAN_MS ? Math.ceil(duration / GAP_CHUNK_MS) : 1;
  const step = duration / parts;
  return Array.from({ length: parts }, (_, index) => ({
    startMs: startMs + index * step,
    endMs: startMs + (index + 1) * step,
  }));
}

/**
 * Uses the kept voices' solo voiceprints to classify speech inside `spans` that pyannote missed
 * and to clarify short non-handoff lines, while preserving clean consecutive voice handoffs for
 * word-aligned splits and skipping refinement when base turns cover less than half of `spans`.
 */
export function refineTurnsWithSpans(
  baseTurns: readonly VoiceTurn[],
  prints: ReadonlyMap<number, Float32Array>,
  spans: readonly TimeSpan[],
  embed: (startMs: number, endMs: number) => Float32Array | null,
): VoiceTurn[] {
  if (prints.size < 2 || spans.length === 0) return [...baseTurns];
  const covered = mergeTimeSpans(baseTurns);
  let totalMs = 0;
  let coveredMs = 0;
  for (const span of spans) {
    totalMs += Math.max(0, span.endMs - span.startMs);
    for (const range of covered) {
      const shared = Math.min(span.endMs, range.endMs) - Math.max(span.startMs, range.startMs);
      if (shared > 0) coveredMs += shared;
    }
  }
  if (totalMs === 0 || coveredMs / totalMs < MIN_REFINE_COVERED) return [...baseTurns];

  const overrides: VoiceTurn[] = [];
  const gapTurns: VoiceTurn[] = [];
  for (const span of spans) {
    const duration = span.endMs - span.startMs;
    const overlapping = baseTurns.filter(
      (turn) => Math.min(turn.endMs, span.endMs) > Math.max(turn.startMs, span.startMs),
    );
    if (
      duration >= MIN_SHORT_SPAN_MS &&
      duration <= MAX_SHORT_SPAN_MS &&
      !hasCleanHandoff(overlapping)
    ) {
      const embedding = embed(span.startMs, span.endMs);
      const voice = embedding ? bestMatchingVoice(embedding, prints) : null;
      if (voice !== null) {
        overrides.push({ startMs: span.startMs, endMs: span.endMs, voice });
        continue;
      }
    }
    let cursor = span.startMs;
    const chunks: TimeSpan[] = [];
    for (const range of covered) {
      if (range.endMs <= cursor) continue;
      if (range.startMs >= span.endMs) break;
      if (range.startMs > cursor) chunks.push(...splitGap(cursor, range.startMs));
      cursor = Math.max(cursor, range.endMs);
      if (cursor >= span.endMs) break;
    }
    if (cursor < span.endMs) chunks.push(...splitGap(cursor, span.endMs));
    for (const chunk of chunks) {
      const embedding = embed(chunk.startMs, chunk.endMs);
      const voice = embedding ? bestMatchingVoice(embedding, prints) : null;
      if (voice !== null) gapTurns.push({ startMs: chunk.startMs, endMs: chunk.endMs, voice });
    }
  }

  const overrideRanges = mergeTimeSpans(overrides);
  const clipped: VoiceTurn[] = [];
  for (const turn of baseTurns) {
    let cursor = turn.startMs;
    for (const range of overrideRanges) {
      if (range.endMs <= cursor) continue;
      if (range.startMs >= turn.endMs) break;
      if (range.startMs > cursor)
        clipped.push({ startMs: cursor, endMs: range.startMs, voice: turn.voice });
      cursor = Math.max(cursor, range.endMs);
      if (cursor >= turn.endMs) break;
    }
    if (cursor < turn.endMs)
      clipped.push({ startMs: cursor, endMs: turn.endMs, voice: turn.voice });
  }
  return [...clipped, ...overrides, ...gapTurns].sort((a, b) => a.startMs - b.startMs);
}

function embedMeetingRange(
  extractor: SpeakerEmbeddingExtractor,
  samples: Float32Array,
  partSpans: readonly PartSpan[],
  startMs: number,
  endMs: number,
): Float32Array | null {
  const stream = extractor.createStream();
  let fed = 0;
  for (const part of partSpans) {
    const partEndMs = part.offsetMs + part.length / SAMPLES_PER_MS;
    const fromMs = Math.max(startMs, part.offsetMs);
    const toMs = Math.min(endMs, partEndMs);
    if (toMs <= fromMs) continue;
    const from = part.at + Math.round((fromMs - part.offsetMs) * SAMPLES_PER_MS);
    const to = Math.min(
      part.at + part.length,
      part.at + Math.round((toMs - part.offsetMs) * SAMPLES_PER_MS),
    );
    if (to <= from) continue;
    stream.acceptWaveform({ samples: samples.subarray(from, to), sampleRate: MEETING_SAMPLE_RATE });
    fed += to - from;
  }
  if (fed < MIN_EMBED_SECONDS * MEETING_SAMPLE_RATE) return null;
  stream.inputFinished();
  const vector = normalize(Float32Array.from(extractor.compute(stream, false)));
  return vector.some((value) => value !== 0) ? vector : null;
}

/** The engine's segments over the recording, a window at a time, each window's voices its own. */
export function segmentsByWindow(
  samples: Float32Array,
  windowSeconds: number,
  process: (window: Float32Array) => readonly Segment[],
): Segment[] {
  const count = Math.max(1, Math.ceil(samples.length / (windowSeconds * MEETING_SAMPLE_RATE)));
  const length = Math.ceil(samples.length / count);
  const all: Segment[] = [];
  let voices = 0;
  for (let from = 0; from < samples.length; from += length) {
    const seconds = from / MEETING_SAMPLE_RATE;
    const found = process(samples.subarray(from, from + length));
    for (const segment of found) {
      all.push({
        start: segment.start + seconds,
        end: segment.end + seconds,
        speaker: voices + segment.speaker,
      });
    }
    voices += found.reduce((most, segment) => Math.max(most, segment.speaker + 1), 0);
  }
  return all;
}

/**
 * Separates the voices in a request's parts. The models load for each request, as each is one
 * Meeting. `threshold`, `samePerson` and `windowSeconds` are for the evaluation's tuning.
 */
export async function createSherpaSeparator({
  threshold = CLUSTER_THRESHOLD,
  samePerson = SAME_PERSON,
  windowSeconds = WINDOW_SECONDS,
}: {
  threshold?: number;
  samePerson?: number;
  windowSeconds?: number;
} = {}): Promise<(request: SeparationRequest) => VoiceTurn[]> {
  const sherpa = await SHERPA.load();
  return (request) => {
    const { model } = request;
    const engine = new sherpa.OfflineSpeakerDiarization({
      segmentation: {
        pyannote: { model: model.segmentation },
        numThreads: model.threads,
        debug: 0,
      },
      embedding: { model: model.embedding, numThreads: model.threads, debug: 0 },
      clustering: { numClusters: -1, threshold },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    });
    const { samples, spans: partSpans } = joinParts(request.parts);
    if (samples.length === 0) return [];
    const segments = segmentsByWindow(samples, windowSeconds, (window) => engine.process(window));
    const extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: model.embedding,
      numThreads: model.threads,
      debug: 0,
    });
    const { map: joined, prints } = joinVoiceGroups(
      voiceprintsOf(extractor, samples, segments),
      samePerson,
    );
    const { turns, voiceOf } = meetingTurns(
      segments.map((segment) => ({
        ...segment,
        speaker: joined.get(segment.speaker) ?? segment.speaker,
      })),
      partSpans,
    );
    if (!request.spans?.length || prints.size < 2) return turns;
    const voicePrints = new Map<number, Float32Array>();
    for (const [speaker, print] of prints) {
      const voice = voiceOf.get(speaker);
      if (voice !== undefined) voicePrints.set(voice, print);
    }
    return refineTurnsWithSpans(turns, voicePrints, request.spans, (startMs, endMs) =>
      embedMeetingRange(extractor, samples, partSpans, startMs, endMs),
    );
  };
}
