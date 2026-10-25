/**
 * The speech-to-text models a Meeting is transcribed with on this computer
 * (#136), downloaded on first use into the data folder and checked against
 * their recorded sizes and SHA-256, as the embedding model is (../embedding/
 * download). Nothing about the User is sent: plain GET requests for the
 * files, to huggingface.co.
 *
 * Which model: the best one this computer has the memory for, and that kept
 * up the last time it ran here (the speed probe: how long decoding took for
 * the audio it decoded, measured as a Meeting is transcribed). Qwen3-ASR-0.6B
 * int8 is the only one yet; #137 adds Whisper's sizes beside it.
 */
import { availableParallelism, freemem, totalmem } from "node:os";
import { join } from "node:path";
import type { EmbeddingModelSource, Transcriber, TranscriptionModelFiles } from "../adapters";
import type { EmbeddingModelError, EmbeddingModelStatus } from "../api";
import { downloadModel, isModelDownloaded, ModelDownloadError } from "../embedding/download";
import type { ModelSources } from "../embedding/modelSources";
import { QWEN3_ASR } from "./sherpa";

export interface TranscriptionModelDefinition {
  /** Stable: the speed probe is kept by it. */
  id: string;
  /** What the User sees. */
  name: string;
  engine: string;
  /** The model's folder under `models/` in the data folder. */
  folder: string;
  /** The engine's files by what they are, relative to the model's folder. */
  files: Readonly<Record<string, string>>;
  source: EmbeddingModelSource;
  /** About the memory it takes while it runs. */
  memoryBytes: number;
}

/** Pinned revisions, so the files never change under their recorded sizes and hashes. */
const QWEN3_ASR_REVISION = "68818b2313fe77bd06f6a7c5068ff3ef59d02b8a";
const VAD_REVISION = "fba88cd2e921609e7675c3aaf51e0b9b295da4bc";

/** Qwen3-ASR-0.6B (Apache-2.0), int8, as sherpa-onnx's authors exported it (2026-03-25). */
export const QWEN3_ASR_0_6B: TranscriptionModelDefinition = {
  id: "qwen3-asr-0.6b-int8",
  name: "Qwen3-ASR 0.6B",
  engine: QWEN3_ASR,
  folder: "qwen3-asr-0.6b-int8",
  files: {
    convFrontend: "conv_frontend.onnx",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    tokenizer: "tokenizer",
  },
  source: {
    baseUrl: `https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/${QWEN3_ASR_REVISION}/`,
    files: [
      {
        path: "conv_frontend.onnx",
        size: 44_148_281,
        sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
      },
      {
        path: "encoder.int8.onnx",
        size: 182_491_662,
        sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
      },
      {
        path: "decoder.int8.onnx",
        size: 755_914_231,
        sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
      },
      {
        path: "tokenizer/merges.txt",
        size: 1_671_853,
        sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
      },
      {
        path: "tokenizer/tokenizer_config.json",
        size: 12_487,
        sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
      },
      {
        path: "tokenizer/vocab.json",
        size: 2_776_833,
        sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
      },
    ],
  },
  // Measured: about 1.1 GB once loaded, 1.7 GB while decoding.
  memoryBytes: 2_000_000_000,
};

/** The models, best first. */
export const TRANSCRIPTION_MODELS: readonly TranscriptionModelDefinition[] = [QWEN3_ASR_0_6B];

/** Silero VAD v5 (MIT), which finds where speech starts and ends. */
export const SILERO_VAD = {
  folder: "silero-vad-v5",
  file: "silero_vad_v5.onnx",
  source: {
    baseUrl: `https://huggingface.co/csukuangfj/vad/resolve/${VAD_REVISION}/`,
    files: [
      {
        path: "silero_vad_v5.onnx",
        size: 2_313_101,
        sha256: "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396",
      },
    ],
  },
} as const;

/** The device value holding the speed probe: decoding time over audio time, by model id. */
export const TRANSCRIPTION_SPEED = "transcriptionSpeed";

/** Decoding took longer than the audio it decoded, by this much at most, and still kept up. */
export const KEEPS_UP = 0.8;

/**
 * The model to use: the best one with the memory to run, unless it didn't
 * keep up here last time (`speed`: decoding time over audio time, by model id)
 * and a smaller one may. The smallest when none fits.
 */
export function chooseModel(
  models: readonly TranscriptionModelDefinition[],
  memory: { freeBytes: number; totalBytes: number },
  speed: Readonly<Record<string, number>>,
): TranscriptionModelDefinition {
  // Free memory alone undercounts what macOS would give back; a quarter of all of it is a floor.
  const available = Math.max(memory.freeBytes, memory.totalBytes / 4);
  const fits = models.filter((model) => model.memoryBytes <= available);
  const fast = fits.filter((model) => (speed[model.id] ?? 0) <= KEEPS_UP);
  return fast[0] ?? fits.at(-1) ?? (models.at(-1) as TranscriptionModelDefinition);
}

/** Where a model's files are once downloaded into the data folder, as the engine loads them. */
export function transcriptionModelFiles(
  dataDir: string,
  definition: TranscriptionModelDefinition,
): TranscriptionModelFiles {
  const folder = join(dataDir, "models", definition.folder);
  return {
    engine: definition.engine,
    files: Object.fromEntries(
      Object.entries(definition.files).map(([role, path]) => [role, join(folder, path)]),
    ),
    vad: join(dataDir, "models", SILERO_VAD.folder, SILERO_VAD.file),
    // Leaves cores for the app, the capture and the rest of the computer.
    threads: Math.max(1, Math.min(4, availableParallelism() - 2)),
  };
}

export interface TranscriptionModelOptions {
  dataDir: string;
  transcriber: Transcriber;
  /** Overrides where the files come from (tests: none at all). */
  source?: { model: EmbeddingModelSource; vad: EmbeddingModelSource };
  /** Where else the files may come from (#1578). */
  sources?: ModelSources;
  /** The speed probe kept on this device, by model id. */
  speed(): Readonly<Record<string, number>>;
  emitStatus(status: EmbeddingModelStatus): void;
  /** Overrides this computer's memory (tests). */
  memory?: () => { freeBytes: number; totalBytes: number };
}

/** Progress events are at most this often, apart from state changes. */
const PROGRESS_INTERVAL_MS = 250;

export function createTranscriptionModel(options: TranscriptionModelOptions) {
  const memory = options.memory ?? (() => ({ freeBytes: freemem(), totalBytes: totalmem() }));
  const definition = chooseModel(TRANSCRIPTION_MODELS, memory(), options.speed());
  const modelSource = options.source?.model ?? definition.source;
  const vadSource = options.source?.vad ?? SILERO_VAD.source;
  const modelFolder = join(options.dataDir, "models", definition.folder);
  const vadFolder = join(options.dataDir, "models", SILERO_VAD.folder);
  const totalBytes = [...modelSource.files, ...vadSource.files].reduce(
    (sum, file) => sum + file.size,
    0,
  );
  const downloaded = () =>
    isModelDownloaded(modelFolder, modelSource.files) &&
    isModelDownloaded(vadFolder, vadSource.files);

  let status: EmbeddingModelStatus = {
    name: definition.name,
    host: new URL(modelSource.baseUrl).host,
    state: downloaded() ? "ready" : "not-downloaded",
    downloadedBytes: 0,
    totalBytes,
    error: null,
  };
  if (status.state === "ready") status.downloadedBytes = totalBytes;
  const lifetime = new AbortController();
  const readyListeners = new Set<() => void>();
  let downloading = false;
  let lastProgress = 0;

  const update = (patch: Partial<EmbeddingModelStatus>) => {
    status = { ...status, ...patch };
    if (!lifetime.signal.aborted) options.emitStatus(status);
  };
  const fail = (error: EmbeddingModelError) => update({ state: "failed", error });

  async function download(): Promise<void> {
    let base = 0;
    const progress = (bytes: number) => {
      status = { ...status, downloadedBytes: base + bytes };
      if (Date.now() - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = Date.now();
      update({});
    };
    await downloadModel({
      directory: vadFolder,
      source: vadSource,
      ...(options.sources && { sources: options.sources }),
      signal: lifetime.signal,
      onProgress: progress,
    });
    base = vadSource.files.reduce((sum, file) => sum + file.size, 0);
    await downloadModel({
      directory: modelFolder,
      source: modelSource,
      ...(options.sources && { sources: options.sources }),
      signal: lifetime.signal,
      onProgress: progress,
    });
  }

  function start(): void {
    if (downloading || lifetime.signal.aborted) return;
    downloading = true;
    update({ state: "downloading", error: null, downloadedBytes: 0 });
    download().then(
      () => {
        downloading = false;
        if (lifetime.signal.aborted) return;
        update({ state: "ready", downloadedBytes: totalBytes, error: null });
        for (const listener of readyListeners) listener();
      },
      (error: unknown) => {
        downloading = false;
        if (lifetime.signal.aborted) return;
        if (error instanceof ModelDownloadError) {
          fail({
            kind: error.kind,
            message: error.message,
            ...(error.sources && { sources: error.sources }),
          });
        } else
          fail({
            kind: "storage",
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
  }

  const files = () => transcriptionModelFiles(options.dataDir, definition);

  return {
    definition,
    status: () => status,
    /** Starts the download if it isn't downloaded or downloading, or after a failed download. */
    ensure(): void {
      if (
        status.state === "not-downloaded" ||
        (status.state === "failed" && status.error?.kind !== "load")
      ) {
        start();
      }
    },
    /** Starts the download again after any failure, a failed load included: the files are checked again. */
    retry(): void {
      if (status.state !== "ready" && status.state !== "downloading") start();
    },
    onReady(listener: () => void): void {
      readyListeners.add(listener);
    },
    /** Silero VAD's file, downloaded first if it isn't yet: a cloud service's turns need it alone (#141). */
    async vadFile(): Promise<string> {
      if (!isModelDownloaded(vadFolder, vadSource.files)) {
        await downloadModel({
          directory: vadFolder,
          source: vadSource,
          ...(options.sources && { sources: options.sources }),
          signal: lifetime.signal,
          onProgress: () => {},
        });
      }
      return files().vad;
    },
    /** Starts the engine with the model. False, with the failure in the status, if it can't. */
    async load(): Promise<boolean> {
      if (status.state !== "ready") return false;
      try {
        await options.transcriber.load(files());
        return true;
      } catch (error) {
        fail({ kind: "load", message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    close(): void {
      lifetime.abort();
      readyListeners.clear();
      options.transcriber.close();
    },
  };
}

export type TranscriptionModel = ReturnType<typeof createTranscriptionModel>;
