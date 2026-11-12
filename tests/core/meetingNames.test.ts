import { describe, expect, test } from "vitest";
import { namesIn } from "../../src/core/meetings/names";

describe("Names in a Meeting's Note and its Folder's Documents (#1031)", () => {
  test("English: runs of capitalised words, but not a sentence's or a list item's first word", () => {
    const note = [
      "Renewal call with Harbor Logistics",
      "Attendees: Marcus (Harbor Logistics), Priya Raman, Lumen Foods",
      "- Review the Rotterdam warehouse plan with Sofia Lindqvist.",
      "Daniel Weiss signs off. The contract goes to Daniel by Wednesday.",
    ].join("\n");
    expect([...namesIn(note).names]).toEqual([
      ["Harbor Logistics", 2],
      ["Marcus", 1],
      ["Priya Raman", 1],
      ["Lumen Foods", 1],
      ["Rotterdam", 1],
      ["Sofia Lindqvist", 1],
      ["Daniel Weiss", 1],
      ["Daniel", 1],
    ]);
    const { names } = namesIn(note);
    expect(names.has("Renewal")).toBe(false);
    expect(names.has("Review")).toBe(false);
    expect(names.has("Wednesday")).toBe(false);
  });

  test("English: a name's joining words are kept, a heading's words are not", () => {
    const { names } = namesIn(
      "Clients are Bank of America and Procter & Gamble. See Table 3 on Page 2.",
    );
    expect([...names.keys()]).toEqual(["Bank of America", "Procter & Gamble"]);
  });

  test("Chinese: a surname and a given name, a surname with a title, and a company", () => {
    const { names } = namesIn(
      "参会：王丽（星河科技）、陈经理、李明。好的，谢谢王总。他是我的同事张伟。把施工图发给你。",
    );
    expect([...names.keys()]).toEqual(["王丽", "星河科技", "陈经理", "李明", "王总", "张伟"]);
    expect(names.has("图发")).toBe(false);
  });

  test("text with no name gives none", () => {
    expect(namesIn("").names.size).toBe(0);
    expect(namesIn("we agreed to send it by friday.").names.size).toBe(0);
    expect(namesIn("我们下周一把合同寄给你们。").names.size).toBe(0);
    expect(namesIn("Marcus will call.").names.size).toBe(0);
    expect([...namesIn("Then Marcus will call.").names.keys()]).toEqual(["Marcus"]);
  });

  test("English: what a person has is not part of the name: Tom's is Tom", () => {
    const { names } = namesIn("We need Tom's sign-off. Then Priya's Budget is next, said Tom.");
    expect([...names]).toEqual([
      ["Tom", 2],
      ["Priya", 1],
      ["Budget", 1],
    ]);
    expect(names.has("Tom's")).toBe(false);
    expect(names.has("Priya's Budget")).toBe(false);
  });

  test("Chinese: a surname with a title is found before a word that joins two names", () => {
    const { names } = namesIn("请王总和李经理确认。王总跟陈总监或张老师及赵博士都同意。");
    expect([...names]).toEqual([
      ["王总", 2],
      ["李经理", 1],
      ["陈总监", 1],
      ["赵博士", 1],
    ]);
    // 总和 is a word of its own where no surname stands before it.
    expect(namesIn("金额的总和是五百。").names.size).toBe(0);
  });

  test("an English word ends where Chinese characters begin: a name of several words is a name, one word alone is kept apart", () => {
    const found = namesIn(
      "跟Priya确认，这个Plan先不动。请Maya Lindqvist跟进，和Lumen Foods签合同。",
    );
    expect([...found.names.keys()]).toEqual(["Maya Lindqvist", "Lumen Foods"]);
    expect([...found.besideChinese.keys()]).toEqual(["Priya", "Plan"]);
    expect(found.itemOpeners.size).toBe(0);
    // Written with spaces, as before: one word that doesn't open a sentence is a name.
    const spaced = namesIn("跟 Priya 确认，这个 Plan 先不动。");
    expect([...spaced.names.keys()]).toEqual(["Priya", "Plan"]);
    expect(spaced.besideChinese.size).toBe(0);
  });

  test("one word that opens a line before a colon, or is a list item alone, is kept apart", () => {
    const found = namesIn(
      [
        "Risks:",
        "- Tom",
        "- Priya Raman: send the deck",
        "Priya: review the plan",
        "1. Findings",
        "- Agenda",
        "Dana",
        "- Marcus will call.",
      ].join("\n"),
    );
    expect([...found.itemOpeners.keys()]).toEqual(["Risks", "Tom", "Priya", "Findings"]);
    expect([...found.names.keys()]).toEqual(["Priya Raman"]);
    // A line of one word with no list marker, and a sentence's first word, are neither.
    expect(found.itemOpeners.has("Dana")).toBe(false);
    expect(found.itemOpeners.has("Marcus")).toBe(false);
  });
});
