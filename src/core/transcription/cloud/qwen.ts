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
import { isRecord } from "../../../shared/record";
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import { createLiveStream, heldWords, pcmBytes } from "./live";
import { HANDSHAKE_REFUSED } from "./protocol";
import { type CloudStreamHandle, type CloudStreamOptions, msOf } from "./stream";
import { QWEN_WORDS_SEPARATOR } from "./words";

/**
 * "InvalidApiKey": the key can't be used here, made in the other region, or wrong. "Arrearage":
 * the Alibaba Cloud account is overdue (https://help.aliyun.com/zh/model-studio/error-code).
 */
const lossOf = (errorCode: string): CloudLoss =>
  errorCode === "InvalidApiKey" ? "refused" : errorCode === "Arrearage" ? "credit" : "dropped";

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
  const words = heldWords(options.words ?? []);
  let taskId = crypto.randomUUID();
  let started = false;
  const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });
  let received = 0;
  let answeredMs = 0;
  let finalMs = 0;
  let furthestMs = 0;
  const open = new Map<number, Sentence>();

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

  return createLiveStream(options, {
    url: options.url,
    words,
    opened(link) {
      taskId = crypto.randomUUID();
      started = false;
      link.setup(
        JSON.stringify({
          header: header("run-task"),
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: options.model,
            // A meeting has long silences, which the service closes a quiet connection over.
            parameters: { format: "pcm", sample_rate: 16_000, heartbeat: true },
            // Its context holds earlier turns' text, a word list among them, in the User's turn.
            input:
              words.now.length > 0
                ? {
                    context: [
                      {
                        role: "user",
                        content: [
                          { type: "input_text", text: words.now.join(QWEN_WORDS_SEPARATOR) },
                        ],
                      },
                    ],
                  }
                : {},
          },
        }),
      );
    },
    heard(message, link) {
      const event = isRecord(message.header) ? message.header : {};
      switch (event.event) {
        case "task-started":
          started = true;
          link.ready();
          return;
        case "result-generated": {
          answeredMs = msOf(received);
          const sentence = sentenceOf(message.payload);
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
          settle();
          link.complete();
          return;
        case "task-failed": {
          const loss = lossOf(String(event.error_code));
          if (loss === "dropped" && !started && link.retryWithoutWords()) return;
          link.lose(loss);
          return;
        }
      }
    },
    audio(samples, link) {
      received += samples.length;
      link.send(pcmBytes(samples));
      report.progress(doneMs(), answeredMs);
    },
    finish(link) {
      link.send(JSON.stringify({ header: header("finish-task"), payload: { input: {} } }));
    },
    late(link) {
      link.lose("dropped");
    },
    closed(code, _reason, link) {
      link.lose(code === HANDSHAKE_REFUSED ? "refused" : "dropped");
    },
  });
}
