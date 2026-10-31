/**
 * A Note's figures are read with what its whole text says of how it writes numbers (its
 * separators, its "¥", whether it is accounts). That is now added up paragraph by paragraph,
 * each read once while its text stays the same, so typing in a long Note no longer reads the
 * whole Note again for every key (#746). It must say exactly what reading the joined text says.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import {
  documentFigureContext,
  type NoteParagraphs,
  partsFigureContext,
} from "../../src/core/answers/calculations";
import { readWordStructure } from "../../src/core/documents/formats/docxImport";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { figureFactsOf } from "../../src/shared/figures";
import { memoized } from "../../src/shared/memo";
import { longContract } from "../helpers/longContract";
import { wordFixtures } from "../helpers/wordLookResolved";

function paragraphs(blocks: readonly JSONContent[]): string[] {
  const texts: string[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "paragraph") {
      texts.push((node.content ?? []).map((child) => child.text ?? "").join(""));
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of blocks) visit(block);
  return texts;
}

/** Each paragraph as a Block of its own. */
const asBlocks = (parts: readonly string[]): NoteParagraphs[] =>
  parts.map((text) => ({
    words: [text],
    facts: (language) => [figureFactsOf(text, language)],
  }));

describe("a Note's figure context, added up from its paragraphs", () => {
  test("says what the joined text says, for every Word file of the corpus and the 304-page contract", async () => {
    const files: [string, Uint8Array][] = [
      ...wordFixtures(),
      ["helpers/longContract", longContract()],
    ];
    let compared = 0;
    for (const [name, bytes] of files) {
      const pkg = await openWordPackage(Buffer.from(bytes));
      const structure = await readWordStructure(pkg, await reviewOf(pkg));
      const parts = paragraphs(structure.blocks);
      expect(partsFigureContext(asBlocks(parts)), name).toEqual(
        documentFigureContext([{ text: parts.join("\n") }]),
      );
      compared++;
    }
    expect(compared).toBeGreaterThan(90);
  }, 240_000);

  test("telling numbers in different paragraphs add up, as in one text", () => {
    const parts = ["Revenue was 1.234.567,89 EUR.", "Costs: 2.100.000,00 EUR", "See 3.5 below."];
    expect(partsFigureContext(asBlocks(parts))).toEqual(
      documentFigureContext([{ text: parts.join("\n") }]),
    );
    expect(partsFigureContext(asBlocks(parts)).separators).toEqual({ decimal: ",", group: "." });
    expect(partsFigureContext(asBlocks(["人民币 1,200 万元", "¥300"])).yen).toBe("CNY");
  });
});

describe("a result remembered for its input", () => {
  test("is computed once while it is remembered, and forgotten oldest first", () => {
    const computed: string[] = [];
    const upper = memoized(
      2,
      (text: string) => text,
      (text: string) => {
        computed.push(text);
        return text.toUpperCase();
      },
    );
    expect([upper("a"), upper("a"), upper("b"), upper("a"), upper("c"), upper("b")]).toEqual([
      "A",
      "A",
      "B",
      "A",
      "C",
      "B",
    ]);
    expect(computed).toEqual(["a", "b", "c", "b"]);
  });
});
