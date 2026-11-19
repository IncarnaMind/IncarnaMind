/**
 * Soniox's real-time transcription (#141): all of the stream's audio goes over the socket as it
 * comes, and text comes back token by token, each with who said it. Tokens that aren't final
 * yet can still change; final ones never do. The service ends an utterance with an `<end>`
 * token when the speaker pauses; a line ends there, where the speaker changes, or at a sentence's
 * end (./lineEnds).
 */
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import { CLOSES, endsAfter, endsBefore, startsWord } from "./lineEnds";
import { closedLoss, createLiveStream, heldWords, type LiveLink, pcmBytes } from "./live";
import type { CloudStreamHandle, CloudStreamOptions } from "./stream";

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

export function transientSonioxLoss(code?: number): boolean {
  return (
    code !== undefined &&
    [408, 413, 500, 502, 503, 504, 1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014].includes(code)
  );
}

/** The key is wrong, or may not use the service; or the account has no credit left. */
const lossOf = (errorCode: number): CloudLoss =>
  errorCode === 401 || errorCode === 403 ? "refused" : errorCode === 402 ? "credit" : "dropped";

interface Token {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

interface Line {
  id: number;
  tokens: Token[];
  speaker: string | null;
}

const isMarker = (text: string) => text === "<end>" || text === "<fin>";

function tokenOf(value: unknown): (Token & { final: boolean }) | null {
  if (typeof value !== "object" || value === null) return null;
  const token = value as Record<string, unknown>;
  if (typeof token.text !== "string") return null;
  return {
    text: token.text,
    start: typeof token.start_ms === "number" ? token.start_ms : 0,
    end: typeof token.end_ms === "number" ? token.end_ms : 0,
    speaker: typeof token.speaker === "string" ? token.speaker : null,
    final: token.is_final === true,
  };
}

const wordsOf = (tokens: readonly Token[]) =>
  cleanSpeech(tokens.map((token) => token.text).join(""));

export function createSonioxStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  const words = heldWords(options.words ?? []);
  let line: Line | null = null;
  let nextId = 1;
  let finalMs = 0;
  let lastWordEndMs = 0;

  function close(): void {
    const done = line;
    line = null;
    if (!done || done.tokens.length === 0) return;
    const first = done.tokens[0] as Token;
    const last = done.tokens.at(-1) as Token;
    lastWordEndMs = Math.max(lastWordEndMs, last.end);
    report.segment({
      stream,
      id: done.id,
      startMs: first.start,
      endMs: Math.max(first.start, last.end),
      text: wordsOf(done.tokens),
      final: true,
      decodeMs: 0,
      ...(done.speaker !== null && { speaker: done.speaker }),
      words: done.tokens.map((token) => ({ text: token.text, ms: token.start })),
    });
  }

  function interrupted(link: LiveLink, loss: CloudLoss, code?: number): void {
    // A fresh connection needs the whole unfinished line to recognize its first words.
    if (link.finishing || !transientSonioxLoss(code)) {
      const hadLine = line !== null;
      close();
      report.progress(hadLine ? lastWordEndMs : Math.max(finalMs, lastWordEndMs));
    }
    link.lose(loss, code);
  }

  function add(token: Token): void {
    const words = token.text.trim().length > 0;
    if (
      line &&
      words &&
      line.speaker !== null &&
      token.speaker !== null &&
      token.speaker !== line.speaker
    ) {
      close();
    }
    const first = line?.tokens[0];
    if (line && first) {
      const text = wordsOf(line.tokens);
      const ms = (line.tokens.at(-1) as Token).end - first.start;
      const wordStart = startsWord(text, token.text);
      // A sentence ends at the piece after it, unless that piece closes it ("?" then "”") or goes
      // on with its word ("3." then "5").
      if (
        (!CLOSES.test(token.text) && endsAfter(text, ms, wordStart)) ||
        endsBefore(token.end - first.start, wordStart)
      ) {
        close();
      }
    }
    line ??= { id: nextId++, tokens: [], speaker: null };
    line.tokens.push(token);
    if (words && line.speaker === null) line.speaker = token.speaker;
  }

  return createLiveStream(options, {
    url: SONIOX_URL,
    words,
    opened(link) {
      link.setup(
        JSON.stringify({
          model: options.model,
          audio_format: "pcm_s16le",
          sample_rate: 16_000,
          num_channels: 1,
          language_hints: ["en", "zh"],
          enable_speaker_diarization: true,
          enable_endpoint_detection: true,
          ...(words.now.length > 0 && { context: { terms: words.now } }),
        }),
      );
      link.ready();
    },
    heard(message, link) {
      if (typeof message.error_code === "number") {
        // A context it won't take is a bad request, its first answer.
        if (message.error_code === 400 && link.retryWithoutWords()) return;
        interrupted(link, lossOf(message.error_code), message.error_code);
        return;
      }
      const tokens = (Array.isArray(message.tokens) ? message.tokens : [])
        .map(tokenOf)
        .filter((token) => token !== null);
      for (const token of tokens) {
        if (!token.final) continue;
        if (isMarker(token.text)) close();
        else add(token);
      }
      if (typeof message.final_audio_proc_ms === "number") finalMs = message.final_audio_proc_ms;
      const pending = tokens.filter((token) => !token.final && !isMarker(token.text));
      const said = [...(line?.tokens ?? []), ...pending];
      const words = wordsOf(said);
      if (words && said.length > 0) {
        line ??= { id: nextId++, tokens: [], speaker: null };
        const first = said[0] as Token;
        report.segment({
          stream,
          id: line.id,
          startMs: first.start,
          endMs: Math.max(first.start, (said.at(-1) as Token).end),
          text: words,
          final: false,
          decodeMs: 0,
          ...((line.speaker ?? pending[0]?.speaker ?? null) !== null && {
            speaker: (line.speaker ?? pending[0]?.speaker) as string,
          }),
        });
      }
      const open = said[0];
      const doneMs = Math.max(lastWordEndMs, open ? Math.min(open.start, finalMs) : finalMs);
      const processedMs = message.total_audio_proc_ms;
      report.progress(
        doneMs,
        typeof processedMs === "number" ? Math.max(doneMs, processedMs) : doneMs,
      );
      if (message.finished === true) {
        close();
        link.complete();
      }
    },
    audio(samples, link) {
      link.send(pcmBytes(samples));
    },
    finish(link) {
      // An empty text frame ends the audio; the service sends what is left, then `finished`.
      link.send("");
    },
    late(link) {
      interrupted(link, "dropped");
    },
    // A close before the service's "finished" leaves audio for the Meeting to replay.
    closed(code, _reason, link) {
      interrupted(link, closedLoss(code), code);
    },
  });
}
