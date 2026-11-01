/**
 * "What drives 2027 EBITDA, and what if growth is 3%?" (2027 年的 EBITDA 由什么驱动？如果增长率是 3% 呢；
 * #2347): over a DCF workbook, it traces the figure through the workbook's formulas, then
 * works it out again with the growth input at 3%, and writes both figures' markers.
 */

import { passagesIn } from "./passages";
import { type Prompt, type Reply, toolResults } from "./prompt";

export const WORKBOOK_WHAT_IF = /\bwhat drives 2027 EBITDA\b|2027 年的 EBITDA 由什么驱动/i;

export function workbookWhatIf(prompt: Prompt, question: string, searched: string): Reply {
  const chinese = /\p{Script=Han}/u.test(question);
  const passage = passagesIn(searched)[0]?.id ?? "P1";
  if (toolResults(prompt, "trace_formulas").length === 0)
    return {
      tool: "trace_formulas",
      input: { passage, cell: "DCF!E5", label: chinese ? "2027 年 EBITDA" : "EBITDA 2027" },
    };
  if (toolResults(prompt, "what_if").length === 0)
    return {
      tool: "what_if",
      input: {
        passage,
        cell: "DCF!E5",
        label: chinese ? "增长率为 3% 时的 2027 年 EBITDA" : "EBITDA 2027 at 3% growth",
        input: "Growth",
        value: "3%",
      },
    };
  return {
    text: chinese
      ? "2027 年的 EBITDA 为 [=1]，由收入增长率和 EBITDA 利润率驱动。增长率为 3% 时，它是 [=2]。"
      : "2027 EBITDA is [=1], driven by revenue growth and the EBITDA margin. At 3% growth it would be [=2].",
  };
}
