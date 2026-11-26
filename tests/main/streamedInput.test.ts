import { describe, expect, it } from "vitest";
import { quotingNow, writingNow } from "../../src/main/streamedInput";

/** A call's input as Claude Code streams it: whole JSON, cut at `cut` characters. */
const cutAt = (input: unknown, cut: number) => JSON.stringify(input).slice(0, cut);

describe("what a call is writing, from its input as it streams (#3677)", () => {
  // protects=the line above a Note's input names the paragraph a change is writing now, from the input as it streams, at any cut, its escapes read; fails_when=the line shows JSON, an escape, an earlier paragraph or nothing while the AI writes the change
  it("reads the paragraph a change is writing now, wherever the input is cut", () => {
    const input = {
      mindId: "m1",
      version: "v1",
      changes: [
        { paragraph: "¶0+", text: "# Onboarding\n\nThe kickoff call set the plan." },
        { paragraph: "¶+", text: 'Data migration was the "hardest" part — 新用户 too.' },
      ],
    };
    const whole = JSON.stringify(input);
    const second = whole.indexOf("Data migration");
    expect(writingNow("propose_changes", cutAt(input, whole.indexOf("The kickoff") + 8))).toBe(
      "The kick",
    );
    expect(writingNow("propose_changes", cutAt(input, second + 22))).toBe("Data migration was the");
    expect(writingNow("propose_changes", cutAt(input, second + 26))).toBe(
      'Data migration was the "h',
    );
    expect(writingNow("propose_changes", whole)).toBe(
      'Data migration was the "hardest" part — 新用户 too.',
    );
    // A cut inside an escape stops before it.
    expect(writingNow("propose_changes", `${whole.slice(0, second)}Data\\`)).toBe("Data");
    expect(writingNow("propose_changes", `${whole.slice(0, second)}Data\\u65`)).toBe("Data");
  });

  // protects=only a key starts a field: words in the text that look like a key never move the line; fails_when=the line shows the rest of the text after a quoted "text": in the AI's own words
  it("takes a key only where it is one, not inside the text", () => {
    const input = {
      mindId: "m1",
      changes: [{ paragraph: "¶1", text: 'He typed "text": "nonsense" here' }],
    };
    expect(writingNow("propose_changes", JSON.stringify(input))).toBe(
      'He typed "text": "nonsense" here',
    );
    expect(
      writingNow(
        "create_mind",
        JSON.stringify({ title: "Summary", markdown: "## Training\n\nShort" }),
      ),
    ).toBe("Short");
    expect(writingNow("create_mind", cutAt({ title: "Summary", markdown: "x" }, 22))).toBeNull();
    expect(writingNow("search", JSON.stringify({ query: "text" }))).toBeNull();
  });

  // protects=the quote being written is known by its Passage once its id is written whole, the latest quote's; fails_when=a half-written id reaches the core, or an earlier quote's Passage stays on the line
  it("names the Passage of the quote being written, once its id is whole", () => {
    const input = {
      citations: [
        { passageId: "p-one", quote: "the kickoff call" },
        { passageId: "p-two", quote: "two evenings" },
      ],
    };
    const whole = JSON.stringify(input);
    expect(quotingNow("cite", cutAt(input, whole.indexOf("p-one") + 3))).toBeNull();
    expect(quotingNow("cite", cutAt(input, whole.indexOf("p-two") + 3))).toBe("p-one");
    expect(quotingNow("cite", whole)).toBe("p-two");
    expect(quotingNow("read_passages", JSON.stringify({ passageId: "p-one" }))).toBeNull();
  });
});
