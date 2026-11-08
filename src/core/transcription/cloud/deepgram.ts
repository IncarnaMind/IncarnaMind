/**
 * Deepgram's live transcription (#866), at Deepgram, at Cloudflare Workers AI's Deepgram model,
 * or at a server of the User's own that speaks Deepgram's protocol. All of the stream's audio
 * goes as it comes; results come back for a stretch of audio at a time, first as it may still
 * change (interim), then final, each word with its time and, as Deepgram tells voices apart,
 * its speaker. A line ends where the speaker pauses (`speech_final`, `UtteranceEnd`) or changes.
 *
 * Protocol: https://developers.deepgram.com/reference/speech-to-text/listen-streaming. Cloudflare
 * takes its own API token as a Bearer token, and the model in its path.
 */

import { isDeepgramHost } from "../../../shared/deepgram";
import { cleanSpeech } from "../speechText";
import { closedLoss, createLiveStream, joinWords, pcmBytes } from "./live";
import type { CloudAuth } from "./socket";
import type { CloudStreamHandle, CloudStreamOptions } from "./stream";

export { DEEPGRAM_MODEL, DEEPGRAM_URL } from "./protocol";

/** A line this long ends even without a pause, so its final text never waits long. */
const LONGEST_LINE_MS = 20_000;

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

export const isCloudflare = (url: string) => new URL(url).hostname === "api.cloudflare.com";

export const deepgramAuth = (url: string): CloudAuth => ({
  header: "Authorization",
  prefix: isCloudflare(url) ? "Bearer " : "Token ",
});

/**
 * The address with what is asked of the stream: 16 kHz PCM, interim results, speakers, any
 * language. Deepgram's own server is asked to leave the audio out of its model improvement, so
 * it keeps it only while transcribing (its Model Improvement Partnership Program page).
 */
export function deepgramUrl(server: string, model: string): string {
  const url = new URL(server);
  const cloudflare = isCloudflare(server);
  const query: [string, string][] = [
    ...(cloudflare ? [] : [["model", model] as [string, string]]),
    // Nova-3's multilingual set holds English and Chinese, as said in one call.
    ["language", "multi"],
    ...(cloudflare
      ? []
      : [["language_hint", "en"] as [string, string], ["language_hint", "zh"] as [string, string]]),
    ["encoding", "linear16"],
    ["sample_rate", "16000"],
    ["channels", "1"],
    ["interim_results", "true"],
    ["punctuate", "true"],
    ["smart_format", "true"],
    ["diarize", "true"],
    ["utterance_end_ms", "1000"],
    ...(isDeepgramHost(url.hostname) ? [["mip_opt_out", "true"] as [string, string]] : []),
  ];
  for (const [name, value] of query) url.searchParams.append(name, value);
  return url.toString();
}

const seconds = (value: unknown) => (typeof value === "number" ? Math.round(value * 1000) : null);

function wordsOf(result: Record<string, unknown>): Word[] {
  const channel = result.channel as { alternatives?: unknown } | undefined;
  const best = Array.isArray(channel?.alternatives) ? channel.alternatives[0] : undefined;
  const words = (best as { words?: unknown } | undefined)?.words;
  if (!Array.isArray(words)) return [];
  return words.flatMap((value: unknown) => {
    if (typeof value !== "object" || value === null) return [];
    const word = value as Record<string, unknown>;
    const text =
      typeof word.punctuated_word === "string"
        ? word.punctuated_word
        : typeof word.word === "string"
          ? word.word
          : "";
    const start = seconds(word.start);
    const end = seconds(word.end);
    if (!text.trim() || start === null || end === null) return [];
    const speaker = typeof word.speaker === "number" ? String(word.speaker + 1) : null;
    return [{ text, start, end, speaker }];
  });
}

const textOf = (words: readonly Word[]) => cleanSpeech(joinWords(words.map((word) => word.text)));

export function createDeepgramStream(
  options: CloudStreamOptions & { url: string },
): CloudStreamHandle {
  const { stream, report } = options;
  let line: Line | null = null;
  let nextId = 1;
  /** All audio before this has its final results. */
  let finalMs = 0;
  /** The service has answered for all audio before this. */
  let heardMs = 0;

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
      words: done.words.map((word) => ({ text: word.text, ms: word.start })),
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
    const said = [...(line?.words ?? []), ...pending];
    if (said.length === 0) return;
    line ??= { id: nextId++, words: [], speaker: null };
    const first = said[0] as Word;
    const speaker = line.speaker ?? pending[0]?.speaker ?? null;
    report.segment({
      stream,
      id: line.id,
      startMs: first.start,
      endMs: Math.max(first.start, (said.at(-1) as Word).end),
      text: textOf(said),
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

  return createLiveStream(options, {
    url: deepgramUrl(options.url, options.model),
    auth: deepgramAuth(options.url),
    opened(link) {
      link.ready();
    },
    heard(message, link) {
      switch (message.type) {
        case "Results": {
          const start = seconds(message.start) ?? 0;
          const end = start + (seconds(message.duration) ?? 0);
          heardMs = Math.max(heardMs, end);
          const words = wordsOf(message);
          if (message.is_final === true) {
            for (const word of words) add(word);
            finalMs = Math.max(finalMs, end);
            if (message.speech_final === true) close();
            else partial([]);
          } else {
            partial(words);
          }
          progress();
          return;
        }
        case "UtteranceEnd":
          close();
          progress();
          return;
        case "Metadata":
          // Sent last, once the service has answered for all audio after CloseStream.
          if (!link.finishing) return;
          close();
          report.progress(heardMs, heardMs);
          link.complete();
          return;
      }
    },
    audio(samples, link) {
      link.send(pcmBytes(samples));
    },
    finish(link) {
      link.send(JSON.stringify({ type: "CloseStream" }));
    },
    late(link) {
      close();
      link.complete();
    },
    // After CloseStream the service closes normally; any other close loses what was in flight.
    closed(code, _reason, link) {
      if (!link.finishing || code !== 1000) return link.lose(closedLoss(code));
      close();
      link.complete();
    },
  });
}
