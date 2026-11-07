/**
 * The pretend Deepgram, AssemblyAI and Gemini Live services (#866), for the tests and the smoke
 * tests, beside ./fakeCloud's other three. Each speaks its service's messages as its published
 * protocol shows them, never the network: a line for every two seconds of sound, with its words'
 * times and, where the service tells voices apart, its speaker; a refused key and an account
 * out of credit as each service says them; and a connection that drops.
 *
 * Deepgram: https://developers.deepgram.com/reference/speech-to-text/listen-streaming (a refused
 * key or no credit is an HTTP error at the handshake: 401, 402).
 * AssemblyAI: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api and
 * https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures.
 * Gemini: https://aistudio.google.com/api-reference/live.
 */
import { MEETING_SAMPLE_RATE } from "../adapters";
import { HANDSHAKE_NO_CREDIT, HANDSHAKE_REFUSED } from "./cloud/protocol";
import type { CloudSocket, CloudSocketEvents } from "./cloud/socket";

export interface FakeLiveOptions {
  dropAfterMs?: number;
  refuse?: boolean;
  noCredit?: boolean;
  voices?: number;
  /** Gemini's side says the connection ends (`goAway`) after this much audio, then ends it. */
  goAwayAfterMs?: number;
}

interface HeardLine {
  startMs: number;
  endMs: number;
  text: string;
  /** From 0, taking turns line by line. */
  voice: number;
}

/** 20 ms frames: one is speech when its level is above a whisper's, as the fake engine hears it. */
const FRAME = MEETING_SAMPLE_RATE / 50;
const LEVEL = 0.01 * 32768;
const LINE_MS = 2000;

const later = (run: () => void) => setTimeout(run, 0);

/** Lines in the sound as it comes: one for each two seconds of it, the next of `lines`. */
function lineMaker(nextLine: () => string, voices: number) {
  let sentMs = 0;
  let loudMs = 0;
  let quietMs = 0;
  let lineStartMs: number | null = null;
  let made = 0;
  return {
    get sentMs() {
      return sentMs;
    },
    /** The lines these samples end, and how much quiet they end with. */
    hear(samples: Int16Array): { lines: HeardLine[]; quietMs: number } {
      const lines: HeardLine[] = [];
      const startMs = sentMs;
      sentMs += (samples.length * 1000) / MEETING_SAMPLE_RATE;
      for (let at = 0; at + FRAME <= samples.length; at += FRAME) {
        let sum = 0;
        for (let i = at; i < at + FRAME; i++) sum += (samples[i] as number) ** 2;
        const frameMs = startMs + (at * 1000) / MEETING_SAMPLE_RATE;
        if (Math.sqrt(sum / FRAME) <= LEVEL) {
          quietMs += 20;
          continue;
        }
        quietMs = 0;
        lineStartMs ??= frameMs;
        loudMs += 20;
        if (loudMs >= LINE_MS) {
          lines.push({
            startMs: lineStartMs,
            endMs: frameMs + 20,
            text: nextLine(),
            voice: made++ % voices,
          });
          loudMs = 0;
          lineStartMs = null;
        }
      }
      return { lines, quietMs };
    },
  };
}

const samplesOf = (data: Uint8Array) =>
  new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

/** A line's words, spread evenly over its time. */
function wordsOf(line: HeardLine) {
  const words = line.text.split(" ");
  const each = (line.endMs - line.startMs) / words.length;
  return words.map((word, index) => ({
    text: word,
    startMs: Math.round(line.startMs + index * each),
    endMs: Math.round(line.startMs + (index + 1) * each),
  }));
}

type Make = (
  options: FakeLiveOptions,
  nextLine: () => string,
  events: CloudSocketEvents,
) => CloudSocket;

function connection(events: CloudSocketEvents) {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    reply(message: object) {
      if (closed) return;
      later(() => events.message(JSON.stringify(message)));
    },
    close(code: number, reason = "") {
      if (closed) return;
      closed = true;
      later(() => events.closed(code, reason));
    },
  };
}

export const fakeDeepgram: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, options.voices ?? 2);
  later(() => {
    if (options.refuse) return link.close(HANDSHAKE_REFUSED);
    if (options.noCredit) return link.close(HANDSHAKE_NO_CREDIT);
    events.open();
  });
  const results = (line: HeardLine | null, startMs: number, endMs: number, final: boolean) => ({
    type: "Results",
    channel_index: [0, 1],
    duration: (endMs - startMs) / 1000,
    start: startMs / 1000,
    is_final: final,
    speech_final: final && line !== null,
    channel: {
      alternatives: [
        {
          transcript: line?.text ?? "",
          confidence: line ? 0.98 : 0,
          words: (line ? wordsOf(line) : []).map((word) => ({
            word: word.text.replace(/[.,]$/, "").toLowerCase(),
            punctuated_word: word.text,
            start: word.startMs / 1000,
            end: word.endMs / 1000,
            confidence: 0.98,
            speaker: line?.voice ?? 0,
          })),
        },
      ],
    },
    metadata: { request_id: "fake-request", model_info: { name: "nova-3" } },
    from_finalize: false,
  });
  let finalMs = 0;
  return {
    send(data) {
      if (link.closed) return;
      if (typeof data === "string") {
        if ((JSON.parse(data) as { type?: string }).type === "CloseStream") {
          link.reply({
            type: "Metadata",
            request_id: "fake-request",
            created: "2026-11-05T09:00:00.000Z",
            duration: lines.sentMs / 1000,
            channels: 1,
          });
          link.close(1000);
        }
        return;
      }
      const heard = lines.hear(samplesOf(data));
      for (const line of heard.lines) {
        const half = { ...line, text: line.text.split(" ").slice(0, 2).join(" ") };
        link.reply(results(half, line.startMs, line.endMs, false));
        link.reply(results(line, finalMs, line.endMs, true));
        finalMs = line.endMs;
      }
      // Quiet still has its results, with no words, as the service sends them.
      if (heard.lines.length === 0 && heard.quietMs >= 1000) {
        link.reply(results(null, finalMs, lines.sentMs, true));
        finalMs = lines.sentMs;
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1011, "NET-0000");
      }
    },
    close: () => link.close(1000),
  };
};

export const fakeAssemblyAi: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, options.voices ?? 2);
  let turns = 0;
  let heartbeatMs = 0;
  const fail = (error: string) => {
    link.reply({ type: "Error", error_code: 1008, error });
    link.close(1008, "See Error message for details");
  };
  later(() => {
    events.open();
    if (options.refuse) return fail("Unauthorized Connection: Invalid API key");
    if (options.noCredit) return fail("Insufficient funds");
    link.reply({ type: "Begin", id: "fake-session", expires_at: 1_793_000_000 });
  });
  const labels = ["A", "B", "C", "D"];
  return {
    send(data) {
      if (link.closed) return;
      if (typeof data === "string") {
        if ((JSON.parse(data) as { type?: string }).type === "Terminate") {
          link.reply({
            type: "Termination",
            audio_duration_seconds: Math.round(lines.sentMs / 1000),
            session_duration_seconds: Math.round(lines.sentMs / 1000) + 1,
          });
          link.close(1000);
        }
        return;
      }
      const heard = lines.hear(samplesOf(data));
      for (const line of heard.lines) {
        const order = turns++;
        const words = wordsOf(line);
        const speaker = labels[line.voice] ?? "A";
        link.reply({
          type: "Turn",
          turn_order: order,
          turn_is_formatted: false,
          end_of_turn: false,
          transcript: words
            .slice(0, 2)
            .map((word) => word.text.replace(/[.,]$/, "").toLowerCase())
            .join(" "),
          end_of_turn_confidence: 0.2,
          words: words.slice(0, 2).map((word) => ({
            text: word.text,
            start: word.startMs,
            end: word.endMs,
            confidence: 0.97,
            word_is_final: true,
          })),
        });
        link.reply({
          type: "Turn",
          turn_order: order,
          turn_is_formatted: true,
          end_of_turn: true,
          transcript: line.text,
          utterance: line.text,
          speaker_label: speaker,
          end_of_turn_confidence: 0.94,
          words: words.map((word) => ({
            text: word.text,
            start: word.startMs,
            end: word.endMs,
            confidence: 0.97,
            word_is_final: true,
            speaker,
          })),
        });
      }
      if (lines.sentMs - heartbeatMs >= 5000) {
        heartbeatMs = lines.sentMs;
        link.reply({
          type: "Heartbeat",
          total_audio_received_ms: Math.round(lines.sentMs),
          total_duration_ms: Math.round(lines.sentMs) + 200,
          realtime_factor: 0.9964,
          max_speech_probability: 0.12,
        });
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(3005, "Internal error");
      }
    },
    close: () => link.close(1000),
  };
};

/** Seconds as protobuf's Duration writes them in JSON. */
const duration = (ms: number) => `${(ms / 1000).toFixed(3)}s`;

export const fakeGemini: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, 1);
  let left = false;
  later(() => {
    if (options.refuse) {
      return link.close(1008, "API key not valid. Please pass a valid API key.");
    }
    events.open();
  });
  return {
    send(data) {
      if (link.closed || typeof data !== "string") return;
      const message = JSON.parse(data) as {
        setup?: object;
        realtimeInput?: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean };
      };
      if (message.setup) {
        if (options.noCredit) {
          return link.close(
            1011,
            "You exceeded your current quota, please check your plan and billing details.",
          );
        }
        link.reply({ setupComplete: {} });
        return;
      }
      const audio = message.realtimeInput?.audio;
      if (message.realtimeInput?.audioStreamEnd) {
        link.reply({ serverContent: { turnComplete: true } });
        return;
      }
      if (!audio) return;
      const heard = lines.hear(samplesOf(Buffer.from(audio.data, "base64")));
      for (const line of heard.lines) {
        const words = line.text.split(" ");
        link.reply({
          serverContent: {
            interimInputTranscription: {
              text: words.slice(0, Math.ceil(words.length / 2)).join(" "),
              startOffset: duration(line.startMs),
              endOffset: duration(Math.round((line.startMs + line.endMs) / 2)),
            },
          },
        });
        link.reply({
          serverContent: {
            inputTranscription: {
              text: line.text,
              startOffset: duration(line.startMs),
              endOffset: duration(line.endMs),
            },
          },
        });
      }
      if (options.goAwayAfterMs !== undefined && !left && lines.sentMs >= options.goAwayAfterMs) {
        left = true;
        link.reply({ goAway: { timeLeft: "5s" } });
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1011, "Internal error encountered.");
      }
    },
    close: () => link.close(1000),
  };
};
