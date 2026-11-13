import { describe, expect, test, vi } from "vitest";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";

/*
 * Short stretches of speech through the engine on this computer (#1031), with a stand-in for
 * sherpa-onnx whose reading depends on how long the audio is and the language it is told.
 */
type Options = Record<string, string>;
/** What the model writes for audio this many seconds long, told these options. */
let answer: (seconds: number, options: Options) => string = () => "";
/** How many tokens the model takes to write that answer. */
let tokensOf: (seconds: number) => number = () => 0;
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
          const tokens = Array.from({ length: tokensOf(seconds) }, () => "▁");
          return { lang: "", text: answer(seconds, options), tokens };
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
/** English with none of the words that name it, as about one long English reading in nine is. */
const UNNAMED = "Tabs are nice. I like tabs, Mozilla style, to be fair.";
const MIXED = "这个 feature 我们 next week 再 discuss 一下 okay";

describe("A short stretch read on this computer (#1031)", () => {
  // protects=a stretch under 3 s is told its stream's language once two of the stream's latest readings of 4 s or more are in it, so a short "yeah" in an English call isn't written "对。"; only that stream's, as the microphone and the call can be in different languages; fails_when=a short reading is told before its stream's language is clear, on another stream, or at 3 s and over; no_claim=the real model's answers, which eval/meetings and the short-phrase runs measure.
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

  // protects=a stream whose latest long readings are in different languages, or in none the words name (a mixed call), tells its short readings nothing; fails_when=a mixed Chinese and English call's short English replies are told Chinese and translated; no_claim=calls that change language for good, which the latest three readings follow.
  test("is told nothing while its stream's long readings disagree", async () => {
    const engine = await createSherpaEngine(model);
    let long = [ENGLISH, CHINESE];
    answer = (seconds, options) =>
      seconds >= 4 ? (long.shift() ?? "") : (options.language ?? "untold");
    const read = (seconds: number) => engine.recognizer.decode(audio(seconds), "meeting-2:mic", []);

    await read(5);
    await read(5);
    expect(await read(1)).toBe("untold");
    long = [MIXED, MIXED];
    await read(5);
    await read(5);
    expect(await read(1)).toBe("untold");
  });

  /** A stream whose long readings come back as given, and whose short ones name the language they were told, in its script. */
  async function streamOf(name: string) {
    const engine = await createSherpaEngine(model);
    const told: Options = { English: "English", Chinese: "中文" };
    let long: string[] = [];
    answer = (seconds, options) =>
      seconds >= 4 ? (long.shift() ?? "") : (told[options.language ?? ""] ?? "untold");
    const read = (seconds: number) => engine.recognizer.decode(audio(seconds), name, []);
    return {
      short: () => read(1),
      async hear(...readings: string[]) {
        long = [...readings];
        for (const _ of readings) await read(5);
      },
    };
  }

  // protects=one long reading in Latin letters whose words name no language leaves its stream told English, between two English readings or after them, as English is often said without the words that tell it; two of the latest three stop it, as that is what a German or Dutch call's readings look like; fails_when=an English call's short replies go untold after every such reading, or a call in another language written in Latin letters stays told English after two sentences with English phrases in them; no_claim=how often each happens, which the replay of the meeting set's lines counts.
  test("stays told English through one Latin reading that names no language, not through two", async () => {
    const stream = await streamOf("meeting-8:mic");

    await stream.hear(ENGLISH, UNNAMED);
    expect(await stream.short()).toBe("untold");
    await stream.hear(ENGLISH);
    expect(await stream.short()).toBe("English");
    await stream.hear(ENGLISH, UNNAMED);
    expect(await stream.short()).toBe("English");
    await stream.hear(UNNAMED);
    expect(await stream.short()).toBe("untold");
    await stream.hear(ENGLISH, ENGLISH);
    expect(await stream.short()).toBe("English");
  });

  // protects=a long reading that mixes scripts between two English ones stops its stream being told English, and keeps it stopped while it is among the latest three; and a reading in Latin letters, naming a language or not, stops a stream being told Chinese, so a mixed call's short English replies aren't told Chinese and translated ("So it's the distance." came back "所以是，是，是，是。"); fails_when=a reading half in Chinese is passed over like one that names no language, or Latin letters that name none pass for Chinese as they do for English; no_claim=a call whose every long reading is mostly Chinese with English terms in it, which is told Chinese.
  test("is not told a language across a reading that mixes scripts or is in another", async () => {
    const stream = await streamOf("meeting-9:mic");

    await stream.hear(ENGLISH, ENGLISH);
    expect(await stream.short()).toBe("English");
    await stream.hear(MIXED, ENGLISH);
    expect(await stream.short()).toBe("untold");
    await stream.hear(ENGLISH);
    expect(await stream.short()).toBe("untold");
    await stream.hear(ENGLISH);
    expect(await stream.short()).toBe("English");

    await stream.hear(CHINESE, CHINESE, CHINESE);
    expect(await stream.short()).toBe("中文");
    await stream.hear(UNNAMED, CHINESE);
    expect(await stream.short()).toBe("untold");
    await stream.hear(CHINESE, CHINESE);
    expect(await stream.short()).toBe("中文");
  });

  // protects=a short reading told the call's language that still comes back in another script is kept when Chinese speech says such words on their own ("OK", "email", an abbreviation said letter by letter) or the model's own reading writes the same ("Okay" for "OK", a Chinese name in an English call), and left out otherwise ("是的" told Chinese as "shit。", read alone as "system"), with none of its words in the log; the same check holds a lone "system" written told English, which the model writes there for "um", "sorry" or "okay" and which stays only when it reads "system" untold too; fails_when=real code-switching is dropped, a word the model makes up in another script reaches the Transcript, or "system" stands in an English call where nobody said it; no_claim=how often each happens, which the short-phrase runs count.
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
    ["English", ENGLISH, "System.", "system", "System."],
    ["English", ENGLISH, "system", "Um.", ""],
    ["English", ENGLISH, "System.", "嗯。", ""],
    ["English", ENGLISH, "system", "", ""],
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

  // protects=when the second reading that checks a doubted short reading fails, the stretch fails with it, so the host notes it as not transcribed and the doubted words aren't written; fails_when=a failed check keeps "shit。" in a Mandarin call's Transcript, or the failure is hidden; no_claim=what the host does with a stretch that failed, which tests/core/captureHealth.test.ts covers.
  test("a doubted short reading whose check fails is a failed stretch, not the doubted words", async () => {
    const engine = await createSherpaEngine(model);
    answer = (seconds, options) => {
      if (seconds >= 4) return CHINESE;
      if (options.language) return "shit。";
      throw new Error("The model stopped.");
    };
    const read = (seconds: number) => engine.recognizer.decode(audio(seconds), "meeting-7:mic", []);
    await read(5);
    await read(5);

    await expect(read(1)).rejects.toThrow("The model stopped.");
  });

  // protects=the most readings one stretch costs, every one at the token limit: its plain reading and the two parts it is read again in, the untold reading that checks a doubted short one, and the reading told its words, five; the check and the told reading are read whole, and the parts once; fails_when=the check or the told reading is read in parts too, or a part is read in parts; no_claim=how often a stretch reaches the limit, which no reading of the meeting set did read as the app reads it (#1031).
  test("costs at most five readings when every one reaches the token limit", async () => {
    // At 6 tokens, a reading of 3 words reaches the limit, the header taking 3.
    const engine = await createSherpaEngine(model, { newTokens: 6 });
    // Told Chinese, the short stretch reads in Latin letters, so an untold reading checks it.
    answer = (seconds, options) => {
      if (seconds >= 4) return CHINESE;
      if (options.hotwords) return "Priya Raman, hello.";
      if (seconds >= 2 || !options.language) return "Priyaman, hello.";
      return seconds >= 1 ? "Priyaman," : "hello.";
    };
    tokensOf = (seconds) => (seconds < 4 ? 3 : 0);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = (seconds: number, words: string[] = []) =>
      engine.recognizer.decode(audio(seconds), "meeting-9:mic", words);
    await read(5);
    await read(5);
    READINGS.length = 0;

    expect(await read(2, ["Priya Raman"])).toBe("Priya Raman, hello.");
    expect(READINGS.map((options) => Object.keys(options).sort().join("+"))).toEqual([
      "language",
      "language",
      "language",
      "",
      "hotwords+language",
    ]);
    warned.mockRestore();
    tokensOf = () => 0;
  });

  // protects=a stretch whose two parts can't be read keeps its first reading, cut short as it is, and the log says why with none of its words; fails_when=the stretch is lost for a part that failed, or the failure is hidden; no_claim=why the model failed.
  test("keeps its first reading when its two parts can't be read", async () => {
    const engine = await createSherpaEngine(model, { newTokens: 6 });
    answer = (seconds) => {
      if (seconds < 5) throw new Error("The model stopped.");
      return "Secret words, cut short";
    };
    tokensOf = () => 3;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await engine.recognizer.decode(audio(5), "meeting-10:mic", [])).toBe(
      "Secret words, cut short",
    );
    expect(warned.mock.calls.map(([message]) => message)).toEqual([
      "A reading of the speech model reached its token limit; its words may be cut short.",
      "The speech model couldn't read a stretch again in two parts; it keeps its first reading.",
    ]);
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/Secret/);
    warned.mockRestore();
    tokensOf = () => 0;
  });

  // protects=a reading that is only the model's header ("language Chinese", "language None", "<asr_text>") is no line in any stream, an English one included, as it is what the model writes for a short or quiet stretch instead of words; fails_when="language Chinese" shows as something said in the Transcript; no_claim=a header in the middle of words, which tests/core/speechText.test.ts covers.
  test.each(["language Chinese", "language None", "<asr_text>", "<asr_text>。"])(
    "reading only %j writes nothing, whatever the stream's language",
    async (text) => {
      const engine = await createSherpaEngine(model);
      answer = (seconds) => (seconds >= 4 ? ENGLISH : text);
      const read = (seconds: number, stream: string) =>
        engine.recognizer.decode(audio(seconds), stream, []);

      expect(await read(1, "meeting-4:mic")).toBe("");
      await read(5, "meeting-4:system");
      await read(5, "meeting-4:system");
      expect(await read(1, "meeting-4:system")).toBe("");
    },
  );

  // protects=a reading that is only "system", the word the model takes from its own prompt for a short stretch it misread ("是的"), is no line in a Chinese stream or one whose language isn't known yet, and is kept in an English stream when the model reads it so told English and untold, as the one-word answer someone gave; fails_when="system" shows in a Mandarin call's Transcript, or a real "System." is lost from an English call; no_claim=a told "system" the untold reading doesn't repeat, which the test above leaves out.
  test.each([
    ["system", "system"],
    ["System.", "System."],
    ["<asr_text>system", "system"],
  ])(
    "reading only %j is kept in an English stream, and left out of a Chinese or unknown one",
    async (text, kept) => {
      const engine = await createSherpaEngine(model);
      const long: Record<string, string> = {
        "meeting-6:english": ENGLISH,
        "meeting-6:chinese": CHINESE,
      };
      let stream = "";
      answer = (seconds) => (seconds >= 4 ? (long[stream] ?? "") : text);
      const read = (seconds: number, name: string) => {
        stream = name;
        return engine.recognizer.decode(audio(seconds), name, []);
      };

      expect(await read(1, "meeting-6:english")).toBe("");
      for (const name of Object.keys(long)) {
        await read(5, name);
        await read(5, name);
      }
      expect(await read(1, "meeting-6:english")).toBe(kept);
      expect(await read(3.5, "meeting-6:english")).toBe(kept);
      expect(await read(1, "meeting-6:chinese")).toBe("");
      expect(await read(1, "meeting-6:unknown")).toBe("");
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
