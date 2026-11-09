/**
 * xAI's streaming speech to text (#866), on the User's xAI key from Settings › Models: all of the
 * stream's audio goes as it comes, set up in the address alone, and results come back for a
 * stretch at a time: a guess that may still change (interim), then locked (chunk final), then the
 * utterance once the speaker stops (utterance final), each word with its time and speaker.
 *
 * Protocol: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text (Streaming
 * Speech-to-Text) and its schema, https://docs.x.ai/stt-streaming.ws.json. An error comes as an
 * `error` message, in words, before the socket closes. A handshake is refused before the socket
 * opens: the docs say 401 for a wrong key, which answers 400 "Incorrect API key provided", and an
 * account out of credit is a 403 saying so (../../providers/creditWords); ./socket reads both.
 */
import type { CloudLoss } from "../../adapters";
import { OUT_OF_CREDIT } from "../../providers/creditWords";
import { cleanSpeech } from "../speechText";
import { endsAfter, endsBefore } from "./lineEnds";
import {
  closedLoss,
  createLiveStream,
  heldWords,
  joinWords,
  type LiveLink,
  pcmBytes,
} from "./live";
import type { CloudStreamHandle, CloudStreamOptions } from "./stream";

export { XAI_STT_MODEL } from "./protocol";
export const XAI_STT_URL = "wss://api.x.ai/v1/stt";

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

/** `words`: the meeting's words to know, each a key term it leans towards (#1031). */
export function xaiUrl(model: string, words: readonly string[] = []): string {
  const url = new URL(XAI_STT_URL);
  url.searchParams.set("model", model);
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("encoding", "pcm");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("diarize", "true");
  for (const word of words) url.searchParams.append("keyterm", word);
  return url.toString();
}

/**
 * An error in xAI's words: the account's credit first, as its credit error also says "The caller
 * does not have permission", then the key, or anything else.
 */
export function xaiLoss(words: string): CloudLoss {
  if (OUT_OF_CREDIT.test(words)) return "credit";
  if (/api key|unauthori[sz]ed|credentials|permission/i.test(words)) return "refused";
  return "dropped";
}

const seconds = (value: unknown) => (typeof value === "number" ? Math.round(value * 1000) : null);

function wordsOf(message: Record<string, unknown>): Word[] {
  if (!Array.isArray(message.words)) return [];
  return message.words.flatMap((value: unknown) => {
    if (typeof value !== "object" || value === null) return [];
    const word = value as Record<string, unknown>;
    const text = typeof word.text === "string" ? word.text : "";
    const start = seconds(word.start);
    const end = seconds(word.end);
    if (!text.trim() || start === null || end === null) return [];
    const speaker = typeof word.speaker === "number" ? String(word.speaker + 1) : null;
    return [{ text, start, end, speaker }];
  });
}

const textOf = (words: readonly Word[]) => cleanSpeech(joinWords(words.map((word) => word.text)));

export function createXaiStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  const words = heldWords(options.words ?? []);
  let line: Line | null = null;
  let nextId = 1;
  /** All audio before this has its final results. */
  let finalMs = 0;
  /** The service has answered for all audio before this. */
  let heardMs = 0;
  let said: CloudLoss | null = null;

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
    const first = line?.words[0];
    if (first && endsBefore(word.end - first.start, true)) close();
    line ??= { id: nextId++, words: [], speaker: null };
    line.words.push(word);
    line.speaker ??= word.speaker;
    if (endsAfter(textOf(line.words), word.end - (line.words[0] as Word).start, true)) close();
  }

  /**
   * Final words for the stretch from `fromMs`. An utterance final holds the utterance whole, its
   * locked chunks again among them, so it replaces what the line already holds from there on.
   */
  function settle(fromMs: number, words: readonly Word[]): void {
    if (line) {
      line.words = line.words.filter((word) => word.start < fromMs);
      if (line.words.length === 0) line.speaker = null;
    }
    for (const word of words) add(word);
  }

  function partial(fromMs: number, pending: readonly Word[]): void {
    const shown = [...(line?.words ?? []).filter((word) => word.start < fromMs), ...pending];
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
    get url() {
      return xaiUrl(options.model, words.now);
    },
    words,
    opened() {
      said = null;
    },
    heard(message, link) {
      switch (message.type) {
        case "transcript.created":
          link.ready();
          return;
        case "transcript.partial": {
          const start = seconds(message.start) ?? finalMs;
          const end = start + (seconds(message.duration) ?? 0);
          heardMs = Math.max(heardMs, end);
          const words = wordsOf(message);
          if (message.is_final === true) {
            settle(start, words);
            finalMs = Math.max(finalMs, end);
            if (message.speech_final === true) close();
            else partial(end, []);
          } else {
            partial(start, words);
          }
          progress();
          return;
        }
        case "transcript.done": {
          // Words past the last final ones are the audio flushed at the end; any before were said.
          const late = wordsOf(message).filter((word) => word.start >= finalMs);
          for (const word of late) add(word);
          heardMs = Math.max(heardMs, seconds(message.duration) ?? 0);
          finished(link);
          return;
        }
        case "error":
          said = xaiLoss(typeof message.message === "string" ? message.message : "");
          return;
      }
    },
    audio(samples, link) {
      link.send(pcmBytes(samples));
    },
    finish(link) {
      link.send(JSON.stringify({ type: "audio.done" }));
    },
    late(link) {
      finished(link);
    },
    closed(code, _reason, link) {
      if (said) return link.lose(said);
      if (link.finishing && code === 1000) return finished(link);
      link.lose(closedLoss(code));
    },
  });
}
