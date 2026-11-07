import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { CITATION_NODE } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { figureReadingSteps } from "../../src/shared/figures";
import { FORMULA_VERSION } from "../../src/shared/formula";

/**
 * A Note's figures are read in steps that grow with its length (#2512, #2523): each sentence is
 * read once for all its figures, each paragraph once for all its sentences, and each table once
 * for all its cells. 16 steps for each character.
 */
function readNote(nodes: readonly NodeJSON[], characters: number) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  blocks.insert(0, nodes.map(createElement));
  const before = figureReadingSteps();
  const figures = figuresInMind(blocks);
  expect(figureReadingSteps() - before).toBeLessThanOrEqual(16 * characters);
  return figures;
}

const text = (value: string): NodeJSON => ({ type: "text", text: value });
const paragraph = (id: string, ...content: NodeJSON[]): NodeJSON => ({
  type: "paragraph",
  attrs: { id },
  content,
});

function figuresOfParagraph(plain: string) {
  return readNote([paragraph("p", text(plain))], plain.length);
}

const cell = (id: string, value: string, header = false): NodeJSON => ({
  type: header ? "tableHeader" : "tableCell",
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(id, text(value))],
});
const row = (...content: NodeJSON[]): NodeJSON => ({ type: "tableRow", content });

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

test("a 200-row table under a 14,000-character caption is read once for all its cells", () => {
  const caption = "All amounts in thousands. ".repeat(538) + "All amounts.";
  const content: NodeJSON[] = [
    paragraph("caption", text(caption)),
    {
      type: "table",
      attrs: { id: "t1" },
      content: [
        row(cell("h0", "Item", true), cell("h1", "2024", true), cell("h2", "2025", true)),
        ...Array.from({ length: 200 }, (_, index) =>
          row(
            cell(`a${index}`, index % 2 === 0 ? "North" : "South"),
            cell(`b${index}`, "1,234"),
            cell(`c${index}`, "2,345"),
          ),
        ),
      ],
    },
  ];
  const figures = readNote(content, 14_000 + 12 + 200 * 15);
  expect(figures).toHaveLength(400);
  expect(figures[0]?.reading.chars).toBe("1,234");
  expect(figures[0]?.reading.value).toBe(1_234);
  expect(figures.at(-1)?.reading.chars).toBe("2,345");
  // The caption still states what it did for each cell's figures.
  const scale = figures[0]?.reading.ambiguous.find((each) => each.kind === "scale");
  expect(
    scale?.readings.map((reading) => [reading.value, reading.scale, reading.unit.kind]),
  ).toEqual([
    [1_234, 1, "plain"],
    [1_234_000, 1_000, "plain"],
  ]);
  expect(scale?.readings.at(-1)?.statedIn).toBe("header");
  expect(figures.at(-1)?.context).toContain("All amounts in thousands.");
});

test("a 5,333-row table after 单位：万元 is read once for all its cells", () => {
  const content: NodeJSON[] = [
    paragraph("caption", text("单位：万元")),
    {
      type: "table",
      attrs: { id: "t1" },
      content: Array.from({ length: 5_333 }, (_, index) =>
        row(cell(`a${index}`, "1,234"), cell(`b${index}`, "1,234"), cell(`c${index}`, "1,234")),
      ),
    },
  ];
  const figures = readNote(content, 5 + 5_333 * 15);
  expect(figures).toHaveLength(15_999);
  expect(figures.at(-1)?.reading.value).toBe(1_234);
  const scale = figures.at(-1)?.reading.ambiguous.find((each) => each.kind === "scale");
  expect(
    scale?.readings.map((reading) => [reading.value, reading.scale, reading.statedIn]),
  ).toEqual([
    [1_234, 1, undefined],
    [12_340_000, 10_000, "header"],
  ]);
});

const citation = (id: string): NodeJSON => ({
  type: CITATION_NODE,
  attrs: { id, documentName: "Accounts", quote: "Revenue grew." },
});

test("a paragraph of 16,000 cited sentences is read once for all of them", () => {
  const content: NodeJSON[] = [];
  // "Revenue was £1." with its Citation and the space after it.
  for (let index = 0; index < 16_000; index++)
    content.push(text("Revenue was £1."), citation(`cite-${index}`), text(" "));
  const figures = readNote([paragraph("p", ...content)], 16_000 * 17);
  expect(figures).toHaveLength(16_000);
  expect(figures.at(-1)?.reading.chars).toBe("£1");
  expect(figures.at(-1)?.sentence?.from.offset).toBe(17 * 15_999);
});

test("a paragraph of 16,000 cited Chinese sentences is read once for all of them", () => {
  const content: NodeJSON[] = [];
  for (let index = 0; index < 16_000; index++)
    content.push(text("收入为£1。"), citation(`引用-${index}`), text(" "));
  const figures = readNote([paragraph("p", ...content)], 16_000 * 8);
  expect(figures).toHaveLength(16_000);
  expect(figures.at(-1)?.reading.chars).toBe("£1");
});

const growth = (id: string): NodeJSON =>
  calculatedFigureNode(
    {
      label: "Growth",
      formula: "",
      inputs: [],
      value: 0.25,
      unit: { kind: "percent" },
      approximate: false,
      shown: "25.0%",
      show: { language: "en", as: "percent", decimals: 1, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      analysis: { analysis: 1, result: "growth" },
    },
    id,
    "run-1",
  );

test("a paragraph of 16,000 calculated figures is read once for all of them", () => {
  const content: NodeJSON[] = [];
  // "Growth was " with its calculated figure and the ". " after it.
  for (let index = 0; index < 16_000; index++)
    content.push(text("Growth was "), growth(`f${index}`), text(". "));
  const figures = readNote([paragraph("p", ...content)], 16_000 * 14);
  expect(figures).toHaveLength(16_000);
  expect(figures.at(-1)?.reading.value).toBe(0.25);
  expect(figures.at(-1)?.reading.chars).toBe("25.0%");
});

test("a paragraph of 16,000 sentences with record cites is read once for all of them", () => {
  const figures = readNote(
    [paragraph("p", text("Revenue £1 (Ex. 7 at 3). ".repeat(16_000)))],
    16_000 * 25,
  );
  expect(figures).toHaveLength(16_000);
  expect(new Set(figures.map((figure) => figure.reading.chars))).toEqual(new Set(["£1"]));
  expect(figures.at(-1)?.reading.value).toBe(1);
});
