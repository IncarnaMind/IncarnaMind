/**
 * A case's tracks sent to a cloud transcription route (#1031) through the app's own adapters
 * (src/core/transcription/cloud), each track a stream as a Meeting's microphone and computer
 * sound are, in 100 ms frames at the pace they were spoken: a live service takes audio as it
 * comes. The words to know go in the route's field as the app fits them (`cloudWords`).
 *
 * SONIOX_API_KEY, OPENAI_API_KEY: the keys. INCARNAMIND_EVAL_SONIOX_MODEL: Soniox's model, the
 * app's by default.
 */
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import {
  OPENAI_LIVE_TRANSCRIPTION_MODEL,
  SONIOX_REALTIME_MODEL,
} from "../../src/core/providers/catalog/transcription";
import { createOpenAiStream } from "../../src/core/transcription/cloud/openai";
import { connectWebSocket } from "../../src/core/transcription/cloud/socket";
import { createSonioxStream } from "../../src/core/transcription/cloud/soniox";
import type { CloudStreamHandle } from "../../src/core/transcription/cloud/stream";
import { cloudWords } from "../../src/core/transcription/cloud/words";
import { QWEN3_ASR_0_6B, transcriptionModelFiles } from "../../src/core/transcription/model";
import { createSileroDetectors } from "../../src/core/transcription/sherpa";
import type { VoiceDetector } from "../../src/core/transcription/speech";
import { FRAME, modelData } from "../transcription/clips";

export const CLOUD_ROUTES = ["soniox", "openai"] as const;
export type CloudRoute = (typeof CLOUD_ROUTES)[number];

export const isCloudRoute = (route: string): route is CloudRoute =>
  CLOUD_ROUTES.some((each) => each === route);

export const cloudModelOf = (route: CloudRoute) =>
  route === "soniox"
    ? (process.env.INCARNAMIND_EVAL_SONIOX_MODEL ?? SONIOX_REALTIME_MODEL)
    : OPENAI_LIVE_TRANSCRIPTION_MODEL;

const keyOf = (route: CloudRoute) => {
  const key = route === "soniox" ? process.env.SONIOX_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`No key for ${route}: set its key in the environment.`);
  return key;
};

const toInt16 = (samples: Float32Array) =>
  Int16Array.from(samples, (sample) =>
    Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
  );

let detectors: Promise<() => VoiceDetector> | null = null;
const loadDetectors = async () =>
  createSileroDetectors(transcriptionModelFiles(await modelData(), QWEN3_ASR_0_6B).vad);

/** The final segments a route gives for `tracks`, by track, told `words`; a lost stream throws. */
export async function transcribeOnCloud(
  route: CloudRoute,
  tracks: Readonly<Record<string, Float32Array>>,
  words: readonly string[],
): Promise<SpeechSegment[]> {
  const segments: SpeechSegment[] = [];
  const lost: string[] = [];
  const told = cloudWords(route, words);
  if (route === "openai") detectors ??= loadDetectors();
  const detector = route === "openai" ? await detectors : null;
  const handles: [string, CloudStreamHandle][] = [];
  for (const stream of Object.keys(tracks)) {
    const options = {
      stream,
      model: cloudModelOf(route),
      apiKey: keyOf(route),
      words: told,
      connect: connectWebSocket,
      report: {
        segment: (segment: SpeechSegment) => {
          if (segment.final && segment.text) segments.push(segment);
        },
        progress: () => {},
        lost: (loss: string) => lost.push(`${stream}: ${loss}`),
        opened: () => {},
      },
    };
    const handle = detector
      ? createOpenAiStream({ ...options, detector: detector() })
      : createSonioxStream(options);
    handles.push([stream, handle]);
  }
  const length = Math.max(...Object.values(tracks).map((samples) => samples.length));
  const started = Date.now();
  for (let at = 0; at < length; at += FRAME) {
    for (const [stream, handle] of handles) {
      const frame = (tracks[stream] as Float32Array).subarray(at, at + FRAME);
      if (frame.length > 0) handle.push(toInt16(frame));
    }
    const due = started + ((at + FRAME) * 1000) / MEETING_SAMPLE_RATE;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));
  }
  await Promise.all(handles.map(([, handle]) => handle.finish()));
  if (lost.length > 0) throw new Error(`${route} lost its stream: ${lost.join(", ")}`);
  return segments;
}
