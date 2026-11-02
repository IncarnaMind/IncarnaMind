import { expect, test } from "vitest";
import type { AnswerToolCall } from "../../src/core/api";
import { analysisCallText as textOf } from "../../src/renderer/src/analysisCall";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";

for (const language of ["en", "zh-CN"] as const) {
  const t: Translate = (key, params) => translate(language, key, params);
  test.each(["done", "failed"] as const)(
    `${language}: a %s call without an Analysis is no longer running`,
    (status) => {
      const call: AnswerToolCall = {
        id: "analysis",
        tool: "run_analysis",
        source: "analysis",
        input: {},
        status,
        resultCount: null,
      };
      expect(textOf(t, call)).toBe(
        language === "en" ? "The analysis didn’t run" : "数据分析未运行",
      );
    },
  );
  test(`${language}: a call still running keeps its progress`, () => {
    const call: AnswerToolCall = {
      id: "analysis",
      tool: "run_analysis",
      source: "analysis",
      input: {},
      status: "running",
      resultCount: null,
    };
    expect(textOf(t, call)).toBe(translate(language, "analysis.call.running"));
  });
}

const runCode = (
  language: unknown,
  status: AnswerToolCall["status"] = "running",
): AnswerToolCall => ({
  id: "code",
  tool: "run_code",
  source: "analysis",
  input: { title: "Probe", language },
  status,
  resultCount: null,
});

const python = (downloadedBytes: number) => ({
  name: "Python 3.14.10",
  host: "github.com",
  state: "downloading" as const,
  downloadedBytes,
  totalBytes: 74_000_000,
  error: null,
});

test.each([
  ["en", "Downloading Python: 31 of 74 MB", "Getting Python ready…"],
  ["zh-CN", "正在下载 Python：31 / 74 MB", "正在准备 Python…"],
] as const)(
  "%s: a run_code call waiting on Python says how far its download has come",
  (language, downloading, unpacking) => {
    const t: Translate = (key, params) => translate(language, key, params);
    expect(textOf(t, runCode("python"), python(31_400_000))).toBe(downloading);
    expect(textOf(t, runCode("python"), python(74_000_000))).toBe(unpacking);
    expect(textOf(t, runCode("bash"), python(31_400_000))).toBe(
      translate(language, "analysis.call.running"),
    );
    expect(textOf(t, runCode("python"), { ...python(74_000_000), state: "ready" })).toBe(
      translate(language, "analysis.call.running"),
    );
  },
);

test.each([
  ["en", "network", "Analysis couldn’t get Python: check your internet connection."],
  ["en", "load", "Analysis couldn’t get Python: it couldn’t start on this computer."],
  ["zh-CN", "network", "无法获取数据分析所需的 Python：请检查网络连接。"],
  ["zh-CN", "integrity", "无法获取数据分析所需的 Python：下载的文件已损坏。"],
] as const)(
  "%s: a run_code call whose Python couldn't be had says why (%s)",
  (language, kind, said) => {
    const t: Translate = (key, params) => translate(language, key, params);
    const call: AnswerToolCall = {
      ...runCode("python", "done"),
      analysis: {
        number: 1,
        title: "Probe",
        documents: ["sales.csv"],
        end: "unavailable",
        reason: "python",
        python: kind,
      },
    };
    expect(textOf(t, call)).toBe(said);
    const ran: AnswerToolCall = {
      ...call,
      analysis: { number: 1, title: "Probe", documents: ["sales.csv"], end: "done" },
    };
    expect(textOf(t, ran)).toBe(
      language === "en" ? "Ran an analysis on sales.csv" : "对“sales.csv”运行了数据分析",
    );
  },
);
