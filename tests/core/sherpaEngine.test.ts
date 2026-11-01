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
        decodeAsync: async () => {
          const told = toldResult !== null && STREAMS.at(-1)?.hotwords;
          if (told && toldResult === "fails") throw new Error("The told reading failed.");
          return JSON.parse(told ? (toldResult as string) : latest());
        },
      }),
    },
    Vad: class {},
    OfflineSpeakerDiarization: class {},
    SpeakerEmbeddingExtractor: class {},
  },
}));
vi.mock("sherpa-onnx-node/addon.js", () => ({
  default: { getOfflineStreamResultAsJson: latest, offlineStreamSetOption: () => {} },
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
});
