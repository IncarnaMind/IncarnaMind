import { appendFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { judgeDocumentAbsence } from "../../eval/everyday/judge";
import { createAiSdkChatModel } from "../../src/core/providers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const CASES = [
  [
    "The release doesn't state the operating margin.",
    "operating margin",
    "What operating margin did the release report?",
    true,
  ],
  [
    "The cash conversion cycle is missing from the 10-Q.",
    "cash conversion cycle",
    "What was the cash conversion cycle?",
    true,
  ],
  [
    "The release was published without specifying the operating margin.",
    "operating margin",
    "What operating margin did the release report?",
    true,
  ],
  ["公告未披露经营利润率。", "经营利润率", "公告中的经营利润率是多少？", true],
  ["公告没有具体说明经营利润率。", "经营利润率", "公告中的经营利润率是多少？", true],
  ["季报中的现金转换周期是缺失的。", "现金转换周期", "季报中的现金转换周期是多少？", true],
  [
    "I didn't find a cash conversion cycle figure for Q2 2026 in the Northmart Q2 2026 10-Q.",
    "cash conversion cycle",
    "What was the cash conversion cycle?",
    false,
  ],
  [
    "未在“北域零售 2026年第二季度季报”中找到现金转换周期。",
    "现金转换周期",
    "季报中的现金转换周期是多少？",
    false,
  ],
  [
    "I didn't find a cash conversion cycle in the 10-Q. The filing doesn't state one.",
    "cash conversion cycle",
    "What was the cash conversion cycle?",
    true,
  ],
  [
    "Operating margin was 38.2% without other income [^1].",
    "operating margin",
    "What operating margin did the release report?",
    false,
  ],
  [
    "Operating margin was 38.2% without including other income [^1].",
    "operating margin",
    "What operating margin did the release report?",
    false,
  ],
  [
    "The 8-K doesn't break out revenue by segment.",
    "recast second-quarter revenue",
    "What was the recast second-quarter revenue?",
    false,
  ],
  ["经营利润率为 38.2%（不含其他收入）[^1]。", "经营利润率", "公告中的经营利润率是多少？", false],
] as const;

test.skipIf(KEY === undefined)(
  `${MODEL}: Document absence judge calibration`,
  { timeout: 600_000 },
  async () => {
    const model = createAiSdkChatModel({
      kind: "anthropic",
      modelId: MODEL,
      apiKey: KEY ?? null,
      baseUrl: null,
      thinking: "off",
    });
    const lines = [`## ${MODEL} Document absence judge`];
    const failures: string[] = [];
    for (const [reply, metric, request, expected] of CASES) {
      const judged = await judgeDocumentAbsence(model, reply, metric, request);
      const actual = judged.length > 0;
      lines.push(
        `- ${reply} [${expected ? "absence" : "not absence"}] → ${JSON.stringify(judged)}`,
      );
      if (actual !== expected)
        failures.push(`${reply}: expected ${expected}, got ${JSON.stringify(judged)}`);
    }
    if (process.env.INCARNAMIND_LIVE_REPORT) {
      await appendFile(
        process.env.INCARNAMIND_LIVE_REPORT,
        `${[...lines, ...failures, ""].join("\n")}\n`,
      );
    }
    expect(failures).toEqual([]);
  },
);
