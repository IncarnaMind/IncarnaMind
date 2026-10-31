import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { CloudLoss, SpeechSegment } from "../../src/core";
import { QWEN_REALTIME_MODEL } from "../../src/core/providers/catalog/transcription";
import { createOpenAiStream, createUpsampler } from "../../src/core/transcription/cloud/openai";
import { createQwenStream } from "../../src/core/transcription/cloud/qwen";
import {
  type CloudConnect,
  type CloudSocketEvents,
  HANDSHAKE_REFUSED,
} from "../../src/core/transcription/cloud/socket";
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

const QWEN_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

interface QwenSentence {
  sentence_id: number;
  sentence_end?: boolean;
  text: string;
  begin_time: number;
  end_time: number | null;
}

interface QwenMessage {
  header: { event: string };
  payload: { output?: { sentence?: QwenSentence } };
}

const qwenStream = (name: "qwen-en" | "qwen-zh" | "qwen-mixed"): { messages: QwenMessage[] } =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/transcription/${name}.json`, import.meta.url), "utf8"),
  );

const finalSentences = (messages: readonly QwenMessage[]) =>
  messages.flatMap((message) => {
    const sentence = message.payload.output?.sentence;
    return sentence?.sentence_end ? [sentence] : [];
  });

const qwenResult = (sentence: QwenSentence): QwenMessage => ({
  header: { event: "result-generated" },
  payload: { output: { sentence } },
});

describe("Qwen's real-time transcription, played back in the format Alibaba documents", () => {
  function connect() {
    const service = playback();
    const heard = collect();
    const order: string[] = [];
    const answered: number[] = [];
    const stream = createQwenStream({
      stream: "m:system",
      model: QWEN_REALTIME_MODEL,
      apiKey: "sk-qwen-test",
      url: QWEN_URL,
      connect: service.connect,
      report: {
        segment: (each) => {
          heard.report.segment(each);
          order.push(`${each.final ? "final" : "partial"} ${each.id}`);
        },
        progress: (doneMs, heardMs) => {
          heard.report.progress(doneMs);
          answered.push(heardMs ?? doneMs);
          order.push(`done ${doneMs}`);
        },
        lost: heard.report.lost,
        opened: heard.report.opened,
      },
    });
    return { service, heard, order, answered, stream };
  }

  /** The service answers as the audio is fed: each message once its time has been said, a second second. */
  async function play(messages: readonly QwenMessage[], seconds: number) {
    const { service, heard, order, stream } = connect();
    service.open();
    const [started, ...rest] = messages;
    service.say(started as object);
    let pending = [...rest];
    const timeOf = (message: QwenMessage) => {
      const sentence = message.payload.output?.sentence;
      if (message.header.event === "task-finished") return Number.POSITIVE_INFINITY;
      return sentence?.end_time ?? sentence?.begin_time ?? 0;
    };
    for (let second = 1; second <= seconds; second++) {
      feed((samples) => stream.push(samples), 1);
      const until = pending.findIndex((message) => timeOf(message) > (second - 1) * 1000);
      const due = until === -1 ? pending : pending.slice(0, until);
      pending = pending.slice(due.length);
      for (const message of due) service.say(message);
    }
    const finished = stream.finish();
    for (const message of pending) service.say(message);
    await finished;
    return { service, heard, order };
  }

  test("starts a task for the pinned model on the region's address, with the key; audio waits for the task, then goes as it comes, and the task is finished", async () => {
    const { service, heard, stream } = connect();
    feed((samples) => stream.push(samples), 1);
    service.open();
    expect(service.sent).toHaveLength(1);
    // The core holds the audio until the task is ready.
    expect(heard.opened.count).toBe(0);
    service.say({ header: { event: "task-started" }, payload: {} });
    expect(heard.opened.count).toBe(1);
    feed((samples) => stream.push(samples), 1);
    const finished = stream.finish();
    service.say({ header: { event: "task-finished" }, payload: { output: {}, usage: null } });
    await finished;

    expect(service.url).toBe(QWEN_URL);
    expect(service.key).toBe("sk-qwen-test");
    expect(QWEN_REALTIME_MODEL).toBe("fun-asr-realtime");
    const [task, ...rest] = service.sent;
    const started = JSON.parse(task as string);
    expect(started).toEqual({
      header: { action: "run-task", task_id: expect.any(String), streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: "fun-asr-realtime",
        parameters: { format: "pcm", sample_rate: 16_000, heartbeat: true },
        input: {},
      },
    });
    // What was said before the task started goes once it has, then the rest: 2 s in all.
    const audio = rest.filter((each) => each instanceof Uint8Array);
    expect(audio.reduce((sum, each) => sum + each.byteLength, 0)).toBe(2 * RATE * 2);
    expect(JSON.parse(rest.at(-1) as string)).toEqual({
      header: { action: "finish-task", task_id: started.header.task_id, streaming: "duplex" },
      payload: { input: {} },
    });
    expect(heard.losses).toEqual([]);
  });

  test.each([
    ["English", "qwen-en"],
    ["Chinese", "qwen-zh"],
    ["English and Chinese in one stream", "qwen-mixed"],
  ] as const)(
    "%s: each sentence's text, as the service gave it, when it was said; partial text comes first",
    async (_language, name) => {
      const { messages } = qwenStream(name);
      const { heard } = await play(messages, 32);
      expect(heard.finals().map((each) => [each.id, each.text, each.startMs, each.endMs])).toEqual(
        finalSentences(messages).map((each) => [
          each.sentence_id,
          each.text,
          each.begin_time,
          each.end_time,
        ]),
      );
      for (const final of heard.finals()) {
        expect(heard.segments.some((each) => !each.final && each.id === final.id)).toBe(true);
        expect(final.speaker).toBeUndefined();
      }
      expect(heard.segments.every((each) => each.text.length > 0)).toBe(true);
      expect(heard.losses).toEqual([]);
    },
  );

  test("the mixed stream keeps both scripts, in the order said", async () => {
    const { heard } = await play(qwenStream("qwen-mixed").messages, 32);
    expect(heard.finals().map((each) => each.text)).toEqual([
      "When you call someone who is thousands of miles away, you are using a satellite.",
      expect.stringMatching(/^报告警告称，没有人能保证.*混乱。$/),
      expect.stringMatching(/^Now widely available/),
    ]);
  });

  test("how far the text is done never goes back, stays before the sentence being said, and is the whole audio once the task is finished", async () => {
    const { order } = await play(qwenStream("qwen-zh").messages, 22);
    const done = order
      .filter((each) => each.startsWith("done "))
      .map((each) => Number(each.slice(5)));
    expect([...done].sort((a, b) => a - b)).toEqual(done);
    // From its first words to its final text, the first sentence (from 2.2 s) is not done.
    const from = order.indexOf("partial 1");
    const to = order.indexOf("final 1");
    expect(from).toBeGreaterThan(0);
    for (const each of order.slice(from, to).filter((entry) => entry.startsWith("done "))) {
      expect(Number(each.slice(5))).toBeLessThanOrEqual(2200);
    }
    // Silence alone moves no boundary: only the final result says what is done.
    const between = order.slice(order.indexOf("final 1"), order.indexOf("partial 2"));
    expect([
      ...new Set(between.filter((e) => e.startsWith("done ")).map((e) => Number(e.slice(5)))),
    ]).toEqual([10_300, 15_400]);
    expect(done.at(-1)).toBe(22_000);
  });

  test("a late first partial never moves done backwards", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ header: { event: "task-started" }, payload: {} });
    feed((samples) => stream.push(samples), 4);
    expect(heard.progress.at(-1)).toBe(0);

    service.say({
      header: { event: "result-generated" },
      payload: {
        output: {
          sentence: {
            sentence_id: 1,
            begin_time: 1000,
            end_time: null,
            text: "Late words",
            sentence_end: false,
          },
        },
      },
    });
    expect(heard.progress.at(-1)).toBe(1000);

    const finished = stream.finish();
    service.say({ header: { event: "task-finished" }, payload: { output: {}, usage: null } });
    await finished;
    expect(heard.progress.at(-1)).toBe(4000);
  });

  test("a dropped late first sentence leaves all of its unfinalized speech to replay", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ header: { event: "task-started" }, payload: {} });
    feed((samples) => stream.push(samples), 10);
    service.say({
      header: { event: "result-generated" },
      payload: {
        output: {
          sentence: {
            sentence_id: 1,
            begin_time: 1000,
            end_time: null,
            text: "Not final yet",
            sentence_end: false,
            words: [{ end_time: 2000 }],
          },
        },
      },
    });
    service.drop(1006);

    expect(heard.losses).toEqual(["dropped"]);
    expect(heard.finals()).toEqual([]);
    expect(heard.progress.at(-1)).toBe(1000);
  });

  test("later partials and an out-of-order final never pass an unfinished earlier sentence", () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ header: { event: "task-started" }, payload: {} });
    feed((samples) => stream.push(samples), 10);
    service.say(
      qwenResult({
        sentence_id: 1,
        begin_time: 1000,
        end_time: null,
        text: "First unfinished",
        sentence_end: false,
      }),
    );
    service.say(
      qwenResult({
        sentence_id: 2,
        begin_time: 5000,
        end_time: null,
        text: "Second unfinished",
        sentence_end: false,
      }),
    );
    service.say(
      qwenResult({
        sentence_id: 2,
        begin_time: 5000,
        end_time: 9000,
        text: "Second finishes first",
        sentence_end: true,
      }),
    );
    expect(heard.progress.at(-1)).toBe(1000);

    service.drop(1006);
    expect(heard.progress.at(-1)).toBe(1000);
  });

  test("normal completion settles every open sentence and reports no loss", async () => {
    const { service, heard, stream } = connect();
    service.open();
    service.say({ header: { event: "task-started" }, payload: {} });
    feed((samples) => stream.push(samples), 4);
    for (const [sentence_id, begin_time, text] of [
      [1, 1000, "First open"],
      [2, 3000, "Second open"],
    ] as const) {
      service.say(
        qwenResult({ sentence_id, begin_time, end_time: null, text, sentence_end: false }),
      );
    }

    const finished = stream.finish();
    service.say({ header: { event: "task-finished" }, payload: { output: {}, usage: null } });
    await finished;
    expect(heard.finals().map((each) => each.id)).toEqual([1, 2]);
    expect(heard.progress.at(-1)).toBe(4000);
    expect(heard.losses).toEqual([]);
  });

  test("a finish timeout leaves the unfinalized sentence to replay", async () => {
    vi.useFakeTimers();
    try {
      const { service, heard, stream } = connect();
      service.open();
      service.say({ header: { event: "task-started" }, payload: {} });
      feed((samples) => stream.push(samples), 4);
      service.say({
        header: { event: "result-generated" },
        payload: {
          output: {
            sentence: {
              sentence_id: 1,
              begin_time: 1000,
              end_time: null,
              text: "Still unfinished",
              sentence_end: false,
            },
          },
        },
      });

      const finished = stream.finish();
      await vi.advanceTimersByTimeAsync(20_000);
      await finished;
      expect(heard.finals()).toEqual([]);
      expect(heard.progress.at(-1)).toBe(1000);
      expect(heard.losses).toEqual(["dropped"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("heartbeats, which carry no sentence, are ignored", async () => {
    const heartbeat = {
      header: { event: "result-generated" },
      payload: {
        output: { sentence: { text: "", heartbeat: true, sentence_id: 0, words: [] } },
      },
    } as unknown as QwenMessage;
    const { messages } = qwenStream("qwen-en");
    const [started, ...rest] = messages;
    const { heard } = await play([started, heartbeat, ...rest, heartbeat] as QwenMessage[], 24);
    expect(heard.finals()).toHaveLength(2);
    expect(heard.segments.every((each) => each.text !== "")).toBe(true);
  });

  // protects=a heartbeat in a long silence shows the service keeps up with the audio sent, so the core doesn't call live text behind, while text done stays where the last final left it; fails_when=a heartbeat moves done, which a later partial could show was speech, or says nothing, so a quiet track falls behind; no_claim=the real service's heartbeat cadence.
  test("a heartbeat shows the service answered for the audio sent, and moves no text done", () => {
    const { service, heard, answered, stream } = connect();
    service.open();
    service.say({ header: { event: "task-started" }, payload: {} });
    feed((samples) => stream.push(samples), 10);
    service.say({
      header: { event: "result-generated" },
      payload: {
        output: { sentence: { begin_time: null, end_time: null, text: "", heartbeat: true } },
      },
    });

    expect(heard.segments).toEqual([]);
    expect(heard.progress.at(-1)).toBe(0);
    expect(answered.at(-1)).toBe(10_000);
  });

  test("a key the service turns away, in either way it does, is refused; any other end is a dropped connection, and nothing more is reported", async () => {
    const failed = (code: string) => (service: ReturnType<typeof playback>) => {
      service.open();
      service.say({
        header: { event: "task-failed", error_code: code, error_message: "x" },
        payload: {},
      });
    };
    for (const [end, loss] of [
      [(service: ReturnType<typeof playback>) => service.drop(HANDSHAKE_REFUSED), "refused"],
      [failed("InvalidApiKey"), "refused"],
      [failed("CLIENT_ERROR"), "dropped"],
      [(service: ReturnType<typeof playback>) => service.drop(1006), "dropped"],
    ] as const) {
      const { service, heard, stream } = connect();
      end(service);
      feed((samples) => stream.push(samples), 2);
      service.drop(1006);
      expect(heard.losses).toEqual([loss]);
      expect(heard.segments).toEqual([]);
      await stream.finish();
    }
  });
});
