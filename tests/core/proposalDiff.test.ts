import { describe, expect, test } from "vitest";
import { passageSoFar, readEditReply, reasonOf, sameText } from "../../src/core/edits/prompt";
import { diffSteps, hunksOf, splitWords } from "../../src/core/proposals/diff";

/** The hunks of two texts as "old → new" pairs, joining across kept runs of `join` characters or fewer. */
function changes(before: string, after: string, join = 0): string[] {
  const a = splitWords(before);
  const b = splitWords(after);
  const hunks = hunksOf(
    diffSteps(a, b),
    (from, to) => a.slice(from, to).join("").replace(/\s+/g, "").length <= join,
  );
  return hunks.map(
    (hunk) =>
      `${a.slice(hunk.oldFrom, hunk.oldTo).join("")} → ${b.slice(hunk.newFrom, hunk.newTo).join("")}`,
  );
}

describe("Comparing a text with its new version", () => {
  test("cuts words, spaces and signs apart, Chinese and Japanese into their words, and keeps a number, date or range whole", () => {
    expect(splitWords("Spring tides, don’t wait.")).toEqual([
      "Spring",
      " ",
      "tides",
      ",",
      " ",
      "don’t",
      " ",
      "wait",
      ".",
    ]);
    expect(splitWords("潮水涨落 twice")).toEqual(["潮水", "涨", "落", " ", "twice"]);
    expect(splitWords("张瑜的主要优势是数据分析经验")).toEqual([
      "张",
      "瑜",
      "的",
      "主要",
      "优势",
      "是",
      "数据",
      "分析",
      "经验",
    ]);
    expect(splitWords("2017.05—2018.09 硕士")).toEqual(["2017.05—2018.09", " ", "硕士"]);
    expect(splitWords("Profit £1.2m, margin 41.8%, up 3.1× by 12:04")).toEqual([
      "Profit",
      " ",
      "£1.2m",
      ",",
      " ",
      "margin",
      " ",
      "41.8%",
      ",",
      " ",
      "up",
      " ",
      "3.1×",
      " ",
      "by",
      " ",
      "12:04",
    ]);
    // Not inside a word, and not a dash with nothing after it.
    expect(splitWords("Q3 3rd 2017.04-至今")).toEqual([
      "Q3",
      " ",
      "3rd",
      " ",
      "2017.04",
      "-",
      "至今",
    ]);
  });

  test("a date range changed is one change, never cut inside", () => {
    expect(changes("2017.05—2017.04 某大学", "2017.05—2018.09 某大学")).toEqual([
      "2017.05—2017.04 → 2017.05—2018.09",
    ]);
  });

  test("finds the shortest change, a removed word taking the space after it", () => {
    expect(
      changes("The tides are very strong and really regular.", "The tides are strong and regular."),
    ).toEqual(["very  → ", "really  → "]);
    expect(changes("潮水每天非常规律", "潮水每天很规律")).toEqual(["非常 → 很"]);
    expect(changes("same text", "same text")).toEqual([]);
  });

  test("joins changes a few kept characters apart into one", () => {
    // Only a space apart: one change.
    expect(changes("the cat sat on the mat", "a dog sat on a rug")).toEqual([
      "the cat → a dog",
      "the mat → a rug",
    ]);
    // "and" apart: one change when three letters join; two when none do.
    expect(changes("moon and at full", "new and full", 3)).toEqual(["moon and at  → new and "]);
    expect(changes("moon and at full", "new and full", 0)).toEqual(["moon → new", "at  → "]);
  });

  test("past its limit, replaces the whole text rather than search on", () => {
    const a = splitWords("one two three four five");
    const b = splitWords("uno dos tres cuatro cinco");
    expect(diffSteps(a, b, 2)).toEqual([...a.map(() => "delete"), ...b.map(() => "insert")]);
  });
});

describe("Reading the model's new text", () => {
  test("drops thinking, a code fence, the passage's tags and quotation marks it added", () => {
    expect(readEditReply("<think>Shorter.</think>\nTides are strong.", "x")).toBe(
      "Tides are strong.",
    );
    expect(readEditReply("```text\nTides are strong.\n```", "x")).toBe("Tides are strong.");
    expect(readEditReply("<passage>\nTides.\n</passage>", "x")).toBe("Tides.");
    expect(readEditReply("“Tides are strong.”", "Tides are very strong.")).toBe(
      "Tides are strong.",
    );
    // Quotation marks the passage had stay.
    expect(readEditReply('"Tides," she said.', '"Tides," she said, "rise."')).toBe(
      '"Tides," she said.',
    );
  });

  test("the reason after the new text is read apart from it, without markers, a few words long", () => {
    const reply = "Tides are strong.\n<why>Shorter, citation [1] kept [^2].</why>";
    expect(readEditReply(reply, "x")).toBe("Tides are strong.");
    expect(reasonOf(reply)).toBe("Shorter, citation kept.");
    expect(reasonOf("```\nTides.\n```\n<why>Clearer.</why>")).toBe("Clearer.");
    expect(readEditReply("```\nTides.\n```\n<why>Clearer.</why>", "x")).toBe("Tides.");
    expect(reasonOf("Tides are strong.")).toBeNull();
    expect([...(reasonOf(`x<why>${"word ".repeat(80)}</why>`) ?? "")]).toHaveLength(160);
  });

  test("the new text so far is read as it streams: up to the reason, and only once it can be told", () => {
    expect(passageSoFar("Tides are strong.\n\nThe Moon", "x")).toBe(
      "Tides are strong.\n\nThe Moon",
    );
    expect(passageSoFar("Tides.\n<why>Short", "x")).toBe("Tides.\n");
    expect(passageSoFar("```text\nTides.", "x")).toBe("Tides.");
    expect(passageSoFar("```te", "x")).toBeNull();
    expect(passageSoFar("<passage>\nTides.", "x")).toBe("Tides.");
    expect(passageSoFar("<pass", "x")).toBeNull();
    expect(passageSoFar("<think>Hmm, shorter", "x")).toBe("");
    // A quotation mark the passage doesn't start with may go round all of it: wait for the end.
    expect(passageSoFar("“Tides are", "Tides are very strong.")).toBeNull();
    expect(passageSoFar("“Tides are", "“Tides,” she said.")).toBe("“Tides are");
  });

  test("a text given back with only its spaces changed is the same", () => {
    expect(sameText("Spring  tides\n", "Spring tides")).toBe(true);
    expect(sameText("Spring tides", "Spring tide")).toBe(false);
  });
});
