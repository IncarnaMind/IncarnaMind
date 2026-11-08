/**
 * "What drives 2027 EBITDA, and what if growth is 3%?" (2027 年的 EBITDA 由什么驱动？如果增长率是 3% 呢；
 * #2347): over a DCF workbook, it traces the figure through the workbook's formulas, then
 * works it out again with the growth input at 3% when the Question asks, and writes the markers
 * of the figures the Tools recorded. A Question that supposes two values at once (#2403) works
 * the value per share out again with both; a covenant Question (#2389) records a cell of text.
 */

import { passagesIn } from "./passages";
import { type Prompt, type Reply, toolResults } from "./prompt";

export const WORKBOOK_WHAT_IF = /\bwhat drives 2027 EBITDA\b|2027 年的 EBITDA 由什么驱动/i;

export function workbookWhatIf(prompt: Prompt, question: string, searched: string): Reply {
  const chinese = /\p{Script=Han}/u.test(question);
  const passage = passagesIn(searched)[0]?.id ?? "P1";
  const traced = toolResults(prompt, "trace_formulas");
  if (traced.length === 0)
    return {
      tool: "trace_formulas",
      input: { passage, cell: "DCF!E5", label: chinese ? "2027 年 EBITDA" : "EBITDA 2027" },
    };
  if (!traced.at(-1)?.startsWith("Recorded [=1]"))
    return {
      text: chinese
        ? "无法按工作簿中的公式计算这个数字。"
        : "The workbook's formulas couldn't be traced.",
    };
  const asked = /3%/.test(question);
  if (asked && toolResults(prompt, "what_if").length === 0)
    return {
      tool: "what_if",
      input: {
        passage,
        cell: "DCF!E5",
        label: chinese ? "增长率为 3% 时的 2027 年 EBITDA" : "EBITDA 2027 at 3% growth",
        changes: [{ input: "Growth", value: "3%" }],
      },
    };
  if (!asked)
    return {
      text: chinese
        ? "2027 年的 EBITDA 为 [=1]，由收入增长率和 EBITDA 利润率驱动。"
        : "2027 EBITDA is [=1], driven by revenue growth and the EBITDA margin.",
    };
  if (!toolResults(prompt, "what_if").at(-1)?.startsWith("Recorded [=2]"))
    return {
      text: chinese
        ? "2027 年的 EBITDA 为 [=1]。增长率为 3% 时的结果无法计算。"
        : "2027 EBITDA is [=1]. It couldn't be worked out at 3% growth.",
    };
  return {
    text: chinese
      ? "2027 年的 EBITDA 为 [=1]，由收入增长率和 EBITDA 利润率驱动。增长率为 3% 时，它是 [=2]。"
      : "2027 EBITDA is [=1], driven by revenue growth and the EBITDA margin. At 3% growth it would be [=2].",
  };
}

export const WORKBOOK_TWO_INPUTS = /at the same time|同时/i;

/** "What if growth were 3% and the EBITDA margin 25% at the same time?" (#2403). */
export function workbookTwoInputs(prompt: Prompt, question: string, searched: string): Reply {
  const chinese = /\p{Script=Han}/u.test(question);
  const passage = passagesIn(searched)[0]?.id ?? "P1";
  const traced = toolResults(prompt, "trace_formulas");
  if (traced.length === 0)
    return {
      tool: "trace_formulas",
      input: { passage, cell: "DCF!E5", label: chinese ? "2027 年 EBITDA" : "EBITDA 2027" },
    };
  if (!traced.at(-1)?.startsWith("Recorded [=1]"))
    return {
      text: chinese
        ? "无法按工作簿中的公式计算这个数字。"
        : "The workbook's formulas couldn't be traced.",
    };
  const changed = toolResults(prompt, "what_if");
  if (changed.length === 0)
    return {
      tool: "what_if",
      input: {
        passage,
        cell: "DCF!E5",
        label: chinese
          ? "增长率 3%、利润率 25% 时的 2027 年 EBITDA"
          : "EBITDA 2027 at 3% growth and a 25% margin",
        changes: [
          { input: "Growth", value: "3%" },
          { input: "Margin", value: "25%" },
        ],
      },
    };
  if (!changed.at(-1)?.startsWith("Recorded [=2]"))
    return {
      text: chinese
        ? "无法同时更改这两个输入。"
        : "The figure couldn't be worked out with both inputs changed.",
    };
  return {
    text: chinese
      ? "两项输入同时改动后，2027 年 EBITDA 为 [=2]。工作簿中的原值为 [=1]。"
      : "With both inputs changed, 2027 EBITDA would be [=2]. The workbook as it is gives [=1].",
  };
}

export const WORKBOOK_TEXT_FLAG = /\bcovenant\b|DSCR|约束/i;

/** "Is the covenant met in year 1? Trace the flag." (#2389): a cell whose value is text. */
export function workbookTextFlag(prompt: Prompt, question: string, searched: string): Reply {
  const chinese = /\p{Script=Han}/u.test(question);
  const passage = passagesIn(searched)[0]?.id ?? "P1";
  const traced = toolResults(prompt, "trace_formulas");
  if (traced.length === 0)
    return {
      tool: "trace_formulas",
      input: {
        passage,
        cell: "Operations!B18",
        label: chinese ? "第一年的约束标记" : "Covenant flag, year 1",
      },
    };
  if (!traced.at(-1)?.startsWith("Recorded [=1]"))
    return {
      text: chinese ? "无法追踪这个标记。" : "The flag couldn't be traced.",
    };
  return {
    text: chinese ? "第一年的约束标记为 [=1]。" : "The covenant flag for year 1 is [=1].",
  };
}
