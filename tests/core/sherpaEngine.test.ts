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

// As the built process gets the package, from a native import(): everything is on `default`.
vi.mock("sherpa-onnx-node", () => ({
  default: {
    OfflineRecognizer: {
      createAsync: async () => ({
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
        decodeAsync: async () =>
          JSON.parse(toldResult !== null && STREAMS.at(-1)?.hotwords ? toldResult : latest()),
      }),
    },
    Vad: class {},
    OfflineSpeakerDiarization: class {},
    SpeakerEmbeddingExtractor: class {},
  },
}));
vi.mock("sherpa-onnx-node/addon.js", () => ({
  default: { getOfflineStreamResultAsJson: latest },
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

  test("fails for a result it can't read at all, as before", async () => {
    const engine = await createSherpaEngine(model);
    RESULTS.push("not json");

    await expect(engine.recognizer.decode(samples, "meeting:1:microphone", [])).rejects.toThrow(
      SyntaxError,
    );
  });

  test("tells the model the words the speech may hold, and reads a stretch again without them when it wrote the list instead (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    const words = ["陈经理", "星河科技", "王丽", "王总", "李明"];
    STREAMS.length = 0;
    toldResult = '{"lang": "", "text": "我们的项目经理李明会把施工图发给你。", "tokens": []}';
    RESULTS.push('{"lang": "", "text": "我们的项目经理李林会把施工图发给你。", "tokens": []}');

    expect(await engine.recognizer.decode(samples, "meeting:1:system", words)).toBe(
      "我们的项目经理李明会把施工图发给你。",
    );
    expect(STREAMS).toEqual([{ hotwords: "陈经理,星河科技,王丽,王总,李明" }]);

    STREAMS.length = 0;
    toldResult = '{"lang": "", "text": "陈经理，星河科技，王丽，王总，李明。", "tokens": []}';
    RESULTS.push('{"lang": "", "text": "神经理，你好，我是星河科技的王丽。", "tokens": []}');
    expect(await engine.recognizer.decode(samples, "meeting:1:mic", words)).toBe(
      "神经理，你好，我是星河科技的王丽。",
    );
    expect(STREAMS).toEqual([{ hotwords: "陈经理,星河科技,王丽,王总,李明" }, {}]);

    STREAMS.length = 0;
    expect(await engine.recognizer.decode(samples, "meeting:1:mic", [])).toBe(
      "神经理，你好，我是星河科技的王丽。",
    );
    expect(STREAMS).toEqual([{}]);
    toldResult = null;
  });
});
