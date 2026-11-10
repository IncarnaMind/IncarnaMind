/**
 * A Note imported from a file whose original isn't a Document (#2216), through the core's public
 * interface: its check compares the file as it was imported, kept with the Note, so a resaved
 * copy or a PDF of that file in the Library is left out and named, while a file that only shares
 * some of its text is still evidence. Nothing is stored for it, and a kept file that is gone
 * leaves out byte-for-byte copies only.
 */
import { execFileSync } from "node:child_process";
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type Document, type WrittenCheckProgress } from "../../src/core";
import type { OfficeConverter } from "../../src/core/adapters";
import { createEvidence } from "../../src/core/documents/evidence";
import { createTextCopies } from "../../src/core/documents/textCopies";
import { migrate, openDatabase } from "../../src/core/storage";
import { WORD_PACKAGES_FOLDER } from "../../src/core/wordImports";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkingModel, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, sha256, waitForDocuments } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import {
  type Agreement,
  agreement,
  firstClauses,
  type Language,
  sameTemplate,
} from "../helpers/sameTextAgreements";
import { printedPdf, wordOf } from "../helpers/sameTextFiles";
import { importWordBytes, importWordMind } from "../helpers/wordMinds";

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

/** Checks as `checkingModel` does, and answers by adding `sentence` to the Note it is asked in. */
function addingModel(plans: Record<string, Plan>, sentence: string, calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call)) return checkReply(call, plans);
      if (call.results.some((result) => result.tool === "add_to_mind")) {
        return { text: "Added it to your Note." };
      }
      return { calls: [{ tool: "add_to_mind", input: { content: sentence } }] };
    },
    { generate: checkGenerate(plans) },
  );
}

/**
 * The checked file and its copies in the Library, then the file imported as a Note. With
 * `adds`, the assistant answers by adding the checked sentence to the Note.
 */
async function importedNote(
  language: Language,
  {
    addOriginal = false,
    file = firstClauses(agreement(language), 1),
    converted = false,
    adds = false,
  } = {},
) {
  const calls: ModelCall[] = [];
  const plans: Record<string, Plan> = { [SENTENCE[language]]: { verdict: "unsupported" } };
  const model = adds ? addingModel(plans, SENTENCE[language], calls) : checkingModel(plans, calls);
  const dataDir = await createTempDataFolder();
  const names = NAMES[language];
  const word = wordOf(file, language);
  // A LibreOffice that "converts" an older .doc into the agreement's .docx.
  const officeConverter: OfficeConverter = {
    available: async () => true,
    convert: async () => ({ outcome: "converted", name: `${names.original}.docx`, bytes: word }),
  };
  const start = () =>
    startCore(dataDir, {
      createChatModel: scriptedModels(model).createChatModel,
      ...(converted && { officeConverter }),
    });
  const core = start();
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
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
  const imported = async () => {
    if (!converted) {
      return importWordBytes(core, await createSourceFolder(), word, {
        name: `${names.original}.docx`,
        origin: "own",
        folderId: null,
        addOriginal,
      });
    }
    const legacy = await write(`${names.original}.doc`, new TextEncoder().encode("an older .doc"));
    const made = await core.convertWordFile(legacy);
    if (made.outcome !== "converted") throw new Error(JSON.stringify(made));
    return importWordMind(core, { path: made.path, origin: "own", folderId: null, addOriginal });
  };
  const { mindId, client } = await imported();
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

const bothCopies = expect.arrayContaining([
  [NAMES.en.resaved, "same-text"],
  [NAMES.en.pdf, "same-text"],
]);

const turns = async (count: number) => {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Makes the kept file a named pipe, so its read holds: `started` settles once the worker has
 * opened it, and the read ends only when the pipe it gives is closed.
 */
async function heldRead(dataDir: string, word: Uint8Array) {
  const kept = join(dataDir, WORD_PACKAGES_FOLDER, `${sha256(word)}.docx`);
  await rm(kept);
  execFileSync("mkfifo", [kept]);
  return { started: () => open(kept, "w") };
}

// A named pipe holds the read open, and Windows has no mkfifo to make one.
const withHeldRead = test.skipIf(process.platform === "win32");

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

  test("a Note imported from an older .doc converted on import, its original never added: the copies are left out", async () => {
    const set = await importedNote("en", { addOriginal: true, converted: true });
    expect(
      (await set.core.listDocuments()).filter((each) => each.name === NAMES.en.original),
    ).toHaveLength(0);

    await checkAll(set.core, set.mindId, "converted");
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

  withHeldRead(
    "a Stop while the file is read ends the check at once, before the read ends, with nothing sent",
    async () => {
      const set = await importedNote("en");
      set.core.close();
      const held = await heldRead(set.dataDir, set.word);
      const core = set.start();
      const checking = checkAll(core, set.mindId, "stopped");
      const pipe = await held.started();
      try {
        await core.cancelCheck("stopped");
        expect(await checking).toEqual({ kind: "cancelled" });
        expect(set.calls.filter(isCheckRun)).toEqual([]);
      } finally {
        await pipe.close();
      }
      core.close();
    },
    120_000,
  );

  withHeldRead(
    "the core closed while the file is read: the check ends stopped, a search waiting on the same read never goes on, and nothing is sent",
    async () => {
      const set = await importedNote("en");
      set.core.close();
      const held = await heldRead(set.dataDir, set.word);
      const core = set.start();
      const checking = checkAll(core, set.mindId, "closing");
      const pipe = await held.started();
      try {
        let searched = false;
        const settled = () => {
          searched = true;
        };
        core
          .searchEvidence("material breach", { checked: { contentHashes: [sha256(set.word)] } })
          .then(settled, settled);
        // A turn, so the search waits on the same read before the core closes.
        await turns(1);
        core.close();

        expect(await checking).toEqual({ kind: "cancelled" });
        await turns(5);
        expect(searched).toBe(false);
        expect(set.calls.filter(isCheckRun)).toEqual([]);
      } finally {
        await pipe.close();
      }
    },
    120_000,
  );

  /**
   * The assistant asked to add to the Note, as its kept file's read holds; resolves once the read
   * has begun. `answered` settles as the Answer finishes, before its write's check ends.
   */
  async function addedWhileRead(set: Awaited<ReturnType<typeof importedNote>>) {
    set.core.close();
    const held = await heldRead(set.dataDir, set.word);
    const core = set.start();
    const ended: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => {
      if (!event.running) ended.push(event);
    });
    const finished: string[] = [];
    core.on("answer.finished", (event) => finished.push(event.answerId));
    const asked = await core.askInConversation({
      text: "Add the clause on the singular to this Note",
      mindId: set.mindId,
    });
    if (!asked.asked) throw new Error("Not asked.");
    const { answerId } = asked;
    const answered = vi.waitFor(() => expect(finished).toContain(answerId), {
      timeout: 20_000,
      interval: 5,
    });
    const pipe = await held.started();
    return { core, ended, answered, pipe };
  }

  // protects=the reply to a write into a Note imported from Word comes while its file is still read, and the write's check, once the file is read, leaves its copies out (#2830, #2216); fails_when=the reply waits for the read, or the check hands the model a copy; no_claim=how long a real file takes to read.
  withHeldRead(
    "the assistant adds to the Note while its file is read: the reply comes at once, and the check leaves the copies out once the file is read",
    async () => {
      const set = await importedNote("en", { adds: true });
      const { core, ended, answered, pipe } = await addedWhileRead(set);
      try {
        await answered;
        expect(set.calls.filter(isCheckRun)).toEqual([]);
        await pipe.write(set.word);
      } finally {
        await pipe.close();
      }

      await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 60_000 });
      expect(set.calls.filter(isCheckRun).length).toBeGreaterThan(0);
      expect(handed(set.calls)).toEqual(new Set([NAMES.en.template]));
      expect(await leftOut(await connectToMind(core, set.mindId), SENTENCE.en)).toEqual(bothCopies);
      core.close();
    },
    120_000,
  );

  // protects=the core closed while a write's check waits on the Note's file being read: the check ends at once, its sentence stopped, and nothing is sent (#2830, #2216); fails_when=close leaves the check waiting on the read, or it goes on and sends; no_claim=what a check whose requests are out does as the core closes.
  withHeldRead(
    "the core closed while a write's check waits on the file being read: the check ends stopped, and nothing is sent",
    async () => {
      const set = await importedNote("en", { adds: true });
      const { core, ended, answered, pipe } = await addedWhileRead(set);
      try {
        await answered;
        core.close();
        expect(ended).toEqual([expect.objectContaining({ running: false })]);
      } finally {
        await pipe.close();
      }

      await turns(5);
      expect(set.calls.filter(isCheckRun)).toEqual([]);
      const again = set.start();
      const client = await connectToMind(again, set.mindId);
      await client.settled();
      const check = claimSpans(readMind(client)).find(
        (span) => span.sentence.text.trim() === SENTENCE.en,
      )?.check;
      expect([check?.state, check?.reason]).toEqual(["not-checked", "stopped"]);
      again.close();
    },
    120_000,
  );
});

describe("A search that arrives after the core has closed", () => {
  test("with the imported file it neither settles nor throws; on an open core it leaves the copies out as before", async () => {
    const set = await importedNote("en");
    const search = (core: Core) =>
      core.searchEvidence("material breach of any term", {
        checked: { contentHashes: [sha256(set.word)] },
      });
    set.core.close();
    const ended: string[] = [];
    search(set.core).then(
      () => ended.push("settled"),
      (error: unknown) => ended.push(`threw ${String(error)}`),
    );
    await turns(5);
    expect(ended).toEqual([]);

    const core = set.start();
    const found = await search(core);
    expect(found.excluded.map((each) => [each.documentName, each.reason])).toEqual(bothCopies);
    core.close();
  }, 120_000);
});

describe("A read of the kept file that fails", () => {
  // Through the core the worker's read never fails (a failure comes back as unread), so the
  // guard is shown on the module.
  test("counts as a file that couldn't be read: the wait ends, with a Stop and without, the warning is logged, and it isn't read again", async () => {
    const db = openDatabase(join(await createTempDataFolder(), DATABASE_FILE));
    migrate(db);
    const warned: string[] = [];
    let reads = 0;
    const evidence = createEvidence({
      db,
      textCopies: createTextCopies(db, () => new Date().toISOString()),
      textFingerprinted: () => Promise.resolve(),
      readImported: () => {
        reads += 1;
        return Promise.reject(new Error("The worker went away."));
      },
      log: { info() {}, warn: (event) => warned.push(event), error() {} },
      leaveOutOwnFiles: () => true,
      search: async () => [],
    });
    const file = (digit: string) => () => ({ contentHashes: [digit.repeat(64)] });

    await evidence.ready(undefined, file("a"));
    await evidence.ready(new AbortController().signal, file("b"));
    await evidence.ready(undefined, file("a"));
    expect(reads).toBe(2);
    expect(warned).toEqual(["checks.importedFileUnread", "checks.importedFileUnread"]);
    db.close();
  });
});
