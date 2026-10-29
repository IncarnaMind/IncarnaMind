import { describe, expect, test } from "vitest";
import { CASES } from "../../eval/everyday/cases";
import { writeFilingDocuments } from "../../eval/everyday/filings";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";

const EXPECTED = new Map([
  ["Northmart Q2 2026 10-Q", { page: 8, text: "like-for-like sales declined 6.2%" }],
  ["北域零售 2026年第二季度季报", { page: 8, text: "同店销售额下降 6.2%" }],
  [
    "Harbour Hotels 2026 annual release",
    { page: 2, text: "Operating profitability reached 38.2%" },
  ],
  ["港湾酒店 2026年度业绩公告", { page: 2, text: "经营利润率达到 38.2%" }],
  [
    "Delta Manufacturing 8-K 2026",
    { page: 9, text: "Restated second-quarter sales: $423 million" },
  ],
  ["三角洲制造 8-K 2026", { page: 9, text: "重述第二季度销售额：4.23 亿元" }],
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
      expect(stored.pages).toHaveLength(12);
      expect(stored.pages[expected.page - 1]?.text).toContain(expected.text);
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

  test("the comparable-sales guard requires a decline, not an increase", () => {
    const english = CASES.find((each) => each.id === "filing-comparable-en");
    const chinese = CASES.find((each) => each.id === "filing-comparable-zh");

    expect(english?.expected.answerWith?.test("Comparable sales declined 6.2%.")).toBe(true);
    expect(english?.expected.answerWith?.test("Comparable sales increased 6.2%.")).toBe(false);
    expect(chinese?.expected.answerWith?.test("集团同店销售额下降 6.2%。")).toBe(true);
    expect(chinese?.expected.answerWith?.test("集团同店销售额上升 6.2%。")).toBe(false);
  });
});
