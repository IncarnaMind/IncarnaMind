/**
 * A Document's quote as the fact line a Citation on a line to say turns into (#2847): its closing
 * full stop off, a list's or heading's mark off, a table row's cells joined, the sentence sharing the
 * most words with the line to say, and a cut past 20 words or 40 Chinese characters.
 */
import { describe, expect, test } from "vitest";
import { quoteAsFact } from "../../src/shared/turnedFacts";

describe("a quote as a turned fact line", () => {
  // protects=the Document's closing full stop comes off, and a list's or a heading's mark, in English and Chinese; fails_when=a stop or mark stays; no_claim=none beyond protects.
  test.each([
    ["Panels carry a 25-year warranty.", "Panels carry a 25-year warranty"],
    ["组件提供 25 年质保。", "组件提供 25 年质保"],
    ["- Panels carry a 25-year warranty.", "Panels carry a 25-year warranty"],
    ["## Warranty", "Warranty"],
  ])("%s", (quote, line) => {
    expect(quoteAsFact(quote, "Yes, it's covered")).toBe(line);
  });

  // protects=of a quote's sentences, the one sharing the most words with the line to say is kept, in English and Chinese; fails_when=the first sentence is kept though another says what the line to say does; no_claim=none beyond protects.
  test.each([
    {
      quote: "Installers work Monday to Saturday. Scaffolding is charged at cost.",
      said: "Scaffolding comes on top, at cost",
      line: "Scaffolding is charged at cost",
    },
    {
      quote: "安装人员周一到周六施工。脚手架按实际成本收费。",
      said: "脚手架另外按成本收",
      line: "脚手架按实际成本收费",
    },
  ])("the sentence that shares the most words: $line", ({ quote, said, line }) => {
    expect(quoteAsFact(quote, said)).toBe(line);
  });

  // protects=past 20 words, or 40 Chinese characters, the line is cut with "…", the whole quote staying in the Citation's card; fails_when=a long quote fills the panel; no_claim=where the cut falls in a sentence.
  test("a long quote is cut", () => {
    const english = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
    expect(quoteAsFact(`${english}.`, "")).toBe(
      `${Array.from({ length: 20 }, (_, index) => `word${index}`).join(" ")}…`,
    );
    const chinese = "企业版每个席位每月四十五美元含单点登录".repeat(3);
    expect(quoteAsFact(`${chinese}。`, "")).toBe(`${[...chinese].slice(0, 40).join("")}…`);
  });

  // protects=a quote that is a table's row reads as its cells joined, without the table's rule; the weakest reading, kept for now, on the saved table's shape; fails_when=its pipes show or a cell is lost; no_claim=that its column names are shown, which they aren't.
  test("a table's row is its cells joined", () => {
    expect(quoteAsFact("| Enterprise | $45 | Included |", "It's $45 on Enterprise")).toBe(
      "Enterprise · $45 · Included",
    );
    expect(quoteAsFact("| 企业版 | 45 美元 | 含 |", "企业版每席 45 美元")).toBe(
      "企业版 · 45 美元 · 含",
    );
  });
});
