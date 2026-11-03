import { describe, expect, test } from "vitest";
import {
  type AnalysisUnavailableReason,
  CRASHED_LINE,
  LINUX_SANDBOX_HELP_URL,
  UNAVAILABLE_LINES,
} from "../../src/shared/analysis";
import { translate } from "../../src/shared/i18n";

/*
 * Where the User would see an Analysis that couldn't run, or that crashed, they read why, in
 * plain words, in English and in Chinese (ADR-0023); with the sandbox off, a link says how to fix it.
 */

const REASONS = Object.keys(UNAVAILABLE_LINES) as AnalysisUnavailableReason[];

describe("why an Analysis can't run", () => {
  test.each(REASONS)("%s reads in English and in Chinese", (reason) => {
    const line = UNAVAILABLE_LINES[reason];
    const english = translate("en", line.text);
    const chinese = translate("zh-CN", line.text);

    expect(english).toMatch(/^Analys[ei]s /);
    expect(chinese).toMatch(/\p{Script=Han}/u);
    expect(chinese).toMatch(/数据分析|分析/);
    expect(chinese).not.toContain("沙箱");
  });

  test("with the sandbox off, the line links to how to turn it back on", () => {
    const line = UNAVAILABLE_LINES["no-sandbox"];

    expect(translate("en", line.text)).toBe("Analyses need the app’s sandbox, which is off");
    expect(translate("zh-CN", line.text)).toBe("沙盒已关闭，无法运行数据分析");
    expect(line.fix?.url).toBe(LINUX_SANDBOX_HELP_URL);
    expect(line.fix && translate("en", line.fix.label)).toBe("How to fix");
    expect(line.fix && translate("zh-CN", line.fix.label)).toBe("如何解决");
  });

  test("a crash says to run it again, in English and in Chinese", () => {
    expect(translate("en", CRASHED_LINE)).toBe("The analysis stopped unexpectedly. Run it again.");
    expect(translate("zh-CN", CRASHED_LINE)).toBe("数据分析意外停止。请重新运行。");
  });
});

describe("the rows an Analysis figure was worked out from (#2346)", () => {
  const rows = translate("zh-CN", "figures.analysisRows.list.other", { runs: "2–6、8–25" });

  test("a Latin column name has a space on each side of it in Chinese, a Chinese one none", () => {
    const worked = (label: string) =>
      translate("zh-CN", "figures.analysisRows.worked.other", {
        input: "marketing",
        rows,
        label,
        how: translate("zh-CN", "figures.analysisRows.how.count"),
        count: 23,
      });

    expect(worked("Revenue")).toBe("“marketing”第 2–6、8–25 行中 Revenue 的计数（共 23 行）");
    expect(worked("收入")).toBe("“marketing”第 2–6、8–25 行中收入的计数（共 23 行）");
  });

  test("so do the column names a model figure used", () => {
    const used = (names: string) =>
      translate("zh-CN", "figures.analysisRows.used.other", {
        input: "marketing",
        rows,
        count: 23,
        names,
      });

    expect(used("AdSpend、Revenue")).toBe(
      "根据“marketing”第 2–6、8–25 行（共 23 行）计算，用到 AdSpend、Revenue",
    );
    expect(used("广告、收入")).toBe(
      "根据“marketing”第 2–6、8–25 行（共 23 行）计算，用到广告、收入",
    );
  });
});
