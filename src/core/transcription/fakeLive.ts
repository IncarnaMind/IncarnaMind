/**
 * The pretend Deepgram, AssemblyAI, Gemini Live, xAI, Speechmatics, ElevenLabs, Gladia and Mistral
 * services (#866), for the tests and the smoke tests, beside ./fakeCloud's other three. Each
 * speaks its service's messages as its published
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
import type { CloudServing } from "./channel";
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

/** A line's words with a closing mark apart, as services that send punctuation on its own do. */
function splitMarks(line: HeardLine) {
  return wordsOf(line).flatMap((word) => {
    const mark = /[.,!?]$/.exec(word.text)?.[0];
    if (!mark) return [{ ...word, mark: false }];
    return [
      { ...word, text: word.text.slice(0, -1), mark: false },
      { text: mark, startMs: word.endMs, endMs: word.endMs, mark: true },
    ];
  });
}

const twoPlaces = (ms: number) => Math.round(ms / 10) / 100;

/**
 * xAI: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text. Its handshake refuses
 * a wrong key with a 400 "Incorrect API key provided" and an account out of credit with a 403
 * "used all available credits", which the socket's probe reads as these closes.
 */
export const fakeXai: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, options.voices ?? 2);
  later(() => {
    if (options.refuse) return link.close(HANDSHAKE_REFUSED);
    if (options.noCredit) return link.close(HANDSHAKE_NO_CREDIT);
    events.open();
    link.reply({ type: "transcript.created", id: "83f2f6fd-1cd1-4747-bc52-cebddc961c32" });
  });
  const partial = (line: HeardLine, words: ReturnType<typeof wordsOf>, flags: object) => ({
    type: "transcript.partial",
    text: words.map((word) => word.text).join(" "),
    words: words.map((word) => ({
      text: word.text,
      start: twoPlaces(word.startMs),
      end: twoPlaces(word.endMs),
      confidence: 0.95,
      speaker: line.voice,
    })),
    start: twoPlaces(words[0]?.startMs ?? line.startMs),
    duration: twoPlaces(line.endMs - (words[0]?.startMs ?? line.startMs)),
    ...flags,
  });
  return {
    send(data) {
      if (link.closed) return;
      if (typeof data === "string") {
        if ((JSON.parse(data) as { type?: string }).type === "audio.done") {
          link.reply({
            type: "transcript.done",
            text: "",
            words: [],
            duration: twoPlaces(lines.sentMs),
          });
          link.close(1000);
        }
        return;
      }
      for (const line of lines.hear(samplesOf(data)).lines) {
        const words = wordsOf(line);
        const half = Math.ceil(words.length / 2);
        link.reply(partial(line, words.slice(0, 2), { is_final: false, speech_final: false }));
        // A chunk locked, then the utterance whole, its locked chunk again among it.
        link.reply(partial(line, words.slice(0, half), { is_final: true, speech_final: false }));
        link.reply(partial(line, words, { is_final: true, speech_final: true }));
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1011);
      }
    },
    close: () => link.close(1000),
  };
};

/**
 * Speechmatics: https://github.com/speechmatics/docs/blob/main/spec/realtime.yaml. A refused key
 * is a 401 at the handshake; an account at its usage quota is a `timelimit_exceeded` Error and
 * close 4006, the nearest the API says to out of credit.
 */
export const fakeSpeechmatics: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, options.voices ?? 2);
  let added = 0;
  later(() => {
    if (options.refuse) return link.close(HANDSHAKE_REFUSED);
    events.open();
  });
  const results = (line: HeardLine, upTo: number) =>
    splitMarks(line)
      .slice(0, upTo)
      .map((word) => ({
        type: word.mark ? "punctuation" : "word",
        start_time: word.startMs / 1000,
        end_time: word.endMs / 1000,
        ...(word.mark && { attaches_to: "previous", is_eos: word.text === "." }),
        alternatives: [
          { content: word.text, confidence: 0.98, language: "en", speaker: `S${line.voice + 1}` },
        ],
      }));
  const transcript = (message: string, line: HeardLine, upTo: number) => ({
    message,
    format: "2.9",
    metadata: {
      start_time: line.startMs / 1000,
      end_time: line.endMs / 1000,
      transcript: line.text,
    },
    results: results(line, upTo),
  });
  return {
    send(data) {
      if (link.closed) return;
      if (typeof data === "string") {
        const message = JSON.parse(data) as { message?: string };
        if (message.message === "StartRecognition") {
          if (options.noCredit) {
            link.reply({
              message: "Error",
              type: "timelimit_exceeded",
              reason: "Usage quota for the contract has been reached",
            });
            return link.close(4006);
          }
          link.reply({ message: "RecognitionStarted", id: "807670e9-14af-4fa2-9e8f-5d525c22156e" });
        }
        if (message.message === "EndOfStream") {
          link.reply({ message: "EndOfTranscript" });
          link.close(1000);
        }
        return;
      }
      link.reply({ message: "AudioAdded", seq_no: ++added });
      for (const line of lines.hear(samplesOf(data)).lines) {
        link.reply(transcript("AddPartialTranscript", line, 2));
        link.reply(transcript("AddTranscript", line, Number.POSITIVE_INFINITY));
        link.reply({
          message: "EndOfUtterance",
          metadata: { start_time: line.endMs / 1000, end_time: line.endMs / 1000 },
        });
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1011);
      }
    },
    close: () => link.close(1000),
  };
};

/**
 * ElevenLabs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime.
 * Its socket opens for any key, then says what is wrong in a message and closes with 1000.
 */
export const fakeElevenLabs: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, 1);
  const fail = (message_type: string, error: string) => {
    link.reply({ message_type, error });
    link.close(1000);
  };
  later(() => {
    events.open();
    if (options.refuse)
      return fail("auth_error", "You must be authenticated to use this endpoint.");
    if (options.noCredit) return fail("quota_exceeded", "You have exceeded your usage quota.");
    link.reply({
      message_type: "session_started",
      session_id: "fake-session",
      config: { model_id: "scribe_v2_realtime", audio_format: "pcm_16000" },
    });
  });
  return {
    send(data) {
      if (link.closed || typeof data !== "string") return;
      const chunk = JSON.parse(data) as { audio_base_64?: string; commit?: boolean };
      if (!chunk.audio_base_64) return;
      for (const line of lines.hear(samplesOf(Buffer.from(chunk.audio_base_64, "base64"))).lines) {
        const words = wordsOf(line);
        link.reply({
          message_type: "partial_transcript",
          text: words
            .slice(0, 2)
            .map((word) => word.text)
            .join(" "),
        });
        link.reply({ message_type: "committed_transcript", text: line.text });
        link.reply({
          message_type: "committed_transcript_with_timestamps",
          text: line.text,
          language_code: "eng",
          words: words.flatMap((word, index) => [
            ...(index > 0
              ? [
                  {
                    text: " ",
                    start: word.startMs / 1000,
                    end: word.startMs / 1000,
                    type: "spacing",
                  },
                ]
              : []),
            { text: word.text, start: word.startMs / 1000, end: word.endMs / 1000, type: "word" },
          ]),
        });
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1006);
      }
    },
    close: () => link.close(1000),
  };
};

/**
 * Gladia's socket, at the address its session's request gave (`fakeGladiaFetch`):
 * https://docs.gladia.io/api-reference/v2/live/websocket.
 */
export const fakeGladia: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, 1);
  let utterances = 0;
  later(() => events.open());
  const transcript = (id: string, line: HeardLine, upTo: number, final: boolean) => {
    const words = wordsOf(line).slice(0, upTo);
    return {
      session_id: "636c70f6-92c1-4026-a8b6-0dfe3ecf826f",
      created_at: "2026-11-07T09:00:00.000Z",
      type: "transcript",
      data: {
        id,
        is_final: final,
        utterance: {
          start: line.startMs / 1000,
          end: (words.at(-1)?.endMs ?? line.endMs) / 1000,
          confidence: 0.93,
          channel: 0,
          words: words.map((word) => ({
            word: word.text,
            start: word.startMs / 1000,
            end: word.endMs / 1000,
            confidence: 0.95,
          })),
          text: words.map((word) => word.text).join(" "),
          language: "en",
        },
      },
    };
  };
  return {
    send(data) {
      if (link.closed) return;
      if (typeof data === "string") {
        if ((JSON.parse(data) as { type?: string }).type === "stop_recording") link.close(1000);
        return;
      }
      for (const line of lines.hear(samplesOf(data)).lines) {
        const id = `00-${String(++utterances).padStart(8, "0")}`;
        link.reply(transcript(id, line, 2, false));
        link.reply(transcript(id, line, Number.POSITIVE_INFINITY, true));
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1006);
      }
    },
    close: () => link.close(1000),
  };
};

/**
 * Gladia's request for a live session: https://docs.gladia.io/api-reference/v2/live/init. A
 * refused key is a 401; its answer for an account out of credit isn't published, so the 402
 * here is a guess the owner's hand check confirms.
 */
export function fakeGladiaFetch(options: FakeLiveOptions): CloudServing["fetch"] {
  let sessions = 0;
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://api.gladia.io/v2/live" || init?.method !== "POST") {
      throw new Error(`The pretend services don't answer ${url}.`);
    }
    const json = (status: number, body: object) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (options.refuse) {
      return json(401, { statusCode: 401, message: "gladia key not found" });
    }
    if (options.noCredit) return json(402, { statusCode: 402, message: "Payment required" });
    const id = `636c70f6-92c1-4026-a8b6-${String(++sessions).padStart(12, "0")}`;
    return json(201, { id, url: `wss://api.gladia.io/v2/live?token=${id}` });
  };
}

/**
 * Mistral: https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-in-realtime and its
 * turn detection. A refused key and an account out of credit are its API's 401 and 402 at the
 * handshake; how its socket says them isn't published, so the owner's hand check confirms it.
 */
export const fakeMistral: Make = (options, nextLine, events) => {
  const link = connection(events);
  const lines = lineMaker(nextLine, 1);
  later(() => {
    if (options.refuse) return link.close(HANDSHAKE_REFUSED);
    if (options.noCredit) return link.close(HANDSHAKE_NO_CREDIT);
    events.open();
    link.reply({
      type: "session.created",
      session: {
        request_id: "fake-request",
        model: "voxtral-mini-transcribe-realtime-3",
        audio_format: { encoding: "pcm_s16le", sample_rate: 16000 },
        target_streaming_delay_ms: 480,
      },
    });
  });
  return {
    send(data) {
      if (link.closed || typeof data !== "string") return;
      const message = JSON.parse(data) as { type?: string; session?: object; audio?: string };
      if (message.type === "session.update") {
        link.reply({ type: "session.updated", session: message.session });
        return;
      }
      if (message.type === "input_audio.end") {
        link.reply({
          type: "transcription.done",
          text: "",
          segments: [],
          language: "en",
          model: "voxtral-mini-transcribe-realtime-3",
        });
        return;
      }
      if (message.type !== "input_audio.append" || !message.audio) return;
      for (const line of lines.hear(samplesOf(Buffer.from(message.audio, "base64"))).lines) {
        const words = line.text.split(" ");
        const half = Math.ceil(words.length / 2);
        link.reply({ type: "turn.start", time_s: line.startMs / 1000 });
        words.slice(0, half).forEach((word, index) => {
          link.reply({ type: "transcription.text.delta", text: index === 0 ? word : ` ${word}` });
        });
        // Its last words come just after the turn ends.
        link.reply({ type: "turn.end", time_s: line.endMs / 1000, end_reason: "threshold" });
        for (const word of words.slice(half)) {
          link.reply({ type: "transcription.text.delta", text: ` ${word}` });
        }
      }
      if (options.dropAfterMs !== undefined && lines.sentMs >= options.dropAfterMs) {
        link.close(1011);
      }
    },
    close: () => link.close(1000),
  };
};
