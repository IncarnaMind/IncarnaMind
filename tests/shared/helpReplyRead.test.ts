import { describe, expect, test } from "vitest";
import { citedSentences } from "../../src/shared/citedSentences";
import { helpReplyRead } from "../../src/shared/helpReplyRead";

describe("A call-help reply as its panel shows it and its check reads it (#2925)", () => {
  // protects=an option the model wrapped whole in its own quotation marks is read without them, in straight, curly and corner marks, its marker inside the marks or after them, after its star or bold; fails_when=the option keeps its own marks, a marker is lost, or its line's star, bold or "→" line change; no_claim=how the panel draws it.
  test.each([
    ['★ "We can extend the pilot [^1]"', "★ We can extend the pilot [^1]"],
    ['★ "We can extend the pilot" [^1]', "★ We can extend the pilot [^1]"],
    ["★ “We can extend the pilot [^1].”", "★ We can extend the pilot [^1]."],
    ["「我们可以延长试用期」[^1]", "我们可以延长试用期[^1]"],
    ['**★ "We can extend the pilot" [^1]**', "**★ We can extend the pilot [^1]**"],
  ])("an option wrapped in its own marks is read without them: %s", (option, read) => {
    expect(helpReplyRead(`${option}\n→ keeps it moving`).text).toBe(`${read}\n→ keeps it moving`);
  });

  // protects=only an option's own pair goes: a line with no "→" line after it, a "→" line, a reading's moment, a quotation inside the option in another kind of mark, a pair another mark of its kind breaks, and an empty pair are read as written; fails_when=one of them loses a quotation mark, so the check stops looking for words the reply quotes; no_claim=which words the check finds.
  test.each([
    ['"We can extend the pilot" [^1]\n\nThey said so at 12:04.', "a line with no → line after it"],
    [
      '★ They want the total\n12:04 "our budget stops at ten" [^1]\n→ ask about it',
      "a reading's moment",
    ],
    ['★ "We can" and "we will" [^1]\n→ keeps it moving', "a pair another mark of its kind breaks"],
    ['★ "" [^1]\n→ keeps it moving', "an empty pair"],
    ['★ We can extend the pilot [^1]\n→ "keeps it moving"', "a → line"],
  ])("%s is read as written (%s)", (reply) => {
    expect(helpReplyRead(reply).text).toBe(reply);
  });

  test.each([
    [
      '★ "We confirm “nothing is ever drilled” on site" [^1]',
      "★ We confirm “nothing is ever drilled” on site [^1]",
    ],
    ["★ “屋顶上「绝不打孔」，请放心” [^1]", "★ 屋顶上「绝不打孔」，请放心 [^1]"],
  ])("a quotation inside an option, in another kind of mark, stays one: %s", (option, read) => {
    expect(helpReplyRead(`${option}\n→ answers the worry`).text).toBe(
      `${read}\n→ answers the worry`,
    );
  });

  // protects=no marker is dropped and each keeps its place among the reply's markers as written, the place the check's verdicts name, so no ✓ moves to another chip; fails_when=a marker's place shifts, or the check's sentences cite other places once read; no_claim=which markers a later rule drops.
  test("every marker keeps its place, the one the check's sentences give it", () => {
    const reply = [
      '★ "We can extend the pilot to 60 days [^1]"',
      "→ keeps the deal moving [^2]",
      "",
      "“Let me check with the team and come back by Friday” [^3] [^1]",
      "→ buys time",
    ].join("\n");
    const read = helpReplyRead(reply);
    expect(read.at).toEqual([0, 1, 2, 3]);
    const places = (text: string) => citedSentences(text).flatMap((sentence) => sentence.at);
    expect(places(read.text).map((at) => read.at[at])).toEqual(places(reply));
  });
});
