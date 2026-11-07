/**
 * Mistral's real-time transcription (#866), Voxtral Mini Transcribe Realtime, on the User's
 * Mistral key from Settings › Models: all of the stream's audio goes as it comes, and its text
 * comes back as it is said, in pieces that never change (deltas). The text has no times, so the
 * service's turn detection says where each line starts and ends: a turn starts and ends at a
 * point in the audio, and its last words can come just after its end. It tells no speakers apart
 * with turns on.
 *
 * Protocol: https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-in-realtime and
 * https://docs.mistral.ai/studio/audio/speech-to-text/turn-detection. An error comes as an
 * `error` message; a key refused, or an account out of credit, at the handshake is a 401 or 402.
 */
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import { base64Pcm, closedLoss, createLiveStream, type LiveLink } from "./live";
import { type CloudStreamHandle, type CloudStreamOptions, msOf } from "./stream";

export { MISTRAL_REALTIME_MODEL } from "./protocol";
export const MISTRAL_REALTIME_URL = "wss://api.mistral.ai/v1/audio/transcriptions/realtime";
/** Each append holds at most 256 KiB of audio; a second is well inside it. */
const CHUNK_SAMPLES = 16_000;
/** The text lags the turns by the streaming delay (480 ms by default): a turn's last words wait this long. */
const LAST_WORDS_MS = 1500;
/** Text before any turn has started begins this long before it came. */
const UNTIMED_LEAD_MS = 1000;

export function mistralUrl(model: string): string {
  const url = new URL(MISTRAL_REALTIME_URL);
  url.searchParams.set("model", model);
  return url.toString();
}

/** An error in Mistral's words: the key, the account's credit, or anything else. */
export function mistralLoss(words: string): CloudLoss {
  if (/api key|unauthori[sz]ed|authenticat/i.test(words)) return "refused";
  if (/credit|payment|balance|billing/i.test(words)) return "credit";
  return "dropped";
}

interface Line {
  id: number;
  startMs: number;
  /** Where its turn ended, once it has. */
  endMs: number | null;
  text: string;
}

const secondsOf = (value: unknown) => (typeof value === "number" ? Math.round(value * 1000) : null);

export function createMistralStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  let received = 0;
  let line: Line | null = null;
  let nextId = 1;
  /** Where the last line ended. */
  let finalMs = 0;
  let said: CloudLoss | null = null;
  let lastWords: ReturnType<typeof setTimeout> | null = null;

  const update = JSON.stringify({
    type: "session.update",
    session: {
      audio_format: { encoding: "pcm_s16le", sample_rate: 16_000 },
      // No language named: it hears which is spoken.
      turn_detection: {},
    },
  });

  function segment(each: Line, final: boolean): void {
    const text = cleanSpeech(each.text);
    if (!text) return;
    const endMs = each.endMs ?? msOf(received);
    report.segment({
      stream,
      id: each.id,
      startMs: each.startMs,
      endMs: Math.max(each.startMs, endMs),
      text,
      final,
      decodeMs: 0,
    });
  }

  function close(): void {
    if (lastWords) clearTimeout(lastWords);
    lastWords = null;
    const done = line;
    line = null;
    if (!done) return;
    if (done.endMs === null) done.endMs = msOf(received);
    segment(done, true);
    finalMs = Math.max(finalMs, done.endMs);
  }

  function progress(): void {
    const done = line ? Math.min(line.startMs, finalMs) : msOf(received);
    report.progress(done, msOf(received));
  }

  function finished(link: LiveLink): void {
    close();
    progress();
    link.complete();
  }

  return createLiveStream(options, {
    url: mistralUrl(options.model),
    opened() {},
    heard(message, link) {
      switch (message.type) {
        case "session.created":
          link.setup(update);
          return;
        case "session.updated":
          link.ready();
          return;
        case "turn.start":
          close();
          line = {
            id: nextId++,
            startMs: secondsOf(message.time_s) ?? msOf(received),
            endMs: null,
            text: "",
          };
          progress();
          return;
        case "turn.end":
          if (!line) return;
          line.endMs = Math.max(line.startMs, secondsOf(message.time_s) ?? msOf(received));
          if (lastWords) clearTimeout(lastWords);
          lastWords = setTimeout(() => {
            close();
            progress();
          }, LAST_WORDS_MS);
          return;
        case "transcription.text.delta": {
          const text = typeof message.text === "string" ? message.text : "";
          if (!text) return;
          line ??= {
            id: nextId++,
            startMs: Math.max(finalMs, msOf(received) - UNTIMED_LEAD_MS),
            endMs: null,
            text: "",
          };
          line.text += text;
          segment(line, false);
          progress();
          return;
        }
        case "transcription.done":
          finished(link);
          return;
        case "error": {
          const error = message.error as { message?: unknown } | undefined;
          said = mistralLoss(typeof error?.message === "string" ? error.message : "");
          // The docs don't say the socket closes after an error: the key and credit end it here.
          if (said !== "dropped") link.lose(said);
          return;
        }
      }
    },
    audio(samples, link) {
      for (let at = 0; at < samples.length; at += CHUNK_SAMPLES) {
        const part = samples.subarray(at, at + CHUNK_SAMPLES);
        received += part.length;
        link.send(JSON.stringify({ type: "input_audio.append", audio: base64Pcm(part) }));
      }
      // It sends nothing while no one speaks: with no turn open, it has kept up with the audio.
      if (!line) progress();
    },
    finish(link) {
      link.send(JSON.stringify({ type: "input_audio.end" }));
    },
    late(link) {
      finished(link);
    },
    closed(code, _reason, link) {
      if (lastWords) clearTimeout(lastWords);
      if (said) return link.lose(said);
      if (link.finishing && code === 1000) return finished(link);
      link.lose(closedLoss(code));
    },
  });
}
