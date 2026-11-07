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
 * int8 is the only one yet; #137 adds Whisper's sizes beside it. A small
 * streaming model comes with it, for the live words (#2662, ADR-0027).
 */
import { availableParallelism, freemem, totalmem } from "node:os";
import { join } from "node:path";
import type {
  EmbeddingModelSource,
  Logger,
  Transcriber,
  TranscriptionModelFiles,
} from "../adapters";
import type { EmbeddingModelError, EmbeddingModelStatus } from "../api";
import {
  downloadModel,
  isModelDownloaded,
  ModelDownloadError,
  progressReporter,
} from "../embedding/download";
import type { ModelSources } from "../embedding/modelSources";
import { QWEN3_ASR, STREAMING_TRANSDUCER } from "./sherpa";

/** A model's files and where they come from. */
export interface SpeechModelFiles {
  engine: string;
  /** The model's folder under `models/` in the data folder. */
  folder: string;
  /** The engine's files by what they are, relative to the model's folder. */
  files: Readonly<Record<string, string>>;
  source: EmbeddingModelSource;
  /** About the memory it takes while it runs. */
  memoryBytes: number;
}

export interface TranscriptionModelDefinition extends SpeechModelFiles {
  /** Stable: the speed probe is kept by it. */
  id: string;
  /** What the User sees. */
  name: string;
  /** The streaming model that reads the live words, downloaded with it. */
  live?: SpeechModelFiles;
}

/** Pinned revisions, so the files never change under their recorded sizes and hashes. */
const QWEN3_ASR_REVISION = "68818b2313fe77bd06f6a7c5068ff3ef59d02b8a";
const VAD_REVISION = "fba88cd2e921609e7675c3aaf51e0b9b295da4bc";
const LIVE_REVISION = "98590b7ed6443e77b714204da2757d75e1a642f4";

/**
 * The streaming Zipformer transducer for Chinese and English (Apache-2.0), int8, as sherpa-onnx's
 * authors exported it (2023-02-20): it reads a stretch as it is said, Chinese and English in one
 * sentence alike. The live words only: Qwen3-ASR still writes each finished line (ADR-0027).
 */
export const STREAMING_ZIPFORMER_ZH_EN: SpeechModelFiles = {
  engine: STREAMING_TRANSDUCER,
  folder: "streaming-zipformer-zh-en-int8",
  files: {
    encoder: "encoder-epoch-99-avg-1.int8.onnx",
    decoder: "decoder-epoch-99-avg-1.onnx",
    joiner: "joiner-epoch-99-avg-1.int8.onnx",
    tokens: "tokens.txt",
  },
  source: {
    baseUrl: `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/${LIVE_REVISION}/`,
    files: [
      {
        path: "encoder-epoch-99-avg-1.int8.onnx",
        size: 181_895_032,
        sha256: "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
      },
      {
        path: "decoder-epoch-99-avg-1.onnx",
        size: 13_876_452,
        sha256: "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
      },
      {
        path: "joiner-epoch-99-avg-1.int8.onnx",
        size: 3_228_404,
        sha256: "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
      },
      {
        path: "tokens.txt",
        size: 56_317,
        sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
      },
    ],
  },
  // Measured: about 220 MB once loaded.
  memoryBytes: 300_000_000,
};

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
  live: STREAMING_ZIPFORMER_ZH_EN,
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
  const fits = models.filter(
    (model) => model.memoryBytes + (model.live?.memoryBytes ?? 0) <= available,
  );
  const fast = fits.filter((model) => (speed[model.id] ?? 0) <= KEEPS_UP);
  return fast[0] ?? fits.at(-1) ?? (models.at(-1) as TranscriptionModelDefinition);
}

/** Where a model's files are once downloaded into the data folder, as the engine loads them. */
export function transcriptionModelFiles(
  dataDir: string,
  definition: TranscriptionModelDefinition,
): TranscriptionModelFiles {
  const filesOf = (model: SpeechModelFiles) => {
    const folder = join(dataDir, "models", model.folder);
    return Object.fromEntries(
      Object.entries(model.files).map(([role, path]) => [role, join(folder, path)]),
    );
  };
  return {
    engine: definition.engine,
    files: filesOf(definition),
    vad: join(dataDir, "models", SILERO_VAD.folder, SILERO_VAD.file),
    // Leaves cores for the app, the capture and the rest of the computer.
    threads: Math.max(1, Math.min(4, availableParallelism() - 2)),
    ...(definition.live && {
      live: { engine: definition.live.engine, files: filesOf(definition.live) },
    }),
  };
}

export interface TranscriptionModelOptions {
  dataDir: string;
  transcriber: Transcriber;
  /** Overrides where the files come from (tests: none at all; no streaming model unless given). */
  source?: { model: EmbeddingModelSource; vad: EmbeddingModelSource; live?: EmbeddingModelSource };
  /** Where else the files may come from (#1578). */
  sources?: ModelSources;
  /** The speed probe kept on this device, by model id. */
  speed(): Readonly<Record<string, number>>;
  emitStatus(status: EmbeddingModelStatus): void;
  /** Overrides this computer's memory (tests). */
  memory?: () => { freeBytes: number; totalBytes: number };
  log: Logger;
}

export function createTranscriptionModel(options: TranscriptionModelOptions) {
  const memory = options.memory ?? (() => ({ freeBytes: freemem(), totalBytes: totalmem() }));
  const chosen = chooseModel(TRANSCRIPTION_MODELS, memory(), options.speed());
  const liveSource = options.source ? options.source.live : chosen.live?.source;
  const { live, ...alone } = chosen;
  const definition: TranscriptionModelDefinition =
    live && liveSource ? { ...alone, live: { ...live, source: liveSource } } : alone;
  const modelSource = options.source?.model ?? definition.source;
  const vadSource = options.source?.vad ?? SILERO_VAD.source;
  const modelFolder = join(options.dataDir, "models", definition.folder);
  const vadFolder = join(options.dataDir, "models", SILERO_VAD.folder);
  const livePart = definition.live && {
    directory: join(options.dataDir, "models", definition.live.folder),
    source: definition.live.source,
  };
  // The streaming model downloads with the speech model, its size told with the rest. Where the
  // speech model is here already, from before it (#2662), it comes on its own, after.
  const speechParts = [
    { directory: vadFolder, source: vadSource },
    { directory: modelFolder, source: modelSource },
  ];
  const parts = livePart ? [...speechParts, livePart] : speechParts;
  const totalBytes = parts
    .flatMap((part) => part.source.files)
    .reduce((sum, file) => sum + file.size, 0);
  const here = (part: { directory: string; source: EmbeddingModelSource }) =>
    isModelDownloaded(part.directory, part.source.files);
  const downloaded = () => speechParts.every(here);

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
  let fetchingLive = false;

  const update = (patch: Partial<EmbeddingModelStatus>) => {
    status = { ...status, ...patch };
    if (!lifetime.signal.aborted) options.emitStatus(status);
  };
  const fail = (error: EmbeddingModelError) => update({ state: "failed", error });

  async function download(): Promise<void> {
    let base = 0;
    const report = progressReporter(() => update({}));
    const progress = (bytes: number) => {
      status = { ...status, downloadedBytes: base + bytes };
      report();
    };
    for (const part of parts) {
      await downloadModel({
        directory: part.directory,
        source: part.source,
        ...(options.sources && { sources: options.sources }),
        signal: lifetime.signal,
        onProgress: progress,
      });
      base += part.source.files.reduce((sum, file) => sum + file.size, 0);
    }
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

  /** The streaming model alone, once the speech model is here: transcription goes on without it meanwhile. */
  function fetchLive(): void {
    if (!livePart || fetchingLive || downloading || here(livePart) || lifetime.signal.aborted)
      return;
    fetchingLive = true;
    downloadModel({
      ...livePart,
      ...(options.sources && { sources: options.sources }),
      signal: lifetime.signal,
      onProgress: () => {},
    })
      .catch((error: unknown) => {
        if (lifetime.signal.aborted) return;
        // Asked for again at the next Meeting; live text is read again meanwhile, as before it.
        options.log.warn("transcription.liveModelDownload", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        fetchingLive = false;
      });
  }

  /** The files the engine loads: the streaming model's only once it is all here. */
  const files = (): TranscriptionModelFiles => {
    const { live, ...speech } = transcriptionModelFiles(options.dataDir, definition);
    return live && livePart && here(livePart) ? { ...speech, live } : speech;
  };

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
      } else if (status.state === "ready") {
        fetchLive();
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
