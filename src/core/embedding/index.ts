/**
 * The built-in embedding model as the rest of the core sees it: its download
 * state, loading it into the `Embedder`, and turning Passages and queries into
 * vectors with the model's prefixes and the shared text normalisation.
 */
import { join } from "node:path";
import { normaliseText } from "../../shared/text";
import type { Embedder, EmbeddingModelSource } from "../adapters";
import type { EmbeddingModelStatus } from "../api";
import { createDownloadableModel } from "./downloadable";
import type { EmbeddingModelDefinition } from "./model";
import type { ModelSources } from "./modelSources";

export { BUILT_IN_EMBEDDING_MODEL } from "./model";

export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  status(): EmbeddingModelStatus;
  /** Downloaded and checked. Loading may still fail (see `load`). */
  isReady(): boolean;
  /**
   * Starts the download if the model isn't ready and isn't downloading, also
   * after a failed download. After a failed load, only `retry` starts again.
   */
  ensure(): void;
  /** Starts the download, or tries again after a failure (a failed load included). */
  retry(): EmbeddingModelStatus;
  /** Calls `listener` each time the model becomes ready. */
  onReady(listener: () => void): void;
  /**
   * Loads the model into the embedder. Resolves true once it can embed, or
   * false if the model isn't ready or can't start (the state is then "failed").
   */
  load(): Promise<boolean>;
  /** A Passage's vector: the Document's name, then the Passage, normalised. L2-normalised. */
  embedPassage(documentName: string, text: string): Promise<Float32Array>;
  /** A search query's vector. L2-normalised. */
  embedQuery(query: string): Promise<Float32Array>;
  /**
   * Stops the embedder, freeing its memory, e.g. while another provider
   * embeds. The next `load` starts it again.
   */
  unload(): void;
  /** Stops a download (keeping what it got) and the embedder. */
  close(): void;
}

export interface EmbeddingModelOptions {
  definition: EmbeddingModelDefinition;
  /** Overrides the definition's source (tests). */
  source?: EmbeddingModelSource;
  /** Where else its files may come from (#1578). */
  sources?: ModelSources;
  dataDir: string;
  embedder: Embedder;
  emitStatus(status: EmbeddingModelStatus): void;
  reportError?: (error: unknown) => void;
}

/** The text the model reads for a Passage. The name goes here, not into the stored Passage, so renaming doesn't change Passages. */
function passageEmbeddingText(
  definition: EmbeddingModelDefinition,
  documentName: string,
  text: string,
): string {
  return `${definition.passagePrefix}${normaliseText(documentName)}\n${normaliseText(text)}`;
}

export function createEmbeddingModel(options: EmbeddingModelOptions): EmbeddingModel {
  const { definition, embedder } = options;
  const files = createDownloadableModel({
    name: definition.name,
    folder: definition.folder,
    runnerFiles: (directory) => ({
      model: join(directory, definition.files.model),
      tokenizer: join(directory, definition.files.tokenizer),
      tokenizerConfig: join(directory, definition.files.tokenizerConfig),
      maxTokens: definition.maxTokens,
    }),
    source: options.source ?? definition.source,
    ...(options.sources && { sources: options.sources }),
    dataDir: options.dataDir,
    loadRunner: (paths) => embedder.load(paths),
    emitStatus: options.emitStatus,
    reportError: options.reportError,
  });

  async function vectorOf(text: string): Promise<Float32Array> {
    const vector = await embedder.embed(text);
    if (vector.length !== definition.dimensions) {
      throw new Error(
        `The embedding model returned ${vector.length} dimensions instead of ${definition.dimensions}.`,
      );
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) throw new Error("The embedding model returned an empty vector.");
    return vector.map((value) => value / norm);
  }

  return {
    id: definition.id,
    dimensions: definition.dimensions,
    status: files.status,
    isReady: files.isReady,
    ensure: files.ensure,
    retry: files.retry,
    onReady: files.onReady,
    load: files.load,
    embedPassage: (documentName, text) =>
      vectorOf(passageEmbeddingText(definition, documentName, text)),
    embedQuery: (query) => vectorOf(`${definition.queryPrefix}${normaliseText(query)}`),
    unload() {
      embedder.close();
    },
    close() {
      files.close();
      embedder.close();
    },
  };
}
