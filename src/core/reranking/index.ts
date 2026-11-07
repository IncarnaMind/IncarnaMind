/**
 * The built-in reranking model as the rest of the core sees it: its download
 * state (as the built-in embedding model's), loading it into the
 * `CrossEncoder`, and reordering search hits by its scores. Nothing it reads
 * leaves this computer; only its files are downloaded, once. A model's GPU
 * file is downloaded only once a load has found a GPU adapter, and the model
 * runs on the GPU from the next load (see ./onnx).
 */
import { statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normaliseText } from "../../shared/text";
import { silentLogger } from "../activityLog";
import type {
  CrossEncoder,
  EmbeddingModelSource,
  Logger,
  RerankingDevice,
  RerankingModelFiles,
} from "../adapters";
import type { EmbeddingModelStatus } from "../api";
import { downloadModel, isModelDownloaded } from "../embedding/download";
import { createDownloadableModel } from "../embedding/downloadable";
import type { ModelSources } from "../embedding/modelSources";
import { withoutHostCopies } from "./hostCopies";
import type { RerankingModelDefinition } from "./model";
import { createRerankQueue } from "./order";

export { BUILT_IN_RERANKING_MODEL, type RerankingModelDefinition } from "./model";

/** What the model reads of a hit: its Document's name and its text. */
export interface Rerankable {
  documentName: string;
  text: string;
}

export interface RerankingModel {
  readonly definition: RerankingModelDefinition;
  status(): EmbeddingModelStatus;
  /** Downloaded and checked. */
  isReady(): boolean;
  /** Starts the download if it isn't downloaded or downloading (see `DownloadableModel.ensure`). */
  ensure(): void;
  /** Starts the download, or tries again after a failure. */
  retry(): EmbeddingModelStatus;
  /**
   * The hits in the model's order, best first, each with the model's score
   * from 0 to 1; ties keep their order. Null, with nothing read, while the
   * model isn't downloaded or can't start. Rejects if the model fails. One
   * search is scored at a time, alone, in the order of the work that asked
   * (./order); one whose `signal` aborts while it waits is never scored.
   */
  rerank<Hit extends Rerankable>(
    query: string,
    hits: readonly Hit[],
    signal?: AbortSignal,
  ): Promise<(Hit & { score: number })[] | null>;
  /** Where it ran when it last loaded. Null before it has loaded, and once it has stopped. */
  device(): RerankingDevice["device"] | null;
  /** Stops the model, freeing its memory, e.g. when the User turns reranking off. */
  unload(): void;
  /** Stops a download (keeping what it got) and the model. */
  close(): void;
}

export interface RerankingModelOptions {
  definition: RerankingModelDefinition;
  /** Overrides the definition's source (tests). */
  source?: EmbeddingModelSource;
  /** Where else its files may come from (#1578). */
  sources?: ModelSources;
  dataDir: string;
  crossEncoder: CrossEncoder;
  emitStatus(status: EmbeddingModelStatus): void;
  reportError?: (error: unknown) => void;
  /** Where the model runs, and why not on the GPU when it has a GPU file. */
  log?: Logger;
}

/** What the model reads for a hit, normalised as for embedding: its Document's name, then its text. */
export const rerankText = (hit: Rerankable) =>
  `${normaliseText(hit.documentName)}\n${normaliseText(hit.text)}`;

/** A logit as a score from 0 to 1, so scores stay positive and comparable, as search's are. */
const sigmoid = (logit: number) => 1 / (1 + Math.exp(-logit));

const modifiedMs = (path: string) => statSync(path, { throwIfNoEntry: false })?.mtimeMs;

/**
 * A model's GPU file, from `baseUrl` into its own folder: downloaded once asked, then kept, with
 * a copy written beside it once for the WebGPU session to open, its copies between host and GPU
 * memory read as Identity (./hostCopies). The copy is opened by its path: a session opened from
 * bytes keeps the whole model in memory a second time while it runs (#2532).
 */
function createGpuFile(
  gpu: NonNullable<RerankingModelDefinition["gpu"]>,
  baseUrl: string,
  dataDir: string,
  log: Logger,
  sources: ModelSources | undefined,
) {
  const directory = join(dataDir, "models", gpu.folder);
  const downloaded = join(directory, gpu.file.path);
  const forWebGpu = `${downloaded.replace(/\.onnx$/, "")}.webgpu.onnx`;
  const lifetime = new AbortController();
  let ready = isModelDownloaded(directory, [gpu.file]);
  let downloading = false;
  /** Written from the file as downloaded now, or tried already while IncarnaMind runs. */
  const written = () => (modifiedMs(forWebGpu) ?? -1) >= (modifiedMs(downloaded) ?? 0);
  let copy: "written" | "none" | undefined = ready && written() ? "written" : undefined;
  let writing: Promise<void> | undefined;

  async function writeCopy() {
    const part = `${forWebGpu}.part`;
    try {
      const model = await readFile(downloaded);
      const rewritten = withoutHostCopies(model);
      if (rewritten === model) {
        copy = "none";
        log.info("reranking.gpuOpenedAsDownloaded");
        return;
      }
      await writeFile(part, rewritten);
      await rename(part, forWebGpu);
      copy = "written";
    } catch (error) {
      copy = "none";
      await rm(part, { force: true });
      log.warn("reranking.gpuCopyFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    files: (): NonNullable<RerankingModelFiles["gpu"]> => ({
      model: ready ? (copy === "written" ? forWebGpu : downloaded) : null,
      check: gpu.check,
    }),
    /** Writes the copy the first time the downloaded file is about to be opened. */
    async prepare(): Promise<void> {
      if (!ready || copy !== undefined) return;
      writing ??= writeCopy();
      await writing;
    },
    download(): void {
      if (ready || downloading) return;
      downloading = true;
      downloadModel({
        directory,
        source: { baseUrl, files: [gpu.file] },
        ...(sources && { sources }),
        signal: lifetime.signal,
        onProgress: () => {},
      })
        .then(
          () => {
            ready = true;
            log.info("reranking.gpuDownloaded");
          },
          (error: unknown) => {
            if (lifetime.signal.aborted) return;
            log.warn("reranking.gpuDownloadFailed", {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        )
        .finally(() => {
          downloading = false;
        });
    },
    close: () => lifetime.abort(),
  };
}

export function createRerankingModel(options: RerankingModelOptions): RerankingModel {
  const { definition, crossEncoder } = options;
  const log = options.log ?? silentLogger;
  const source = options.source ?? definition.source;
  const gpuFile =
    definition.gpu &&
    createGpuFile(definition.gpu, source.baseUrl, options.dataDir, log, options.sources);
  let device: RerankingDevice | undefined;
  /** Why the model failed on the GPU as it reranked: it runs on the CPU until IncarnaMind restarts. */
  let gpuFailed: string | undefined;
  const inTurn = createRerankQueue();

  /** Says where the model runs when that changes; a GPU adapter with no GPU file yet starts its download. */
  const onLoaded = (found: RerankingDevice) => {
    if (JSON.stringify(found) === JSON.stringify(device)) return;
    device = found;
    const fallback =
      found.fallback ??
      (gpuFailed === undefined ? undefined : { reason: "session", message: gpuFailed });
    const problem = fallback !== undefined && fallback.reason !== "not-downloaded";
    log[problem ? "warn" : "info"]("reranking.device", {
      device: found.device,
      reason: fallback?.reason,
      message: fallback?.message,
    });
    if (fallback?.reason === "not-downloaded") gpuFile?.download();
    options.emitStatus(files.status());
  };

  const files = createDownloadableModel({
    name: definition.name,
    folder: definition.folder,
    runnerFiles: (directory) => ({
      model: join(directory, definition.files.model),
      tokenizer: join(directory, definition.files.tokenizer),
      tokenizerConfig: join(directory, definition.files.tokenizerConfig),
      maxTokens: definition.maxTokens,
    }),
    source,
    ...(options.sources && { sources: options.sources }),
    dataDir: options.dataDir,
    loadRunner: async (paths) => {
      const onGpu = gpuFile && gpuFailed === undefined ? gpuFile : undefined;
      await onGpu?.prepare();
      onLoaded(await crossEncoder.load(onGpu ? { ...paths, gpu: onGpu.files() } : paths));
    },
    emitStatus: options.emitStatus,
    reportError: options.reportError,
  });

  return {
    definition,
    status: files.status,
    isReady: files.isReady,
    ensure: files.ensure,
    retry: files.retry,
    async rerank(query, hits, signal) {
      const texts = hits.map(rerankText);
      // Loaded in its turn: the model may have stopped while the search waited.
      const logits = await inTurn(async () => {
        if (!(await files.load())) return null;
        if (texts.length === 0) return [];
        try {
          return await crossEncoder.score(normaliseText(query), texts);
        } catch (error) {
          if (device?.device !== "gpu") throw error;
          gpuFailed = error instanceof Error ? error.message : String(error);
          if (!(await files.load())) throw error;
          return crossEncoder.score(normaliseText(query), texts);
        }
      }, signal);
      if (logits === null) return null;
      return hits
        .map((hit, index) => ({
          ...hit,
          score: sigmoid(logits[index] ?? Number.NEGATIVE_INFINITY),
        }))
        .map((hit, index) => ({ hit, index }))
        .sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
        .map(({ hit }) => hit);
    },
    device: () => device?.device ?? null,
    unload() {
      crossEncoder.close();
      device = undefined;
    },
    close() {
      files.close();
      gpuFile?.close();
      crossEncoder.close();
      device = undefined;
    },
  };
}
