import { describe, expect, test } from "vitest";
import { REMOVAL_ASKED_INSTRUCTIONS } from "../../src/core/edits/removalAsked";
import { fakeRemovalAsked } from "../../src/main/fakeChat/claims";
import type { GenerateOptions } from "../../src/main/fakeChat/prompt";

const askedOf = (request: string): GenerateOptions =>
  ({
    prompt: [
      { role: "system", content: REMOVAL_ASKED_INSTRUCTIONS },
      { role: "user", content: [{ type: "text", text: `<question>\n${request}\n</question>` }] },
    ],
  }) as GenerateOptions;

describe("The built app's scripted answer to whether a request asks to take text out", () => {
  // protects=the scripted model the window specs run on reads "Delete the second paragraph." as a removal, and "Make it shorter." and 把它改短一些。 as none, so a spec's typed removal applies and a shortening that quotes a paragraph waits as in the app (#2333); fails_when=a delete request is read as none or a shortening as a removal; no_claim=how a real model reads other words.
  test.each([
    ["Delete the second paragraph.", "yes"],
    ["Please remove the last sentence and fix the typos.", "yes"],
    ["把第二段删掉。", "yes"],
    ["Make it shorter.", "no"],
    ["把它改短一些。", "no"],
    ["Improve the writing.", "no"],
  ])("%s: %s", (request, answer) => {
    expect(JSON.parse(fakeRemovalAsked(askedOf(request)) ?? "{}")).toEqual({
      asks_to_remove: answer,
    });
  });

  // protects=another question gets no answer from this reader, so the other scripted answers still apply; fails_when=any prompt is answered as a removal question; no_claim=none.
  test("another question is left to the other answers", () => {
    const other = {
      prompt: [{ role: "system", content: "You sort sentences." }],
    } as unknown as GenerateOptions;
    expect(fakeRemovalAsked(other)).toBeNull();
  });
});
