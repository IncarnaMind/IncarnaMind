import { afterEach, describe, expect, test, vi } from "vitest";
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
    const chineseTurn = "今天下午三点我们开会讨论。";
    answer = (seconds, options) =>
      seconds >= 4
        ? ENGLISH
        : options.language === "English"
          ? "Yeah."
          : seconds >= 3
            ? chineseTurn
            : "对。";
    const read = (seconds: number, stream = "meeting-1:system") =>
      engine.recognizer.decode(audio(seconds), stream, []);

    expect(await read(1)).toBe("对。");
    await read(5);
    expect(await read(1)).toBe("对。");
    await read(6);
    READINGS.length = 0;
    expect(await read(1)).toBe("Yeah.");
    expect(await read(2.9)).toBe("Yeah.");
    expect(await read(3)).toBe(chineseTurn);
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

  // protects=the most readings one stretch costs, every one at the token limit: its plain reading, then each of the two parts it is read again in with the untold reading that checks it, as a short stretch is checked, then the reading told its words, six; the whole's own check isn't read, its words being replaced, and the told reading is read whole; fails_when=a part goes unchecked, the whole is checked too, the told reading is read in parts, or a part is read in parts; no_claim=how often a stretch reaches the limit, which no reading of the meeting set did read as the app reads it (#1031).
  test("costs at most six readings when every one reaches the token limit", async () => {
    // At 6 tokens, a reading of 3 words reaches the limit, the header taking 3.
    const engine = await createSherpaEngine(model, { newTokens: 6 });
    // Told Chinese, the short stretch and its parts read in Latin letters, so untold readings check them.
    answer = (seconds, options) => {
      if (seconds >= 4) return CHINESE;
      if (options.hotwords) return "Priya Raman, Lumen Foods.";
      if (seconds >= 2 || !options.language) return "Priyaman, Lumen Foods.";
      return seconds >= 1 ? "Priyaman," : "Lumen Foods.";
    };
    tokensOf = (seconds) => (seconds < 4 ? 3 : 0);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = (seconds: number, words: string[] = []) =>
      engine.recognizer.decode(audio(seconds), "meeting-9:mic", words);
    await read(5);
    await read(5);
    READINGS.length = 0;

    expect(await read(2, ["Priya Raman"])).toBe("Priya Raman, Lumen Foods.");
    expect(READINGS.map((options) => Object.keys(options).sort().join("+"))).toEqual([
      "language",
      "language",
      "",
      "language",
      "",
      "hotwords+language",
    ]);
    warned.mockRestore();
    tokensOf = () => 0;
  });

  describe("A stretch read again in two parts reads each as a stretch of its length is read (#1031)", () => {
    /** What one reading writes, told its stream's language and untold. */
    type Said = { told: string; untold: string };
    const either = (text: string): Said => ({ told: text, untold: text });
    /**
     * A stream whose language two long readings of `long` tell, none when null, and an engine at a
     * 6-token limit that a 5 s stretch reaches: its parts (2.95 s and 2.05 s, cut at the end of the
     * silent middle fifth) write `first` and `second`, and a 1 s stretch after it `after`.
     */
    async function stretchAtLimit(long: string | null, first: Said, second: Said, after: Said) {
      const engine = await createSherpaEngine(model, { newTokens: 6 });
      answer = (seconds, options) => {
        if (seconds >= 6) return long ?? "";
        if (seconds >= 5) return "是。嗯，是。";
        const said = seconds > 2.5 ? first : seconds > 1.5 ? second : after;
        return options.language ? said.told : said.untold;
      };
      tokensOf = (seconds) => (seconds === 5 ? 3 : 0);
      const read = (seconds: number) =>
        engine.recognizer.decode(audio(seconds), "meeting-11:mic", []);
      if (long !== null) {
        await read(6);
        await read(6);
      }
      return read;
    }

    // protects=a part that is only the model's prompt word goes by the rule a stretch that reads only that word goes by: no words on a stream not known to be English, the other part's words staying; on an English stream, where "system" can be someone's answer, kept when its untold reading reads it too; fails_when="system" stands beside the other part's words on a stream not known to be English, or an English answer "system" is lost; no_claim=an English "system" its untold reading doesn't repeat, which the doubted-part row leaves out.
    test.each([
      ["en", "a new", null, either("system"), either("Yeah, okay."), "Yeah, okay."],
      ["en", "an English", ENGLISH, either("system"), either("Yeah, okay."), "system Yeah, okay."],
      ["zh-CN", "a new", null, either("好的。"), either("System."), "好的。"],
      ["zh-CN", "a Chinese", CHINESE, either("system"), either("好的。"), "好的。"],
    ])(
      "%s, on %s stream: a part that is only the prompt word goes by the rule a stretch of it does",
      async (_language, _stream, long, first, second, line) => {
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        const read = await stretchAtLimit(long, first, second, either(""));
        expect(await read(5)).toBe(line);
        warned.mockRestore();
      },
    );

    // protects=a short part told its stream's language that its untold reading doubts is left out as a short stretch is, the other part's words staying, with none of its words in the log; fails_when=the doubted part's words stand in the line, or the whole line goes with it; no_claim=parts that aren't short, which aren't told a language.
    test.each([
      ["en", ENGLISH, { told: "system", untold: "Um." }, either("Yeah, okay."), "Yeah, okay."],
      ["zh-CN", CHINESE, { told: "shit。", untold: "system" }, either("好的。"), "好的。"],
    ])(
      "%s: a part its check doubts is left out, the other part kept",
      async (_language, long, first, second, line) => {
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        const read = await stretchAtLimit(long, first, second, either(""));
        expect(await read(5)).toBe(line);
        expect(warned.mock.calls.map(([message]) => message)).toContain(
          "The speech model read a short stretch one way told its call's language and another way untold; it is left out.",
        );
        expect(JSON.stringify(warned.mock.calls)).not.toMatch(/shit|system|Um\./);
        warned.mockRestore();
      },
    );

    // protects=short parts on a stream whose language is known are told it, as a short stretch is, and the stream knows its language after: parts under 4 s and the reading at the limit aren't learned from, so the next short stretch is told it too; fails_when=the parts are read untold ("对。" for an English "Yeah.") and the line is learned from, so the stream's next short stretches go untold; no_claim=parts of 4 s or more, which are learned from as a stretch of their length is.
    test.each([
      ["en", ENGLISH, { told: "Yeah.", untold: "对。" }, "Yeah. Yeah.", "Yeah."],
      ["zh-CN", CHINESE, { told: "对。", untold: "Yeah." }, "对。对。", "对。"],
    ])(
      "%s: short parts are told the stream's language, and the stream still knows it after",
      async (_language, long, said, line, next) => {
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        const read = await stretchAtLimit(long, said, said, said);
        READINGS.length = 0;

        expect(await read(5)).toBe(line);
        expect(READINGS.map((options) => options.language ?? "untold")).toEqual([
          "untold",
          long === ENGLISH ? "English" : "Chinese",
          long === ENGLISH ? "English" : "Chinese",
        ]);
        expect(await read(1)).toBe(next);
        warned.mockRestore();
      },
    );

    // protects=what a stretch read in parts teaches its stream: each part of 4 s or more, as a stretch of its length does, never the reading at the limit, which can be the model writing the same words over and over in another language; fails_when=the reading at the limit is learned from, so a call's short stretches go untold after it; no_claim=parts under 4 s, which teach nothing.
    test.each([
      ["en", ENGLISH, "是。嗯，是。嗯，是。嗯，是。", "Yeah.", "对。"],
      ["zh-CN", CHINESE, "Yeah. Yeah. Yeah. Yeah.", "对。", "Yeah."],
    ])(
      "%s: parts of 4 s or more are learned from, the reading at the limit never",
      async (_language, long, loop, told, untold) => {
        const engine = await createSherpaEngine(model, { newTokens: 6 });
        // 10 s at the limit, its parts 5.95 s and 4.05 s; the stream told by readings of 8 s.
        answer = (seconds, options) => {
          if (seconds >= 10) return loop;
          if (seconds >= 4) return long;
          return options.language ? told : untold;
        };
        tokensOf = (seconds) => (seconds === 10 ? 3 : 0);
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        const read = (seconds: number) =>
          engine.recognizer.decode(audio(seconds), `meeting-learn-${_language}:mic`, []);
        await read(8);
        await read(8);

        expect(await read(10)).toBe(`${long}${long === ENGLISH ? " " : ""}${long}`);
        expect(await read(1)).toBe(told);
        warned.mockRestore();
      },
    );

    // protects=when a part can't be read, the stretch keeps its first reading and the stream is taught by that reading alone, not also by a part read before the failure; fails_when=an abandoned part's language stays among the stream's latest readings, so its next short stretch goes untold; no_claim=why the model failed.
    test.each([
      ["en", ENGLISH, CHINESE, "Yeah.", "对。"],
      ["zh-CN", CHINESE, ENGLISH, "对。", "Yeah."],
    ])(
      "%s: a part that can't be read leaves the stream knowing what its first reading taught",
      async (_language, long, other, told, untold) => {
        const engine = await createSherpaEngine(model, { newTokens: 6 });
        // 10 s at the limit, read in the stream's language; its parts 5.95 s, read in the other, and 4.05 s, which fails.
        answer = (seconds, options) => {
          if (seconds >= 8) return long;
          if (seconds >= 5) return other;
          if (seconds >= 4) throw new Error("The model stopped.");
          return options.language ? told : untold;
        };
        tokensOf = (seconds) => (seconds === 10 ? 3 : 0);
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        const read = (seconds: number) =>
          engine.recognizer.decode(audio(seconds), `meeting-failed-${_language}:mic`, []);
        await read(8);

        expect(await read(10)).toBe(long);
        expect(await read(1)).toBe(told);
        warned.mockRestore();
      },
    );

    afterEach(() => {
      tokensOf = () => 0;
    });
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

  // protects=a long stretch (>= 3 s) on a stream whose language is known that collapses into a sparse reading in another script (such as "提纲" for 14 s of English, or "system" for 5 s of Chinese) is read again told the stream's language and keeps the recovered speech without logging words; genuine speech in another script or mixed-script speech (Chinese with English terms, English with Chinese names, or a slow foreign name whose forced retry only transliterates) is never replaced; fails_when=a collapsed long stretch stays "提纲" or poisons the stream's language, or real code-switching is translated into the stream's language; no_claim=the real model's output, which the 8-meeting run and synthetic code-switching calls verify.
  test("recovers a long stretch that collapsed into another script without touching real code-switching (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    // English stream: 14 s collapse to "提纲" recovers and keeps the stream known as English.
    const recoveredEn = "Yeah, like maybe tie that in with dialogue acts or something as well.";
    answer = (seconds, options) => {
      if (seconds >= 10) return options.language === "English" ? recoveredEn : "提纲";
      if (seconds >= 4) return ENGLISH;
      return options.language === "English" ? "Yeah." : "对。";
    };
    await engine.recognizer.decode(audio(5), "collapse:en", []);
    await engine.recognizer.decode(audio(5), "collapse:en", []);
    READINGS.length = 0;

    expect(await engine.recognizer.decode(audio(14), "collapse:en", [])).toBe(recoveredEn);
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "English"]);
    expect(await engine.recognizer.decode(audio(1), "collapse:en", [])).toBe("Yeah.");
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/提纲|dialogue/);

    // English stream: mixed English with Chinese names, full Chinese sentence, and a slow Chinese
    // name whose forced retry only transliterates are never replaced.
    const mixedEnZh = "I talked to 林明远 and 陈嘉宁 about the warehouse lease.";
    const fullZh = "林明远，陈嘉宁，周志远，顾清河。";
    answer = (seconds, options) => {
      if (seconds === 6) return mixedEnZh;
      if (seconds === 4.5) return options.language ? "Lin Mingyuan, Chen Jianing." : fullZh;
      if (seconds === 3.2) return options.language ? "Lin Mingyuan" : "林明远";
      return ENGLISH;
    };
    // Slow 3.2 s Chinese name triggers one check, sees only 2 transliterated words (< 2x 3), keeps Han.
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(3.2), "collapse:en", [])).toBe("林明远");
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "English"]);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(6), "collapse:en", [])).toBe(mixedEnZh);
    expect(READINGS).toEqual([{}]);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(4.5), "collapse:en", [])).toBe(fullZh);
    expect(READINGS).toEqual([{}]);

    // Chinese stream: 5 s collapse to "system" recovers real Chinese; mixed Chinese with English
    // terms and a real 4 s English sentence are never re-read.
    const recoveredZh = "对，就是说，咱们最主要的是先把方案定下来。";
    const mixedZhEn = "我们下周三和 Acme 讨论第三季度的 API deadline。";
    const fullEn = "We need to finalize the deployment schedule before Friday afternoon.";
    answer = (seconds, options) => {
      if (seconds === 5.5) return options.language === "Chinese" ? recoveredZh : "system";
      if (seconds === 6.5) return mixedZhEn;
      if (seconds === 4.2) return options.language ? "我们需要在周五下午之前完成。" : fullEn;
      return CHINESE;
    };
    await engine.recognizer.decode(audio(5), "collapse:zh", []);
    await engine.recognizer.decode(audio(5), "collapse:zh", []);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(5.5), "collapse:zh", [])).toBe(recoveredZh);
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "Chinese"]);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(6.5), "collapse:zh", [])).toBe(mixedZhEn);
    expect(READINGS).toEqual([{}]);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(4.2), "collapse:zh", [])).toBe(fullEn);
    expect(READINGS).toEqual([{}]);

    // A failed retry keeps the first reading and logs no spoken words.
    answer = (seconds, options) => {
      if (seconds === 9) {
        if (options.language) throw new Error("The model stopped.");
        return "提纲";
      }
      return ENGLISH;
    };
    await engine.recognizer.decode(audio(5), "collapse:fail", []);
    await engine.recognizer.decode(audio(5), "collapse:fail", []);
    expect(await engine.recognizer.decode(audio(9), "collapse:fail", [])).toBe("提纲");
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/提纲/);
    warned.mockRestore();
  });

  // protects=a long stretch (>= 3 s) that collapses within its own script ("提纲：", "提出修改意见") or into an invalid UTF-8 replacement character ("\uFFFD") is recovered by retrying in the stream's language (or splitting in two when "\uFFFD" occurs before the stream's language is known), while slow genuine speech and empty stretches stay untouched; fails_when=a Chinese prompt-mode collapse or "\uFFFD" stays in the Transcript, slow real speech is replaced, or spoken words leak into the log; no_claim=the real model's output, which eval/meetings verifies.
  test("recovers same-script and replacement-character collapses on long stretches without touching slow speech (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const recoveredOutline = "招聘条件的话，有亲和力，有良好的应变能力，交谈能力，做事认真细心。";
    const recoveredProbation = "试用期也给他们定一个基本工资吧，试用期就嗯两个月吧。";
    const recoveredBroken = "我们给他们一个机会嘛，他们要是想来我们这里的话。";
    answer = (seconds, options) => {
      if (seconds === 8.4) return options.language === "Chinese" ? recoveredOutline : "提纲：";
      if (seconds === 6.7)
        return options.language === "Chinese" ? recoveredProbation : "提出修改意见";
      if (seconds === 12) return options.language === "Chinese" ? recoveredBroken : "\uFFFD";
      if (seconds === 5.2) return "";
      return CHINESE;
    };
    await engine.recognizer.decode(audio(5), "collapse:zh-same", []);
    await engine.recognizer.decode(audio(5), "collapse:zh-same", []);

    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(8.4), "collapse:zh-same", [])).toBe(
      recoveredOutline,
    );
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "Chinese"]);

    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(6.7), "collapse:zh-same", [])).toBe(
      recoveredProbation,
    );
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "Chinese"]);

    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(12), "collapse:zh-same", [])).toBe(recoveredBroken);
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "Chinese"]);

    // Empty stretches are not retried.
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(5.2), "collapse:zh-same", [])).toBe("");
    expect(READINGS).toEqual([{}]);

    // Before the stream's language is known, a long pure replacement-character collapse splits in two,
    // while a short stretch does not.
    answer = (seconds) => {
      if (seconds === 12 || seconds === 1) return "\uFFFD";
      return seconds > 6 ? "讨论会啊，咱们这次讨论会呢。" : "首先呢，咱们讲一下这个需求点。";
    };
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(12), "collapse:zh-first", [])).toBe(
      "讨论会啊，咱们这次讨论会呢。首先呢，咱们讲一下这个需求点。",
    );
    expect(READINGS).toHaveLength(3);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(1), "collapse:zh-first", [])).toBe("\uFFFD");
    expect(READINGS).toHaveLength(1);

    // Slow genuine speech stays untouched when the forced reading does not recover >= 2x units.
    answer = (seconds) => (seconds === 4.3 ? "Young office people." : ENGLISH);
    await engine.recognizer.decode(audio(5), "collapse:en-slow", []);
    await engine.recognizer.decode(audio(5), "collapse:en-slow", []);
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(4.3), "collapse:en-slow", [])).toBe(
      "Young office people.",
    );
    expect(READINGS.map((o) => o.language)).toEqual([undefined, "English"]);

    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/提纲|修改意见|试用期|招聘条件|Young/);
    warned.mockRestore();
  });

  // protects=when Qwen3-ASR collapses into a repetition loop and sherpa-onnx truncates it before the 128-token limit, leaving a long verbatim repeated phrase at the tail, the stretch is read again in two parts (at most once) without logging spoken words, while short natural emphasis is never split; fails_when=a truncated repetition loop stays duplicated and cuts off the rest of the stretch, a part splits recursively, or natural speech splits; no_claim=how sherpa-onnx chooses its truncation threshold.
  test("reads a stretch again in two parts when its reading ends in a verbatim repetition loop below the token limit (#1031)", async () => {
    const engine = await createSherpaEngine(model);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const zhLoop =
      "呃，主要是咱们电脑啊，就是那个纸箱，咱们得找个人去买，买一下，从明码标价。这个打包特别重要，就是那个纸箱，咱们得找个人去买，买一下，从明码标价。这个打包特别重要。";
    answer = (seconds) => {
      if (seconds === 12) return zhLoop;
      return seconds > 6
        ? "呃，主要是咱们电脑啊，这个打包特别重要。"
        : "那个纸箱，咱们得找个人去买，买一下。这不用，搬家公司应该都有。";
    };
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(12), "loop:zh", [])).toBe(
      "呃，主要是咱们电脑啊，这个打包特别重要。那个纸箱，咱们得找个人去买，买一下。这不用，搬家公司应该都有。",
    );
    expect(READINGS).toHaveLength(3);

    const enLoop =
      "We should check the shipping schedule before Friday afternoon and confirm with the team we should check the shipping schedule before Friday afternoon and confirm with the team.";
    answer = (seconds) => {
      if (seconds === 12) return enLoop;
      return seconds > 6
        ? "We should check the shipping schedule before Friday afternoon."
        : "And confirm with the team before the deadline.";
    };
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(12), "loop:en", [])).toBe(
      "We should check the shipping schedule before Friday afternoon. And confirm with the team before the deadline.",
    );
    expect(READINGS).toHaveLength(3);

    // One level only: if a part repeats too, it is not split again.
    answer = () => zhLoop;
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(12), "loop:once", [])).toBe(`${zhLoop}${zhLoop}`);
    expect(READINGS).toHaveLength(3);

    // Short natural emphasis is never treated as a repetition loop.
    const natural = "I think we should go. I think we should go.";
    answer = () => natural;
    READINGS.length = 0;
    expect(await engine.recognizer.decode(audio(6), "loop:natural", [])).toBe(natural);
    expect(READINGS).toHaveLength(1);

    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/纸箱|明码标价|shipping/);
    warned.mockRestore();
  });
});
