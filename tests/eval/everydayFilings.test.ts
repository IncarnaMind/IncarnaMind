import { describe, expect, test } from "vitest";
import { CASES } from "../../eval/everyday/cases";
import { writeFilingDocuments } from "../../eval/everyday/filings";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";

// Each filing's length, and the page and words that hold its figure, as `filings.ts` writes them.
const EXPECTED = new Map([
  [
    "Northmart Q2 2026 10-Q",
    {
      pages: 33,
      page: 30,
      text: "Change in sales from stores and channels open over 13 months",
      figure: "2.1%",
    },
  ],
  [
    "北域零售 2026年第二季度季报",
    { pages: 33, page: 30, text: "开业满 13 个月的门店及渠道销售额变动", figure: "2.1%" },
  ],
  [
    "Harbour Hotels 2026 annual release",
    { pages: 13, page: 11, text: "Operating income as a percentage of revenue", figure: "38.2%" },
  ],
  [
    "港湾酒店 2026年度业绩公告",
    { pages: 13, page: 11, text: "营业利润占收入的百分比", figure: "38.2%" },
  ],
  [
    "Delta Manufacturing 8-K 2026",
    { pages: 18, page: 16, text: "Total segment earnings", figure: "592" },
  ],
  ["三角洲制造 8-K 2026", { pages: 18, page: 16, text: "分部利润合计", figure: "592" }],
]);

describe("The filing evaluation", () => {
  test("builds six readable synthetic filings with each needed figure on its intended page", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await createTempDataFolder();
    const files = await writeFilingDocuments(folder);
    expect(files.map((file) => file.key.replace(/\.pdf$/, "")).sort()).toEqual(
      [...EXPECTED.keys()].sort(),
    );
    const documents = await addAndProcess(
      core,
      files.map((file) => file.path),
    );

    for (const document of documents) {
      const expected = EXPECTED.get(document.name);
      if (!expected) throw new Error(`Unexpected filing: ${document.name}`);
      const stored = await core.readDocumentText(document.id);
      expect(stored.pages).toHaveLength(expected.pages);
      expect(stored.pages[expected.page - 1]?.text).toContain(expected.text);
      expect(stored.pages[expected.page - 1]?.text).toContain(expected.figure);
    }
    core.close();
  });

  test("asks each scenario in English and Chinese, requiring a cited figure and no whole-Document absence", () => {
    const cases = CASES.filter((each) => each.id.startsWith("filing-"));
    expect(cases.map((each) => each.id)).toEqual([
      "filing-comparable-en",
      "filing-comparable-zh",
      "filing-margin-en",
      "filing-margin-zh",
      "filing-recast-en",
      "filing-recast-zh",
      "filing-absent-en",
      "filing-absent-zh",
    ]);
    for (const each of cases) {
      expect(each.expected.documentAbsenceMetric).toEqual(expect.any(String));
      expect(each.expected.documentAbsenceMetric).not.toContain("|");
    }
    for (const each of cases.filter((each) => !each.id.startsWith("filing-absent-"))) {
      expect(each.library).toBe("filings");
      expect(each.expected.cite).toBe(true);
      expect(each.expected.answerWith).toBeInstanceOf(RegExp);
      expect(each.expected.answerEvidence).toBeDefined();
      expect(each.expected.noDocumentAbsence).toBeInstanceOf(RegExp);
    }
    for (const each of cases.filter((each) => each.id.startsWith("filing-absent-"))) {
      expect(each.expected.cite).toBe(false);
      expect(each.expected.searchMiss).toBe(true);
      expect(each.expected.noDocumentAbsence).toBeInstanceOf(RegExp);
    }
  });

  test("the comparable-sales guard requires the rise the 10-Q states, not a decline", () => {
    const english = CASES.find((each) => each.id === "filing-comparable-en");
    const chinese = CASES.find((each) => each.id === "filing-comparable-zh");

    expect(english?.expected.answerWith?.test("Comparable sales rose **2.1%** [^1].")).toBe(true);
    expect(english?.expected.answerWith?.test("Comparable sales declined 2.1%.")).toBe(false);
    expect(chinese?.expected.answerWith?.test("集团同店销售额增长 2.1%。")).toBe(true);
    expect(chinese?.expected.answerWith?.test("集团同店销售额下降 2.1%。")).toBe(false);
  });
});
