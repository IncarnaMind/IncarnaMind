import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { figureReadingSteps } from "../../src/shared/figures";

/**
 * A Note's figures are read in steps that grow with its length (#2512): each sentence is read once
 * for all its figures, and each paragraph once for all its sentences. 16 steps for each character.
 */
function figuresOfParagraph(text: string) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  blocks.insert(0, [
    createElement({ type: "paragraph", attrs: { id: "p" }, content: [{ type: "text", text }] }),
  ]);
  const before = figureReadingSteps();
  const figures = figuresInMind(blocks);
  expect(figureReadingSteps() - before).toBeLessThanOrEqual(16 * text.length);
  return figures;
}

test("a sentence of 16,000 figures is read once for all of them", () => {
  const figures = figuresOfParagraph(`Revenue was ${"£1, ".repeat(16_000)}in all.`);
  expect(figures).toHaveLength(16_000);
  expect(new Set(figures.map((figure) => figure.sentence?.from.offset))).toEqual(new Set([0]));
});

test("a paragraph of 16,000 sentences, each with a figure, is read once for all of them", () => {
  const figures = figuresOfParagraph("Revenue was £1. ".repeat(16_000));
  expect(figures).toHaveLength(16_000);
  expect(figures.at(-1)?.reading.chars).toBe("£1");
  expect(figures.at(-1)?.sentence?.from.offset).toBe(16 * 15_999);
});
