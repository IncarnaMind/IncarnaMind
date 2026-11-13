/**
 * The first speech-to-text engine (#136): Qwen3-ASR-0.6B, int8, with Silero
 * VAD, both through sherpa-onnx-node (Apache-2.0), on the CPU. Decoding runs
 * on sherpa's own threads (`decodeAsync`), so the process keeps taking audio
 * while a stretch is decoded. Beside it, a small streaming model reads the
 * live words as they are said (#2662, ADR-0027), on the process's own thread:
 * sherpa-onnx has no asynchronous call for it. The desktop app runs it in a
 * utility process (src/main/transcriberProcess.ts), never on the core's thread.
 */
import { gap } from "../../shared/i18n/join";
import type { TranscriptionModelFiles } from "../adapters";
import { MEETING_SAMPLE_RATE } from "../adapters";
import { engineModule, exportsOf } from "../engineModules";
import { contextWords, echoes, hotwordsOf, mayMend, toldTokens, withToldWords } from "./context";
import { type LiveReading, quietestCut, type SpeechEngine, type VoiceDetector } from "./speech";
import { onlyPromptWord, resultOf, textOfResult, untilEndOfText, wordsOnly } from "./speechText";
import {
  borrowedInto,
  shareAWord,
  spokenLanguageOf,
  unnamedLatin,
  writtenOutside,
} from "./spokenLanguage";
import { writtenNumbers } from "./spokenNumbers";

/** Silero's window at 16 kHz: it reads audio 512 samples at a time. */
const WINDOW = 512;

/**
 * Qwen3-ASR's limits, sherpa-onnx's own defaults set here so the log can say when a reading
 * reaches one: it writes at most `MAX_NEW_TOKENS`, its header "language Chinese<asr_text>"
 * (`HEADER_TOKENS`) among them, and holds its prompt (`PROMPT_TOKENS` and the words it is told),
 * the audio (`AUDIO_TOKENS_PER_SECOND`) and what it writes in `MAX_TOTAL_TOKENS`. Reaching the
 * total, it stops with no word in sherpa-onnx's own log, and the end of the stretch is lost (#1031).
 */
const MAX_NEW_TOKENS = 128;
const MAX_TOTAL_TOKENS = 512;
const HEADER_TOKENS = 3;
const PROMPT_TOKENS = 15;
const AUDIO_TOKENS_PER_SECOND = 13;
/**
 * The most speech one reading takes, so that it reaches neither: 15 s of audio is 195 tokens,
 * which leaves all 128 it may write with the prompt and the words told, and the densest speech of
 * the meeting set, about 5.7 tokens a second, writes about 86 of them in it. On that set, 15 s
 * read better than 12 s, whose extra cuts cost context (#1031).
 */
const LONGEST_READING_MS = 15_000;
/**
 * A plain reading that reaches a limit anyway is read again in two parts, cut at the quietest
 * moment between these shares of it, its middle fifth. Read as the app reads it, the meeting set
 * reached none; the one stretch of it seen to reach one was the model writing the same words over
 * and over, and its two parts read what was said (#1031).
 */
const SECOND_PART_FROM = 0.4;
const SECOND_PART_BY = 0.6;
/**
 * Qwen3-ASR guesses a reading's language from its audio, and with under about 3 s of it guesses
 * wrong: a short English "yeah" comes back as "对。", a Mandarin "那就这样" as Cantonese (#1031).
 * Such a reading is told its stream's language, as `AGREEING` of the stream's `LATEST` readings of
 * at least `LANGUAGE_FROM_MS` show it in their words and the other shows no other: from that
 * length the model's guess holds.
 */
const TOLD_LANGUAGE_UNDER_MS = 3000;
const LANGUAGE_FROM_MS = 4000;
const AGREEING = 2;
const LATEST = 3;
/**
 * What a long reading in Latin letters shows when its words name no language: nothing against
 * English, the one language named here that is written in them, and that it is no other. One
 * between two English readings is English said without the words that tell it, about one in nine
 * on the meeting set; two of the latest three are a call in another language written in those
 * letters.
 */
const UNNAMED = "";

/**
 * How long speech must go on unbroken, in seconds, before the detector counts it. sherpa-onnx
 * starts a stretch only then, a little before that point, and forgets a shorter run. At a quarter
 * second, a short first word before a pause or a stop ("对。", "可以。", "Good.") was left out of
 * its line, so this computer's stretches count from Silero's first windows of speech (#2305).
 * OpenAI's turns keep the quarter second: they start 1.2 s ahead of the detector anyway.
 */
const STRETCH_MIN_SPEECH = WINDOW / MEETING_SAMPLE_RATE;
const TURN_MIN_SPEECH = 0.25;

/** The engine id the model definitions use (./model). */
export const QWEN3_ASR = "qwen3-asr";
/** The kinds of streaming model, as the model definitions name them (./model): a transducer's files are its encoder, decoder, joiner and tokens. */
export const STREAMING_TRANSDUCER = "streaming-transducer";

/** The speech engine, its voice detector and the speaker pass (./diarization). */
export const SHERPA = engineModule(
  "sherpa-onnx-node",
  async () => exportsOf(await import("sherpa-onnx-node")),
  [
    "OfflineRecognizer.createAsync",
    "OnlineRecognizer",
    "Vad",
    "OfflineSpeakerDiarization",
    "SpeakerEmbeddingExtractor",
  ],
);

/**
 * Reads a decoded stretch's result itself when sherpa's own reader refuses it (#981). A stream's
 * options, which tell the model the words a stretch may hold (#1031), are set through it too.
 */
export const SHERPA_ADDON = engineModule(
  "sherpa-onnx-node/addon.js",
  async () => exportsOf(await import("sherpa-onnx-node/addon.js")),
  ["getOfflineStreamResultAsJson", "getOnlineStreamResultAsJson", "offlineStreamSetOption"],
);

type Sherpa = Awaited<ReturnType<typeof SHERPA.load>>;

function sileroDetector(sherpa: Sherpa, vadFile: string, minSpeech: number): VoiceDetector {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadFile,
        threshold: 0.5,
        minSpeechDuration: minSpeech,
        minSilenceDuration: 0.5,
        // Past this, sherpa-onnx only looks harder for a pause: a stretch can run on well beyond
        // it, so the speech host cuts long speech itself (`longestMs`, #1031).
        maxSpeechDuration: 20,
        windowSize: WINDOW,
      },
      sampleRate: MEETING_SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60,
  );
  let waiting = new Float32Array(0);
  return {
    accept(samples) {
      const all = new Float32Array(waiting.length + samples.length);
      all.set(waiting);
      all.set(samples, waiting.length);
      let at = 0;
      for (; at + WINDOW <= all.length; at += WINDOW)
        vad.acceptWaveform(all.subarray(at, at + WINDOW));
      waiting = all.slice(at);
    },
    speaking: () => vad.isDetected(),
    next() {
      if (vad.isEmpty()) return null;
      const segment = vad.front(false);
      vad.pop();
      return { start: segment.start, samples: segment.samples };
    },
    flush() {
      if (waiting.length > 0) {
        const padded = new Float32Array(WINDOW);
        padded.set(waiting);
        vad.acceptWaveform(padded);
        waiting = new Float32Array(0);
      }
      vad.flush();
    },
  };
}

/** Silero VAD alone, for a cloud service that needs our own turns (OpenAI's live model, #141). */
export async function createSileroDetectors(vadFile: string): Promise<() => VoiceDetector> {
  const sherpa = await SHERPA.load();
  return () => sileroDetector(sherpa, vadFile, TURN_MIN_SPEECH);
}

/**
 * The streaming model's threads. Measured on the FLEURS clips (#2662): one thread read them at
 * 0.044 of their time, two at 0.039 for nearly three times the CPU.
 */
const LIVE_THREADS = 1;

/** A model that writes English in capitals only: its words, as live text, in lower case. */
const CAPITALS_ONLY = /^[^\p{Ll}]*\p{Lu}[^\p{Ll}]*$/u;

/** Readings by the streaming model of `live`, each of one stretch of speech. */
async function liveReadings(
  live: NonNullable<TranscriptionModelFiles["live"]>,
): Promise<() => LiveReading> {
  if (live.engine !== STREAMING_TRANSDUCER)
    throw new Error(`Unknown streaming speech model "${live.engine}".`);
  const sherpa = await SHERPA.load();
  const addon = await SHERPA_ADDON.load();
  const required = (name: string) => {
    const path = live.files[name];
    if (!path) throw new Error(`The streaming model has no ${name} file.`);
    return path;
  };
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: MEETING_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: required("encoder"),
        decoder: required("decoder"),
        joiner: required("joiner"),
      },
      tokens: required("tokens"),
      numThreads: LIVE_THREADS,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    // The voice detector ends each stretch, as it does for the final text.
    enableEndpoint: 0,
  });
  return () => {
    const stream = recognizer.createStream();
    const words = () => {
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      let text: string;
      try {
        text = recognizer.getResult(stream).text;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // As for a final reading (#981): sherpa's reader refused the result's JSON.
        text = textOfResult(addon.getOnlineStreamResultAsJson(recognizer.handle, stream.handle));
      }
      return CAPITALS_ONLY.test(text) ? text.toLowerCase() : text;
    };
    return {
      hear(samples) {
        stream.acceptWaveform({ samples, sampleRate: MEETING_SAMPLE_RATE });
        return words();
      },
      end() {
        stream.inputFinished();
        return words();
      },
    };
  };
}

/** The streaming model's readings, or none if it can't load: live words are then read again as before. */
async function liveReadingsOrNone(
  live: NonNullable<TranscriptionModelFiles["live"]>,
): Promise<(() => LiveReading) | undefined> {
  try {
    return await liveReadings(live);
  } catch (error) {
    // The process has no logger of its own: its output goes to the app's log.
    console.warn(
      "The streaming speech model couldn't load; live words are read again as speech goes on.",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

/**
 * Whether a reading reached one of Qwen3-ASR's limits, its words cut short, and says so in the log:
 * counted from the `tokens` its words took and the audio it read, erring high. None of its words
 * are logged.
 */
function atLimit(
  samples: Float32Array,
  words: readonly string[],
  tokens: number,
  newTokens: number,
): boolean {
  const written = tokens + HEADER_TOKENS;
  const seconds = samples.length / MEETING_SAMPLE_RATE;
  const total =
    PROMPT_TOKENS + toldTokens(words) + Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND) + written;
  if (written < newTokens && total < MAX_TOTAL_TOKENS) return false;
  // The process has no logger of its own: its output goes to the app's log.
  console.warn(
    "A reading of the speech model reached its token limit; its words may be cut short.",
    {
      limit: written >= newTokens ? newTokens : MAX_TOTAL_TOKENS,
      seconds: Math.round(seconds * 10) / 10,
      written,
      total,
    },
  );
  return true;
}

/** `newTokens`: the most tokens one reading writes, its header among them; `MAX_NEW_TOKENS` unless given. */
export async function createSherpaEngine(
  model: TranscriptionModelFiles,
  { newTokens = MAX_NEW_TOKENS }: { newTokens?: number } = {},
): Promise<SpeechEngine> {
  if (model.engine !== QWEN3_ASR)
    throw new Error(`Unknown speech-to-text engine "${model.engine}".`);
  const sherpa = await SHERPA.load();
  const { files } = model;
  const required = (name: string) => {
    const path = files[name];
    if (!path) throw new Error(`The model has no ${name} file.`);
    return path;
  };
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: MEETING_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      qwen3Asr: {
        convFrontend: required("convFrontend"),
        encoder: required("encoder"),
        decoder: required("decoder"),
        tokenizer: required("tokenizer"),
        hotwords: "",
        maxNewTokens: newTokens,
        maxTotalLen: MAX_TOTAL_TOKENS,
      },
      tokens: "",
      numThreads: model.threads,
      provider: "cpu",
      debug: 0,
    },
  });

  const detector = () => sileroDetector(sherpa, model.vad, STRETCH_MIN_SPEECH);
  const live = model.live && (await liveReadingsOrNone(model.live));

  /**
   * What each stream's latest readings long enough to show a language showed: its name, null for
   * more than one or one with no name here, or `UNNAMED`.
   */
  const heard = new Map<string, (string | null)[]>();

  function languageOf(stream: string): string | undefined {
    const latest = heard.get(stream) ?? [];
    const named = latest.filter((each) => each !== UNNAMED);
    const [first] = named;
    if (named.length < AGREEING || !first || named.some((each) => each !== first)) return undefined;
    return first === "English" || named.length === latest.length ? first : undefined;
  }

  function learn(stream: string, text: string): void {
    if (!/\p{L}/u.test(text)) return;
    const shown = unnamedLatin(text) ? UNNAMED : spokenLanguageOf(text);
    heard.set(stream, [...(heard.get(stream) ?? []), shown].slice(-LATEST));
  }

  async function reading(
    samples: Float32Array,
    words: readonly string[],
    language?: string,
  ): Promise<{ text: string; atLimit: boolean }> {
    const stream = recognizer.createStream();
    if (words.length > 0) stream.setOption("hotwords", hotwordsOf(words));
    if (language) stream.setOption("language", language);
    stream.acceptWaveform({ samples, sampleRate: MEETING_SAMPLE_RATE });
    let result: { text: string; tokens?: unknown };
    try {
      result = await recognizer.decodeAsync(stream);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // The stretch was decoded; sherpa's reader refused its JSON (#981): read it here.
      const addon = await SHERPA_ADDON.load();
      result = resultOf(addon.getOfflineStreamResultAsJson(stream.handle));
    }
    const said = untilEndOfText(result);
    if (said.ranOn) {
      console.warn(
        "The speech model wrote on after a stretch's words; what it wrote after them is left out.",
      );
    }
    return {
      text: writtenNumbers(wordsOnly(said.text)),
      atLimit: atLimit(samples, words, said.tokens, newTokens),
    };
  }

  const read = async (samples: Float32Array, words: readonly string[], language?: string) =>
    (await reading(samples, words, language)).text;

  /**
   * The reading whose words the stretch keeps. One that reaches a limit is read again in two parts,
   * whose words are kept in its place; a part that reaches it too keeps what it wrote (#1031).
   */
  async function plainReading(samples: Float32Array, language?: string): Promise<string> {
    const whole = await reading(samples, [], language);
    if (!whole.atLimit) return whole.text;
    const cut = quietestCut(
      samples,
      Math.round(samples.length * SECOND_PART_FROM),
      Math.round(samples.length * SECOND_PART_BY),
    );
    let parts: [string, string];
    try {
      parts = [
        await read(samples.subarray(0, cut), [], language),
        await read(samples.subarray(cut), [], language),
      ];
    } catch (error) {
      console.warn(
        "The speech model couldn't read a stretch again in two parts; it keeps its first reading.",
        error instanceof Error ? error.name : typeof error,
      );
      return whole.text;
    }
    console.warn("The stretch was read again in two parts.", {
      seconds: Math.round((samples.length / MEETING_SAMPLE_RATE) * 10) / 10,
      cutAt: Math.round((cut / MEETING_SAMPLE_RATE) * 10) / 10,
    });
    const [first, second] = parts;
    return first + gap("zh-CN", first, second) + second;
  }

  return {
    detector,
    ...(live && { live }),
    longestMs: LONGEST_READING_MS,
    recognizer: {
      async decode(samples, name, given) {
        const words = contextWords(given);
        const short = samples.length < (TOLD_LANGUAGE_UNDER_MS * MEETING_SAMPLE_RATE) / 1000;
        const language = short ? languageOf(name) : undefined;
        const plain = await plainReading(samples, language);
        // A stream not yet known to be English counts as not English: a word left out is the
        // smaller harm than one written that nobody said (#1031).
        if (onlyPromptWord(plain) && languageOf(name) !== "English") return "";
        if (samples.length >= (LANGUAGE_FROM_MS * MEETING_SAMPLE_RATE) / 1000) learn(name, plain);
        const outside =
          language && writtenOutside(plain, language) && !borrowedInto(plain, language);
        if (outside || (language && onlyPromptWord(plain))) {
          // Told the call's language, it still wrote another, or wrote only "system", as it also
          // does told English for a stretch it can't read. Kept only if its own guess agrees, as
          // a word said alone (a name, a one-word answer) reads the same both ways. If that
          // second reading fails, so does the stretch: the host notes it as not transcribed,
          // rather than keeping words this check doubts.
          if (!shareAWord(plain, await read(samples, []))) {
            console.warn(
              "The speech model read a short stretch one way told its call's language and another way untold; it is left out.",
              { language },
            );
            return "";
          }
        }
        if (!mayMend(plain, words)) return plain;
        let told: string;
        try {
          told = await read(samples, words, language);
        } catch (error) {
          // The second reading only mends names: the stretch keeps the reading it has.
          console.warn(
            "The speech model couldn't read a stretch again with its words; it keeps its plain reading.",
            error instanceof Error ? error.name : typeof error,
          );
          return plain;
        }
        if (echoes(told, words)) {
          // The process has no logger of its own: its output goes to the app's log. No words in it.
          console.warn(
            "The speech model wrote the words it was told; the stretch keeps its plain reading.",
          );
        }
        return withToldWords(plain, told, words);
      },
    },
    // The recognizer and detectors are freed with the process; nothing holds them here.
    close() {},
  };
}
