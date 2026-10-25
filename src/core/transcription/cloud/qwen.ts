/**
 * Qwen's real-time transcription: Alibaba Cloud Model Studio's `fun-asr-realtime`, which
 * switches between Chinese and English by itself. A task is started on the socket, all of the
 * stream's audio goes to it as it comes, and text comes back a sentence at a time: the words so
 * far, then the sentence once the speaker pauses. The service tells no speakers apart.
 *
 * It sends nothing while it hears silence, so what has been done is worked out here: everything
 * before the sentence being said, or, between sentences, all but the last moments, in which
 * speech may have begun without a first result yet.
 */
import { randomUUID } from "node:crypto";
import { cleanSpeech } from "../speechText";
import { HANDSHAKE_REFUSED } from "./socket";
import {
  type CloudStreamHandle,
  type CloudStreamOptions,
  CONNECT_TIMEOUT_MS,
  FINISH_TIMEOUT_MS,
  msOf,
} from "./stream";

/** Where it listens, on the host of the key's region: a key works in no other. */
export const QWEN_REALTIME_PATH = "/api-ws/v1/inference";

/** Between sentences, speech this recent may not have a result yet. */
const UNHEARD_MS = 2000;
/** The key can't be used here: made in the other region, or wrong. */
const REFUSALS = new Set(["InvalidApiKey"]);

interface Sentence {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
}

const numberOf = (value: unknown) => (typeof value === "number" ? value : null);

function sentenceOf(payload: unknown): (Sentence & { ended: boolean }) | null {
  const output = (payload as { output?: { sentence?: unknown } } | null)?.output;
  const sentence = output?.sentence as Record<string, unknown> | null | undefined;
  if (typeof sentence !== "object" || sentence === null || sentence.heartbeat === true) return null;
  const id = numberOf(sentence.sentence_id);
  if (id === null || id < 1) return null;
  const startMs = numberOf(sentence.begin_time) ?? 0;
  const words = Array.isArray(sentence.words) ? (sentence.words as { end_time?: unknown }[]) : [];
  return {
    id,
    startMs,
    endMs: Math.max(startMs, numberOf(sentence.end_time) ?? numberOf(words.at(-1)?.end_time) ?? 0),
    text: cleanSpeech(typeof sentence.text === "string" ? sentence.text : ""),
    ended: sentence.sentence_end === true,
  };
}

export function createQwenStream(options: CloudStreamOptions & { url: string }): CloudStreamHandle {
  const { stream, report } = options;
  const taskId = randomUUID();
  const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });
  let received = 0;
  let finalMs = 0;
  let furthestMs = 0;
  let open: Sentence | null = null;
  let started = false;
  const waiting: (Uint8Array | string)[] = [];
  let ended = false;
  let refused = false;
  let finishing: { resolve(): void } | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;

  const socket = options.connect(options.url, options.apiKey, {
    open() {
      if (ended) return;
      socket.send(
        JSON.stringify({
          header: header("run-task"),
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: options.model,
            // A meeting has long silences, which the service closes a quiet connection over.
            parameters: { format: "pcm", sample_rate: 16_000, heartbeat: true },
            input: {},
          },
        }),
      );
    },
    message: heard,
    closed(code) {
      if (ended) return;
      const finished = finishing !== null;
      end();
      if (!finished) report.lost(refused || code === HANDSHAKE_REFUSED ? "refused" : "dropped");
    },
  });
  const connectTimer = setTimeout(() => {
    if (!started && !ended) socket.close();
  }, CONNECT_TIMEOUT_MS);

  function end(): void {
    ended = true;
    // What waited for the task is never sent once the stream has ended.
    waiting.length = 0;
    clearTimeout(connectTimer);
    if (finishTimer) clearTimeout(finishTimer);
    finishing?.resolve();
    finishing = null;
  }

  function doneMs(): number {
    const candidate = open ? open.startMs : Math.max(finalMs, msOf(received) - UNHEARD_MS);
    furthestMs = Math.max(furthestMs, candidate);
    return furthestMs;
  }

  function say(sentence: Sentence, final: boolean): void {
    if (!sentence.text) return;
    report.segment({
      stream,
      id: sentence.id,
      startMs: sentence.startMs,
      endMs: sentence.endMs,
      text: sentence.text,
      final,
      decodeMs: 0,
    });
  }

  function settle(): void {
    if (open) say(open, true);
    open = null;
    report.progress(msOf(received));
  }

  function heard(text: string): void {
    if (ended) return;
    let message: { header?: Record<string, unknown>; payload?: unknown } | null;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message?.header?.event) {
      case "task-started":
        started = true;
        clearTimeout(connectTimer);
        for (const audio of waiting.splice(0)) socket.send(audio);
        report.opened();
        return;
      case "result-generated": {
        const sentence = sentenceOf(message?.payload);
        if (!sentence) return;
        if (sentence.ended) {
          if (open?.id === sentence.id) open = null;
          finalMs = Math.max(finalMs, sentence.endMs);
          say(sentence, true);
        } else {
          open = sentence;
          say(sentence, false);
        }
        report.progress(doneMs());
        return;
      }
      case "task-finished":
        settle();
        end();
        socket.close();
        return;
      case "task-failed":
        refused = REFUSALS.has(String(message?.header?.error_code));
        end();
        socket.close();
        report.lost(refused ? "refused" : "dropped");
        return;
    }
  }

  return {
    push(samples) {
      if (ended || finishing || samples.length === 0) return;
      received += samples.length;
      const bytes = new Uint8Array(
        samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
      );
      if (started) socket.send(bytes);
      else waiting.push(bytes);
      report.progress(doneMs());
    },

    finish() {
      if (ended) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishing = { resolve };
        const done = JSON.stringify({ header: header("finish-task"), payload: { input: {} } });
        if (started) socket.send(done);
        else waiting.push(done);
        finishTimer = setTimeout(() => {
          settle();
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
