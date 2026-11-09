/**
 * A copy of the checked file that isn't the same bytes (#2216), through the core's public
 * interface: a Document that holds nearly all of the checked file's text is left out of a
 * check's evidence and named with its reason, whatever its format; one that shares only part
 * of it is still searched. The pairs are the ruling's, in English and Chinese.
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type Document, type SearchScope } from "../../src/core";
import { kindOf } from "../../src/core/documents/files";
import { processFile } from "../../src/core/documents/processing";
import { heldShare, shinglesOf } from "../../src/core/documents/textCopies";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, nextEvent, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, waitForProcessing } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";
import {
  agreement,
  firstClauses,
  type Language,
  sameTemplate,
} from "../helpers/sameTextAgreements";
import {
  type CopyPair,
  copyPairs,
  type FixtureFile,
  printedPdf,
  wordOf,
} from "../helpers/sameTextFiles";

const LANGUAGES: readonly Language[] = ["en", "zh"];

/** Words of clause 13.2, which every draft, the template's other file and the reply hold; and of the code the data clause quotes. */
const QUERIES = {
  en: {
    clause: "material breach of any term remedy it within thirty days of being notified",
    code: "share a tenant's records with a third party",
  },
  zh: { clause: "严重违反本合同约定 三十日内未予纠正", code: "不得向第三方提供住户的记录" },
} as const;

const REPLY = "a reply quoting two paragraphs";

const only = (...documentIds: string[]): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds,
});

/** A Library of every file of the language's pairs, each once. */
async function library(language: Language, files: readonly FixtureFile[] = []) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const folder = await createSourceFolder();
  const pairs = copyPairs(language);
  const all = new Map<string, FixtureFile>();
  for (const pair of pairs) for (const file of [pair.checked, pair.other]) all.set(file.name, file);
  for (const file of files) all.set(file.name, file);
  const paths: string[] = [];
  for (const file of all.values()) {
    const path = join(folder, file.name);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  const documents = await addAndProcess(core, paths, 60_000);
  const named = (name: string): Document => {
    const found = documents.find((each) => each.path.endsWith(name));
    if (!found) throw new Error(`${name} wasn't added.`);
    return found;
  };
  const reply = pairs.find((pair) => pair.pair === REPLY);
  if (!reply) throw new Error("No reply.");
  return { core, dataDir, folder, pairs, named, reply: named(reply.other.name) };
}

/** What a check of `checked` finds for the pair's words among `scope`: the Documents it reads, and those it left out, with why. */
async function checkOf(core: Core, query: string, checked: Document, scope: Document[]) {
  const found = await core.searchEvidence(query, {
    scope: only(...scope.map((each) => each.id)),
    checked: { documentIds: [checked.id] },
  });
  return {
    evidence: new Set(found.passages.map((passage) => passage.documentId)),
    leftOut: found.excluded.map((each) => [each.documentName, each.reason]),
  };
}

const queryFor = (language: Language, pair: CopyPair) =>
  pair.pair === "a source the checked file quotes" ? QUERIES[language].code : QUERIES[language].clause;

describe.each(LANGUAGES)("A copy of the checked file by its text (%s)", (language) => {
  test("each of the ruling's copies is left out, named, with its reason; a reply quoting two of its paragraphs is still searched", async () => {
    const { core, pairs, named, reply } = await library(language);
    for (const pair of pairs.filter((each) => each.copy)) {
      const other = named(pair.other.name);
      const found = await checkOf(core, queryFor(language, pair), named(pair.checked.name), [
        other,
        reply,
      ]);
      expect(found.leftOut, pair.pair).toContainEqual([other.name, "same-text"]);
      expect(found.evidence.has(other.id), pair.pair).toBe(false);
      expect(found.evidence.has(reply.id), pair.pair).toBe(true);
    }
  }, 120_000);

  test("each Document that shares only part of the file is still evidence, and named as left out by nothing", async () => {
    const { core, pairs, named } = await library(language);
    for (const pair of pairs.filter((each) => !each.copy)) {
      const other = named(pair.other.name);
      const found = await checkOf(core, queryFor(language, pair), named(pair.checked.name), [
        other,
      ]);
      expect(found.evidence.has(other.id), pair.pair).toBe(true);
      expect(found.leftOut, pair.pair).toEqual([]);
    }
  }, 120_000);
});

describe("The shares measured for #2216", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "text-copies-"));
  });
  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  /** The text processing stores for a file, as shingles. */
  async function shinglesStored(file: FixtureFile) {
    const folder = await mkdtemp(join(scratch, "file-"));
    const path = join(folder, file.name);
    await writeFile(path, file.bytes);
    const kind = kindOf(path);
    if (!kind) throw new Error(`${file.name} isn't a Document.`);
    const result = await processFile({ task: "process", documentId: file.name, kind, file: path });
    if (result.outcome !== "ready") throw new Error(`${file.name} wasn't read.`);
    return shinglesOf(result.pages);
  }

  test.each(LANGUAGES)("in %s: every copy holds 90% or more of the checked text, every other Document less, and the checked text is past 200 shingles", async (language) => {
    for (const pair of copyPairs(language)) {
      const checked = await shinglesStored(pair.checked);
      const share = heldShare(checked, await shinglesStored(pair.other));
      expect(checked.length, pair.pair).toBeGreaterThan(200);
      if (pair.copy) expect(share, pair.pair).toBeGreaterThanOrEqual(0.9);
      else expect(share, pair.pair).toBeLessThan(0.9);
    }
  }, 60_000);
});

describe("Where the rule stops", () => {
  test("a file shorter than the rule applies to is matched by its bytes only: its resaved copy is evidence, a byte copy is left out; one a little longer leaves its resaved copy out", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await createSourceFolder();
    const write = async (name: string, bytes: Uint8Array) => {
      const path = join(folder, name);
      await writeFile(path, bytes);
      return path;
    };
    const short = firstClauses(agreement("en"), 0);
    const longer = firstClauses(agreement("en"), 1);
    const shortPath = await write("Short.docx", wordOf(short, "en"));
    await mkdir(join(folder, "Sent"));
    const bytesCopy = join(folder, "Sent", "Short.docx");
    await copyFile(shortPath, bytesCopy);
    const [checked, resaved, copy, longChecked, longResaved] = await addAndProcess(core, [
      shortPath,
      await write("Short (saved again).docx", wordOf(short, "en", "saved again")),
      bytesCopy,
      await write("Longer.docx", wordOf(longer, "en")),
      await write("Longer (saved again).docx", wordOf(longer, "en", "saved again")),
    ]);
    if (!checked || !resaved || !copy || !longChecked || !longResaved) throw new Error("Not added.");

    const query = "registered office";
    const shortCheck = await checkOf(core, query, checked, [resaved, copy]);
    expect(shortCheck.evidence).toEqual(new Set([resaved.id]));
    expect(shortCheck.leftOut).toEqual([["Short", "checked-document"]]);

    const longCheck = await checkOf(core, query, longChecked, [longResaved]);
    expect(longCheck.evidence.size).toBe(0);
    expect(longCheck.leftOut).toEqual([["Longer (saved again)", "same-text"]]);
  });

  test("a checked file with no text to compare, a scan nobody read or an empty file, makes no Document a copy; nor is a broken file one", async () => {
    const { core, folder, named } = await library("en");
    const scan = join(folder, "Scanned agreement.pdf");
    await writeFile(scan, buildPdf([{ image: true }, { image: true }]));
    const empty = join(folder, "Agreement notes.txt");
    await writeFile(empty, "");
    const broken = join(folder, "Agreement (damaged).docx");
    await writeFile(broken, Buffer.from("PK\u0003\u0004 not a whole package"));
    const [unread, nothing, damaged] = await addAndProcess(core, [scan, empty, broken]);
    if (!unread || !nothing || !damaged) throw new Error("Not added.");
    expect([unread.status, nothing.status, damaged.status]).toEqual(["no-text", "no-text", "failed"]);

    const word = named("Services Agreement.docx");
    for (const checked of [unread, nothing]) {
      const found = await checkOf(core, QUERIES.en.clause, checked, [word]);
      expect(found.evidence).toEqual(new Set([word.id]));
      expect(found.leftOut).toEqual([]);
    }
    const pdf = named("Services Agreement.pdf");
    const withBroken = await checkOf(core, QUERIES.en.clause, word, [pdf, damaged]);
    expect(withBroken.leftOut).toEqual([["Services Agreement", "same-text"]]);
  }, 60_000);

  test("a huge bundle holding the file is left out; checking the bundle leaves out nothing the file alone holds", async () => {
    const filler = Array.from({ length: 10 }, () => sameTemplate("en"));
    const bundle: FixtureFile = {
      name: "Disclosure bundle.pdf",
      bytes: printedPdf([...filler, agreement("en"), ...filler], "en", "Disclosure bundle").bytes,
    };
    const { core, named, reply } = await library("en", [bundle]);
    const huge = named(bundle.name);
    expect(huge.pageCount ?? 0).toBeGreaterThan(100);
    const word = named("Services Agreement.docx");

    const ofFile = await checkOf(core, QUERIES.en.clause, word, [huge, reply]);
    expect(ofFile.leftOut).toContainEqual(["Disclosure bundle", "same-text"]);
    expect(ofFile.evidence.has(reply.id)).toBe(true);

    const ofBundle = await checkOf(core, QUERIES.en.clause, huge, [word, reply]);
    expect(ofBundle.evidence).toEqual(new Set([word.id, reply.id]));
    expect(ofBundle.leftOut).toEqual([]);
  }, 120_000);
});

describe("A copy that changes", () => {
  test("twice gives the same answer; deleted, a copy is gone from the check and left out again once restored; given other text, it is evidence again", async () => {
    const { core, folder, named, reply } = await library("zh");
    const word = named("技术服务合同.docx");
    const pdf = named("技术服务合同.pdf");
    const check = () => checkOf(core, QUERIES.zh.clause, word, [pdf, reply]);

    const first = await check();
    expect(first.leftOut).toEqual([["技术服务合同", "same-text"]]);
    expect(await check()).toEqual(first);

    await core.deleteDocument(pdf.id);
    const deleted = await check();
    expect(deleted.leftOut).toEqual([]);
    expect(deleted.evidence).toEqual(new Set([reply.id]));

    await core.restore([{ kind: "document", id: pdf.id }]);
    expect((await check()).leftOut).toEqual([["技术服务合同", "same-text"]]);

    // Saved over with another deal's agreement: its new text is the template's, not a copy.
    await writeFile(join(folder, "技术服务合同.pdf"), printedPdf([sameTemplate("zh")], "zh").bytes);
    const changed = nextEvent(core, "document.status");
    await core.reconcileDocuments();
    await changed;
    await waitForProcessing(core, [pdf.id]);
    const replaced = await check();
    expect(replaced.leftOut).toEqual([]);
    expect(replaced.evidence).toEqual(new Set([pdf.id, reply.id]));
  }, 120_000);

  test("Documents stored before fingerprints were are fingerprinted after the start, without a check; a check before that still leaves the copy out", async () => {
    const { core, dataDir, named, reply } = await library("en");
    const word = named("Services Agreement.docx");
    const pdf = named("Services Agreement.pdf");
    const fingerprints = () =>
      queryDatabase<{ count: number }>(
        dataDir,
        "SELECT COUNT(*) AS count FROM text_fingerprints WHERE deleted_at IS NULL",
      )[0]?.count ?? 0;
    const stored = fingerprints();
    expect(stored).toBeGreaterThan(0);
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("DELETE FROM text_fingerprints");
    db.close();

    const again = startCore(dataDir);
    again.fillTextFingerprints();
    await vi.waitFor(() => expect(fingerprints()).toBe(stored), { timeout: 15_000 });
    again.close();

    const cleared = openDatabase(join(dataDir, DATABASE_FILE));
    cleared.run("DELETE FROM text_fingerprints");
    cleared.close();
    const third = startCore(dataDir);
    const found = await checkOf(third, QUERIES.en.clause, word, [pdf, reply]);
    expect(found.leftOut).toEqual([["Services Agreement", "same-text"]]);
    expect(found.evidence).toEqual(new Set([reply.id]));
  }, 120_000);
});
