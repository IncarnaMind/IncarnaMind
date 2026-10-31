import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import * as Y from "yjs";
import type { Document, Examples, LinkedFolder, Mind } from "../../src/core";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import { createExamples } from "../../src/core/examples";
import type { Language } from "../../src/core/language";
import { createTempDataFolder } from "../helpers/core";

const documentOf = (linkedFolderId: string, name: string): Document => ({
  id: randomUUID(),
  name,
  kind: "pdf",
  contentHash: randomUUID(),
  path: `/examples/${name}.pdf`,
  fileStatus: "available",
  keptByApp: false,
  linkedFolderId,
  size: 1000,
  pageCount: 1,
  status: "queued",
  progress: null,
  scan: null,
  failure: null,
  unreadParts: null,
  unreadPartsUnknown: false,
  folderId: null,
  tags: [],
  tagging: "pending",
  taggingError: null,
  creationDate: null,
  modifiedAt: null,
  title: null,
  web: null,
  reference: null,
  ownFile: null,
  notCited: false,
  found: null,
  importedAs: null,
  createdAt: "2026-10-16T09:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
});

const EXAMPLES = resolve(__dirname, "../../resources/examples");

/**
 * The example's pieces over fakes, where a linked folder's Documents are
 * reported at the first moment the event loop is free: the earliest the real
 * library can report them.
 */
async function exampleOverFakes() {
  const dataDir = await createTempDataFolder();
  const values = new Map<string, unknown>();
  const minds = new Map<string, { mind: Mind; blocks: Y.XmlFragment }>();
  const folders = new Set<string>();
  const documents = new Map<string, Document[]>();
  const cited = new Map<string, string | null>();
  let language: Language = "en";
  let listingFails = false;
  let shown: Examples | undefined;
  const reports: { folder: string; shownFolder: string | null | undefined }[] = [];

  const examples = createExamples({
    source: EXAMPLES,
    dataDir,
    language: () => language,
    readValue: (key) => values.get(key),
    writeValue: (key, value) => void values.set(key, value),
    createMind: (title) => {
      const mind: Mind = {
        id: randomUUID(),
        title,
        autoTitle: "",
        kind: "mind",
        createdAt: "2026-10-16T09:00:00.000Z",
        updatedAt: "2026-10-16T09:00:00.000Z",
        folderId: null,
      };
      minds.set(mind.id, { mind, blocks: new Y.Doc().getXmlFragment("content") });
      return mind;
    },
    renameMind: (mindId, title) => {
      const held = minds.get(mindId);
      if (held) held.mind = { ...held.mind, title };
    },
    mindTitle: (mindId) => minds.get(mindId)?.mind.title ?? "",
    mindExists: (mindId) => minds.has(mindId),
    deleteMind: (mindId) => void minds.delete(mindId),
    restoreMind: () => {
      throw new Error("not used");
    },
    editMind: (mindId, change) => {
      const held = minds.get(mindId);
      if (!held) throw new Error("No such Mind.");
      return change(held.blocks);
    },
    linkFolder: async (path) => {
      const id = randomUUID();
      folders.add(id);
      // The names the ready Question cites, in the language just asked for.
      const quotes = EXAMPLE_SETS.credit[language].ready?.quotes ?? [];
      documents.set(
        id,
        quotes.map((quote) => documentOf(id, quote.document)),
      );
      setImmediate(() => reports.push({ folder: id, shownFolder: shown?.linkedFolderId }));
      return {
        id,
        path,
        folderId: randomUUID(),
        status: "scanning",
        layout: "tree",
        progress: { files: 0, indexed: 0 },
        onlineOnly: { files: 0, bytes: 0, downloading: false },
        unsupportedFiles: 0,
        createdAt: "2026-10-16T09:00:00.000Z",
        updatedAt: "2026-10-16T09:00:00.000Z",
      } satisfies LinkedFolder;
    },
    unlinkFolder: (linkedFolderId) => void folders.delete(linkedFolderId),
    restoreFolder: () => {
      throw new Error("not used");
    },
    linkedFolderExists: (linkedFolderId) => folders.has(linkedFolderId),
    documentsIn: (linkedFolderId) => {
      if (listingFails) throw new Error("The folders couldn't be listed.");
      return documents.get(linkedFolderId) ?? [];
    },
    mindFolder: () => null,
    now: () => "2026-10-16T09:00:00.000Z",
    checksRelyOn: () => false,
    citationsRelyOn: (documentIds, exceptMindId) =>
      documentIds.some((id) => cited.has(id) && cited.get(id) !== exceptMindId),
    cite: () => {
      throw new Error("No Document has been read.");
    },
    changed: (value) => {
      shown = value;
    },
  });

  return {
    examples,
    reports,
    failListing: () => {
      listingFails = true;
    },
    cite: (documentIds: readonly string[], mindId: string | null = null) => {
      for (const id of documentIds) cited.set(id, mindId);
    },
    uncite: () => cited.clear(),
    switchTo: async (next: Language) => {
      language = next;
      await examples.followLanguage();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

// protects=the interface never holds an example's Documents as the User's own, while the example is made or follows the language; fails_when=an example's folder is linked and the core waits (for the old files to be deleted) before it says the folder is the example's, so the Documents are reported as the User's own; no_claim=what the renderer does with them.
test("an example's Documents are known to be the example's before they are reported, when it follows the language too", async () => {
  const { examples, reports, switchTo } = await exampleOverFakes();

  await examples.create();
  await switchTo("zh-CN");
  await switchTo("en");

  expect(reports).toHaveLength(3);
  for (const report of reports) expect(report.shownFolder).toBe(report.folder);
});

// protects=an untouched example whose Documents an existing Conversation Citation points at keeps its language and its Documents when the interface language changes (#1794); fails_when=the Documents are swapped, so the Citation's page can no longer open; no_claim=what the Citation's card shows.
test("an example whose Documents a Conversation Citation uses keeps its language and Documents", async () => {
  const { examples, switchTo, cite, uncite } = await exampleOverFakes();

  const made = await examples.create();
  const documents = examples.documentsOf(made.mindId as string) ?? [];
  expect(documents).toHaveLength(2);
  cite(documents);

  await switchTo("zh-CN");
  expect(examples.readyQuestion()?.question).toBe(EXAMPLE_SETS.credit.en.ready?.question);

  // Once the Citation is gone, the next change of language swaps the example as usual.
  uncite();
  await switchTo("en");
  await switchTo("zh-CN");
  expect(examples.readyQuestion()?.question).toBe(EXAMPLE_SETS.credit["zh-CN"].ready?.question);
});

// protects=an untouched example is swapped while only its own Mind's Citations quote its Documents, and kept while a Citation in another Mind does; fails_when=the example's own Mind is not left out, so its Answer's Citations keep it from following the language, or a Citation in another Mind is not counted; no_claim=what the Citation's card shows.
test("an example's own Mind doesn't keep it from following the language, another Mind does", async () => {
  const { examples, switchTo, cite, uncite } = await exampleOverFakes();

  const made = await examples.create();
  const mindId = made.mindId as string;
  const documents = examples.documentsOf(mindId) ?? [];
  cite(documents, mindId);

  await switchTo("zh-CN");
  expect(examples.readyQuestion()?.question).toBe(EXAMPLE_SETS.credit["zh-CN"].ready?.question);

  uncite();
  cite(examples.documentsOf(mindId) ?? [], randomUUID());
  await switchTo("en");
  expect(examples.readyQuestion()?.question).toBe(EXAMPLE_SETS.credit["zh-CN"].ready?.question);
});

// protects=a listing that fails ends in a reason, not in no Question at all; fails_when=readyState swallows the failure and reads as absent.
test("a listing that fails says so rather than reading as no example", async () => {
  const { examples, failListing } = await exampleOverFakes();
  await examples.create();
  failListing();
  expect(() => examples.readyState()).toThrow("The folders couldn't be listed.");
});
