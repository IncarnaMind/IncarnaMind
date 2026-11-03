/**
 * Keyword search's words (ADR-0009): the one place the keyword index's text
 * and a query's terms are made, where traditional Chinese characters are read
 * as simplified ones.
 */
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { keywordQuery, keywordTerms, keywordText } from "../../src/core/documents/keywords";
import { SIMPLIFIED } from "../../src/shared/hanVariants";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  unfoldedKeywords,
  writeSourceFile,
} from "../helpers/documents";

const TRADITIONAL = "可持續發展目標是聯合國制定的十七個全球發展目標。";
const SIMPLIFIED_TEXT = "可持续发展目标是联合国制定的十七个全球发展目标。";

/** Each traditional character as its simplified one, after the text was split. */
const foldedAfter = (words: string) =>
  [...words].map((char) => SIMPLIFIED.get(char) ?? char).join("");

describe("Keyword search's words", () => {
  test("traditional Chinese characters are read as simplified ones, in the index and in queries alike", () => {
    expect(keywordText(TRADITIONAL)).toBe(keywordText(SIMPLIFIED_TEXT));
    expect(keywordText(TRADITIONAL)).not.toMatch(/[續發標聯國個]/);
    expect(keywordQuery("聯合國的目標")).toBe(keywordQuery("联合国的目标"));
  });

  test("the characters are folded before the text is split, so both scripts split into the same words", () => {
    const traditional = "聯合國大會通過了這項決議";
    const simplified = "联合国大会通过了这项决议";
    expect(keywordText(traditional)).toBe(keywordText(simplified));
    // Split first, they don't: the traditional text has other words to match.
    expect(foldedAfter(unfoldedKeywords(traditional))).not.toBe(keywordText(simplified));
  });

  test("a traditional stopword is left out of a query like its simplified one", () => {
    expect(keywordTerms("什麼是聯合國？")).toEqual(keywordTerms("什么是联合国？"));
    expect(keywordTerms("什麼")).toEqual([]);
  });

  test("text with no traditional characters gives the words it gave before", () => {
    for (const text of [
      SIMPLIFIED_TEXT,
      "The Transformer relies entirely on self-attention.",
      "カタカナとひらがなの文",
      "한국어 문장은 띄어 씁니다",
    ]) {
      expect(keywordText(text)).toBe(unfoldedKeywords(text));
    }
  });
});

describe("Keyword search's query terms", () => {
  test("an English possessive is searched without its 's, straight or curly, and a plural's trailing ' is no term", () => {
    expect(keywordTerms("Costco's revenue")).toEqual(["costco", "revenue"]);
    expect(keywordTerms("Costco’s revenue")).toEqual(["costco", "revenue"]);
    expect(keywordTerms("the dogs’ toys")).toEqual(["dogs", "toys"]);
    // The index keeps the apostrophe, which its tokenizer splits on: nothing there changes.
    expect(keywordText("Costco’s revenue")).toBe("costco's revenue");
  });

  test("a run of single Han characters is one phrase, and a stopword or other word ends it", () => {
    expect(keywordTerms("五粮液")).toEqual(["五 粮 液"]);
    expect(keywordQuery("五粮液")).toBe('"五 粮 液"');
    expect(keywordTerms("茅台和五粮液")).toEqual(["茅台", "五 粮 液"]);
    expect(keywordTerms("贵州茅台五粮液集团")).toEqual(["贵州", "茅台", "五 粮 液", "集团"]);
    expect(keywordTerms("五粮液，五粮液")).toEqual(["五 粮 液"]);
  });
});

describe("Searching with a possessive or a split Chinese name", { timeout: 30_000 }, () => {
  async function libraryOf(files: { name: string; contents: string }[]) {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const paths = await Promise.all(
      files.map((file) => writeSourceFile(sources, file.name, file.contents)),
    );
    await addAndProcess(core, paths);
    return core;
  }
  const namesFor = async (core: Core, query: string) =>
    (await core.searchPassages(query, { mode: "keyword" })).map((passage) => passage.documentName);

  test("Costco's finds a Passage that says Costco, with either apostrophe, and one that says Costco's", async () => {
    const core = await libraryOf([
      { name: "Plain.txt", contents: "Costco revenue grew in the fourth quarter.\n" },
      { name: "Possessive.txt", contents: "Costco’s membership fees rose again.\n" },
      { name: "Other.txt", contents: "Walmart sells groceries at low prices.\n" },
    ]);

    expect(await namesFor(core, "Costco's revenue")).toContain("Plain");
    expect(await namesFor(core, "Costco’s revenue")).toContain("Plain");
    expect(await namesFor(core, "Costco's membership")).toContain("Possessive");
    expect(await namesFor(core, "Costco's revenue")).not.toContain("Other");
  });

  test("a name the segmenter splits into single characters still matches as a whole", async () => {
    const core = await libraryOf([
      { name: "Liquor.txt", contents: "五粮液是中国著名的白酒品牌。\n" },
      { name: "Scattered.txt", contents: "五个人买了粮食，喝了液体。\n" },
      { name: "Traditional.txt", contents: "五糧液是中國著名的白酒品牌。\n" },
    ]);

    const found = await namesFor(core, "五粮液");
    expect(found).toContain("Liquor");
    expect(found).toContain("Traditional");
    expect(found).not.toContain("Scattered");
    expect(await namesFor(core, "茅台和五粮液")).toContain("Liquor");
  });
});

describe("A Document's name in the keyword index", { timeout: 30_000 }, () => {
  /** More than one Passage: about 500 tokens each, and a Han character counts one. */
  const LONG_ENGLISH = Array.from(
    { length: 60 },
    (_, line) => `Entry ${line} notes ordinary weather and quiet coastal traffic.`,
  ).join("\n");
  const LONG_CHINESE = Array.from(
    { length: 160 },
    (_, line) => `第${line}条记录只谈论普通的沿海天气和安静的交通。`,
  ).join("\n");

  const matching = (dataDir: string, word: string, table = "passages_fts") =>
    queryDatabase(dataDir, `SELECT rowid FROM ${table} WHERE ${table} MATCH ?`, [`"${word}"`])
      .length;

  for (const [name, word, contents] of [
    ["Annual Report", "report", LONG_ENGLISH],
    ["年度报告", "报告", LONG_CHINESE],
  ] as const) {
    test(`“${word}” in ${name}'s name weighs the Document once, and still finds its Passages (#2042)`, async () => {
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir);
      const sources = await createSourceFolder();
      const [document] = await addAndProcess(core, [
        await writeSourceFile(sources, `${name}.txt`, contents),
      ]);
      if (!document) throw new Error("Nothing was added.");
      const positions = queryDatabase<{ position: number }>(
        dataDir,
        "SELECT position FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
        [document.id],
      ).map((row) => row.position);
      expect(positions.length).toBeGreaterThan(1);

      // No Passage's row holds the name: a word of it counts once, with its Document.
      expect(matching(dataDir, word)).toBe(0);
      expect(matching(dataDir, word, "document_names_fts")).toBe(1);
      // Its name alone still finds the Passages, as a Document filter does, in reading order.
      const found = await core.searchPassages(word, { mode: "keyword" });
      expect(new Set(found.map((passage) => passage.documentId))).toEqual(new Set([document.id]));
      expect(found.map((passage) => passage.position)).toEqual(positions.slice(0, found.length));
      core.close();
    });
  }

  test("a Passage that says a name's word ranks above one whose Document's name alone holds it (#2042)", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const sources = await createSourceFolder();
    const added = (await addAndProcess(core, [
      await writeSourceFile(sources, "Annual Report.txt", LONG_ENGLISH),
      await writeSourceFile(sources, "Weekly Log.txt", "Annual rainfall rose through the year."),
    ])) as [Document, Document];
    const [named, saying] = added;

    // Both Documents hold a word of the query; the one that says both in its Passages comes
    // first, and the other is still found by its name.
    const found = await core.searchPassages("annual rainfall", { mode: "keyword" });
    expect(found[0]?.documentId).toBe(saying.id);
    expect(new Set(found.map((passage) => passage.documentId))).toEqual(
      new Set([saying.id, named.id]),
    );
    // A word in neither a Passage nor a name finds nothing.
    expect(await core.searchPassages("harbourmaster", { mode: "keyword" })).toEqual([]);
    core.close();
  });
});
