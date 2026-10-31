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
import { contextWords, echoes, hotwordsOf } from "./context";
import type { SpeechEngine, VoiceDetector } from "./speech";
import { textOfResult, wordsOnly } from "./speechText";
import { writtenNumbers } from "./spokenNumbers";

/** Silero's window at 16 kHz: it reads audio 512 samples at a time. */
const WINDOW = 512;

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

function sileroDetector(sherpa: Sherpa, vadFile: string): VoiceDetector {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadFile,
        threshold: 0.5,
        minSpeechDuration: 0.25,
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
  return () => sileroDetector(sherpa, vadFile);
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

  const detector = () => sileroDetector(sherpa, model.vad);

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
        const text = await read(samples, words);
        // It wrote out the list it was told rather than the speech: the stretch is read without it.
        return words.length > 0 && echoes(text, words) ? read(samples, []) : text;
      },
    },
    // The recognizer and detectors are freed with the process; nothing holds them here.
    close() {},
  };
}
