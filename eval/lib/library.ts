/**
 * A Document library for the evaluation: a core on a new temporary data
 * folder (never the User's), with the evaluation set's Documents added
 * through the core's public interface and processed.
 */
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnswerPathsOverride,
  type AnswerSearchTuning,
  type ChatModelFactory,
  type Core,
  type CoreAdapters,
  type CrossEncoder,
  createAiSdkChatModel,
  createCore,
  DATABASE_FILE,
  type Document,
  type DocumentStatus,
  type Embedder,
  type EmbeddingModelStatus,
  type Keychain,
  type OllamaModels,
  type RerankSettings,
  type SaveEmbeddingProviderInput,
  type TextRecognizer,
} from "../../src/core";
import { createFakeCrossEncoder } from "../../src/core/reranking/fake";
import { openDatabase } from "../../src/core/storage";
import type { CorpusPassage } from "./corpus";
import type { EvalDocument } from "./evaluationSet";
import type { Log } from "./log";
import { answerSearchOf, createTimingRecorder, type TimingRecorder } from "./timing";

export interface LibraryOptions {
  /** For the temporary folder's name and the log. */
  name: string;
  /**
   * Runs the built-in model; never started when `embeddingProvider` is given.
   * Embeddings are off by default in the app: the library turns them on with
   * one or the other before any Document is added.
   */
  embedder: Embedder;
  /**
   * An embedding provider to use instead of the built-in model, chosen
   * through the core's public interface before any Document is added, as in
   * Settings. Setting it is the consent to send it the Documents' text: the
   * library accepts the "embeddings" flow's consent request.
   */
  embeddingProvider?: SaveEmbeddingProviderInput;
  /**
   * A folder kept between runs that the data folder's `models/` points to, so
   * the built-in models are downloaded (and checked) by the core once.
   */
  modelCache?: string;
  /**
   * Runs the built-in reranking model, which the core reranks with by
   * default, as in the app: the library waits until it is downloaded (into
   * `modelCache`) and checked. Absent: a fake with nothing to download, for
   * checks that never search through the search Tool.
   */
  reranker?: CrossEncoder;
  /** Reads scanned pages and pictures on this computer, as the app does; none without it. */
  textRecognizer?: TextRecognizer;
  documents: readonly EvalDocument[];
  /** The folder of the example Documents the app ships, for a run that makes the example Mind. */
  examples?: string;
  /** The folder of the built-in Skills the app ships, installed as the app installs them. */
  builtInSkills?: string;
  /** Web pages saved by their address from the HTML given, as `saveWebPage` saves a page open in the app: nothing is fetched. */
  webPages?: readonly EvalWebPage[];
  /** Looks up models in Ollama instead of the app's own lookup (see `evalOllamaModels`). */
  ollamaModels?: OllamaModels;
  /** Keep the data folder afterwards, also when opening fails. */
  keep: boolean;
  log: Log;
  /**
   * Go on when some files aren't added or don't process (no text, or
   * failed), as in a User's own library, instead of failing; they are
   * counted in the log, and skipped files are left out of `documents`.
   */
  allowUnprocessed?: boolean;
  /**
   * False: add the Documents with embeddings off, as the app does by default,
   * so they are ready once their keyword index is; the caller can turn
   * embeddings on afterwards. True by default.
   */
  embeddings?: boolean;
  /**
   * The search Tool's reranking and Passage count for Answers, instead of the
   * app's (INCARNAMIND_EVAL_RERANK_DEPTH and INCARNAMIND_EVAL_MAX_PASSAGES).
   */
  answerSearch?: Pick<AnswerSearchTuning, "rerankDepth" | "maxPassages">;
  /** Time each step of the Answers asked (see ./timing); nothing sent to the model changes. */
  recordTimings?: boolean;
  /** Which models take the faster Answer paths, instead of the lists beside the catalog. */
  answerPaths?: AnswerPathsOverride;
  /** How outside agents reach this core (#351): where its socket is and the shim they start. */
  agents?: CoreAdapters["agents"];
  /** Wraps the chat model factory the core asks with, for a run that watches or stands in for its requests. */
  chatModels?: (inner: ChatModelFactory) => ChatModelFactory;
}

export interface EvalWebPage {
  key: string;
  address: string;
  html: string;
}

export interface Library {
  core: Core;
  /** Times the Answers asked through `core`; null unless the library was opened to record. */
  timings: TimingRecorder | null;
  dataDir: string;
  /** The Document added for each key of the evaluation set. */
  documents: ReadonlyMap<string, Document>;
  /** How long adding and processing took, embedding included. */
  processingSeconds: number;
  /** Live Passages in the data folder. */
  passageCount: number;
  /** The stored text of a Document's pages, as the Citation check reads them. */
  pageTexts(documentId: string): { page: number | null; text: string }[];
  /** The pages (Units) a Passage covers; null when it has none or is unknown. */
  passagePages(passageId: string): [number, number] | null;
  /** Every live Passage, with the `seq` it is indexed under, Document by Document in reading order. */
  passages(): CorpusPassage[];
  /** Closes the core, and deletes the data folder unless it is kept. */
  close(): Promise<void>;
}

/** Keys in memory, like the tests' keychain: nothing is written anywhere. */
function memoryKeychain(): Keychain {
  const secrets = new Map<string, string>();
  return {
    protection: () => "os",
    allowPlainText: () => {},
    get: async (name) => secrets.get(name) ?? null,
    set: async (name, secret) => {
      secrets.set(name, secret);
    },
    delete: async (name) => {
      secrets.delete(name);
    },
  };
}

const FINISHED: ReadonlySet<DocumentStatus> = new Set(["ready", "failed", "no-text"]);

/** Resolves once the built-in model is ready; rejects if its download fails. */
export function modelReady(core: Core, log: Log): Promise<void> {
  return new Promise((resolve, reject) => {
    let lastLogged = 0;
    const settle = (status: EmbeddingModelStatus) => {
      if (status.state === "ready") {
        stop();
        resolve();
      } else if (status.state === "failed") {
        stop();
        reject(new Error(`The embedding model couldn't be downloaded: ${status.error?.message}`));
      } else if (status.state === "downloading" && Date.now() - lastLogged > 5000) {
        lastLogged = Date.now();
        const mb = (bytes: number) => Math.round(bytes / 1e6);
        log(
          `Downloading ${status.name}: ${mb(status.downloadedBytes)} of ${mb(status.totalBytes)} MB`,
        );
      }
    };
    const stop = core.on("embeddingModel.status", settle);
    void core.downloadEmbeddingModel().then(settle, reject);
  });
}

/**
 * Resolves once the built-in reranking model, which the core reranks with
 * by default, is downloaded and checked: at once when the model cache has
 * it, with no network. Rejects, saying so, if it can't be downloaded.
 */
function rerankingModelReady(core: Core, modelCache: string | undefined, log: Log): Promise<void> {
  return new Promise((resolve, reject) => {
    let lastLogged = 0;
    const settle = (settings: RerankSettings) => {
      const { model } = settings;
      if (settings.kind !== "built-in") {
        stop();
        reject(new Error(`The core doesn't rerank with the built-in model by default.`));
      } else if (model.state === "ready") {
        stop();
        resolve();
      } else if (model.state === "failed") {
        stop();
        reject(
          new Error(
            `The built-in reranking model, ${model.name}, couldn't be downloaded from ${model.host}: ${model.error?.message ?? "unknown error"}. Retrieval is gated on it: run once with a connection, and it is kept in ${modelCache ?? "the data folder"} for later runs.`,
          ),
        );
      } else if (model.state === "downloading" && Date.now() - lastLogged > 5000) {
        lastLogged = Date.now();
        const mb = (bytes: number) => Math.round(bytes / 1e6);
        log(
          `Downloading ${model.name}: ${mb(model.downloadedBytes)} of ${mb(model.totalBytes)} MB`,
        );
      }
    };
    const stop = core.on("rerank.changed", settle);
    void core.downloadRerankingModel().then(settle, reject);
  });
}

/** Resolves with the Documents once each has finished processing, logging progress. */
function processed(core: Core, ids: readonly string[], log: Log): Promise<Document[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return new Promise<Document[]>((resolve, reject) => {
    const latest = new Map<string, Document>();
    const finish = () => {
      clearInterval(timer);
      stop();
    };
    const settle = (document: Document) => {
      if (!ids.includes(document.id)) return;
      latest.set(document.id, document);
      if (!ids.every((id) => FINISHED.has(latest.get(id)?.status as DocumentStatus))) return;
      finish();
      resolve(ids.map((id) => latest.get(id) as Document));
    };
    const timer = setInterval(() => {
      const documents = [...latest.values()];
      const ready = documents.filter((document) => FINISHED.has(document.status)).length;
      // One Document is embedded at a time; the others wait as "embedding" at 0%.
      const embedding = documents
        .filter((document) => document.status === "embedding")
        .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))[0];
      const detail = embedding
        ? `, embedding ${embedding.name} (${Math.round((embedding.progress ?? 0) * 100)}%)`
        : "";
      log(`Processing: ${ready} of ${ids.length} Documents done${detail}`);
    }, 15_000);
    const stop = core.on("document.status", settle);
    core.listDocuments().then((documents) => {
      for (const document of documents) settle(document);
    }, reject);
  });
}

export async function openLibrary(options: LibraryOptions): Promise<Library> {
  const { log } = options;
  const dataDir = await mkdtemp(join(tmpdir(), `incarnamind-eval-${options.name}-`));
  const modelsLink = join(dataDir, "models");
  if (options.modelCache) {
    await mkdir(options.modelCache, { recursive: true });
    // A junction on Windows needs no special rights; elsewhere the type is ignored.
    await symlink(options.modelCache, modelsLink, "junction");
  }
  const adapters: CoreAdapters = {
    paths: {
      dataDir,
      home: join(dataDir, "home"),
      documents: join(dataDir, "Documents"),
      ...(options.examples && { examples: options.examples }),
      ...(options.builtInSkills && { builtInSkills: options.builtInSkills }),
    },
    systemLanguages: () => ["en-US"],
    keychain: memoryKeychain(),
    browser: {
      open: async () => {
        throw new Error("The evaluation can't open a browser.");
      },
    },
    processes: {
      spawn: () => {
        throw new Error("The evaluation can't start processes.");
      },
    },
    embedder: options.embedder,
    ...(options.textRecognizer && { textRecognizer: options.textRecognizer }),
    ...(options.ollamaModels && { ollamaModels: options.ollamaModels }),
    ...(options.agents && { agents: options.agents }),
    // The core reranks by default: with the real built-in model when asked for, as in the app
    // (Answers' searches); otherwise a fake, with nothing to download.
    ...(options.reranker
      ? { crossEncoder: options.reranker }
      : {
          crossEncoder: createFakeCrossEncoder(),
          rerankingModelSource: { baseUrl: "http://127.0.0.1/", files: [] },
        }),
  };
  const timings = options.recordTimings ? createTimingRecorder() : null;
  const answerSearch = answerSearchOf(options.answerSearch ?? {}, timings);
  const timed = timings ? timings.chatModels(createAiSdkChatModel) : createAiSdkChatModel;
  const chatModels = options.chatModels?.(timed) ?? (timings ? timed : null);
  const core = createCore({
    ...adapters,
    ...(answerSearch && { answerSearch }),
    ...(chatModels && { createChatModel: chatModels }),
    ...(timings && { answerEngine: timings.engine }),
    ...(options.answerPaths && { answerPaths: options.answerPaths }),
  });
  const close = async () => {
    core.close();
    if (options.keep) {
      log(`Kept the data folder ${dataDir}`);
      return;
    }
    // The link goes first, so deleting the folder can't reach the model cache it points to.
    if (options.modelCache) await unlink(modelsLink);
    await rm(dataDir, { recursive: true, force: true });
  };

  try {
    const started = Date.now();
    if (options.embeddingProvider) {
      const provider = options.embeddingProvider;
      // Only the embeddings flow is accepted; nothing else may leave the machine.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(request.requestId, request.flow.id === "embeddings");
      });
      const saved = await core.saveEmbeddingProvider(provider);
      log(`Embedding with ${saved.provider.kind}/${saved.provider.modelId}`);
    } else if (options.embeddings !== false) {
      // Embeddings are off by default: on, as a User turns them on in Settings, the vector
      // and hybrid modes can be measured next to keyword search.
      await core.saveEmbeddingProvider({ kind: "built-in" });
      await modelReady(core, log);
      log(`The embedding model is ready (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
    if (options.reranker) {
      const begun = Date.now();
      await rerankingModelReady(core, options.modelCache, log);
      log(`The reranking model is ready (${((Date.now() - begun) / 1000).toFixed(1)} s)`);
    }

    const begun = Date.now();
    const { documents: added, skipped } = await core.addDocuments(
      options.documents.map((document) => document.path),
    );
    if (skipped.length > 0 && options.allowUnprocessed) {
      log(`${skipped.length} files weren't added; going on without them`);
    } else if (skipped.length > 0) {
      throw new Error(`Files weren't added: ${skipped.map((file) => file.path).join(", ")}`);
    }
    // The Documents come in the order of the files given, without those skipped.
    const skippedPaths = new Set(skipped.map((file) => file.path));
    const kept: { key: string }[] = options.documents.filter(
      (document) => !skippedPaths.has(document.path),
    );
    for (const page of options.webPages ?? []) {
      const saved = await core.saveWebPage({ address: page.address, html: page.html });
      if (saved.outcome !== "saved") {
        throw new Error(`The web page ${page.address} wasn't saved: ${saved.failure.message}`);
      }
      added.push(saved.document);
      kept.push(page);
    }
    const done = await processed(
      core,
      added.map((document) => document.id),
      log,
    );
    const processingSeconds = (Date.now() - begun) / 1000;
    const notReady = done.filter((document) => document.status !== "ready");
    if (notReady.length > 0 && options.allowUnprocessed) {
      log(
        `${notReady.length} Documents didn't process (no text, or failed); going on without them`,
      );
    } else if (notReady.length > 0) {
      throw new Error(
        `Documents didn't process: ${notReady.map((document) => `${document.name} (${document.status}: ${document.failure?.message ?? ""})`).join(", ")}`,
      );
    }
    const documents = new Map(
      kept.map((document, index) => [document.key, done[index] as Document]),
    );

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    const pages = new Map<string, { page: number | null; text: string }[]>();
    const passageCount =
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM passages WHERE deleted_at IS NULL")
        ?.count ?? 0;
    log(`${done.length} Documents, ${passageCount} Passages, in ${processingSeconds.toFixed(0)} s`);

    return {
      core,
      timings,
      dataDir,
      documents,
      processingSeconds,
      passageCount,
      pageTexts(documentId) {
        let found = pages.get(documentId);
        if (!found) {
          // Read straight from the data folder, as the tests do: the public interface has no call for it.
          found = db.all<{ page: number | null; text: string }>(
            "SELECT page, text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY page",
            [documentId],
          );
          pages.set(documentId, found);
        }
        return found;
      },
      passagePages(passageId) {
        const row = db.get<{ page_from: number | null; page_to: number | null }>(
          "SELECT page_from, page_to FROM passages WHERE id = ?",
          [passageId],
        );
        if (!row || row.page_from === null || row.page_to === null) return null;
        return [row.page_from, row.page_to];
      },
      passages() {
        return db
          .all<{
            seq: number;
            passage_id: string;
            document_id: string;
            document_name: string;
            page_from: number | null;
            page_to: number | null;
            position: number;
            text: string;
          }>(
            `SELECT p.seq, p.id AS passage_id, p.document_id, d.name AS document_name,
               p.page_from, p.page_to, p.position, p.text
             FROM passages p JOIN documents d ON d.id = p.document_id
             WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL
             ORDER BY d.created_at, d.rowid, p.position`,
          )
          .map((row) => ({
            seq: row.seq,
            passageId: row.passage_id,
            documentId: row.document_id,
            documentName: row.document_name,
            pageFrom: row.page_from,
            pageTo: row.page_to,
            position: row.position,
            text: row.text,
          }));
      },
      async close() {
        db.close();
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
