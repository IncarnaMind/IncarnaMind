/**
 * The built-in text recognition model as the rest of the core sees it
 * (#397): its download state (as the built-in embedding model's), loading it
 * into the `TextRecognizer`, and reading a page's picture with it. Its files
 * are downloaded the first time a scanned page needs reading. Nothing it
 * reads leaves this computer.
 */
import { join } from "node:path";
import type {
  EmbeddingModelSource,
  PagePicture,
  PictureRead,
  RecognizedLine,
  TextRecognitionFiles,
  TextRecognizer,
} from "../../adapters";
import type { EmbeddingModelStatus } from "../../api";
import { createDownloadableModel } from "../../embedding/downloadable";
import type { ModelSources } from "../../embedding/modelSources";
import type { TextRecognitionModelDefinition } from "./model";

export { BUILT_IN_TEXT_RECOGNITION_MODEL } from "./model";

/** The model couldn't be downloaded or started: no page can be read until it is. */
export class TextRecognitionUnavailableError extends Error {
  override name = "TextRecognitionUnavailableError";
}

export interface TextRecognitionModel {
  /** What reads pages now, as their Units record it (`UnitScan.reader`). */
  readonly reader: string;
  status(): EmbeddingModelStatus;
  /** Starts the download, or tries again after a failure. */
  retry(): EmbeddingModelStatus;
  /** Calls `listener` each time the model becomes ready. */
  onReady(listener: () => void): void;
  /**
   * The lines of text on a page's picture. Downloads the model first if it
   * must, and waits for it. Rejects with `TextRecognitionUnavailableError`
   * if it can't be downloaded or started, or with the model's error.
   */
  read(picture: PagePicture, page: number): Promise<RecognizedLine[]>;
  /** As `read`, for a picture file (`TextRecognizer.readFile`). */
  readFile(file: Uint8Array, page: number): Promise<PictureRead>;
  /** Stops a download (keeping what it got) and the model. */
  close(): void;
}

export interface TextRecognitionModelOptions {
  definition: TextRecognitionModelDefinition;
  /** Overrides the definition's source (tests). */
  source?: EmbeddingModelSource;
  /** Where else its files may come from (#1578). */
  sources?: ModelSources;
  dataDir: string;
  recognizer: TextRecognizer;
  emitStatus(status: EmbeddingModelStatus): void;
  reportError?: (error: unknown) => void;
}

export function createTextRecognitionModel(
  options: TextRecognitionModelOptions,
): TextRecognitionModel {
  const { definition, recognizer } = options;
  const waiting = new Set<{ resolve(): void; reject(error: Error): void }>();
  const files = createDownloadableModel<TextRecognitionFiles>({
    name: definition.name,
    folder: definition.folder,
    runnerFiles: (directory) => ({
      detector: join(directory, definition.files.detector),
      recognizer: join(directory, definition.files.recognizer),
    }),
    source: options.source ?? definition.source,
    ...(options.sources && { sources: options.sources }),
    dataDir: options.dataDir,
    loadRunner: (paths) => recognizer.load(paths),
    emitStatus(status) {
      if (status.state === "ready" || status.state === "failed") {
        for (const waiter of waiting) {
          if (status.state === "ready") waiter.resolve();
          else {
            waiter.reject(
              new TextRecognitionUnavailableError(
                status.error?.message ?? "The text recognition model couldn't be downloaded.",
              ),
            );
          }
        }
        waiting.clear();
      }
      options.emitStatus(status);
    },
    reportError: options.reportError,
  });

  async function started(): Promise<void> {
    await downloaded();
    if (!(await files.load())) {
      throw new TextRecognitionUnavailableError(
        files.status().error?.message ?? "The text recognition model couldn't start.",
      );
    }
  }

  /** Resolves once the files are downloaded and checked, downloading them if they aren't. */
  function downloaded(): Promise<void> {
    if (files.isReady()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waiting.add({ resolve, reject });
      files.retry();
    });
  }

  return {
    reader: definition.reader,
    status: files.status,
    retry: files.retry,
    onReady: files.onReady,
    async read(picture, page) {
      await started();
      return recognizer.read(picture, page);
    },
    async readFile(file, page) {
      await started();
      return recognizer.readFile(file, page);
    },
    close() {
      files.close();
      recognizer.close();
      for (const waiter of waiting) {
        waiter.reject(new TextRecognitionUnavailableError("IncarnaMind is closing."));
      }
      waiting.clear();
    },
  };
}
