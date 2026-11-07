/**
 * Speechmatics' real-time transcription (#866), with its Mandarin and English language pack,
 * which takes both in one meeting: all of the stream's audio goes as it comes; words come back as
 * a guess that may still change (partial), then final, each with its time and who said it. A line
 * ends where the speaker pauses (`EndOfUtterance`) or changes.
 *
 * Protocol: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket and its AsyncAPI
 * spec, https://github.com/speechmatics/docs/blob/main/spec/realtime.yaml. An error comes as an
 * Error message before the socket closes, with a close code of its own (4001 for the key).
 */
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import { closedLoss, createLiveStream, joinWords, type LiveLink, pcmBytes } from "./live";
import type { CloudStreamHandle, CloudStreamOptions } from "./stream";

export { SPEECHMATICS_MODEL } from "./protocol";
/** The nearest of Speechmatics' regions takes the connection. */
export const SPEECHMATICS_URL = "wss://global.rt.speechmatics.com/v2";
/** Mandarin and English, as said in the same meeting. */
const LANGUAGE_PACK = "cmn_en";
/** A line this long ends even without a pause, so its final text never waits long. */
const LONGEST_LINE_MS = 20_000;

/**
 * An error by its type or close code: the key, the account's usage quota (the nearest the API
 * says to out of credit), or anything else; "quota_exceeded" is too many sessions at once.
 */
export function speechmaticsLoss(type: string | number): CloudLoss {
  if (type === "not_authorised" || type === 4001) return "refused";
  if (type === "timelimit_exceeded" || type === 4006) return "credit";
  return typeof type === "number" ? closedLoss(type) : "dropped";
}

interface Word {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

interface Line {
  id: number;
  words: Word[];
  speaker: string | null;
}

const seconds = (value: unknown) => (typeof value === "number" ? Math.round(value * 1000) : null);

function wordsOf(message: Record<string, unknown>): Word[] {
  if (!Array.isArray(message.results)) return [];
  return message.results.flatMap((value: unknown) => {
    if (typeof value !== "object" || value === null) return [];
    const result = value as Record<string, unknown>;
    const best = Array.isArray(result.alternatives)
      ? (result.alternatives[0] as Record<string, unknown> | undefined)
      : undefined;
    const text = typeof best?.content === "string" ? best.content : "";
    const start = seconds(result.start_time);
    const end = seconds(result.end_time);
    if (!text.trim() || start === null || end === null) return [];
    const label = typeof best?.speaker === "string" ? best.speaker : "";
    const speaker = /^S\d+$/.test(label) ? label.slice(1) : null;
    return [{ text, start, end, speaker }];
  });
}

const endOf = (message: Record<string, unknown>) => {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  return seconds(metadata?.end_time);
};

const textOf = (words: readonly Word[]) => cleanSpeech(joinWords(words.map((word) => word.text)));

export function createSpeechmaticsStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  let line: Line | null = null;
  let nextId = 1;
  let finalMs = 0;
  let heardMs = 0;
  /** How many chunks of audio were sent: the last one's number ends the stream. */
  let chunks = 0;
  let said: CloudLoss | null = null;

  const start = JSON.stringify({
    message: "StartRecognition",
    audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16_000 },
    transcription_config: {
      language: LANGUAGE_PACK,
      model: options.model,
      diarization: "speaker",
      enable_partials: true,
      max_delay: 2,
      conversation_config: { end_of_utterance_silence_trigger: 1 },
    },
  });

  function close(): void {
    const done = line;
    line = null;
    if (!done || done.words.length === 0) return;
    const first = done.words[0] as Word;
    const last = done.words.at(-1) as Word;
    report.segment({
      stream,
      id: done.id,
      startMs: first.start,
      endMs: Math.max(first.start, last.end),
      text: textOf(done.words),
      final: true,
      decodeMs: 0,
      ...(done.speaker !== null && { speaker: done.speaker }),
    });
  }

  function add(word: Word): void {
    if (line && line.speaker !== null && word.speaker !== null && word.speaker !== line.speaker) {
      close();
    }
    if (
      line &&
      line.words.length > 0 &&
      word.end - (line.words[0] as Word).start > LONGEST_LINE_MS
    ) {
      close();
    }
    line ??= { id: nextId++, words: [], speaker: null };
    line.words.push(word);
    line.speaker ??= word.speaker;
  }

  function partial(pending: readonly Word[]): void {
    const shown = [...(line?.words ?? []), ...pending];
    if (shown.length === 0) return;
    line ??= { id: nextId++, words: [], speaker: null };
    const first = shown[0] as Word;
    const speaker = line.speaker ?? pending[0]?.speaker ?? null;
    report.segment({
      stream,
      id: line.id,
      startMs: first.start,
      endMs: Math.max(first.start, (shown.at(-1) as Word).end),
      text: textOf(shown),
      final: false,
      decodeMs: 0,
      ...(speaker !== null && { speaker }),
    });
  }

  function progress(): void {
    const open = line?.words[0];
    const done = open ? Math.min(open.start, finalMs) : finalMs;
    report.progress(done, Math.max(done, heardMs));
  }

  function finished(link: LiveLink): void {
    close();
    report.progress(heardMs, heardMs);
    link.complete();
  }

  return createLiveStream(options, {
    url: SPEECHMATICS_URL,
    opened(link) {
      link.setup(start);
    },
    heard(message, link) {
      switch (message.message) {
        case "RecognitionStarted":
          link.ready();
          return;
        case "AddPartialTranscript":
          heardMs = Math.max(heardMs, endOf(message) ?? 0);
          partial(wordsOf(message));
          progress();
          return;
        case "AddTranscript": {
          for (const word of wordsOf(message)) add(word);
          const end = endOf(message);
          if (end !== null) {
            finalMs = Math.max(finalMs, end);
            heardMs = Math.max(heardMs, end);
          }
          partial([]);
          progress();
          return;
        }
        case "EndOfUtterance":
          close();
          progress();
          return;
        case "EndOfTranscript":
          finished(link);
          return;
        case "Error":
          said = speechmaticsLoss(typeof message.type === "string" ? message.type : "");
          return;
      }
    },
    audio(samples, link) {
      chunks += 1;
      link.send(pcmBytes(samples));
    },
    finish(link) {
      link.send(JSON.stringify({ message: "EndOfStream", last_seq_no: chunks }));
    },
    late(link) {
      finished(link);
    },
    closed(code, _reason, link) {
      if (said) return link.lose(said);
      if (link.finishing && code === 1000) return finished(link);
      link.lose(speechmaticsLoss(code));
    },
  });
}
