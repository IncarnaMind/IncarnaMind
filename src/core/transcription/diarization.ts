/**
 * Telling the voices in a recording apart (#138), with sherpa-onnx-node's speaker diarization:
 * pyannote's segmentation model finds where each voice speaks, 3D-Speaker's CAM++ gives each
 * stretch a voiceprint, and the stretches are clustered into voices. Its `process` holds its
 * thread until it is done, so the desktop app runs it in a process of its own
 * (src/main/speakerProcess.ts).
 */
import { readFileSync, statSync } from "node:fs";
import type { SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import {
  type ClusteredVoices,
  MEETING_SAMPLE_RATE,
  type SpeakerModelFiles,
  type VoiceTurn,
} from "../adapters";
import { SHERPA } from "./sherpa";
import { joinedTurns, SAME_PERSON, WINDOW_SECONDS } from "./voiceprints";

/** Voiceprints closer than this are one voice: set on the first 15 minutes of the English cases of eval/meetings (eval/speakers/README.md). */
export const CLUSTER_THRESHOLD = 1.05;

/** A voiceprint is taken from a voice's longest stretches, up to this much of them. */
const PRINT_SECONDS = 30;

const WAV_HEADER_BYTES = 44;
const SAMPLES_PER_MS = MEETING_SAMPLE_RATE / 1000;

const samplesIn = (bytes: number) => Math.max(0, Math.floor((bytes - WAV_HEADER_BYTES) / 2));

export interface SeparationRequest {
  parts: readonly { path: string; offsetMs: number }[];
  model: SpeakerModelFiles;
}

interface Span {
  /** Where it starts in the joined samples. */
  at: number;
  length: number;
  offsetMs: number;
}

// Read straight into one array, a part at a time: the whole recording is held once, not twice.
function joinParts(parts: SeparationRequest["parts"]): { samples: Float32Array; spans: Span[] } {
  const sorted = [...parts].sort((a, b) => a.offsetMs - b.offsetMs);
  const lengths = sorted.map((part) => samplesIn(statSync(part.path).size));
  const samples = new Float32Array(lengths.reduce((sum, length) => sum + length, 0));
  const spans: Span[] = [];
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

/**
 * The engine's segments (seconds of the joined samples, its own speaker numbers) in the
 * Meeting's time, cut where the recording paused, with voices numbered in the order first heard.
 */
export function toMeetingTime(
  segments: readonly { start: number; end: number; speaker: number }[],
  spans: readonly Span[],
): VoiceTurn[] {
  const order = new Map<number, number>();
  const turns: VoiceTurn[] = [];
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const voice = order.get(segment.speaker) ?? order.size;
    order.set(segment.speaker, voice);
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
  return turns;
}

export interface Segment {
  start: number;
  end: number;
  speaker: number;
}

function voiceprintsOf(
  extractor: SpeakerEmbeddingExtractor,
  samples: Float32Array,
  segments: readonly Segment[],
): Map<number, { print: Float32Array; seconds: number }> {
  const bySpeaker = new Map<number, Segment[]>();
  for (const segment of segments) {
    bySpeaker.set(segment.speaker, [...(bySpeaker.get(segment.speaker) ?? []), segment]);
  }
  const voices = new Map<number, { print: Float32Array; seconds: number }>();
  for (const [speaker, own] of bySpeaker) {
    const longest = [...own].sort((a, b) => b.end - b.start - (a.end - a.start));
    const stream = extractor.createStream();
    let taken = 0;
    for (const segment of longest) {
      if (taken >= PRINT_SECONDS) break;
      const seconds = Math.min(segment.end - segment.start, PRINT_SECONDS - taken);
      const from = Math.round(segment.start * MEETING_SAMPLE_RATE);
      stream.acceptWaveform({
        samples: samples.subarray(from, from + Math.round(seconds * MEETING_SAMPLE_RATE)),
        sampleRate: MEETING_SAMPLE_RATE,
      });
      taken += seconds;
    }
    stream.inputFinished();
    voices.set(speaker, {
      print: Float32Array.from(extractor.compute(stream, false)),
      seconds: own.reduce((sum, segment) => sum + segment.end - segment.start, 0),
    });
  }
  return voices;
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

/** The segments with their voices numbered from 0 in the order first heard, as their turns are. */
function numberedAsHeard(segments: readonly Segment[]): Segment[] {
  const order = new Map<number, number>();
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    if (!order.has(segment.speaker)) order.set(segment.speaker, order.size);
  }
  return segments.map((segment) => ({ ...segment, speaker: order.get(segment.speaker) ?? 0 }));
}

/**
 * Clusters the voices in a request's parts, each with its voiceprint. The models load for each
 * request. `threshold` and `windowSeconds` are for the evaluation's tuning.
 */
export async function createSherpaClusterer({
  threshold = CLUSTER_THRESHOLD,
  windowSeconds = WINDOW_SECONDS,
}: {
  threshold?: number;
  windowSeconds?: number;
} = {}): Promise<(request: SeparationRequest) => ClusteredVoices> {
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
    const { samples, spans } = joinParts(request.parts);
    if (samples.length === 0) return { turns: [], voices: [] };
    const segments = numberedAsHeard(
      segmentsByWindow(samples, windowSeconds, (window) => engine.process(window)),
    );
    const extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: model.embedding,
      numThreads: model.threads,
      debug: 0,
    });
    return {
      turns: toMeetingTime(segments, spans),
      voices: [...voiceprintsOf(extractor, samples, segments)].map(([voice, heard]) => ({
        voice,
        ...heard,
      })),
    };
  };
}

/**
 * Separates the voices in a request's parts, as the speaker pass does with a recording clustered
 * whole. `samePerson` is for the evaluation's tuning, with `createSherpaClusterer`'s options.
 */
export async function createSherpaSeparator({
  samePerson = SAME_PERSON,
  ...options
}: {
  threshold?: number;
  samePerson?: number;
  windowSeconds?: number;
} = {}): Promise<(request: SeparationRequest) => VoiceTurn[]> {
  const cluster = await createSherpaClusterer(options);
  return (request) => joinedTurns([cluster(request)], samePerson);
}
