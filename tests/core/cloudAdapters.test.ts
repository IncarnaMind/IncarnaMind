import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { CloudLoss, SpeechSegment } from "../../src/core";
import { createOpenAiStream, createUpsampler } from "../../src/core/transcription/cloud/openai";
import type { CloudConnect, CloudSocketEvents } from "../../src/core/transcription/cloud/socket";
import { createSonioxStream } from "../../src/core/transcription/cloud/soniox";
import type { VoiceDetector } from "../../src/core/transcription/speech";

const RATE = 16_000;

interface OpenAiEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
}

const openai: { events: OpenAiEvent[] } = JSON.parse(
  readFileSync(new URL("../fixtures/transcription/openai-mixed.json", import.meta.url), "utf8"),
);
const soniox: { messages: object[] } = JSON.parse(
  readFileSync(new URL("../fixtures/transcription/soniox-mixed.json", import.meta.url), "utf8"),
);

/** A service that plays back what it is told to, and keeps what it was sent. */
function playback() {
  let events: CloudSocketEvents | null = null;
  const sent: (string | Uint8Array)[] = [];
  let url = "";
  let key = "";
  const connect: CloudConnect = (to, apiKey, given) => {
    url = to;
    key = apiKey;
    events = given;
    return { send: (data) => sent.push(data), close: () => {} };
  };
  const live = () => {
    if (!events) throw new Error("Nothing connected.");
    return events;
  };
  return {
    connect,
    sent,
    get url() {
      return url;
    },
    get key() {
      return key;
    },
    open: () => live().open(),
    say: (message: object) => live().message(JSON.stringify(message)),
    drop: (code = 1006) => live().closed(code),
    sentJson: () =>
      sent
        .filter((each): each is string => typeof each === "string" && each !== "")
        .map((each) => JSON.parse(each) as { type?: string }),
  };
}

/** Speech where the test says, in seconds, as Silero would report it. */
function scriptedDetector(speech: readonly [number, number][]): VoiceDetector {
  let position = 0;
  let kept = 0;
  const ended: { start: number; samples: Float32Array }[] = [];
  let open: [number, number] | undefined;
  const inSpeech = (at: number) => speech.find(([from, to]) => at >= from * RATE && at < to * RATE);
  return {
    accept(samples) {
      for (let i = 0; i < samples.length; i++) {
        const now = inSpeech(position);
        if (open && now !== open) {
          ended.push({ start: open[0] * RATE, samples: new Float32Array(kept) });
          kept = 0;
        }
        open = now;
        if (now) kept++;
        position++;
      }
    },
    speaking: () => open !== undefined,
    next: () => ended.shift() ?? null,
    flush() {
      if (open) ended.push({ start: open[0] * RATE, samples: new Float32Array(kept) });
      open = undefined;
      kept = 0;
    },
  };
}

function collect() {
  const segments: SpeechSegment[] = [];
  const progress: number[] = [];
  const losses: CloudLoss[] = [];
  const opened = { count: 0 };
  return {
    opened,
    segments,
    progress,
    losses,
    finals: () => segments.filter((each) => each.final),
    report: {
      segment: (each: SpeechSegment) => segments.push(each),
      progress: (doneMs: number) => progress.push(doneMs),
      lost: (loss: CloudLoss) => losses.push(loss),
      opened: () => {
        opened.count++;
      },
    },
  };
}

/** Audio in 100 ms frames, as a Meeting's capture sends it: a tone, which the scripted detector ignores. */
function feed(push: (samples: Int16Array) => void, seconds: number) {
  for (let at = 0; at < seconds * 10; at++) {
    push(Int16Array.from({ length: RATE / 10 }, (_, i) => Math.round(Math.sin(i / 3) * 3000)));
  }
}

const turnsOf = (events: readonly OpenAiEvent[]) =>
  events.filter((each) => each.type === "input_audio_buffer.committed").map((each) => each.item_id);

const completedOf = (events: readonly OpenAiEvent[]) =>
  new Map(
    events
      .filter((each) => each.type === "conversation.item.input_audio_transcription.completed")
      .map((each) => [each.item_id, each.transcript ?? ""]),
  );

/** Ten turns of 2 s speech after 4 s of quiet, as the recording's ten turns. */
const TURNS: [number, number][] = Array.from({ length: 10 }, (_, i) => [i * 6 + 4, i * 6 + 6]);

describe("OpenAI's live transcription, played back as it was recorded", () => {
  function run(events: readonly OpenAiEvent[]) {
    const service = playback();
    const heard = collect();
    const stream = createOpenAiStream({
      stream: "m:system",
      model: "gpt-live-transcribe",
      apiKey: "sk-test",
      connect: service.connect,
      report: heard.report,
      detector: scriptedDetector(TURNS),
    });
    service.open();
    service.say({ type: "session.updated" });
    feed((samples) => stream.push(samples), 61);
    const finished = stream.finish();
    for (const event of events) if (event.type !== "session.updated") service.say(event);
    return { service, heard, finished };
  }

  test("sets up a transcription session with no turn detection of the service's own, then sends only speech, each turn committed", async () => {
    const { service, heard, finished } = run(openai.events);
    await finished;
    expect(service.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
    expect(service.key).toBe("sk-test");
    const [update, ...rest] = service.sentJson();
    expect(update).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-live-transcribe", languages: ["en", "zh"] },
            turn_detection: null,
          },
        },
      },
    });
    expect(rest.filter((each) => each.type === "input_audio_buffer.commit")).toHaveLength(10);
    // 2 s of speech in each of ten turns, from 1.2 s before the detector heard it: 33 s of 61.
    const appended = rest
      .filter(
        (each): each is { type: string; audio: string } =>
          each.type === "input_audio_buffer.append",
      )
      .reduce((sum, each) => sum + Buffer.from(each.audio, "base64").byteLength / 2, 0);
    expect(appended / 24_000).toBeGreaterThan(30);
    expect(appended / 24_000).toBeLessThan(36);
    expect(heard.losses).toEqual([]);
    // Ready for audio once the session is set up, not merely connected.
    expect(heard.opened.count).toBe(1);
  });

  test("each turn's final text is its own completed transcript, at the time its speech was heard; partial text comes first", async () => {
    const { heard, finished } = run(openai.events);
    await finished;
    const completed = completedOf(openai.events);
    const turns = turnsOf(openai.events);
    expect(heard.finals().map((each) => [each.id, each.text])).toEqual(
      turns.map((item, index) => [index + 1, (completed.get(item) ?? "").trim()]),
    );
    const third = heard.finals()[2];
    // Its speech from 16 s to 18 s, from 1.2 s before the detector heard it, a frame in.
    expect(third).toMatchObject({ startMs: 14_900, endMs: 18_000 });
    const partials = heard.segments.filter((each) => !each.final && each.id === 1);
    expect(partials.length).toBeGreaterThan(1);
    expect(heard.progress.at(-1)).toBe(61_000);
  });

  test("results that arrive out of order still go to their own turns, matched by item_id", async () => {
    // The last turn's events first, then the rest from the end: completions and deltas reversed.
    const header = openai.events.filter((each) => each.type === "input_audio_buffer.committed");
    const rest = openai.events.filter(
      (each) => each.type !== "input_audio_buffer.committed" && each.type !== "session.updated",
    );
    const shuffled = [...header, ...[...rest].reverse()];
    const { heard, finished } = run(shuffled);
    await finished;
    const completed = completedOf(openai.events);
    expect(
      heard
        .finals()
        .sort((a, b) => a.id - b.id)
        .map((each) => each.text),
    ).toEqual(turnsOf(openai.events).map((item) => (completed.get(item) ?? "").trim()));
  });

  test("a turn's text that comes before its commit is acknowledged waits for it, then goes to the right turn", async () => {
    const committed = openai.events.filter((each) => each.type === "input_audio_buffer.committed");
    const completions = openai.events.filter((each) => each.type.endsWith(".completed"));
    // Every completion before any commit is acknowledged, the second turn's first.
    const [first, second, ...others] = completions;
    const { heard, finished } = run(
      [second, first, ...others, ...committed].filter((each) => each !== undefined),
    );
    await finished;
    const completed = completedOf(openai.events);
    expect(
      heard
        .finals()
        .sort((a, b) => a.id - b.id)
        .map((each) => each.text),
    ).toEqual(turnsOf(openai.events).map((item) => (completed.get(item) ?? "").trim()));
  });

  test("a refused key, or the connection lost, ends the stream: the service says so, and nothing more is reported", async () => {
    for (const [last, loss] of [
      [
        { type: "error", error: { type: "invalid_request_error", code: "invalid_api_key" } },
        "refused",
      ],
      [null, "dropped"],
    ] as const) {
      const service = playback();
      const heard = collect();
      const stream = createOpenAiStream({
        stream: "m:microphone",
        model: "gpt-live-transcribe",
        apiKey: "sk-wrong",
        connect: service.connect,
        report: heard.report,
        detector: scriptedDetector(TURNS),
      });
      service.open();
      if (last) service.say(last);
      service.drop(last ? 3000 : 1006);
      feed((samples) => stream.push(samples), 2);
      expect(heard.losses).toEqual([loss]);
      expect(heard.segments).toEqual([]);
      await stream.finish();
    }
  });

  test("16 kHz audio becomes 24 kHz, two samples in for three out, across chunks", () => {
    const upsample = createUpsampler();
    const ramp = Int16Array.from({ length: 8 }, (_, i) => i * 300);
    const out = [...upsample(ramp.subarray(0, 3)), ...upsample(ramp.subarray(3))];
    expect(out).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]);
  });
});

describe("Soniox's real-time transcription, played back as it was recorded", () => {
  function run(messages: readonly object[]) {
    const service = playback();
    const heard = collect();
    const stream = createSonioxStream({
      stream: "m:system",
      model: "stt-rt-v5",
      apiKey: "soniox-test",
      connect: service.connect,
      report: heard.report,
    });
    feed((samples) => stream.push(samples), 1);
    service.open();
    feed((samples) => stream.push(samples), 1);
    const finished = stream.finish();
    for (const message of messages) service.say(message);
    return { service, heard, finished };
  }

  test("starts with its settings, then sends the audio as it comes, and an empty frame to end it", async () => {
    const { service, heard, finished } = run(soniox.messages);
    await finished;
    expect(service.url).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(JSON.parse(service.sent[0] as string)).toEqual({
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
      language_hints: ["en", "zh"],
      enable_speaker_diarization: true,
      enable_endpoint_detection: true,
    });
    const audio = service.sent.filter((each) => each instanceof Uint8Array);
    // What came before the connection opened went first, then the rest.
    expect(audio.reduce((sum, each) => sum + each.byteLength, 0)).toBe(2 * RATE * 2);
    expect(service.sent.at(-1)).toBe("");
    expect(heard.opened.count).toBe(1);
  });

  test("a line ends where the service heard a pause, with who said it; its words in English and Chinese as sent", async () => {
    const { heard, finished } = run(soniox.messages);
    await finished;
    const finals = heard.finals();
    expect(finals.map((each) => each.text)).toEqual([
      "When you call someone who is thousands of miles away, you are using a satellite.",
      "报告警告称，没有人能保证目前在伊拉克采取的任何行动能够阻止宗派战争不断增长的暴力或走向混乱。",
      expect.stringMatching(/^Now widely available throughout the/),
    ]);
    expect(finals.map((each) => each.speaker)).toEqual(["1", "2", "3"]);
    expect(finals[1]?.startMs).toBeGreaterThan(finals[0]?.endMs ?? 0);
    // Partial text of each line comes first, as the same line.
    for (const final of finals) {
      expect(heard.segments.some((each) => !each.final && each.id === final.id)).toBe(true);
    }
    const sorted = [...heard.progress].sort((a, b) => a - b);
    expect(heard.progress).toEqual(sorted);
  });

  test("a refused key, or the connection lost, ends the stream: the service says so", async () => {
    for (const [message, loss] of [
      [{ tokens: [], error_code: 401, error_message: "Incorrect API key provided." }, "refused"],
      [{ tokens: [], error_code: 503, error_message: "Unavailable." }, "dropped"],
    ] as const) {
      const service = playback();
      const heard = collect();
      createSonioxStream({
        stream: "m:system",
        model: "stt-rt-v5",
        apiKey: "soniox-test",
        connect: service.connect,
        report: heard.report,
      });
      service.open();
      service.say(message);
      service.drop(1000);
      expect(heard.losses).toEqual([loss]);
    }
  });
});
