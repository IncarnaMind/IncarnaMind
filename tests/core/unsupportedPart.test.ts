import { expect, test } from "vitest";
import { readVerdict } from "../../src/core/answers/checks/prompt";

test.each([
  [
    "English lines",
    "Verdict: supported\nExplanation: The Document says so [^1].",
    "The Document says so.",
  ],
  ["Chinese lines", "Verdict: supported\nExplanation: 文档这样写 [^1]。", "文档这样写。"],
  [
    "English JSON",
    '{"verdict":"supported","says":"The Document says so [^1]."}',
    "The Document says so.",
  ],
  ["Chinese JSON", '{"verdict":"supported","says":"文档这样写 [^1]。"}', "文档这样写。"],
])("a supported %s reply preserves its explanation", (_name, reply, says) => {
  expect(readVerdict(reply)).toEqual({ verdict: "supported", says, evidence: null });
});
