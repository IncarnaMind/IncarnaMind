/**
 * The workspace the recording starts in, made before the first frame through the core's bridge,
 * as a person who had used the app for a while would have it: Folders with Documents in them and
 * a draft in a Mind. Test Documents only.
 */
import { constants, existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import * as Y from "yjs";
import type { CoreBridge } from "../../src/core/api";
import { mindNode } from "../app";
import { type DemoLanguage, writeTermSheets } from "./documents";
import type { Block, DemoScript } from "./script";

/** The model the recording is made with. */
const MODEL = "claude-sonnet-5-5";
/** The keys to try, in order: the first the provider doesn't refuse is used. */
const KEY_NAMES = ["ANTHROPIC_API_KEY_JOEYXIONG26", "ANTHROPIC_API_KEY_JOEYXIONG28"];

const SHIPPED = resolve(__dirname, "../../resources/examples");

/**
 * Puts the speech and search models, as the app's own downloads left them, in the data folder:
 * a test build reaches no model host. `INCARNAMIND_MODEL_CACHE` is the folder that holds them in
 * `models/` (the evaluation's cache by default).
 */
export async function seedModels(dataDir: string): Promise<void> {
  const cache =
    process.env.INCARNAMIND_MODEL_CACHE ?? join(homedir(), ".cache", "incarnamind-eval");
  const models = join(cache, "models");
  if (!existsSync(models)) {
    throw new Error(
      `No models in ${models}: set INCARNAMIND_MODEL_CACHE to the folder that has them.`,
    );
  }
  await mkdir(join(dataDir, "models"), { recursive: true });
  await cp(models, join(dataDir, "models"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

/** Makes the first key in `KEY_NAMES` the provider accepts the chat model. Never shows the key. */
export async function connectClaude(window: Page): Promise<string> {
  for (const name of KEY_NAMES) {
    const apiKey = process.env[name];
    if (!apiKey) continue;
    const accepted = await window.evaluate(
      async ({ key, modelId }) => {
        const bridge = () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const tested = await bridge().testChatConnection({
          kind: "anthropic",
          apiKey: key,
          modelId,
        });
        if (!tested.ok) return false;
        await bridge().saveChatProvider({ kind: "anthropic", apiKey: key, modelId });
        return true;
      },
      { key: apiKey, modelId: MODEL },
    );
    if (accepted) return name;
  }
  throw new Error(`No key in ${KEY_NAMES.join(" or ")} is accepted by Anthropic.`);
}

/**
 * Makes Claude Sonnet 5.5 the model of every step that picks its own cheaper one otherwise: the
 * calls that don't write the Answer, and tagging and Organize. Organize stays a thing the User
 * starts, so it is on screen when it runs.
 */
export async function chooseSonnetEverywhere(window: Page): Promise<void> {
  await window.evaluate(async (modelId) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [provider] = await bridge.listChatProviders();
    if (!provider) throw new Error("No chat provider is saved.");
    const choice = { providerId: provider.id, modelId };
    await bridge.updateSettings({ user: { quickTasksModel: choice } });
    const { settings } = await bridge.getLibrary();
    await bridge.saveLibrarySettings({
      ...settings,
      classifier: { kind: "chat", choice },
      automatic: false,
    });
  }, MODEL);
}

/** The spend the app has counted this month on its providers, in dollars. */
export async function spent(window: Page): Promise<number> {
  return window.evaluate(async () => {
    const bridge = () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const summary = await bridge().getCostSummary();
    return summary.spent
      .filter((each) => each.currency === "USD")
      .reduce((sum, each) => sum + each.amount, 0);
  });
}

const blockElement = (block: Block) =>
  mindNode(
    block.type === "paragraph" ? "paragraph" : "heading",
    {
      id: crypto.randomUUID(),
      ...(block.type === "paragraph" ? {} : { level: block.type === "heading1" ? 1 : 2 }),
    },
    [block.text],
  );

export interface Workspace {
  /** The Mind of the draft. */
  paperId: string;
  /** Where the lenders' new Documents are, on disk. */
  lendersPath: string;
}

/**
 * Makes the two Folders, adds the credit Documents to the first, links the folder the lenders'
 * new Documents arrived in (left for Organize to sort), makes the draft's title and the Mind the
 * term sheets are compared in, and waits until every Document is read. `writeDraft` adds the
 * rest once the cited paragraph is in.
 */
export async function buildWorkspace(
  window: Page,
  script: DemoScript,
  sources: string,
): Promise<Workspace> {
  const credit = join(SHIPPED, script.credit.source);
  const lendersPath = join(sources, script.lenders);
  const sheets = await writeTermSheets(lendersPath, script.language as DemoLanguage);
  const creditFiles = (await readdir(credit)).sort().map((name) => join(credit, name));
  const { creditFolderId, contractsFolderId } = await window.evaluate(
    async ({ folders, creditFiles: inCredit, lenders }) => {
      const bridge = () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const creditFolder = await bridge().createLibraryGroup(folders.credit);
      const contractsFolder = await bridge().createLibraryGroup(folders.contracts);
      await bridge().addDocuments(inCredit, { groupId: creditFolder.id });
      await bridge().addLinkedFolder(lenders);
      return { creditFolderId: creditFolder.id, contractsFolderId: contractsFolder.id };
    },
    { folders: script.folders, creditFiles, lenders: lendersPath },
  );
  // "Ready" comes before the search finds every Document's words: an Answer asked in between
  // says they are still being read.
  await expect
    .poll(
      () =>
        window.evaluate(async (expected) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const documents = await bridge.listDocuments();
          const found = await bridge.searchDocumentText("EBITDA");
          const read =
            documents.length === expected && documents.every((each) => each.status === "ready");
          return read ? new Set(found.map((match) => match.documentId)).size : -1;
        }, creditFiles.length + sheets.length),
      { timeout: 120_000, intervals: [500] },
    )
    .toBeGreaterThanOrEqual(2);

  const doc = new Y.Doc();
  const [title] = script.paper.blocks;
  if (title) doc.getXmlFragment("blocks").push([blockElement(title)]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  const paperId = await window.evaluate(
    async ({ title, folderId, change }) => {
      const bridge = () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await bridge().createMind({ title, folderId });
      await bridge().applyMindUpdate(mind.id, new Uint8Array(change));
      await bridge().closeMind(mind.id);
      return mind.id;
    },
    { title: script.paper.title, folderId: creditFolderId, change: update },
  );
  const options = new Y.Doc();
  options.getXmlFragment("blocks").push(
    [
      { type: "heading1", text: script.options.title },
      { type: "paragraph", text: script.options.intro },
    ].map((block) => blockElement(block as Block)),
  );
  await window.evaluate(
    async ({ title, folderId, change }) => {
      const bridge = () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await bridge().createMind({ title, folderId });
      await bridge().applyMindUpdate(mind.id, new Uint8Array(change));
      await bridge().closeMind(mind.id);
      return mind.id;
    },
    {
      title: script.options.title,
      folderId: contractsFolderId,
      change: Array.from(Y.encodeStateAsUpdate(options)),
    },
  );
  return { paperId, lendersPath };
}

/**
 * Writes the rest of the draft between its title and the paragraph the assistant added there,
 * as a change from another editor: the User's own sentences, above the cited ones.
 */
export async function writeDraft(window: Page, script: DemoScript, paperId: string): Promise<void> {
  const opened = await window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return Array.from((await bridge.openMind(id)).state);
  }, paperId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(opened));
  const before = Y.encodeStateVector(doc);
  doc.getXmlFragment("blocks").insert(1, script.paper.blocks.slice(1).map(blockElement));
  const change = Array.from(Y.encodeStateAsUpdate(doc, before));
  await window.evaluate(
    async ({ id, update }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.applyMindUpdate(id, new Uint8Array(update));
    },
    { id: paperId, update: change },
  );
}
