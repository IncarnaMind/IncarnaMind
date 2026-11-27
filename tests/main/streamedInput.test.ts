import { describe, expect, it } from "vitest";
import { quotingNow, sayingNow, writingNow } from "../../src/main/streamedInput";

/** A call's input as Claude Code streams it: whole JSON, cut at `cut` characters. */
const cutAt = (input: unknown, cut: number) => JSON.stringify(input).slice(0, cut);

describe("what a call is writing, from its input as it streams (#3677)", () => {
  // protects=the line above a Note's input names the paragraph a change is writing now, from the input as it streams, at any cut, its escapes read, once it says something, else the one before; fails_when=the line shows JSON, an escape, a fragment such as "On", an earlier paragraph than it could, or nothing while the AI writes the change
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
    // Just begun, a paragraph says nothing yet: the one before it, finished, stands.
    expect(writingNow("propose_changes", cutAt(input, whole.indexOf("The kickoff") + 8))).toBe(
      "# Onboarding",
    );
    expect(writingNow("propose_changes", cutAt(input, whole.indexOf("The kickoff") + 13))).toBe(
      "The kickoff c",
    );
    expect(writingNow("propose_changes", cutAt(input, second + 4))).toBeNull();
    expect(writingNow("propose_changes", cutAt(input, second + 22))).toBe("Data migration was the");
    expect(writingNow("propose_changes", cutAt(input, second + 26))).toBe(
      'Data migration was the "h',
    );
    expect(writingNow("propose_changes", whole)).toBe(
      'Data migration was the "hardest" part — 新用户 too.',
    );
    // A cut inside an escape stops before it.
    const begun = `${whole.slice(0, second)}Data migration`;
    expect(writingNow("propose_changes", `${begun}\\`)).toBe("Data migration");
    expect(writingNow("propose_changes", `${begun}\\u65`)).toBe("Data migration");
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
        JSON.stringify({ title: "Summary", markdown: "## Training\n\nShort sessions only" }),
      ),
    ).toBe("Short sessions only");
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
    expect(quotingNow("cite", '{"citations":[{"passageId":"p\\u002done","quote":"x"}]}')).toBe(
      "p-one",
    );
  });

  // protects=what the AI thinks reaches the line in words that say something: a sentence or paragraph just begun waits until it has a few words, the ones before it stand meanwhile, in English and Chinese; fails_when=the line shows "Thinking · I'm nar"
  it("gives a thought up to where it says something", () => {
    expect(sayingNow("I'm nar")).toBeNull();
    expect(sayingNow("I'm narrowing the search")).toBe("I'm narrowing the search");
    expect(sayingNow("**Grouping the clinics**\n\nI've")).toBe("**Grouping the clinics**");
    expect(sayingNow("I've read the ten interviews. Now I'm")).toBe(
      "I've read the ten interviews.",
    );
    expect(sayingNow("现在")).toBeNull();
    expect(sayingNow("我已经读完十份访谈。现在")).toBe("我已经读完十份访谈。");
    expect(sayingNow("我已经读完了十份访谈，正在按主题归类每家店的反馈")).toBe(
      "我已经读完了十份访谈，正在按主题归类每家店的反馈",
    );
  });
});
