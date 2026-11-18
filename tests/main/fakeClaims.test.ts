import { expect, test } from "vitest";
import {
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
  readSortWords,
} from "../../src/core/answers/checks/claims";
import { fakeClaims } from "../../src/main/fakeChat/claims";
import type { GenerateOptions } from "../../src/main/fakeChat/prompt";

const options = (text: string): GenerateOptions => ({
  prompt: [
    { role: "system", content: FIND_OWN_CLAIMS_INSTRUCTIONS },
    { role: "user", content: [{ type: "text", text }] },
  ],
});

test("the scripted sorter reads multiline text and numbered words inside it as one claim", () => {
  const text = "Revenue rose 8%\nin June; [2] is the report's own numbering.";
  const sentences = [
    { number: 1, text },
    { number: 2, text },
  ];
  const reply = fakeClaims(options(findClaimsPrompt(sentences)));
  expect(reply).not.toBeNull();
  expect(readSortWords(reply ?? "", [1, 2])).toEqual(
    new Map([
      [1, "claim"],
      [2, "claim"],
    ]),
  );
});

test("the scripted sorter sends a view to its check, leaves a question out and sets words about the note aside", () => {
  const sentences = [
    { number: 1, text: "We think the deal is risky." },
    { number: 2, text: "What should we do?" },
    { number: 3, text: "This note leaves out VAT." },
  ];
  const reply = fakeClaims(options(findClaimsPrompt(sentences)));
  expect(readSortWords(reply ?? "", [1, 2, 3])).toEqual(
    new Map([
      [1, "claim"],
      [2, "no"],
      [3, "note"],
    ]),
  );
});

test("the scripted sorter can leave the last sentence undecided", () => {
  const sentences = [
    { number: 1, text: "Revenue rose 8%." },
    { number: 2, text: "Costs fell 3%." },
  ];
  const reply = fakeClaims(options(findClaimsPrompt(sentences)), { undecidedLast: true });
  expect(readSortWords(reply ?? "", [1, 2])).toEqual(new Map([[1, "claim"]]));
});
