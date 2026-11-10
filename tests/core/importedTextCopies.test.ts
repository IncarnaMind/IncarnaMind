/**
 * A Note imported from a file whose original isn't a Document (#2216), through the core's public
 * interface: its check compares the file as it was imported, kept with the Note, so a resaved
 * copy or a PDF of that file in the Library is left out and named, while a file that only shares
 * some of its text is still evidence. Nothing is stored for it, and a kept file that is gone
 * leaves out byte-for-byte copies only.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { WORD_PACKAGES_FOLDER } from "../../src/core/wordImports";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, sha256, waitForDocuments } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModels } from "../helpers/models";
import {
  type Agreement,
  agreement,
  firstClauses,
  type Language,
  sameTemplate,
} from "../helpers/sameTextAgreements";
import { printedPdf, wordOf } from "../helpers/sameTextFiles";
import { importWordBytes } from "../helpers/wordMinds";

/** A sentence of clause 1.2 after its first, which the other deal's file from the template holds too. */
const SENTENCE = {
  en: "Words in the singular include the plural and the other way round.",
  zh: "本合同所称法律法规，包括其不时修订后的版本。",
} as const;

const NAMES = {
  en: {
    original: "Services Agreement",
    resaved: "Services Agreement (saved again)",
    pdf: "Services Agreement (signed)",
    template: "Services Agreement (Marlow Street)",
    bytes: "Services Agreement (as sent)",
  },
  zh: {
    original: "技术服务合同",
    resaved: "技术服务合同（另存）",
    pdf: "技术服务合同（签署版）",
    template: "技术服务合同（白鹭洲）",
    bytes: "技术服务合同（原件）",
  },
} as const;

/** The checked file and its copies in the Library, then the file imported as a Note. */
async function importedNote(
  language: Language,
  { addOriginal = false, file = firstClauses(agreement(language), 1) } = {},
) {
  const calls: ModelCall[] = [];
  const model = checkingModel({ [SENTENCE[language]]: { verdict: "unsupported" } }, calls);
  const dataDir = await createTempDataFolder();
  const start = () =>
    startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
  const core = start();
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const names = NAMES[language];
  const word = wordOf(file, language);
  const folder = await createSourceFolder();
  const write = async (name: string, bytes: Uint8Array) => {
    const path = join(folder, name);
    await writeFile(path, bytes);
    return path;
  };
  const added = await addAndProcess(core, [
    await write(`${names.resaved}.docx`, wordOf(file, language, "saved again")),
    await write(`${names.pdf}.pdf`, printedPdf([file], language).bytes),
    await write(
      `${names.template}.docx`,
      wordOf(firstClauses(sameTemplate(language), 1), language),
    ),
  ]);
  const [resaved, pdf, template] = added as [Document, Document, Document];
  const { mindId, client } = await importWordBytes(core, await createSourceFolder(), word, {
    name: `${names.original}.docx`,
    origin: "own",
    folderId: null,
    addOriginal,
  });
  return {
    core,
    start,
    dataDir,
    calls,
    names,
    word,
    write,
    mindId,
    client,
    resaved,
    pdf,
    template,
  };
}

/** The Documents the model was handed as evidence, by name, since `from` calls. */
const handed = (calls: readonly ModelCall[], from = 0) =>
  new Set(
    calls
      .slice(from)
      .filter(isCheckRun)
      .flatMap((call) =>
        call.results
          .filter((result) => result.tool === "search_documents")
          .flatMap((result) => shownPassages(result.text).map((passage) => passage.document)),
      ),
  );

const checkAll = (core: Core, mindId: string, requestId: string) =>
  core.checkMind({ requestId, mindId, mode: "all" });

/** What the claim's check left out, by name and reason. */
async function leftOut(client: MindClient, sentence: string) {
  await client.settled();
  const check = claimSpans(readMind(client)).find(
    (span) => span.sentence.text.trim() === sentence,
  )?.check;
  return (check?.excluded ?? []).map((each) => [each.documentName, each.reason]);
}

describe.each(["en", "zh"] as const)(
  "A Note imported from a file never added to the Library (%s)",
  (language) => {
    test("a resaved copy and a PDF of the file are never handed to the model and are named as left out; the template's other file is still evidence", async () => {
      const set = await importedNote(language);
      await checkAll(set.core, set.mindId, "all");

      expect(handed(set.calls)).toEqual(new Set([set.names.template]));
      expect(await leftOut(set.client, SENTENCE[language])).toEqual(
        expect.arrayContaining([
          [set.names.resaved, "same-text"],
          [set.names.pdf, "same-text"],
        ]),
      );
      set.core.close();
    }, 120_000);
  },
);

describe("A Note imported from a file whose original isn't in the Library", () => {
  test("the original deleted later: its copies are still left out and named", async () => {
    const set = await importedNote("en", { addOriginal: true });
    const listed = await waitForDocuments(set.core, (documents) =>
      expect(documents.filter((each) => each.status === "ready")).toHaveLength(4),
    );
    const original = listed.find(
      (each) => ![set.resaved.id, set.pdf.id, set.template.id].includes(each.id),
    );
    if (!original) throw new Error("The original wasn't added.");
    await set.core.deleteDocument(original.id);

    await checkAll(set.core, set.mindId, "all");
    expect(handed(set.calls)).toEqual(new Set([NAMES.en.template]));
    expect(await leftOut(set.client, SENTENCE.en)).toEqual(
      expect.arrayContaining([
        [NAMES.en.resaved, "same-text"],
        [NAMES.en.pdf, "same-text"],
      ]),
    );
    set.core.close();
  }, 120_000);

  test("a duplicate of the Note shares its import: its check leaves the copies out too", async () => {
    const set = await importedNote("en");
    const copy = await set.core.duplicateMind(set.mindId);
    const client = await connectToMind(set.core, copy.id);

    await checkAll(set.core, copy.id, "copy");
    expect(handed(set.calls)).toEqual(new Set([NAMES.en.template]));
    expect(await leftOut(client, SENTENCE.en)).toEqual(
      expect.arrayContaining([
        [NAMES.en.resaved, "same-text"],
        [NAMES.en.pdf, "same-text"],
      ]),
    );
    set.core.close();
  }, 120_000);

  test("the kept file gone: the check goes on with byte-for-byte copies only, so a resaved copy and a PDF are read as evidence", async () => {
    const set = await importedNote("en");
    set.core.close();
    await rm(join(set.dataDir, WORD_PACKAGES_FOLDER, `${sha256(set.word)}.docx`));
    const core = set.start();
    const client = await connectToMind(core, set.mindId);

    await checkAll(core, set.mindId, "gone");
    expect(await leftOut(client, SENTENCE.en)).toEqual([]);
    const found = await core.searchEvidence("registered office", {
      scope: { folderIds: [], tagIds: [], documentIds: [set.resaved.id, set.pdf.id] },
      checked: { contentHashes: [sha256(set.word)] },
    });
    expect(new Set(found.passages.map((passage) => passage.documentName))).toEqual(
      new Set([NAMES.en.resaved, NAMES.en.pdf]),
    );
    expect(found.excluded).toEqual([]);
    core.close();
  }, 120_000);

  test("a byte-for-byte copy of the imported file in the Library is left out, and its text stands for the file's", async () => {
    const set = await importedNote("en");
    const [bytes] = await addAndProcess(set.core, [
      await set.write(`${NAMES.en.bytes}.docx`, set.word),
    ]);
    if (!bytes) throw new Error("Not added.");

    await checkAll(set.core, set.mindId, "bytes");
    expect(handed(set.calls)).toEqual(new Set([NAMES.en.template]));
    expect(await leftOut(set.client, SENTENCE.en)).toEqual(
      expect.arrayContaining([[NAMES.en.bytes, "checked-document"]]),
    );
    set.core.close();
  }, 120_000);

  test("the same check twice gives the same answer", async () => {
    const set = await importedNote("en");
    await checkAll(set.core, set.mindId, "first");
    const first = await leftOut(set.client, SENTENCE.en);
    const asked = set.calls.length;

    await checkAll(set.core, set.mindId, "second");
    expect(handed(set.calls, asked)).toEqual(new Set([NAMES.en.template]));
    expect(await leftOut(set.client, SENTENCE.en)).toEqual(first);
    set.core.close();
  }, 120_000);

  test("a 300-page file: its resaved copy is left out of the evidence", async () => {
    const two = [agreement("en"), sameTemplate("en")];
    const file: Agreement = {
      ...agreement("en"),
      paragraphs: Array.from({ length: 60 }, (_, at) => two[at % 2]?.paragraphs ?? []).flat(),
    };
    const set = await importedNote("en", { file });
    const found = await set.core.searchEvidence("material breach of any term", {
      checked: { contentHashes: [sha256(set.word)] },
    });
    const evidence = new Set(found.passages.map((passage) => passage.documentName));
    expect(evidence.has(NAMES.en.resaved)).toBe(false);
    expect(evidence.has(NAMES.en.pdf)).toBe(false);
    expect(evidence.has(NAMES.en.template)).toBe(true);
    // With two near-identical copies the card may name only one; neither is ever evidence.
    expect(found.excluded.length).toBeGreaterThanOrEqual(1);
    expect(new Set(found.excluded.map((each) => each.reason))).toEqual(new Set(["same-text"]));
    set.core.close();
  }, 180_000);

  test("a Stop while the file is read ends the check at once, with nothing sent", async () => {
    const set = await importedNote("en");
    set.core.close();
    const core = set.start();
    const checking = checkAll(core, set.mindId, "stopped");
    await core.cancelCheck("stopped");

    expect(await checking).toEqual({ kind: "cancelled" });
    expect(set.calls.filter(isCheckRun)).toEqual([]);
    core.close();
  }, 120_000);

  test("the core closed while the file is read: the check ends stopped, a search never goes on, and nothing is sent", async () => {
    const set = await importedNote("en");
    set.core.close();
    const core = set.start();
    const checking = checkAll(core, set.mindId, "closing");
    let searched = false;
    const settled = () => {
      searched = true;
    };
    core
      .searchEvidence("material breach", { checked: { contentHashes: [sha256(set.word)] } })
      .then(settled, settled);
    core.close();

    expect(await checking).toEqual({ kind: "cancelled" });
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(searched).toBe(false);
    expect(set.calls.filter(isCheckRun)).toEqual([]);
  }, 120_000);
});
