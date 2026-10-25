/**
 * Soniox's real-time transcription (#141): all of the stream's audio goes over the socket as it
 * comes, and text comes back token by token, each with who said it. Tokens that aren't final
 * yet can still change; final ones never do. The service ends an utterance with an `<end>`
 * token when the speaker pauses; a line ends there, or where the speaker changes.
 */
import { cleanSpeech } from "../speechText";
import {
  type CloudStreamHandle,
  type CloudStreamOptions,
  CONNECT_TIMEOUT_MS,
  FINISH_TIMEOUT_MS,
} from "./stream";

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

/** A line this long ends even without a pause, so its final text never waits long. */
const LONGEST_LINE_MS = 20_000;
/** The key is wrong, or may not use the service. */
const REFUSALS = new Set([401, 403]);

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
  let line: Line | null = null;
  let nextId = 1;
  let started = false;
  const waiting: (Uint8Array | string)[] = [];
  let ended = false;
  let refused = false;
  let finishing: { resolve(): void } | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let finalMs = 0;

  const socket = options.connect(SONIOX_URL, options.apiKey, {
    open() {
      if (ended) return;
      socket.send(
        JSON.stringify({
          model: options.model,
          audio_format: "pcm_s16le",
          sample_rate: 16_000,
          num_channels: 1,
          language_hints: ["en", "zh"],
          enable_speaker_diarization: true,
          enable_endpoint_detection: true,
        }),
      );
      started = true;
      clearTimeout(connectTimer);
      for (const audio of waiting.splice(0)) socket.send(audio);
      report.opened();
    },
    message: heard,
    closed() {
      if (ended) return;
      const finished = finishing !== null;
      end();
      if (!finished) report.lost(refused ? "refused" : "dropped");
    },
  });
  const connectTimer = setTimeout(() => {
    if (!started && !ended) socket.close();
  }, CONNECT_TIMEOUT_MS);

  function end(): void {
    ended = true;
    // What waited for the connection is never sent once the stream has ended.
    waiting.length = 0;
    clearTimeout(connectTimer);
    if (finishTimer) clearTimeout(finishTimer);
    finishing?.resolve();
    finishing = null;
  }

  function close(): void {
    const done = line;
    line = null;
    if (!done || done.tokens.length === 0) return;
    const first = done.tokens[0] as Token;
    const last = done.tokens.at(-1) as Token;
    report.segment({
      stream,
      id: done.id,
      startMs: first.start,
      endMs: Math.max(first.start, last.end),
      text: wordsOf(done.tokens),
      final: true,
      decodeMs: 0,
      ...(done.speaker !== null && { speaker: done.speaker }),
    });
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
    if (
      line &&
      line.tokens.length > 0 &&
      token.end - (line.tokens[0] as Token).start > LONGEST_LINE_MS
    ) {
      close();
    }
    line ??= { id: nextId++, tokens: [], speaker: null };
    line.tokens.push(token);
    if (words && line.speaker === null) line.speaker = token.speaker;
  }

  function heard(text: string): void {
    if (ended) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.error_code === "number") {
      refused = REFUSALS.has(message.error_code);
      end();
      socket.close();
      report.lost(refused ? "refused" : "dropped");
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
    const open = line?.tokens[0];
    report.progress(open ? Math.min(open.start, finalMs) : finalMs);
    if (message.finished === true) {
      close();
      end();
      socket.close();
    }
  }

  return {
    push(samples) {
      if (ended || finishing || samples.length === 0) return;
      const bytes = new Uint8Array(
        samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
      );
      if (started) socket.send(bytes);
      else waiting.push(bytes);
    },

    finish() {
      if (ended) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishing = { resolve };
        // An empty text frame ends the audio; the service sends what is left, then `finished`.
        if (started) socket.send("");
        else waiting.push("");
        finishTimer = setTimeout(() => {
          close();
          end();
          socket.close();
        }, FINISH_TIMEOUT_MS);
      });
    },

    drop() {
      if (ended) return;
      end();
      socket.close();
    },
  };
}
