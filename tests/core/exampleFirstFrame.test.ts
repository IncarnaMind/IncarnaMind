import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { CLAIM_CHECK_MARK, type LinkedFolder, type Mind } from "../../src/core/api";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import { createExamples } from "../../src/core/examples";

/** The example Documents the app ships. */
const EXAMPLES = resolve(__dirname, "../../resources/examples");
const NOW = "2026-10-29T09:00:00.000Z";

let dataDir: string;
afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/**
 * The example made with no Document read yet, as a first run makes it: the
 * Documents are linked and still being read, so nothing can cite one yet.
 */
async function madeBeforeItsDocumentsAreRead() {
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-example-"));
  const store = new Map<string, unknown>();
  const blocks = new Y.Doc().getXmlFragment("blocks");
  const mind: Mind = {
    id: "mind",
    title: "",
    autoTitle: "",
    kind: "mind",
    createdAt: NOW,
    updatedAt: NOW,
    folderId: null,
  };
  const linked: LinkedFolder = {
    id: "linked",
    path: join(dataDir, "Examples"),
    folderId: "folder",
    status: "scanning",
    layout: "tree",
    progress: { files: 0, indexed: 0 },
    onlineOnly: { files: 0, bytes: 0, downloading: false },
    unsupportedFiles: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const examples = createExamples({
    source: EXAMPLES,
    dataDir,
    language: () => "en",
    readValue: (key) => store.get(key),
    writeValue: (key, value) => void store.set(key, value),
    createMind: (title) => ({ ...mind, title }),
    renameMind: () => undefined,
    mindTitle: () => mind.title,
    mindExists: () => true,
    deleteMind: () => undefined,
    restoreMind: () => undefined,
    editMind: (_mindId, change) => change(blocks),
    linkFolder: async () => linked,
    unlinkFolder: () => undefined,
    restoreFolder: () => undefined,
    linkedFolderExists: () => true,
    documentsIn: () => [],
    mindFolder: () => null,
    now: () => NOW,
    checksRelyOn: () => false,
    citationsRelyOn: () => false,
    cite: () => {
      throw new Error("Nothing is read yet: a check made now can't cite a Passage.");
    },
    changed: () => undefined,
    random: Math.random,
  });
  return { examples, blocks };
}

/** Each check's mark in the Mind, with the text it marks. */
function checksIn(blocks: Y.XmlFragment): { text: string; check: Record<string, unknown> }[] {
  const found: { text: string; check: Record<string, unknown> }[] = [];
  for (const block of blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    for (const child of block.toArray()) {
      if (!(child instanceof Y.XmlText)) continue;
      for (const run of child.toDelta() as {
        insert: unknown;
        attributes?: Record<string, unknown>;
      }[]) {
        const check = run.attributes?.[CLAIM_CHECK_MARK] as Record<string, unknown> | undefined;
        if (typeof run.insert !== "string" || !check) continue;
        found.push({ text: run.insert, check });
      }
    }
  }
  return found;
}

describe("the example's draft before its Documents are read (#2196)", () => {
  test("carries its verdict's mark, with the Document and quote known and the Passage still to come", async () => {
    const { examples, blocks } = await madeBeforeItsDocumentsAreRead();

    await examples.create("credit");

    const set = EXAMPLE_SETS.credit.en;
    const check = set.checks?.[0];
    expect(check).toBeDefined();
    expect(checksIn(blocks)).toEqual([
      {
        text: check?.sentence,
        check: expect.objectContaining({
          state: "contradicted",
          says: check?.says,
          // The Mind is in no Folder, so its check's scope is the same one the check made
          // when the Documents are read has: the mark reads as the verdict, not as a scope change.
          scope: { folderId: null, widened: false },
          // The Passage that decides it is not cited yet: the card says it is being checked.
          evidence: expect.objectContaining({
            documentName: check?.evidence.document,
            quote: check?.evidence.quote,
            check: "checking",
          }),
        }),
      },
    ]);
  });
});
