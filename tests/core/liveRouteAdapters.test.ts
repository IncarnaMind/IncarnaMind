import { describe, expect, test, vi } from "vitest";
import type { CloudLoss, SpeechSegment } from "../../src/core";
import { createAssemblyAiStream } from "../../src/core/transcription/cloud/assemblyai";
import { createDeepgramStream } from "../../src/core/transcription/cloud/deepgram";
import { createElevenLabsStream } from "../../src/core/transcription/cloud/elevenlabs";
import { createGeminiStream } from "../../src/core/transcription/cloud/gemini";
import { createGladiaStream } from "../../src/core/transcription/cloud/gladia";
import {
  type CloudAuth,
  type CloudConnect,
  type CloudSocketEvents,
  HANDSHAKE_NO_CREDIT,
  HANDSHAKE_REFUSED,
  handshakeRefusalOf,
} from "../../src/core/transcription/cloud/socket";
import { createSpeechmaticsStream } from "../../src/core/transcription/cloud/speechmatics";
import { createXaiStream } from "../../src/core/transcription/cloud/xai";

const RATE = 16_000;

/** A service that plays back what the test says it sent, and keeps what it was sent, per connection. */
function playback() {
  const connections: {
    url: string;
    key: string;
    auth: CloudAuth | undefined;
    events: CloudSocketEvents;
    sent: (string | Uint8Array)[];
    closed: boolean;
  }[] = [];
  const connect: CloudConnect = (url, key, events, auth) => {
    const connection = {
      url,
      key,
      auth,
      events,
      sent: [] as (string | Uint8Array)[],
      closed: false,
    };
    connections.push(connection);
    return {
      send: (data) => connection.sent.push(data),
      close: () => {
        connection.closed = true;
      },
    };
  };
  const last = () => {
    const connection = connections.at(-1);
    if (!connection) throw new Error("Nothing connected.");
    return connection;
  };
  return {
    connect,
    connections,
    last,
    open: () => last().events.open(),
    say: (message: object) => last().events.message(JSON.stringify(message)),
    drop: (code = 1006, reason = "") => last().events.closed(code, reason),
    json: (index = connections.length - 1) =>
      (connections[index]?.sent ?? [])
        .filter((each): each is string => typeof each === "string")
        .map((each) => JSON.parse(each) as Record<string, unknown>),
    audioBytes: (index = connections.length - 1) =>
      (connections[index]?.sent ?? [])
        .filter((each): each is Uint8Array => each instanceof Uint8Array)
        .map((each) => each.byteLength),
  };
}

function collect() {
  const segments: SpeechSegment[] = [];
  const progress: [number, number | undefined][] = [];
  const losses: CloudLoss[] = [];
  const opened = { count: 0 };
  return {
    segments,
    progress,
    losses,
    opened,
    finals: () => segments.filter((each) => each.final),
    report: {
      segment: (each: SpeechSegment) => segments.push(each),
      progress: (doneMs: number, heardMs?: number) => progress.push([doneMs, heardMs]),
      lost: (loss: CloudLoss) => losses.push(loss),
      opened: () => {
        opened.count++;
      },
    },
  };
}

/** Audio in 100 ms frames, as a Meeting's capture sends it. */
function feed(push: (samples: Int16Array) => void, seconds: number) {
  for (let at = 0; at < seconds * 10; at++) {
    push(Int16Array.from({ length: RATE / 10 }, (_, i) => Math.round(Math.sin(i / 3) * 3000)));
  }
}

// ---- Deepgram, as https://developers.deepgram.com/reference/speech-to-text/listen-streaming shows its messages ----

interface DeepgramWord {
  word: string;
  punctuated_word: string;
  start: number;
  end: number;
  speaker: number;
}

const word = (text: string, start: number, end: number, speaker = 0): DeepgramWord => ({
  word: text.replace(/[.,]$/u, "").toLowerCase(),
  punctuated_word: text,
  start,
  end,
  speaker,
});

const results = (
  start: number,
  duration: number,
  words: DeepgramWord[],
  flags: { is_final: boolean; speech_final: boolean },
) => ({
  type: "Results",
  channel_index: [0, 1],
  duration,
  start,
  ...flags,
  channel: {
    alternatives: [
      {
        transcript: words.map((each) => each.punctuated_word).join(" "),
        confidence: 0.97,
        words: words.map((each) => ({ ...each, confidence: 0.97 })),
      },
    ],
  },
  metadata: { request_id: "a1", model_info: { name: "nova-3", version: "1", arch: "x" } },
  from_finalize: false,
});

describe("Deepgram's live transcription, in the messages its reference shows", () => {
  function connect(url = "wss://api.deepgram.com/v1/listen", apiKey = "dg-test-key") {
    const service = playback();
    const heard = collect();
    const stream = createDeepgramStream({
      stream: "m:system",
      model: "nova-3",
      apiKey,
      url,
      connect: service.connect,
      report: heard.report,
    });
    return { service, heard, stream };
  }

  test("asks Deepgram for Nova-3 in any language, 16 kHz PCM, interim results and speakers, with the key as a Token", () => {
    const { service } = connect();
    const url = new URL(service.last().url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("language")).toBe("multi");
    expect(url.searchParams.getAll("language_hint")).toEqual(["en", "zh"]);
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(url.searchParams.get("mip_opt_out")).toBe("true");
    expect(service.last().auth).toEqual({ header: "Authorization", prefix: "Token " });
    expect(service.last().key).toBe("dg-test-key");
  });

  test("Cloudflare Workers AI takes its token as Bearer, with the model in its path; a server of the User's own is asked at its address", () => {
    const cloudflare = connect(
      "wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
      "cf-test-token",
    ).service.last();
    const url = new URL(cloudflare.url);
    expect(url.pathname).toBe("/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3");
    expect(url.searchParams.has("model")).toBe(false);
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(cloudflare.auth).toEqual({ header: "Authorization", prefix: "Bearer " });

    const own = connect("ws://localhost:8080/v1/listen", "").service.last();
    expect(own.url.startsWith("ws://localhost:8080/v1/listen?")).toBe(true);
    expect(new URL(own.url).searchParams.get("model")).toBe("nova-3");
    // Its model improvement is Deepgram's own: another server isn't asked about it.
    expect(new URL(own.url).searchParams.has("mip_opt_out")).toBe(false);
  });

  test("audio before the socket opens waits for it, then goes as it comes; interim text comes first, then the line once the speaker pauses, with its speaker and words' times", async () => {
    const { service, heard, stream } = connect();
    feed((samples) => stream.push(samples), 1);
    expect(service.audioBytes()).toEqual([]);
    service.open();
    expect(heard.opened.count).toBe(1);
    expect(service.audioBytes()).toHaveLength(10);
    feed((samples) => stream.push(samples), 1);
    service.say(
      results(0, 1.2, [word("Ilse", 0.32, 0.6), word("moves", 0.6, 0.9)], {
        is_final: false,
        speech_final: false,
      }),
    );
    service.say(
      results(
        0,
        2.4,
        [
          word("Ilse", 0.32, 0.6),
          word("moves", 0.6, 0.9),
          word("the", 0.9, 1.0),
          word("review", 1.0, 1.4),
          word("to", 1.4, 1.5),
          word("Thursday.", 1.5, 2.1),
        ],
        { is_final: true, speech_final: true },
      ),
    );
    expect(heard.segments[0]).toMatchObject({ text: "Ilse moves", final: false, speaker: "1" });
    expect(heard.finals()).toEqual([
      expect.objectContaining({
        id: heard.segments[0]?.id,
        text: "Ilse moves the review to Thursday.",
        startMs: 320,
        endMs: 2100,
        speaker: "1",
        final: true,
      }),
    ]);
    expect(heard.progress.at(-1)).toEqual([2400, 2400]);
    const finished = stream.finish();
    expect(service.json().at(-1)).toEqual({ type: "CloseStream" });
    service.say({ type: "Metadata", request_id: "a1", duration: 2.4, channels: 1 });
    await finished;
    expect(heard.losses).toEqual([]);
    expect(service.last().closed).toBe(true);
  });

  test("a new voice in the final words starts a new line; Chinese words join without spaces", () => {
    const { service, heard } = connect();
    service.open();
    service.say(
      results(
        3,
        3,
        [
          word("Budget", 3.1, 3.5, 0),
          word("first.", 3.5, 3.9, 0),
          word("预算", 4.2, 4.6, 1),
          word("下周三", 4.6, 5.1, 1),
          word("再确认。", 5.1, 5.8, 1),
        ],
        { is_final: true, speech_final: true },
      ),
    );
    expect(heard.finals().map((each) => [each.text, each.speaker, each.startMs])).toEqual([
      ["Budget first.", "1", 3100],
      ["预算下周三再确认。", "2", 4200],
    ]);
  });

  test("a key turned away at the handshake is refused, no credit is out of credit, any other end a dropped connection; nothing more is reported", () => {
    for (const [code, loss] of [
      [HANDSHAKE_REFUSED, "refused"],
      [HANDSHAKE_NO_CREDIT, "credit"],
      [1011, "dropped"],
    ] as const) {
      const { service, heard, stream } = connect();
      if (code === 1011) service.open();
      service.drop(code);
      feed((samples) => stream.push(samples), 1);
      service.say(results(0, 1, [word("Late", 0.1, 0.4)], { is_final: true, speech_final: true }));
      expect(heard.losses).toEqual([loss]);
      expect(heard.segments).toEqual([]);
    }
  });

  test("after CloseStream the normal close ends it whole; a drop then loses what was in flight", async () => {
    for (const [code, losses] of [
      [1000, []],
      [1006, ["dropped"]],
    ] as const) {
      const { service, heard, stream } = connect();
      service.open();
      const finished = stream.finish();
      service.drop(code);
      await finished;
      expect(heard.losses).toEqual(losses);
    }
  });

  test("Deepgram's other regions are Deepgram's own: their audio is left out of its model improvement too", () => {
    const { service } = connect("wss://api.eu.deepgram.com/v1/listen");
    const url = new URL(service.last().url);
    expect(url.searchParams.get("mip_opt_out")).toBe("true");
    expect(service.last().auth).toEqual({ header: "Authorization", prefix: "Token " });
  });
});

// ---- AssemblyAI, as its v3 streaming reference and its errors page show them ----

describe("AssemblyAI's real-time transcription, in the messages its reference shows", () => {
  function connect() {
    const service = playback();
    const heard = collect();
    const stream = createAssemblyAiStream({
      stream: "m:system",
      model: "universal-3-6-pro",
      apiKey: "aai-test-key",
      connect: service.connect,
      report: heard.report,
    });
    return { service, heard, stream };
  }

  const turn = (
    order: number,
    transcript: string,
    end: boolean,
    words: [string, number, number][],
  ) => ({
    type: "Turn",
    turn_order: order,
    turn_is_formatted: end,
    end_of_turn: end,
    transcript,
    end_of_turn_confidence: end ? 0.93 : 0.21,
    ...(end && { speaker_label: order % 2 === 0 ? "A" : "B" }),
    words: words.map(([text, start, endMs]) => ({
      text,
      start,
      end: endMs,
      confidence: 0.96,
      word_is_final: true,
    })),
  });

  test("asks for Universal-3.6 Pro at 16 kHz PCM with speakers, the key itself in Authorization, and sends audio only after Begin", () => {
    const { service, heard, stream } = connect();
    const url = new URL(service.last().url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://streaming.assemblyai.com/v3/ws");
    expect(url.searchParams.get("speech_model")).toBe("universal-3-6-pro");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(url.searchParams.get("speaker_labels")).toBe("true");
    expect(service.last().auth).toEqual({ header: "Authorization", prefix: "" });
    service.open();
    feed((samples) => stream.push(samples), 1);
    expect(service.audioBytes()).toEqual([]);
    expect(heard.opened.count).toBe(0);
    service.say({ type: "Begin", id: "s1", expires_at: 1_793_000_000 });
    expect(heard.opened.count).toBe(1);
    // 100 ms chunks, inside the 20 to 1,000 ms the service takes.
    expect(service.audioBytes()).toEqual(Array.from({ length: 10 }, () => 3200));
  });

  test("a turn's words so far, then the whole turn with its speaker and its words' times; a heartbeat says it keeps up in a long quiet", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ type: "Begin", id: "s1", expires_at: 1_793_000_000 });
    service.say(
      turn(0, "the review moves", false, [
        ["the", 400, 520],
        ["review", 520, 900],
        ["moves", 900, 1200],
      ]),
    );
    service.say(
      turn(0, "The review moves to Thursday.", true, [
        ["The", 400, 520],
        ["review", 520, 900],
        ["moves", 900, 1200],
        ["to", 1200, 1300],
        ["Thursday.", 1300, 1900],
      ]),
    );
    expect(heard.segments.map((each) => [each.text, each.final, each.speaker ?? null])).toEqual([
      ["the review moves", false, null],
      ["The review moves to Thursday.", true, "A"],
    ]);
    expect(heard.finals()[0]).toMatchObject({ startMs: 400, endMs: 1900 });
    service.say({
      type: "Heartbeat",
      total_audio_received_ms: 31_000,
      total_duration_ms: 31_400,
      realtime_factor: 0.99,
      max_speech_probability: 0.05,
    });
    // It kept up with all it heard; what is final is still the last turn's end.
    expect(heard.progress.at(-1)).toEqual([1900, 31_000]);
    // Audio short of a chunk still goes at the end, made up to the 20 ms the service takes.
    stream.push(new Int16Array(100));
    const finished = stream.finish();
    expect(service.audioBytes().at(-1)).toBe(640);
    expect(service.json().at(-1)).toEqual({ type: "Terminate" });
    service.say({ type: "Termination", audio_duration_seconds: 32, session_duration_seconds: 33 });
    await finished;
    expect(heard.losses).toEqual([]);
  });

  test("Chinese comes as the service writes it", () => {
    const { service, heard } = connect();
    service.open();
    service.say({ type: "Begin", id: "s1", expires_at: 1_793_000_000 });
    service.say(
      turn(1, "预算下周三再确认。", true, [
        ["预算", 200, 600],
        ["下周三", 600, 1100],
        ["再确认。", 1100, 1700],
      ]),
    );
    expect(heard.finals()[0]).toMatchObject({ text: "预算下周三再确认。", speaker: "B" });
  });

  test("its Error message names a 1008 close: an invalid key is refused, insufficient funds is out of credit, too many sessions is dropped; nothing more is reported", () => {
    for (const [error, loss] of [
      ["Unauthorized Connection: Invalid API key", "refused"],
      ["Insufficient funds", "credit"],
      ["Too many concurrent sessions", "dropped"],
    ] as const) {
      const { service, heard } = connect();
      service.open();
      service.say({ type: "Error", error_code: 1008, error });
      service.drop(1008, "See Error message for details");
      service.say(turn(0, "Late words.", true, [["Late", 0, 300]]));
      expect(heard.losses).toEqual([loss]);
      expect(heard.segments).toEqual([]);
    }
    const { service, heard } = connect();
    service.open();
    service.say({ type: "Begin", id: "s1", expires_at: 1_793_000_000 });
    service.drop(3005, "Internal error");
    expect(heard.losses).toEqual(["dropped"]);
  });

  test("a 1008 close with no Error message is refused or out of credit only when its reason says so", () => {
    for (const [reason, loss] of [
      ["Unauthorized Connection: Invalid API key", "refused"],
      ["Insufficient funds", "credit"],
      ["Too many concurrent sessions", "dropped"],
      ["See Error message for details", "dropped"],
    ] as const) {
      const { service, heard } = connect();
      service.open();
      service.drop(1008, reason);
      expect(heard.losses).toEqual([loss]);
    }
  });
});

// ---- Gemini Live, as https://aistudio.google.com/api-reference/live shows its messages ----

describe("Gemini's Live API, for what it hears, in the messages its reference shows", () => {
  function connect() {
    const service = playback();
    const heard = collect();
    const stream = createGeminiStream({
      stream: "m:system",
      model: "gemini-3.5-transcribe-live",
      apiKey: "AIza-test-key",
      connect: service.connect,
      report: heard.report,
    });
    return { service, heard, stream };
  }

  const guess = (text: string, from: string, to: string) => ({
    serverContent: { interimInputTranscription: { text, startOffset: from, endOffset: to } },
  });
  const said = (text: string, from: string, to: string) => ({
    serverContent: { inputTranscription: { text, startOffset: from, endOffset: to } },
  });

  test("sets up its transcription model, answering in text, with the key in x-goog-api-key; audio waits for setupComplete", () => {
    const { service, heard, stream } = connect();
    expect(service.last().url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    );
    expect(service.last().auth).toEqual({ header: "x-goog-api-key", prefix: "" });
    service.open();
    const [setup] = service.json();
    expect(setup).toEqual({
      setup: {
        model: "models/gemini-3.5-transcribe-live",
        generationConfig: { responseModalities: ["TEXT"] },
        realtimeInputConfig: { interimTranscriptTimestampEnabled: true },
        inputAudioTranscription: { languageCodes: [] },
      },
    });
    feed((samples) => stream.push(samples), 1);
    expect(service.json()).toHaveLength(1);
    service.say({ setupComplete: {} });
    expect(heard.opened.count).toBe(1);
    const audio = service.json().slice(1);
    expect(audio).toHaveLength(10);
    expect(audio[0]).toMatchObject({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000" } },
    });
  });

  test("each guess replaces the last as the line being said, and the final text ends it at the times it gives; Chinese as written", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ setupComplete: {} });
    feed((samples) => stream.push(samples), 4);
    service.say(guess("The review", "0.400s", "1.100s"));
    service.say(guess("The review moves", "0.400s", "1.600s"));
    service.say(said("The review moves to Thursday.", "0.400s", "2.300s"));
    service.say(guess("预算", "2.600s", "2.900s"));
    service.say(said("预算下周三再确认。", "2.600s", "3.600s"));
    expect(heard.segments.filter((each) => !each.final).map((each) => each.text)).toEqual([
      "The review",
      "The review moves",
      "预算",
    ]);
    expect(
      heard.finals().map((each) => [each.text, each.startMs, each.endMs, each.speaker]),
    ).toEqual([
      ["The review moves to Thursday.", 400, 2300, undefined],
      ["预算下周三再确认。", 2600, 3600, undefined],
    ]);
    const [first, second] = heard.finals();
    expect(heard.segments.filter((each) => each.id === first?.id)).toHaveLength(3);
    expect(heard.segments.filter((each) => each.id === second?.id)).toHaveLength(2);
    const finished = stream.finish();
    expect(service.json().at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    service.say({ serverContent: { turnComplete: true } });
    await finished;
    expect(heard.losses).toEqual([]);
  });

  test("a turnComplete before its final text leaves the guess open, so the line is written once", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ setupComplete: {} });
    feed((samples) => stream.push(samples), 3);
    service.say(guess("Budget is", "0.300s", "1.000s"));
    service.say({ serverContent: { turnComplete: true } });
    service.say(said("Budget is two point six million.", "0.300s", "2.400s"));
    expect(heard.finals().map((each) => [each.text, each.startMs, each.endMs])).toEqual([
      ["Budget is two point six million.", 300, 2400],
    ]);
  });

  test("after the last audio it waits for text still to come, and with none for three seconds it is done", async () => {
    vi.useFakeTimers();
    try {
      const { service, heard, stream } = connect();
      service.open();
      service.say({ setupComplete: {} });
      feed((samples) => stream.push(samples), 2);
      let done = false;
      void stream.finish().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1000);
      // The words said just before Stop come after it.
      service.say(guess("Last", "1.200s", "1.500s"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toBe(false);
      service.say(said("Last words.", "1.200s", "1.900s"));
      await vi.advanceTimersByTimeAsync(2900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(true);
      expect(heard.finals().map((each) => each.text)).toEqual(["Last words."]);

      const quiet = connect();
      quiet.service.open();
      quiet.service.say({ setupComplete: {} });
      let quietDone = false;
      void quiet.stream.finish().then(() => {
        quietDone = true;
      });
      await vi.advanceTimersByTimeAsync(2900);
      expect(quietDone).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(quietDone).toBe(true);
      expect(quiet.heard.losses).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("it says nothing while no one speaks, and has still kept up with all it was sent", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ setupComplete: {} });
    feed((samples) => stream.push(samples), 31);
    expect(heard.progress.at(-1)).toEqual([0, 31_000]);
    service.say(guess("After the quiet", "31.200s", "31.900s"));
    feed((samples) => stream.push(samples), 1);
    // While a line is being said, only the service's own messages say how far it got.
    expect(heard.progress.at(-1)).toEqual([0, 31_000]);
  });

  test("goAway moves the stream to a new session, sending again the audio after the last final text: no words lost and none twice", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ setupComplete: {} });
    feed((samples) => stream.push(samples), 2);
    service.say(said("First point.", "0.200s", "1.000s"));
    feed((samples) => stream.push(samples), 1);
    service.say(guess("Second", "2.100s", "2.600s"));
    service.say({ goAway: { timeLeft: "10s" } });
    // The line being said finishes on the old connection first.
    expect(service.connections).toHaveLength(1);
    service.say(said("Second point.", "2.100s", "2.900s"));
    expect(service.connections).toHaveLength(2);
    expect(service.connections[0]?.closed).toBe(true);
    service.open();
    service.say({ setupComplete: {} });
    // Kept from the end of the last final text, 2.9 s, to the 3 s received.
    const resent = service.json().slice(1);
    expect(resent).toHaveLength(1);
    // Its times count from where its audio starts.
    service.say(said("Third point.", "0.050s", "0.090s"));
    expect(heard.finals().map((each) => [each.text, each.startMs])).toEqual([
      ["First point.", 200],
      ["Second point.", 2100],
      ["Third point.", 2950],
    ]);
    expect(heard.losses).toEqual([]);
    expect(heard.opened.count).toBe(1);
  });

  test("a close for the key is refused, for quota or billing out of credit, any other dropped", () => {
    for (const [code, reason, loss] of [
      [1008, "API key not valid. Please pass a valid API key.", "refused"],
      [
        1011,
        "You exceeded your current quota, please check your plan and billing details.",
        "credit",
      ],
      [1011, "Internal error encountered.", "dropped"],
    ] as const) {
      const { service, heard } = connect();
      service.open();
      service.drop(code, reason);
      expect(heard.losses).toEqual([loss]);
    }
  });
});

// ---- A handshake refused before the socket opened, as a probe with the same key hears the answer ----

describe("A refused handshake, read from the service's answer", () => {
  test.each([
    [
      "xAI's wrong key",
      400,
      '{"code":"Client specified an invalid argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}',
      HANDSHAKE_REFUSED,
    ],
    [
      "xAI's account out of credit",
      403,
      '{"code":"The caller does not have permission to execute the specified operation","error":"Your team has used all available credits. Please purchase more credits."}',
      HANDSHAKE_NO_CREDIT,
    ],
    [
      "Google's wrong key",
      400,
      "API key not valid. Please pass a valid API key.",
      HANDSHAKE_REFUSED,
    ],
    ["a 401", 401, "", HANDSHAKE_REFUSED],
    ["a 401 in credit's words", 401, "Insufficient credits.", HANDSHAKE_REFUSED],
    ["a bare 403", 403, "Forbidden", HANDSHAKE_REFUSED],
    ["a 402", 402, "", HANDSHAKE_NO_CREDIT],
    [
      "a 429 for the quota",
      429,
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
      HANDSHAKE_NO_CREDIT,
    ],
    ["a 429 for the rate", 429, "Rate limit reached.", 0],
    ["another 400", 400, "Unsupported sample rate.", 0],
    ["a 500", 500, "Insufficient credits.", 0],
  ] as const)("%s", (_, status, body, refusal) => {
    expect(handshakeRefusalOf(status, body)).toBe(refusal);
  });
});

// ---- xAI, as https://docs.x.ai/developers/model-capabilities/audio/speech-to-text shows its stream ----

describe("xAI's streaming speech to text, in the messages its reference shows", () => {
  function connect() {
    const service = playback();
    const heard = collect();
    const stream = createXaiStream({
      stream: "m:system",
      model: "grok-voice-transcribe-2.0",
      apiKey: "xai-test-key",
      connect: service.connect,
      report: heard.report,
    });
    return { service, heard, stream };
  }

  const xaiWord = (text: string, start: number, end: number, speaker = 0) => ({
    text,
    start,
    end,
    confidence: 0.95,
    speaker,
  });
  const result = (
    words: ReturnType<typeof xaiWord>[],
    start: number,
    duration: number,
    flags: { is_final: boolean; speech_final: boolean },
  ) => ({
    type: "transcript.partial",
    text: words.map((each) => each.text).join(" "),
    words,
    start,
    duration,
    ...flags,
  });

  test("asks for grok-voice-transcribe-2.0 on 16 kHz PCM with interim results and speakers, in the address alone, with the key as Bearer; audio waits for transcript.created", () => {
    const { service, heard, stream } = connect();
    const url = new URL(service.last().url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.x.ai/v1/stt");
    expect(url.searchParams.get("model")).toBe("grok-voice-transcribe-2.0");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("encoding")).toBe("pcm");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(service.last().auth).toBeUndefined();
    expect(service.last().key).toBe("xai-test-key");
    service.open();
    feed((samples) => stream.push(samples), 1);
    expect(service.audioBytes()).toEqual([]);
    service.say({ type: "transcript.created", id: "83f2f6fd-1cd1-4747-bc52-cebddc961c32" });
    expect(heard.opened.count).toBe(1);
    expect(service.audioBytes()).toHaveLength(10);
  });

  test("an interim guess, a locked chunk, then the utterance whole, written once with its words' times and speaker", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ type: "transcript.created", id: "s1" });
    const words = [
      xaiWord("The", 0.24, 0.48),
      xaiWord("review", 0.48, 0.96),
      xaiWord("moves", 0.96, 1.3),
      xaiWord("to", 1.3, 1.42),
      xaiWord("Thursday.", 1.42, 2.1),
    ];
    service.say(result(words.slice(0, 2), 0.24, 0.8, { is_final: false, speech_final: false }));
    service.say(result(words.slice(0, 3), 0.24, 1.1, { is_final: true, speech_final: false }));
    service.say(result(words, 0.24, 1.9, { is_final: true, speech_final: true }));
    expect(heard.segments.filter((each) => !each.final).map((each) => each.text)).toEqual([
      "The review",
      "The review moves",
    ]);
    expect(heard.finals()).toEqual([
      expect.objectContaining({
        id: heard.segments[0]?.id,
        text: "The review moves to Thursday.",
        startMs: 240,
        endMs: 2100,
        speaker: "1",
      }),
    ]);
    const finished = stream.finish();
    expect(service.json().at(-1)).toEqual({ type: "audio.done" });
    service.say({ type: "transcript.done", text: "", words: [], duration: 2.4 });
    await finished;
    expect(heard.losses).toEqual([]);
    expect(service.last().closed).toBe(true);
  });

  test("a new voice starts a new line; Chinese joins without spaces; words flushed after audio.done are kept", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ type: "transcript.created", id: "s1" });
    service.say(
      result(
        [
          xaiWord("Budget", 3.1, 3.5, 0),
          xaiWord("first.", 3.5, 3.9, 0),
          xaiWord("预算", 4.2, 4.6, 1),
          xaiWord("下周三", 4.6, 5.1, 1),
          xaiWord("再确认。", 5.1, 5.8, 1),
        ],
        3.1,
        2.7,
        { is_final: true, speech_final: true },
      ),
    );
    const finished = stream.finish();
    service.say({
      type: "transcript.done",
      text: "好的。",
      words: [xaiWord("预算", 4.2, 4.6, 1), xaiWord("好的。", 6.0, 6.4, 1)],
      duration: 6.5,
    });
    await finished;
    expect(heard.finals().map((each) => [each.text, each.speaker, each.startMs])).toEqual([
      ["Budget first.", "1", 3100],
      ["预算下周三再确认。", "2", 4200],
      ["好的。", "2", 6000],
    ]);
  });

  test("a key refused at the handshake is refused; an error in words names the credit before the key, any other end is dropped; nothing more is reported", () => {
    for (const [message, loss] of [
      ["Incorrect API key provided.", "refused"],
      [
        "The caller does not have permission to execute the specified operation: Your team has used all available credits. Please purchase more credits.",
        "credit",
      ],
      ["The caller does not have permission to execute the specified operation.", "refused"],
      ["RESOURCE_EXHAUSTED: too many requests.", "dropped"],
      ["Stream timeout.", "dropped"],
    ] as const) {
      const { service, heard } = connect();
      service.open();
      service.say({ type: "error", message });
      service.drop(1008);
      service.say(
        result([xaiWord("Late", 0.1, 0.4)], 0.1, 0.3, { is_final: true, speech_final: true }),
      );
      expect(heard.losses).toEqual([loss]);
      expect(heard.segments).toEqual([]);
    }
    const refused = connect();
    refused.service.drop(HANDSHAKE_REFUSED);
    expect(refused.heard.losses).toEqual(["refused"]);
    const noCredit = connect();
    noCredit.service.drop(HANDSHAKE_NO_CREDIT);
    expect(noCredit.heard.losses).toEqual(["credit"]);
    const dropped = connect();
    dropped.service.open();
    dropped.service.say({ type: "transcript.created", id: "s1" });
    dropped.service.drop(1006);
    expect(dropped.heard.losses).toEqual(["dropped"]);
  });
});

// ---- Speechmatics, as its real-time AsyncAPI spec shows its messages ----

describe("Speechmatics' real-time transcription, in the messages its spec shows", () => {
  function connect() {
    const service = playback();
    const heard = collect();
    const stream = createSpeechmaticsStream({
      stream: "m:system",
      model: "enhanced",
      apiKey: "sm-test-key",
      connect: service.connect,
      report: heard.report,
    });
    return { service, heard, stream };
  }

  const smWord = (content: string, start: number, end: number, speaker = "S1") => ({
    type: "word",
    start_time: start,
    end_time: end,
    alternatives: [{ content, confidence: 0.98, language: "en", speaker }],
  });
  const mark = (content: string, at: number, speaker = "S1") => ({
    type: "punctuation",
    start_time: at,
    end_time: at,
    attaches_to: "previous",
    is_eos: content === "." || content === "。",
    alternatives: [{ content, confidence: 1, speaker }],
  });
  const transcript = (message: string, end: number, results: object[]) => ({
    message,
    format: "2.9",
    metadata: { start_time: 0, end_time: end, transcript: "" },
    results,
  });

  test("starts recognition of Mandarin and English with the Enhanced model on 16 kHz PCM, with speakers, partials and the end of each utterance, the key as Bearer; audio waits for RecognitionStarted", () => {
    const { service, heard, stream } = connect();
    expect(service.last().url).toBe("wss://global.rt.speechmatics.com/v2");
    expect(service.last().auth).toBeUndefined();
    expect(service.last().key).toBe("sm-test-key");
    service.open();
    expect(service.json()).toEqual([
      {
        message: "StartRecognition",
        audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
        transcription_config: {
          language: "cmn_en",
          model: "enhanced",
          diarization: "speaker",
          enable_partials: true,
          max_delay: 2,
          conversation_config: { end_of_utterance_silence_trigger: 1 },
        },
      },
    ]);
    feed((samples) => stream.push(samples), 1);
    expect(service.audioBytes()).toEqual([]);
    service.say({ message: "RecognitionStarted", id: "807670e9" });
    expect(heard.opened.count).toBe(1);
    expect(service.audioBytes()).toHaveLength(10);
  });

  test("a partial, then final words with their times and speaker; the end of the utterance ends the line; EndOfStream names the last chunk", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ message: "RecognitionStarted", id: "s1" });
    feed((samples) => stream.push(samples), 3);
    service.say(
      transcript("AddPartialTranscript", 0.9, [
        smWord("The", 0.4, 0.5),
        smWord("review", 0.5, 0.9),
      ]),
    );
    service.say(
      transcript("AddTranscript", 2.2, [
        smWord("The", 0.4, 0.5),
        smWord("review", 0.5, 0.9),
        smWord("moves", 0.9, 1.2),
        smWord("to", 1.2, 1.3),
        smWord("Thursday", 1.3, 1.9),
        mark(".", 1.9),
      ]),
    );
    expect(heard.finals()).toEqual([]);
    service.say({ message: "EndOfUtterance", metadata: { start_time: 2.9, end_time: 2.9 } });
    expect(heard.segments[0]).toMatchObject({ text: "The review", final: false, speaker: "1" });
    expect(heard.finals()).toEqual([
      expect.objectContaining({
        id: heard.segments[0]?.id,
        text: "The review moves to Thursday.",
        startMs: 400,
        endMs: 1900,
        speaker: "1",
      }),
    ]);
    const finished = stream.finish();
    expect(service.json().at(-1)).toEqual({ message: "EndOfStream", last_seq_no: 30 });
    service.say({ message: "EndOfTranscript" });
    await finished;
    expect(heard.losses).toEqual([]);
  });

  test("a new voice starts a new line; Chinese joins without spaces, its marks without one before them", () => {
    const { service, heard } = connect();
    service.open();
    service.say({ message: "RecognitionStarted", id: "s1" });
    service.say(
      transcript("AddTranscript", 5.8, [
        smWord("Budget", 3.1, 3.5),
        smWord("first", 3.5, 3.9),
        mark(".", 3.9),
        smWord("预算", 4.2, 4.6, "S2"),
        smWord("下周三", 4.6, 5.1, "S2"),
        smWord("再确认", 5.1, 5.8, "S2"),
        mark("。", 5.8, "S2"),
      ]),
    );
    service.say({ message: "EndOfUtterance", metadata: { start_time: 6.8, end_time: 6.8 } });
    expect(heard.finals().map((each) => [each.text, each.speaker, each.startMs])).toEqual([
      ["Budget first.", "1", 3100],
      ["预算下周三再确认。", "2", 4200],
    ]);
  });

  test("not_authorised or close 4001 is a refused key, timelimit_exceeded or close 4006 is out of credit, too many sessions is dropped; nothing more is reported", () => {
    for (const [type, code, loss] of [
      ["not_authorised", 4001, "refused"],
      ["timelimit_exceeded", 4006, "credit"],
      ["quota_exceeded", 4005, "dropped"],
    ] as const) {
      const withMessage = connect();
      withMessage.service.open();
      withMessage.service.say({ message: "Error", type, reason: "From the service." });
      withMessage.service.drop(code);
      withMessage.service.say(transcript("AddTranscript", 1, [smWord("Late", 0.1, 0.4)]));
      expect(withMessage.heard.losses).toEqual([loss]);
      expect(withMessage.heard.segments).toEqual([]);
      const closeOnly = connect();
      closeOnly.service.open();
      closeOnly.service.drop(code);
      expect(closeOnly.heard.losses).toEqual([loss]);
    }
    const refused = connect();
    refused.service.drop(HANDSHAKE_REFUSED);
    expect(refused.heard.losses).toEqual(["refused"]);
  });
});

// ---- ElevenLabs, as its real-time speech to text reference and event reference show them ----

describe("ElevenLabs' real-time speech to text, in the messages its reference shows", () => {
  function connect() {
    const service = playback();
    const heard = collect();
    const stream = createElevenLabsStream({
      stream: "m:system",
      model: "scribe_v2_realtime",
      apiKey: "sk_eleven-test-key",
      connect: service.connect,
      report: heard.report,
    });
    return { service, heard, stream };
  }

  const timed = (text: string, words: [string, number, number][]) => ({
    message_type: "committed_transcript_with_timestamps",
    text,
    language_code: "eng",
    words: words.flatMap(([word, start, end], index) => [
      ...(index > 0 ? [{ text: " ", start, end: start, type: "spacing" }] : []),
      { text: word, start, end, type: "word", logprob: -0.1 },
    ]),
  });

  test("asks for Scribe v2 Realtime on 16 kHz PCM with its own voice detection and words' times, the key in xi-api-key; audio waits for session_started, in chunks of a tenth of a second", () => {
    const { service, heard, stream } = connect();
    const url = new URL(service.last().url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
    );
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.get("commit_strategy")).toBe("vad");
    expect(url.searchParams.get("include_timestamps")).toBe("true");
    expect(service.last().auth).toEqual({ header: "xi-api-key", prefix: "" });
    service.open();
    feed((samples) => stream.push(samples), 1);
    expect(service.json()).toEqual([]);
    service.say({ message_type: "session_started", session_id: "s1", config: {} });
    expect(heard.opened.count).toBe(1);
    const chunks = service.json();
    expect(chunks).toHaveLength(10);
    expect(chunks[0]).toMatchObject({
      message_type: "input_audio_chunk",
      commit: false,
      sample_rate: 16000,
    });
    expect(Buffer.from(String(chunks[0]?.audio_base_64), "base64").byteLength).toBe(3200);
  });

  test("each guess replaces the last, the committed text ends the line at its words' times; the last audio is committed at the end", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ message_type: "session_started", session_id: "s1", config: {} });
    feed((samples) => stream.push(samples), 3);
    service.say({ message_type: "partial_transcript", text: "The review" });
    service.say({ message_type: "partial_transcript", text: "The review moves" });
    service.say({ message_type: "committed_transcript", text: "The review moves to Thursday." });
    service.say(
      timed("The review moves to Thursday.", [
        ["The", 0.4, 0.52],
        ["review", 0.52, 0.9],
        ["moves", 0.9, 1.2],
        ["to", 1.2, 1.3],
        ["Thursday.", 1.3, 1.9],
      ]),
    );
    expect(heard.segments.filter((each) => !each.final).map((each) => each.text)).toEqual([
      "The review",
      "The review moves",
    ]);
    expect(heard.finals()).toEqual([
      expect.objectContaining({
        id: heard.segments[0]?.id,
        text: "The review moves to Thursday.",
        startMs: 400,
        endMs: 1900,
      }),
    ]);
    stream.push(new Int16Array(100));
    const finished = stream.finish();
    const last = service.json().at(-1);
    expect(last).toMatchObject({ message_type: "input_audio_chunk", commit: true });
    expect(Buffer.from(String(last?.audio_base_64), "base64").byteLength).toBe(3200);
    service.say({ message_type: "partial_transcript", text: "最后" });
    service.say({ message_type: "committed_transcript", text: "最后一句。" });
    service.say(timed("最后一句。", [["最后一句。", 3.1, 3.6]]));
    await finished;
    expect(heard.finals().at(-1)).toMatchObject({ text: "最后一句。", startMs: 3100, endMs: 3600 });
    expect(heard.losses).toEqual([]);
  });

  test("after the last audio with nothing being said, it waits three seconds for text, then is done", async () => {
    vi.useFakeTimers();
    try {
      const { service, heard, stream } = connect();
      service.open();
      service.say({ message_type: "session_started", session_id: "s1", config: {} });
      let done = false;
      void stream.finish().then(() => {
        done = true;
      });
      expect(service.json().at(-1)).toMatchObject({ audio_base_64: "", commit: true });
      await vi.advanceTimersByTimeAsync(2900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(true);
      expect(heard.losses).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a session at its time limit goes on over a new one, sending again the audio after the last committed text: no words lost and none twice", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ message_type: "session_started", session_id: "s1", config: {} });
    feed((samples) => stream.push(samples), 2);
    service.say({ message_type: "partial_transcript", text: "First" });
    service.say({ message_type: "committed_transcript", text: "First point." });
    service.say(
      timed("First point.", [
        ["First", 0.2, 0.6],
        ["point.", 0.6, 1.0],
      ]),
    );
    feed((samples) => stream.push(samples), 1);
    service.say({ message_type: "partial_transcript", text: "Second" });
    service.say({
      message_type: "session_time_limit_exceeded",
      error: "Maximum session duration exceeded. Start a new session.",
    });
    expect(service.connections).toHaveLength(2);
    expect(service.connections[0]?.closed).toBe(true);
    // The old socket's own close, after its error, ends nothing.
    service.connections[0]?.events.closed(1000, "");
    service.open();
    service.say({ message_type: "session_started", session_id: "s2", config: {} });
    // Kept from the end of the last committed text, 1 s, to the 3 s received.
    const again = service.json();
    expect(again).toHaveLength(20);
    expect(again.every((each) => each.commit === false)).toBe(true);
    // Its times count from where its audio starts.
    service.say({ message_type: "committed_transcript", text: "Second point." });
    service.say(
      timed("Second point.", [
        ["Second", 0.1, 0.5],
        ["point.", 0.5, 0.9],
      ]),
    );
    expect(heard.finals().map((each) => [each.text, each.startMs, each.endMs])).toEqual([
      ["First point.", 200, 1000],
      ["Second point.", 1100, 1900],
    ]);
    expect(heard.losses).toEqual([]);
    expect(heard.opened.count).toBe(1);
  });

  test("a session at its time limit between a committed text and its times: the new session hears that text again, and its words come once", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ message_type: "session_started", session_id: "s1", config: {} });
    feed((samples) => stream.push(samples), 2);
    service.say({ message_type: "partial_transcript", text: "First" });
    service.say({ message_type: "committed_transcript", text: "First point." });
    service.say({
      message_type: "session_time_limit_exceeded",
      error: "Maximum session duration exceeded. Start a new session.",
    });
    expect(service.connections).toHaveLength(2);
    service.connections[0]?.events.closed(1000, "");
    service.open();
    service.say({ message_type: "session_started", session_id: "s2", config: {} });
    // All 2 s again: nothing had its times, so nothing was let go.
    expect(service.json()).toHaveLength(20);
    service.say({ message_type: "committed_transcript", text: "First point." });
    service.say(
      timed("First point.", [
        ["First", 0.2, 0.6],
        ["point.", 0.6, 1.0],
      ]),
    );
    expect(heard.finals().map((each) => [each.text, each.startMs, each.endMs])).toEqual([
      ["First point.", 200, 1000],
    ]);
    expect(heard.losses).toEqual([]);
  });

  test("its error message names the close: auth_error is a refused key, quota_exceeded out of credit, anything else dropped; nothing more is reported", () => {
    for (const [type, loss] of [
      ["auth_error", "refused"],
      ["quota_exceeded", "credit"],
      ["unaccepted_terms", "dropped"],
      ["resource_exhausted", "dropped"],
    ] as const) {
      const { service, heard } = connect();
      service.open();
      service.say({ message_type: type, error: "From the service." });
      service.drop(1000);
      service.say({ message_type: "committed_transcript", text: "Late words." });
      expect(heard.losses).toEqual([loss]);
      expect(heard.segments).toEqual([]);
    }
    const dropped = connect();
    dropped.service.open();
    dropped.service.say({ message_type: "session_started", session_id: "s1", config: {} });
    dropped.service.drop(1006);
    expect(dropped.heard.losses).toEqual(["dropped"]);
  });
});

// ---- Gladia, as its live API reference shows the session's request and its socket ----

describe("Gladia's live transcription, in the request and messages its reference shows", () => {
  function connect(answer: () => Response = () => started(201)) {
    const service = playback();
    const heard = collect();
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    const stream = createGladiaStream({
      stream: "m:system",
      model: "solaria-1",
      apiKey: "gladia-test-key",
      languages: ["en", "zh"],
      connect: service.connect,
      report: heard.report,
      fetch: async (input, init) => {
        asked.push({ url: String(input), init });
        return answer();
      },
    });
    return { service, heard, stream, asked };
  }

  const started = (status: number, url = "wss://api.gladia.io/v2/live?token=636c70f6") =>
    new Response(JSON.stringify({ id: "636c70f6", url }), { status });
  const transcript = (
    id: string,
    final: boolean,
    text: string,
    words: [string, number, number][],
  ) => ({
    session_id: "636c70f6",
    created_at: "2026-11-07T09:00:00Z",
    type: "transcript",
    data: {
      id,
      is_final: final,
      utterance: {
        start: words[0]?.[1],
        end: words.at(-1)?.[2],
        confidence: 0.93,
        channel: 0,
        words: words.map(([word, start, end]) => ({ word, start, end, confidence: 0.95 })),
        text,
        language: "en",
      },
    },
  });

  test("asks Gladia for a session with the key in x-gladia-key and the User's languages, then opens its socket with no key, as the address holds its token", async () => {
    const { service, asked, heard, stream } = connect();
    expect(service.connections).toEqual([]);
    feed((samples) => stream.push(samples), 1);
    await vi.waitFor(() => expect(service.connections).toHaveLength(1));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe("https://api.gladia.io/v2/live");
    expect(asked[0]?.init?.method).toBe("POST");
    expect(asked[0]?.init?.headers).toMatchObject({ "x-gladia-key": "gladia-test-key" });
    expect(JSON.parse(String(asked[0]?.init?.body))).toEqual({
      encoding: "wav/pcm",
      bit_depth: 16,
      sample_rate: 16000,
      channels: 1,
      model: "solaria-1",
      language_config: { languages: ["en", "zh"], code_switching: true },
      endpointing: 0.4,
      maximum_duration_without_endpointing: 15,
      messages_config: { receive_partial_transcripts: true, receive_final_transcripts: true },
    });
    expect(service.last().url).toBe("wss://api.gladia.io/v2/live?token=636c70f6");
    expect(service.last().key).toBe("");
    expect(service.audioBytes()).toEqual([]);
    service.open();
    expect(heard.opened.count).toBe(1);
    expect(service.audioBytes()).toHaveLength(10);
  });

  test("an utterance as it is said, then final with its times; Chinese as it writes it; stop_recording, then the normal close, ends it whole", async () => {
    const { service, heard, stream } = connect();
    await vi.waitFor(() => expect(service.connections).toHaveLength(1));
    service.open();
    service.say(
      transcript("00-00000001", false, "The review", [
        ["The", 0.4, 0.52],
        ["review", 0.52, 0.9],
      ]),
    );
    service.say(
      transcript("00-00000001", true, "The review moves to Thursday.", [
        ["The", 0.4, 0.52],
        ["review", 0.52, 0.9],
        ["moves", 0.9, 1.2],
        ["to", 1.2, 1.3],
        ["Thursday.", 1.3, 1.9],
      ]),
    );
    service.say(transcript("00-00000002", false, "预算", [["预算", 2.2, 2.6]]));
    expect(heard.finals()).toEqual([
      expect.objectContaining({
        id: heard.segments[0]?.id,
        text: "The review moves to Thursday.",
        startMs: 400,
        endMs: 1900,
      }),
    ]);
    const finished = stream.finish();
    expect(service.json().at(-1)).toEqual({ type: "stop_recording" });
    service.say(
      transcript("00-00000002", true, "预算下周三再确认。", [
        ["预算", 2.2, 2.6],
        ["下周三", 2.6, 3.1],
        ["再确认。", 3.1, 3.8],
      ]),
    );
    service.drop(1000);
    await finished;
    expect(heard.finals().map((each) => [each.text, each.startMs])).toEqual([
      ["The review moves to Thursday.", 400],
      ["预算下周三再确认。", 2200],
    ]);
    expect(heard.losses).toEqual([]);
  });

  test("a 401 to the session's request is a refused key, a 402 out of credit, any other answer or a socket address not Gladia's dropped; no socket opens", async () => {
    for (const [answer, loss] of [
      [() => new Response("{}", { status: 401 }), "refused"],
      [() => new Response("{}", { status: 402 }), "credit"],
      [() => new Response("{}", { status: 429 }), "dropped"],
      [() => started(201, "wss://elsewhere.example/v2/live?token=1"), "dropped"],
    ] as const) {
      const { service, heard } = connect(answer);
      await vi.waitFor(() => expect(heard.losses).toEqual([loss]));
      expect(service.connections).toEqual([]);
    }
  });

  test("dropped while its session is being asked for, it opens no socket, so no audio goes", async () => {
    let answer: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const service = playback();
    const heard = collect();
    const stream = createGladiaStream({
      stream: "m:system",
      model: "solaria-1",
      apiKey: "gladia-test-key",
      languages: [],
      connect: service.connect,
      report: heard.report,
      fetch: () => pending,
    });
    feed((samples) => stream.push(samples), 1);
    stream.drop();
    answer(started(201));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.connections).toEqual([]);
    expect(heard.losses).toEqual([]);
  });

  test("a socket that closes before the end drops the stream", async () => {
    const { service, heard } = connect();
    await vi.waitFor(() => expect(service.connections).toHaveLength(1));
    service.open();
    service.drop(1006);
    expect(heard.losses).toEqual(["dropped"]);
  });
});
