import { describe, expect, test, vi } from "vitest";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";

/*
 * The engine's recognizer when sherpa-onnx's own reader refuses a result (#981):
 * a stand-in for the package whose `decodeAsync` reads JSON the way the real
 * one does, and an addon that still holds the result.
 */
const RESULTS: string[] = [];
const latest = () => RESULTS.at(-1) ?? "";
/** Each stream's options, and what a stream told hotwords decodes to instead, when set. */
const STREAMS: Record<string, string>[] = [];
let toldResult: string | null = null;
/** The recognizer's configuration, as each engine made it. */
const CONFIGS: unknown[] = [];

// As the built process gets the package, from a native import(): everything is on `default`.
vi.mock("sherpa-onnx-node", () => ({
  default: {
    OfflineRecognizer: {
      createAsync: async (config: unknown) => {
        CONFIGS.push(config);
        return {
          createStream: () => {
            const options: Record<string, string> = {};
            STREAMS.push(options);
            return {
              acceptWaveform: () => {},
              setOption: (key: string, value: string) => {
                options[key] = value;
              },
              handle: { id: RESULTS.length },
            };
          },
          decodeAsync: async () => {
            const told = toldResult !== null && STREAMS.at(-1)?.hotwords;
            if (told && toldResult === "fails") throw new Error("The told reading failed.");
            return JSON.parse(told ? (toldResult as string) : latest());
          },
        };
      },
    },
    OnlineRecognizer: class {
      constructor() {
        throw new Error("Could not load the streaming model's encoder.");
      }
    },
    Vad: class {},
    OfflineSpeakerDiarization: class {},
    SpeakerEmbeddingExtractor: class {},
  },
}));
vi.mock("sherpa-onnx-node/addon.js", () => ({
  default: {
    getOfflineStreamResultAsJson: latest,
    getOnlineStreamResultAsJson: () => "",
    offlineStreamSetOption: () => {},
  },
}));

const { createSherpaEngine } = await import("../../src/core/transcription/sherpa");

const model = {
  engine: "qwen3-asr",
  files: { convFrontend: "a", encoder: "b", decoder: "c", tokenizer: "d" },
  vad: "v",
  threads: 1,
};
const samples = new Float32Array(MEETING_SAMPLE_RATE);

describe("The sherpa-onnx recognizer", () => {
  test("keeps the words of a stretch whose result has a control character, which the package's reader refuses", async () => {
    const engine = await createSherpaEngine(model);
    RESULTS.push('{"lang": "", "text": "The launch\nmoves to the eighteenth.", "tokens": []}');
    expect(() => JSON.parse(latest())).toThrow(SyntaxError);

    expect(await engine.recognizer.decode(samples, "meeting:1:microphone", [])).toBe(
      "The launch\nmoves to the eighteenth.",
    );
  });

  test("leaves out the model's header that sherpa-onnx left in the text, with its control characters too", async () => {
    const engine = await createSherpaEngine(model);
    RESULTS.push(
      '{"lang": "", "text": "提uggestion\nlanguage English<asr_text>Local authorities are warning.", "tokens": []}',
    );

    expect(await engine.recognizer.decode(samples, "meeting:1:microphone", [])).toBe(
      "Local authorities are warning.",
    );
  });

  test("gives the text of an ordinary result as the package reads it", async () => {
    const engine = await createSherpaEngine(model);
    RESULTS.push('{"lang": "", "text": "Plain words.", "tokens": []}');

    expect(await engine.recognizer.decode(samples, "meeting:1:microphone", [])).toBe(
      "Plain words.",
    );
  });

  test("writes the numbers of a stretch as digits, whichever way the model said them, so a check of 6.8% finds the line (#1508)", async () => {
    const engine = await createSherpaEngine(model);
    RESULTS.push(
      '{"lang": "", "text": "Voss said six point eight percent to eighteen point four million, and 9.3% before the thirtieth of November.", "tokens": []}',
    );

    const text = await engine.recognizer.decode(samples, "meeting:1:microphone", []);

    expect(text).toBe("Voss said 6.8% to 18.4 million, and 9.3% before the 30th of November.");
    expect(text).toContain("6.8%");
  });

  test("a streaming model that can't load leaves the engine as before, its live words read again, and says why in the log (#2662)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await createSherpaEngine({
      ...model,
      live: {
        engine: "streaming-transducer",
        files: { encoder: "e", decoder: "f", joiner: "g", tokens: "h" },
      },
    });
    RESULTS.push('{"lang": "", "text": "Plain words.", "tokens": []}');

    expect(engine.live).toBeUndefined();
    expect(await engine.recognizer.decode(samples, "meeting:1:microphone", [])).toBe(
      "Plain words.",
    );
    expect(warn).toHaveBeenCalledWith(
      "The streaming speech model couldn't load; live words are read again as speech goes on.",
      "Could not load the streaming model's encoder.",
    );
    warn.mockRestore();
  });

  test("fails for a result it can't read at all, as before", async () => {
    const engine = await createSherpaEngine(model);
    RESULTS.push("not json");

    await expect(engine.recognizer.decode(samples, "meeting:1:microphone", [])).rejects.toThrow(
      SyntaxError,
    );
  });

  test("reads a stretch again told the words only where its first reading holds one misheard, and keeps the first reading but that name (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    const words = ["Marcus", "Priya Raman", "Lumen Foods", "Harbor Logistics", "Sofia Lindqvist"];
    const told = { hotwords: "Marcus,Priya Raman,Lumen Foods,Harbor Logistics,Sofia Lindqvist" };
    STREAMS.length = 0;
    RESULTS.push(
      '{"lang": "", "text": "Hi, this is Priyaman from Lumen Foods, by Friday.", "tokens": []}',
    );
    toldResult = '{"lang": "", "text": "This is Priya Raman from Lumen Foods.", "tokens": []}';

    // The name comes from the told reading; the words it dropped stay as first read.
    expect(await engine.recognizer.decode(samples, "meeting:1:system", words)).toBe(
      "Hi, this is Priya Raman from Lumen Foods, by Friday.",
    );
    expect(STREAMS).toEqual([{}, told]);

    STREAMS.length = 0;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    RESULTS.push(
      '{"lang": "", "text": "Our operations lead, Sophia Lindvist, will send it.", "tokens": []}',
    );
    toldResult =
      '{"lang": "", "text": "Marcus, Priya Raman, Lumen Foods, Harbor Logistics.", "tokens": []}';
    expect(await engine.recognizer.decode(samples, "meeting:1:mic", words)).toBe(
      "Our operations lead, Sophia Lindvist, will send it.",
    );
    expect(STREAMS).toEqual([{}, told]);
    // The log says the model wrote the list, and holds none of the words.
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0])).not.toMatch(/Priya|Marcus|Lumen|Sofia/);
    warned.mockRestore();

    STREAMS.length = 0;
    expect(await engine.recognizer.decode(samples, "meeting:1:mic", [])).toBe(
      "Our operations lead, Sophia Lindvist, will send it.",
    );
    expect(STREAMS).toEqual([{}]);
    toldResult = null;
  });

  test("reads once a stretch whose first reading holds no told name misheard: a name already right, other words, or Chinese (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    toldResult = '{"lang": "", "text": "Thanks, Priya Raman.", "tokens": []}';
    for (const [text, words] of [
      ["Thanks, see you on Friday.", ["Priya Raman", "Lumen Foods"]],
      ["Thanks, Priya Raman.", ["Priya Raman", "Lumen Foods"]],
      ["I will send it.", ["Will", "Hope"]],
      ["我们的项目经理李名会把施工图发给你。", ["李明", "星河科技"]],
    ] as const) {
      STREAMS.length = 0;
      RESULTS.push(JSON.stringify({ lang: "", text, tokens: [] }));
      expect(await engine.recognizer.decode(samples, "meeting:1:mic", words)).toBe(text);
      expect(STREAMS).toEqual([{}]);
    }
    toldResult = null;
  });

  test("a told reading that fails leaves the stretch its first reading, and the log none of its words (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    RESULTS.push('{"lang": "", "text": "This is Priyaman from Lumen Foods.", "tokens": []}');
    toldResult = "fails";

    expect(await engine.recognizer.decode(samples, "meeting:1:mic", ["Priya Raman"])).toBe(
      "This is Priyaman from Lumen Foods.",
    );
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0])).not.toMatch(/Priya|Lumen/);
    warned.mockRestore();
    toldResult = null;
  });

  // protects=a reading that reaches Qwen3-ASR's 128 written tokens, or its 512 in all with its prompt and audio, says so in the app's log with none of its words, since sherpa-onnx's own log says nothing at the total; the limits are the engine's own, set where it is made; a reading of 15 s, the most one takes, reaches neither; fails_when=a reading cut short at either limit goes unseen again, the log holds what was said, or the limits the log counts against aren't the ones the engine runs with; no_claim=that readings stay that short, which tests/core/longSpeech.test.ts covers.
  test("a reading that reaches either token limit says so in the log, with none of its words (#1031)", async () => {
    CONFIGS.length = 0;
    const engine = await createSherpaEngine(model);
    expect(CONFIGS).toEqual([
      expect.objectContaining({
        modelConfig: expect.objectContaining({
          qwen3Asr: expect.objectContaining({ maxNewTokens: 128, maxTotalLen: 512 }),
        }),
      }),
    ]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reading = async (seconds: number, tokens: number) => {
      RESULTS.push(
        JSON.stringify({ lang: "", text: "Secret words.", tokens: Array(tokens).fill("x") }),
      );
      await engine.recognizer.decode(
        new Float32Array(seconds * MEETING_SAMPLE_RATE),
        "meeting:1:mic",
        [],
      );
    };
    // 125 tokens after its 3-token header: all 128 written.
    await reading(10, 125);
    // 30 s of audio is 390 tokens: with the 15 of the prompt and 107 written, all 512.
    await reading(30, 104);
    await reading(15, 100);
    await reading(15, 10);

    const message =
      "A reading of the speech model reached its token limit; its words may be cut short.";
    expect(warned.mock.calls).toEqual([
      [message, { limit: 128, seconds: 10, written: 128, total: 273 }],
      [message, { limit: 512, seconds: 30, written: 107, total: 512 }],
    ]);
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/Secret/);
    warned.mockRestore();
  });

  // protects=when the model writes its end-of-text token after a stretch's words and runs on with a passage of its own until its limit, as Qwen3-ASR did on the meeting set, the line keeps the words before the token and nothing after, the log says it ran on with none of the words, and no limit is reported since no word said was cut; fails_when=the Transcript shows the passage the model ran on with, or a run-on reads in the log as words cut short; no_claim=stopping the model at the token, which sherpa-onnx doesn't offer.
  test.each([
    ["en", "We sign on Friday, then the board reads it."],
    ["zh-CN", "三四个人，你人员要是扛过来的话，多派几个人也可以。"],
  ])(
    "a reading that runs on past its end-of-text token keeps the words before it, %s (#1031)",
    async (_language, said) => {
      const engine = await createSherpaEngine(model);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const passage = "Human Rights Watch（人权观察）是美国一个非政府组织，专门关注人权问题。";
      RESULTS.push(
        JSON.stringify({
          lang: "",
          text: `${said}<|endoftext|>${passage}${passage}${passage}`,
          tokens: [...Array(20).fill("x"), "<|endoftext|>", ...Array(104).fill("y")],
        }),
      );

      expect(await engine.recognizer.decode(samples, "meeting:1:mic", [])).toBe(said);
      expect(warned.mock.calls).toEqual([
        [
          "The speech model wrote on after a stretch's words; what it wrote after them is left out.",
        ],
      ]);
      warned.mockRestore();
    },
  );
});
