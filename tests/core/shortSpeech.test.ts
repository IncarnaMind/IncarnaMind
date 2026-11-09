import { describe, expect, test, vi } from "vitest";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";

/*
 * Short stretches of speech through the engine on this computer (#1031), with a stand-in for
 * sherpa-onnx whose reading depends on how long the audio is and the language it is told.
 */
type Options = Record<string, string>;
/** What the model writes for audio this many seconds long, told these options. */
let answer: (seconds: number, options: Options) => string = () => "";
/** Each reading's options, in order. */
const READINGS: Options[] = [];

vi.mock("sherpa-onnx-node", () => ({
  default: {
    OfflineRecognizer: {
      createAsync: async () => ({
        createStream: () => {
          const options: Options = {};
          let seconds = 0;
          return {
            acceptWaveform: ({ samples }: { samples: Float32Array }) => {
              seconds = samples.length / MEETING_SAMPLE_RATE;
            },
            setOption: (key: string, value: string) => {
              options[key] = value;
            },
            get reading() {
              return { seconds, options };
            },
            handle: {},
          };
        },
        decodeAsync: async (stream: { reading: { seconds: number; options: Options } }) => {
          const { seconds, options } = stream.reading;
          READINGS.push(options);
          return { lang: "", text: answer(seconds, options), tokens: [] };
        },
      }),
    },
    OnlineRecognizer: class {},
    Vad: class {},
    OfflineSpeakerDiarization: class {},
    SpeakerEmbeddingExtractor: class {},
  },
}));
vi.mock("sherpa-onnx-node/addon.js", () => ({
  default: {
    getOfflineStreamResultAsJson: () => "",
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
const audio = (seconds: number) => new Float32Array(Math.round(seconds * MEETING_SAMPLE_RATE));
const ENGLISH = "I think that's the plan, and it should be fine for the team.";
const CHINESE = "我们先看一下这个季度的预算，然后再讨论下周的安排。";

describe("A short stretch read on this computer (#1031)", () => {
  // protects=a stretch under 3 s is told its stream's language once the stream's latest two readings of 4 s or more are in it, so a short "yeah" in an English call isn't written "对。"; only that stream's, as the microphone and the call can be in different languages; fails_when=a short reading is told before its stream's language is clear, on another stream, or at 3 s and over; no_claim=the real model's answers, which eval/meetings and the short-phrase runs measure.
  test("is told its stream's language once two long readings agree, and only on that stream", async () => {
    const engine = await createSherpaEngine(model);
    answer = (seconds, options) =>
      seconds >= 4 ? ENGLISH : options.language === "English" ? "Yeah." : "对。";
    const read = (seconds: number, stream = "meeting-1:system") =>
      engine.recognizer.decode(audio(seconds), stream, []);

    expect(await read(1)).toBe("对。");
    await read(5);
    expect(await read(1)).toBe("对。");
    await read(6);
    READINGS.length = 0;
    expect(await read(1)).toBe("Yeah.");
    expect(await read(2.9)).toBe("Yeah.");
    expect(await read(3)).toBe("对。");
    expect(await read(1, "meeting-1:microphone")).toBe("对。");
    expect(READINGS.map((options) => options.language)).toEqual([
      "English",
      "English",
      undefined,
      undefined,
    ]);
  });

  // protects=a stream whose latest long readings are in different languages, or in none the words name (a mixed call), tells its short readings nothing; fails_when=a mixed Chinese and English call's short English replies are told Chinese and translated; no_claim=calls that change language for good, which the latest two readings follow.
  test("is told nothing while its stream's long readings disagree", async () => {
    const engine = await createSherpaEngine(model);
    let long = [ENGLISH, CHINESE];
    answer = (seconds, options) =>
      seconds >= 4 ? (long.shift() ?? "") : (options.language ?? "untold");
    const read = (seconds: number) => engine.recognizer.decode(audio(seconds), "meeting-2:mic", []);

    await read(5);
    await read(5);
    expect(await read(1)).toBe("untold");
    long = [
      "这个 feature 我们 next week 再 discuss 一下 okay",
      "这个 feature 我们 next week 再 discuss 一下 okay",
    ];
    await read(5);
    await read(5);
    expect(await read(1)).toBe("untold");
  });

  // protects=a short reading told the call's language that still comes back in another script is kept when Chinese speech says such words on their own ("OK", "email", an abbreviation said letter by letter) or the model's own reading writes the same ("Okay" for "OK", a Chinese name in an English call), and left out otherwise ("是的" told Chinese as "shit。", read alone as "system"), with none of its words in the log; fails_when=real code-switching is dropped, or a word the model makes up in another script reaches the Transcript; no_claim=how often each happens, which the short-phrase runs count.
  test.each([
    ["Chinese", CHINESE, "OK。", "", "OK。"],
    ["Chinese", CHINESE, "OK。", "Okay.", "OK。"],
    ["Chinese", CHINESE, "Email.", "", "Email."],
    ["Chinese", CHINESE, "k p i", "", "k p i"],
    ["Chinese", CHINESE, "KPI。", "", "KPI。"],
    ["Chinese", CHINESE, "PPT发我。", "PPT发我。", "PPT发我。"],
    ["English", ENGLISH, "王总。", "王总。", "王总。"],
    ["Chinese", CHINESE, "shit。", "system", ""],
    ["Chinese", CHINESE, "kitty。", "", ""],
    ["Chinese", CHINESE, "bullshit。", "我 shit。", ""],
    ["English", ENGLISH, "对。", "是。", ""],
  ])(
    "told %s, a short reading of %s's stream written %s, read alone as %s, gives %j",
    async (_language, long, told, alone, kept) => {
      const engine = await createSherpaEngine(model);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      answer = (seconds, options) => (seconds >= 4 ? long : options.language ? told : alone);
      const read = (seconds: number) =>
        engine.recognizer.decode(audio(seconds), "meeting-3:mic", []);
      await read(5);
      await read(5);

      expect(await read(1)).toBe(kept);
      if (kept) expect(warned).not.toHaveBeenCalled();
      else {
        expect(warned).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warned.mock.calls)).not.toMatch(/shit|system|对|是/);
      }
      warned.mockRestore();
    },
  );

  // protects=a reading that is only the model's header ("language Chinese", "language None") or its prompt's word ("system", "<asr_text>system") is no line, as it is what the model writes for a short or quiet stretch instead of words; fails_when="language Chinese" or "system" shows as something said in the Transcript; no_claim=a header in the middle of words, which tests/core/speechText.test.ts covers.
  test.each(["language Chinese", "language None", "<asr_text>system", "system", "System."])(
    "reading only %j writes nothing",
    async (text) => {
      const engine = await createSherpaEngine(model);
      answer = () => text;
      expect(await engine.recognizer.decode(audio(1), "meeting-4:mic", [])).toBe("");
    },
  );

  // protects=the end-of-text token with nothing after it ends the words without a run-on in the log, and with words after it, the log says the model ran on; fails_when=the log reports a run-on that didn't happen; no_claim=what the run-on wrote, which is never logged.
  test("the end-of-text token alone at the end isn't a run-on; words after it are", async () => {
    const engine = await createSherpaEngine(model);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer = () => "Yes, that's fine.<|endoftext|>";
    expect(await engine.recognizer.decode(audio(1), "meeting-5:mic", [])).toBe("Yes, that's fine.");
    expect(warned).not.toHaveBeenCalled();
    answer = () => "Yes, that's fine.<|endoftext|>Human Rights Watch is a group.";
    expect(await engine.recognizer.decode(audio(1), "meeting-5:mic", [])).toBe("Yes, that's fine.");
    expect(warned).toHaveBeenCalledWith(
      "The speech model wrote on after a stretch's words; what it wrote after them is left out.",
    );
    warned.mockRestore();
  });
});
