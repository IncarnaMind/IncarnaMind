import { describe, expect, test } from "vitest";
import type { ComparisonProblem } from "../../src/core";
import {
  cellProblemMessage,
  cellToFill,
  comparisonCellCounts,
  comparisonCellOf,
  comparisonQuestionsOf,
  comparisonRowMatchesFilter,
} from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

describe("Reading a comparison table", () => {
  test("malformed columns and cells read as their defaults", () => {
    expect(comparisonQuestionsOf({ questions: "nope" })).toEqual([]);
    expect(
      comparisonQuestionsOf({
        questions: [{ id: "q1", text: "A" }, { id: "q1", text: "again" }, { text: "no id" }, null],
      }),
    ).toEqual([{ id: "q1", text: "A" }]);
    expect(comparisonCellOf({ status: "odd" })).toMatchObject({ status: "waiting", problem: null });
    expect(comparisonCellOf({ status: "failed" })).toMatchObject({ problem: "unknown" });
  });

  test("title counts distinguish found nothing from failure and follow the latest cells", () => {
    const cells = [
      { questionId: "q1", status: "done" },
      { questionId: "q2", status: "failed", problem: "not-found" },
      { questionId: "q3", status: "failed", problem: "network" },
      { questionId: "q4", status: "waiting" },
      { questionId: "q5", status: "writing" },
    ].map(comparisonCellOf);
    expect(comparisonCellCounts(cells)).toMatchObject({
      total: 5,
      settled: 3,
      notFound: 1,
      failed: 1,
    });
    const refilled = cells.map((cell) =>
      comparisonCellOf({ ...cell, status: "done", problem: null }),
    );
    expect(comparisonCellCounts(refilled)).toMatchObject({
      total: 5,
      settled: 5,
      notFound: 0,
      failed: 0,
    });
    expect(comparisonCellCounts([])).toMatchObject({ total: 0, notFound: 0, failed: 0 });
  });

  test("problem filters match rows by any cell, and combine only where both kinds occur", () => {
    const done = comparisonCellOf({ questionId: "done", status: "done" });
    const notFound = comparisonCellOf({ questionId: "nf", status: "failed", problem: "not-found" });
    const failed = comparisonCellOf({ questionId: "failed", status: "failed", problem: "network" });
    const rows = [[done, notFound], [done, failed], [notFound, failed], [done]];
    expect(rows.filter((row) => comparisonRowMatchesFilter(row, ["not-found"]))).toEqual([
      rows[0],
      rows[2],
    ]);
    expect(rows.filter((row) => comparisonRowMatchesFilter(row, ["failed"]))).toEqual([
      rows[1],
      rows[2],
    ]);
    expect(rows.filter((row) => comparisonRowMatchesFilter(row, ["not-found", "failed"]))).toEqual([
      rows[2],
    ]);
    expect(rows.filter((row) => comparisonRowMatchesFilter(row, []))).toEqual(rows);
  });

  test("a cell's edited and reviewed marks read as booleans, including HTML's strings", () => {
    expect(comparisonCellOf({ status: "done", edited: true, reviewed: "true" })).toMatchObject({
      edited: true,
      reviewed: true,
    });
    expect(comparisonCellOf({ status: "done", edited: "false", reviewed: false })).toMatchObject({
      edited: false,
      reviewed: false,
    });
  });

  test("filling again writes cells with no Answer, but not those whose Document can't answer", () => {
    expect(cellToFill({ status: "waiting", problem: null })).toBe(true);
    expect(cellToFill({ status: "done", problem: null })).toBe(false);
    for (const problem of ["cost-cap", "plan-limit", "network", "rate-limit"] as const) {
      expect(cellToFill({ status: "failed", problem })).toBe(true);
    }
    for (const problem of ["not-found", "nothing-to-search", "source-removed"] as const) {
      expect(cellToFill({ status: "failed", problem })).toBe(false);
    }
  });

  test("every cell without an Answer says why, in English and Chinese", () => {
    const problems: ComparisonProblem[] = [
      "not-found",
      "scale-changed",
      "nothing-to-search",
      "source-removed",
      "left-out",
      "not-cited",
      "cost-cap",
      "plan-limit",
      "auth",
      "rate-limit",
      "network",
      "consent-declined",
      "local-mode",
      "too-long",
      "provider",
      "unknown",
    ];
    for (const problem of problems) {
      const { key, params } = cellProblemMessage(problem);
      expect(translate("en", key, params)).not.toBe("");
      expect(translate("zh-CN", key, params)).not.toBe("");
    }
    expect(translate("en", cellProblemMessage("cost-cap").key)).toBe("not checked: cost cap");
    expect(translate("zh-CN", cellProblemMessage("not-found").key)).toBe("未找到");
    const scale = cellProblemMessage("scale-changed", "310000 GBP thousands");
    expect(translate("en", scale.key, scale.params)).toBe(
      "scale differs from the Document, which gives 310000 GBP thousands",
    );
    const yuan = cellProblemMessage("scale-changed", "31000 万元");
    expect(translate("zh-CN", yuan.key, yuan.params)).toBe(
      "金额单位与文档不符，文档写的是 31000 万元",
    );
  });

  test("the interface says Compare Documents and comparison table, never Matrix", () => {
    expect(en["command.compareDocuments"]).toBe("Compare Documents…");
    expect(en["comparison.title"]).toBe("Comparison table");
    for (const text of [...Object.values(en), ...Object.values(zhCN)]) {
      expect(text).not.toMatch(/matrix/i);
    }
  });
});
