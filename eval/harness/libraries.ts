/**
 * The bake-off's Documents (README.md), each set in a core of its own on a
 * temporary data folder, as `eval/everyday` has them: added with embeddings
 * off, searched with the built-in reranking model. Each core also takes
 * outside agents, which start the bake-off's shim (./shim.ts) with this Node.
 */
import { join, resolve } from "node:path";
import { type ChatModelChoice, type Core, DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { fetchPapers, reports } from "../everyday/asking";
import { writeDatedDocuments } from "../everyday/dated";
import type { ChatSettings, EvalConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import type { EvalDocument } from "../lib/evaluationSet";
import { type Library, openLibrary } from "../lib/library";
import type { Log } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import type { HarnessLibrary } from "./cases";

const ROOT = resolve(__dirname, "../..");

/** The shim an outside harness starts, run by this Node. */
export const SHIM = {
  command: process.execPath,
  args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(__dirname, "shim.ts")],
};

/** The credit example's Documents, in English and Chinese, as the app ships them. */
function creditDocuments(): EvalDocument[] {
  const folder = join(ROOT, "resources", "examples", "credit");
  return [
    "en/Northwind Retail · Q3 2026 results.pdf",
    "en/Northwind Retail · Senior facilities agreement (excerpt).pdf",
    "zh-CN/Northwind Retail · 2026 年第三季度业绩.pdf",
    "zh-CN/Northwind Retail · 优先级贷款协议（节选）.pdf",
  ].map((file) => ({ key: file, path: join(folder, file) }));
}

/** Each library's Documents: the credit example's beside the two papers, for the two-turn requests. */
export async function documentsOf(
  name: HarnessLibrary,
  config: EvalConfig,
  datedFolder: string,
  log: Log,
): Promise<EvalDocument[]> {
  switch (name) {
    case "papers":
      return fetchPapers(config.cacheDir, log);
    case "reports":
      return reports();
    case "dated":
      return writeDatedDocuments(datedFolder);
    case "credit":
      return [...creditDocuments(), ...(await fetchPapers(config.cacheDir, log))];
  }
}

export interface HarnessLibraryHandle {
  library: Library;
  core: Core;
  /** Every Document of the library: what each harness searches. */
  scoped: { id: string; name: string }[];
  /** The data folder's database, read for the Citations minted for outside agents. */
  db: ReturnType<typeof openDatabase>;
  /** The model the Supported column's check runs on; null: the model under test. */
  checkModel: ChatModelChoice | null;
  close(): Promise<void>;
}

/**
 * A library with the chat model under test saved, outside agents on, and the consent for both
 * given; with `checker`, that model is saved too, for the support check.
 */
export async function openHarnessLibrary(options: {
  name: HarnessLibrary;
  documents: readonly EvalDocument[];
  chat: ChatSettings;
  checker: ChatSettings | null;
  config: EvalConfig;
  log: Log;
}): Promise<HarnessLibraryHandle> {
  const { config, chat, checker } = options;
  const library = await openLibrary({
    name: `harness-${options.name}`,
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: options.documents,
    examples: join(ROOT, "resources", "examples"),
    keep: config.keepData,
    embeddings: false,
    agents: { launcher: SHIM, version: "0.0.0-harness" },
    log: options.log,
  });
  const { core } = library;
  // Setting the variables is the consent to send the requests and Passages to the model; each
  // pairing's own consent is given as it is made (connectAgent).
  core.on("consent.requested", (request) => {
    void core.respondToConsent(
      request.requestId,
      request.flow.id === "chat" || request.flow.id === "checks",
    );
  });
  const save = (settings: ChatSettings) =>
    core.saveChatProvider({
      kind: settings.kind,
      modelId: settings.modelId,
      ...(settings.apiKey !== null && { apiKey: settings.apiKey }),
      ...(settings.baseUrl !== null && { baseUrl: settings.baseUrl }),
    });
  // The checker first: the provider saved last holds the default model, the one under test.
  const checkModel = checker
    ? { providerId: (await save(checker)).id, modelId: checker.modelId }
    : null;
  await save(chat);
  await core.setAgentsEnabled(true);
  const db = openDatabase(join(library.dataDir, DATABASE_FILE));
  return {
    library,
    core,
    scoped: [...library.documents.values()].map((document) => ({
      id: document.id,
      name: document.name,
    })),
    db,
    checkModel,
    async close() {
      db.close();
      await library.close();
    },
  };
}
