import { createHash } from "node:crypto";
import { mkdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import type { AddDocumentsOptions, Core, Document, DocumentStatus } from "../../src/core";
import { normaliseText } from "../../src/shared/text";
import { createTempDataFolder } from "./core";

/** When the last file `writeSourceFile` wrote was modified, in milliseconds. */
let lastModified = 0;

/**
 * Writes a file the User might add, in a folder outside the data folder (and
 * any folders on the way), and returns its path. Each file written is newer
 * than the one before, as when a person writes them one after another: a
 * Linked folder is read newest file first, and Linux stamps files written
 * within the same few milliseconds with the same time.
 */
export async function writeSourceFile(
  folder: string,
  name: string,
  contents: string | Uint8Array,
): Promise<string> {
  const path = join(folder, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  const { mtimeMs } = await stat(path);
  if (mtimeMs <= lastModified) {
    const later = new Date(lastModified + 1);
    await utimes(path, later, later);
    lastModified += 1;
  } else lastModified = mtimeMs;
  return path;
}

/**
 * A fresh, empty folder for the User's files, deleted when the current test
 * finishes. Its path has symbolic links resolved (macOS's temporary folder is
 * one), as the core records Documents' paths.
 */
export async function createSourceFolder(): Promise<string> {
  return realpath(await createTempDataFolder());
}

export const sha256 = (contents: string | Uint8Array) =>
  createHash("sha256").update(contents).digest("hex");

const wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * What the keyword index held for a text before it read traditional Chinese
 * characters as simplified ones (processing version 5): its normalised words,
 * as written, lowercased, joined by spaces.
 */
export const unfoldedKeywords = (text: string) =>
  [...wordSegmenter.segment(normaliseText(text))]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLowerCase())
    .join(" ");

/** Where the old layout (before ADR-0010) kept a Document's copy in the data folder. */
export const storedFile = (dataDir: string, contentHash: string) =>
  join(dataDir, "documents", contentHash);

const FINISHED: ReadonlySet<DocumentStatus> = new Set(["ready", "failed", "no-text"]);

/** Resolves with the Documents, in the order given, once each has finished processing. */
export function waitForProcessing(
  core: Core,
  ids: readonly string[],
  timeout = 15_000,
): Promise<Document[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const wanted = new Set(ids);
    const finished = new Map<string, Document>();
    const settle = (document: Document) => {
      if (!wanted.has(document.id) || !FINISHED.has(document.status)) return;
      finished.set(document.id, document);
      if (finished.size < wanted.size) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(ids.map((id) => finished.get(id) as Document));
    };
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Processing didn't finish within ${timeout} ms.`));
    }, timeout);
    const unsubscribe = core.on("document.status", settle);
    void core.listDocuments().then((documents) => {
      for (const document of documents) settle(document);
    }, reject);
  });
}

/** Adds files and waits until they have all finished processing. */
export async function addAndProcess(
  core: Core,
  paths: string[],
  timeout?: number,
): Promise<Document[]> {
  const { documents } = await core.addDocuments(paths);
  return waitForProcessing(
    core,
    documents.map((document) => document.id),
    timeout,
  );
}

/**
 * Polls the core's Documents until `check` passes for them (it throws until
 * then, e.g. with `expect`), and returns them: for changes the core picks up
 * by itself, such as a Linked folder's watcher.
 */
export function waitForDocuments(
  core: Core,
  check: (documents: Document[]) => void,
  timeout = 15_000,
): Promise<Document[]> {
  return vi.waitFor(
    async () => {
      const documents = await core.listDocuments();
      check(documents);
      return documents;
    },
    { timeout, interval: 25 },
  );
}

/** The live Document at `path`; throws if there is none. */
export function documentAt(documents: readonly Document[], path: string): Document {
  const document = documents.find((each) => each.path === path);
  if (!document) throw new Error(`No Document at ${path}.`);
  return document;
}

/** Links a folder and waits until every file in it is processed. */
export async function linkAndProcess(
  core: Core,
  path: string,
  options?: AddDocumentsOptions,
): Promise<Document[]> {
  const linked = await core.addLinkedFolder(path, options);
  await core.reconcileDocuments();
  const documents = await core.listDocuments({ linkedFolderId: linked.id });
  return waitForProcessing(
    core,
    documents.map((document) => document.id),
  );
}

/** What a figure schedule reads of the Library when none of its Documents is there. */
export const NO_SOURCE_DOCUMENTS = {
  citationSource: () => null,
  documentDate: () => null,
  pageTexts: () => [],
};
