/**
 * A pretend cloud transcription service, for the tests and the smoke tests (#141): it speaks
 * enough of OpenAI's, Soniox's and Qwen's protocols for their adapters (./cloud) and never
 * touches the network. Soniox's side gives a line, with a speaker, for every two seconds of
 * sound it is sent, and Qwen's a sentence; OpenAI's gives one for each turn committed. It can
 * refuse the key, or drop the connection after so much audio, as a lost network does.
 */
import { MEETING_SAMPLE_RATE } from "../adapters";
import { OPENAI_TRANSCRIPTION_URL } from "./cloud/openai";
import { HANDSHAKE_REFUSED, QWEN_REALTIME_PATH } from "./cloud/protocol";
import type { CloudConnect, CloudSocket } from "./cloud/socket";

export const FAKE_CLOUD_LINES: readonly string[] = [
  "The budget holds at one point two million.",
  "Partner preview stays on the twenty-eighth.",
  "Press waits for the new launch date.",
  "Mats checks the briefing date with the agency.",
];

export interface FakeCloudOptions {
  /** The connection drops once this many ms of audio have been sent on it. */
  dropAfterMs?: number;
  /** The service refuses the key. */
  refuse?: boolean;
  /** How many voices Soniox's side tells apart, taking turns line by line: 2 by default. */
  voices?: number;
  /** A first Qwen sentence that stays partial, so a drop leaves its speech unfinished. */
  latePartial?: { atMs: number; beginMs: number; text: string; dropOnFinish?: boolean };
}

/** 20 ms frames: one is speech when its level is above a whisper's, as the fake engine hears it. */
const FRAME = MEETING_SAMPLE_RATE / 50;
const LEVEL = 0.01 * 32768;
const LINE_MS = 2000;

const later = (run: () => void) => setTimeout(run, 0);

export function createFakeCloud(options: FakeCloudOptions = {}): CloudConnect {
  let said = 0;
  const nextLine = () => FAKE_CLOUD_LINES[said++ % FAKE_CLOUD_LINES.length] as string;

  return (url, _apiKey, events) => {
    const openai = url === OPENAI_TRANSCRIPTION_URL;
    const qwen = new URL(url).pathname === QWEN_REALTIME_PATH;
    let closed = false;
    let sentences = 0;
    let partialSent = false;
    let sentMs = 0;
    let loudMs = 0;
    let lineStartMs: number | null = null;
    let items = 0;
    let previous: string | null = null;
    const reply = (message: object) => {
      if (closed) return;
      later(() => events.message(JSON.stringify(message)));
    };
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      later(() => events.closed(code));
    };
    const heardAudio = (samples: Int16Array) => {
      const ms = (samples.length * 1000) / MEETING_SAMPLE_RATE;
      sentMs += ms;
      if (options.dropAfterMs !== undefined && sentMs >= options.dropAfterMs) close(1006);
      return ms;
    };

    const socket: CloudSocket = {
      send(data) {
        if (closed) return;
        if (openai) {
          if (typeof data !== "string") return;
          const event = JSON.parse(data) as { type: string; audio?: string };
          if (event.type === "session.update") reply({ type: "session.updated" });
          if (event.type === "input_audio_buffer.append" && event.audio) {
            const bytes = Buffer.from(event.audio, "base64");
            // 24 kHz samples: two thirds as many at the meeting's rate.
            heardAudio(new Int16Array(Math.round((bytes.byteLength / 2) * (2 / 3))));
          }
          if (event.type === "input_audio_buffer.commit") {
            const item = `item_${++items}`;
            const line = nextLine();
            reply({
              type: "input_audio_buffer.committed",
              previous_item_id: previous,
              item_id: item,
            });
            previous = item;
            reply({
              type: "conversation.item.input_audio_transcription.delta",
              item_id: item,
              delta: line,
            });
            reply({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: item,
              transcript: line,
            });
          }
          return;
        }
        if (qwen && typeof data === "string") {
          const { action } = (JSON.parse(data) as { header: { action: string } }).header;
          if (action === "run-task") reply({ header: { event: "task-started" }, payload: {} });
          if (action === "finish-task") {
            if (options.latePartial?.dropOnFinish) {
              close(1006);
              return;
            }
            reply({ header: { event: "task-finished" }, payload: { output: {}, usage: null } });
            close(1000);
          }
          return;
        }
        if (typeof data === "string") {
          if (data === "") {
            reply({
              tokens: [],
              final_audio_proc_ms: sentMs,
              total_audio_proc_ms: sentMs,
              finished: true,
            });
            close(1000);
          } else if (options.refuse) {
            reply({ tokens: [], error_code: 401, error_message: "Incorrect API key provided." });
            later(() => close(1000));
          }
          return;
        }
        const samples = new Int16Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
        const startMs = sentMs;
        heardAudio(samples);
        const late = options.latePartial;
        if (qwen && late && !partialSent && sentMs >= late.atMs) {
          partialSent = true;
          reply({
            header: { event: "result-generated" },
            payload: {
              output: {
                sentence: {
                  sentence_id: 1,
                  begin_time: late.beginMs,
                  end_time: null,
                  text: late.text,
                  heartbeat: false,
                  sentence_end: false,
                  words: [],
                },
              },
              usage: null,
            },
          });
        }
        for (let at = 0; at + FRAME <= samples.length; at += FRAME) {
          let sum = 0;
          for (let i = at; i < at + FRAME; i++) sum += (samples[i] as number) ** 2;
          const frameMs = startMs + (at * 1000) / MEETING_SAMPLE_RATE;
          if (Math.sqrt(sum / FRAME) <= LEVEL) continue;
          lineStartMs ??= frameMs;
          loudMs += 20;
          if (loudMs >= LINE_MS) {
            const start = lineStartMs;
            const end = frameMs + 20;
            const speaker = String((said % (options.voices ?? 2)) + 1);
            if (!late)
              reply(
                qwen
                  ? {
                      header: { event: "result-generated" },
                      payload: {
                        output: {
                          sentence: {
                            begin_time: start,
                            end_time: end,
                            text: nextLine(),
                            heartbeat: false,
                            sentence_end: true,
                            sentence_id: ++sentences,
                            words: [],
                          },
                        },
                        usage: { duration: Math.ceil(end / 1000) },
                      },
                    }
                  : {
                      tokens: [
                        {
                          text: nextLine(),
                          start_ms: start,
                          end_ms: end,
                          is_final: true,
                          speaker,
                        },
                        { text: "<end>", is_final: true },
                      ],
                      final_audio_proc_ms: end,
                      total_audio_proc_ms: end,
                    },
              );
            loudMs = 0;
            lineStartMs = null;
          }
        }
      },
      close: () => close(1000),
    };
    later(() => {
      if (closed) return;
      if (qwen && options.refuse) {
        closed = true;
        events.closed(HANDSHAKE_REFUSED);
        return;
      }
      events.open();
      if (openai && options.refuse) {
        reply({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key" } });
        later(() => close(3000));
      }
    });
    return socket;
  };
}
