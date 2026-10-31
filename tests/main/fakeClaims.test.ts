import { expect, test } from "vitest";
import {
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
  readClaimParts,
} from "../../src/core/answers/checks/claims";
import { fakeClaims } from "../../src/main/fakeChat/claims";
import type { GenerateOptions } from "../../src/main/fakeChat/prompt";

const options = (text: string): GenerateOptions => ({
  prompt: [
    { role: "system", content: FIND_OWN_CLAIMS_INSTRUCTIONS },
    { role: "user", content: [{ type: "text", text }] },
  ],
});

test("the scripted sorter preserves multiline text and numbered words inside it", () => {
  const text = "Revenue rose 8%\nin June; [2] is the report's own numbering.";
  const sentences = [
    { number: 1, text },
    { number: 2, text },
  ];
  const reply = fakeClaims(options(findClaimsPrompt(sentences)));
  expect(reply).not.toBeNull();
  const parts = readClaimParts(reply ?? "", sentences);
  expect(parts?.get(1)).toEqual([{ kind: "fact", span: { start: 0, end: text.length } }]);
  expect(parts?.get(2)).toEqual(parts?.get(1));
});

test("the scripted sorter distinguishes a left-out opinion from a question's empty inventory", () => {
  const sentences = [
    { number: 1, text: "We think the deal is risky." },
    { number: 2, text: "What should we do?" },
  ];
  const reply = fakeClaims(options(findClaimsPrompt(sentences)));
  expect(readClaimParts(reply ?? "", sentences)?.get(1)?.[0]?.kind).toBe("opinion");
  expect(readClaimParts(reply ?? "", sentences)?.get(2)).toEqual([]);
});
