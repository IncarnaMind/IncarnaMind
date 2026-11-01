/**
 * Qwen's real-time transcription: Alibaba Cloud Model Studio's `fun-asr-realtime`, which
 * switches between Chinese and English by itself. A task is started on the socket, all of the
 * stream's audio goes to it as it comes, and text comes back a sentence at a time: the words so
 * far, then the sentence once the speaker pauses. The service tells no speakers apart.
 *
 * Text is done only up to a final result's boundary: the last finished sentence, or the start of
 * the sentence now being said. Audio received beyond that is not guessed to be finished, since a
 * late result can show that it is speech which still needs replaying after a lost connection.
 * Apart from that, every result, a heartbeat in a long silence included, shows the service keeps
 * up with the audio sent before it: that alone says live text isn't falling behind.
 */
import { cleanSpeech } from "../speechText";
import { HANDSHAKE_REFUSED } from "./protocol";
import {
  type CloudStreamHandle,
  type CloudStreamOptions,
  CONNECT_TIMEOUT_MS,
  FINISH_TIMEOUT_MS,
  msOf,
} from "./stream";

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
  const taskId = crypto.randomUUID();
  const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });
  let received = 0;
  let answeredMs = 0;
  let finalMs = 0;
  let furthestMs = 0;
  const open = new Map<number, Sentence>();
  let completed = false;
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
      end();
      if (!completed) report.lost(refused || code === HANDSHAKE_REFUSED ? "refused" : "dropped");
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
    const candidate =
      open.size === 0
        ? finalMs
        : Math.min(...[...open.values()].map((sentence) => sentence.startMs));
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
    for (const sentence of [...open.values()].sort((a, b) => a.startMs - b.startMs)) {
      say(sentence, true);
    }
    open.clear();
    report.progress(msOf(received), msOf(received));
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
        answeredMs = msOf(received);
        const sentence = sentenceOf(message?.payload);
        if (sentence?.ended) {
          open.delete(sentence.id);
          finalMs = Math.max(finalMs, sentence.endMs);
          say(sentence, true);
        } else if (sentence) {
          open.set(sentence.id, sentence);
          say(sentence, false);
        }
        report.progress(doneMs(), answeredMs);
        return;
      }
      case "task-finished":
        completed = true;
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
      report.progress(doneMs(), answeredMs);
    },

    finish() {
      if (ended) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishing = { resolve };
        const done = JSON.stringify({ header: header("finish-task"), payload: { input: {} } });
        if (started) socket.send(done);
        else waiting.push(done);
        finishTimer = setTimeout(() => {
          end();
          socket.close();
          report.lost("dropped");
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
