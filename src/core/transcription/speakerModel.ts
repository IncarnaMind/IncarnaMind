/**
 * The models that tell a Meeting's speakers apart after the call (#138), downloaded into the
 * data folder when the User first records a Meeting, and checked against their recorded sizes
 * and SHA-256, as the speech-to-text model is (./model). Nothing about the User is sent: plain
 * GET requests for the files, to huggingface.co or the other sources the built-in models use
 * (../embedding/modelSources).
 *
 * Both may be redistributed, as their licences were checked on 2026-10-21:
 * - pyannote's segmentation-3.0 (MIT, © 2022 CNRS), as sherpa-onnx's authors exported it to
 *   ONNX, int8; the export carries the MIT licence.
 * - 3D-Speaker's CAM++ trained on Chinese and English speech (Apache-2.0, ModelScope
 *   iic/speech_campplus_sv_zh_en_16k-common_advanced), as sherpa-onnx's authors exported it.
 */
import { join } from "node:path";
import type { EmbeddingModelSource, Logger, SpeakerModelFiles } from "../adapters";
import { downloadModel, isModelDownloaded } from "../embedding/download";
import type { ModelSources } from "../embedding/modelSources";

const SEGMENTATION_REVISION = "9403a6902bb58e3d5ae8c7e77c3422de279db2e0";
// This mirror has no licence file: the licence is on the original's card,
// https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced
const EMBEDDING_REVISION = "0743f301363dec56491a490f6d6cbc9d67f9a3bf";

export const SPEAKER_SEGMENTATION = {
  folder: "pyannote-segmentation-3.0",
  file: "model.int8.onnx",
  source: {
    baseUrl: `https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/${SEGMENTATION_REVISION}/`,
    files: [
      {
        path: "model.int8.onnx",
        size: 1_540_506,
        sha256: "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d",
      },
    ],
  },
} as const;

export const SPEAKER_EMBEDDING = {
  folder: "3dspeaker-campplus-zh-en",
  file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  source: {
    baseUrl: `https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/${EMBEDDING_REVISION}/`,
    files: [
      {
        path: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
        size: 28_281_164,
        sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
      },
    ],
  },
} as const;

/** The pass runs after the call, beside whatever else the User does: it leaves most cores free. */
export const SPEAKER_THREADS = 2;

export function speakerModelFiles(dataDir: string): SpeakerModelFiles {
  return {
    segmentation: join(dataDir, "models", SPEAKER_SEGMENTATION.folder, SPEAKER_SEGMENTATION.file),
    embedding: join(dataDir, "models", SPEAKER_EMBEDDING.folder, SPEAKER_EMBEDDING.file),
    threads: SPEAKER_THREADS,
  };
}

export interface SpeakerModelOptions {
  dataDir: string;
  /** Overrides where the files come from (tests: none at all). */
  source?: { segmentation: EmbeddingModelSource; embedding: EmbeddingModelSource };
  sources?: ModelSources;
  log: Logger;
}

export function createSpeakerModel(options: SpeakerModelOptions) {
  const lifetime = new AbortController();
  const models = [
    {
      directory: join(options.dataDir, "models", SPEAKER_SEGMENTATION.folder),
      source: options.source?.segmentation ?? SPEAKER_SEGMENTATION.source,
    },
    {
      directory: join(options.dataDir, "models", SPEAKER_EMBEDDING.folder),
      source: options.source?.embedding ?? SPEAKER_EMBEDDING.source,
    },
  ];
  let downloading: Promise<void> | null = null;

  function download(): Promise<void> {
    downloading ??= (async () => {
      for (const model of models) {
        if (isModelDownloaded(model.directory, model.source.files)) continue;
        await downloadModel({
          ...model,
          ...(options.sources && { sources: options.sources }),
          signal: lifetime.signal,
          onProgress: () => {},
        });
      }
    })().finally(() => {
      downloading = null;
    });
    return downloading;
  }

  return {
    /** Starts the download in the background if it isn't downloaded: a failure is tried again by `files`. */
    ensure(): void {
      if (lifetime.signal.aborted || downloading) return;
      if (models.every((model) => isModelDownloaded(model.directory, model.source.files))) return;
      download().catch((error: unknown) => {
        if (lifetime.signal.aborted) return;
        options.log.warn("speakers.downloadFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    /** The files, downloaded first if they aren't. Rejects if they can't be. */
    async files(): Promise<SpeakerModelFiles> {
      await download();
      return speakerModelFiles(options.dataDir);
    },
    close(): void {
      lifetime.abort();
    },
  };
}

export type SpeakerModel = ReturnType<typeof createSpeakerModel>;
