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
    expect([...namesIn(note)]).toEqual([
      ["Harbor Logistics", 2],
      ["Marcus", 1],
      ["Priya Raman", 1],
      ["Lumen Foods", 1],
      ["Rotterdam", 1],
      ["Sofia Lindqvist", 1],
      ["Daniel Weiss", 1],
      ["Daniel", 1],
    ]);
    const names = namesIn(note);
    expect(names.has("Renewal")).toBe(false);
    expect(names.has("Review")).toBe(false);
    expect(names.has("Wednesday")).toBe(false);
  });

  test("English: a name's joining words are kept, a heading's words are not", () => {
    const names = namesIn(
      "Clients are Bank of America and Procter & Gamble. See Table 3 on Page 2.",
    );
    expect([...names.keys()]).toEqual(["Bank of America", "Procter & Gamble"]);
  });

  test("Chinese: a surname and a given name, a surname with a title, and a company", () => {
    const names = namesIn(
      "参会：王丽（星河科技）、陈经理、李明。好的，谢谢王总。他是我的同事张伟。把施工图发给你。",
    );
    expect([...names.keys()]).toEqual(["王丽", "星河科技", "陈经理", "李明", "王总", "张伟"]);
    expect(names.has("图发")).toBe(false);
  });

  test("text with no name gives none", () => {
    expect(namesIn("").size).toBe(0);
    expect(namesIn("we agreed to send it by friday.").size).toBe(0);
    expect(namesIn("我们下周一把合同寄给你们。").size).toBe(0);
    expect(namesIn("Marcus will call.").size).toBe(0);
    expect([...namesIn("Then Marcus will call.").keys()]).toEqual(["Marcus"]);
  });
});
