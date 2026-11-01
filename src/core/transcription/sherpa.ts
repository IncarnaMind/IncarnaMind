/**
 * The first speech-to-text engine (#136): Qwen3-ASR-0.6B, int8, with Silero
 * VAD, both through sherpa-onnx-node (Apache-2.0), on the CPU. Decoding runs
 * on sherpa's own threads (`decodeAsync`), so the process keeps taking audio
 * while a stretch is decoded. The desktop app runs it in a utility process
 * (src/main/transcriberProcess.ts), never on the core's thread.
 */
import type { TranscriptionModelFiles } from "../adapters";
import { MEETING_SAMPLE_RATE } from "../adapters";
import { engineModule, exportsOf } from "../engineModules";
import { contextWords, echoes, hotwordsOf, withToldWords } from "./context";
import type { SpeechEngine, VoiceDetector } from "./speech";
import { textOfResult, wordsOnly } from "./speechText";
import { writtenNumbers } from "./spokenNumbers";

/** Silero's window at 16 kHz: it reads audio 512 samples at a time. */
const WINDOW = 512;

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

/** The speech engine, its voice detector and the speaker pass (./diarization). */
export const SHERPA = engineModule(
  "sherpa-onnx-node",
  async () => exportsOf(await import("sherpa-onnx-node")),
  [
    "OfflineRecognizer.createAsync",
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
  ["getOfflineStreamResultAsJson", "offlineStreamSetOption"],
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
        // Long speech is cut, so its final text never waits long.
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

export async function createSherpaEngine(model: TranscriptionModelFiles): Promise<SpeechEngine> {
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
      },
      tokens: "",
      numThreads: model.threads,
      provider: "cpu",
      debug: 0,
    },
  });

  const detector = () => sileroDetector(sherpa, model.vad, STRETCH_MIN_SPEECH);

  async function read(samples: Float32Array, words: readonly string[]): Promise<string> {
    const stream = recognizer.createStream();
    if (words.length > 0) stream.setOption("hotwords", hotwordsOf(words));
    stream.acceptWaveform({ samples, sampleRate: MEETING_SAMPLE_RATE });
    try {
      return writtenNumbers(wordsOnly((await recognizer.decodeAsync(stream)).text));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // The stretch was decoded; sherpa's reader refused its JSON (#981): read it here.
      const addon = await SHERPA_ADDON.load();
      return writtenNumbers(
        wordsOnly(textOfResult(addon.getOfflineStreamResultAsJson(stream.handle))),
      );
    }
  }

  return {
    detector,
    recognizer: {
      async decode(samples, _stream, given) {
        const words = contextWords(given);
        const plain = await read(samples, []);
        if (words.length === 0) return plain;
        let told: string;
        try {
          told = await read(samples, words);
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
