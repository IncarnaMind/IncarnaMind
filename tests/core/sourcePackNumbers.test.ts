import { describe, expect, test } from "vitest";
import type { CalculatedFigure, CitationAttributes } from "../../src/core/api";
import { numberCitations } from "../../src/core/exports/sourcePack";
import { type Block, type Footnote, type Inline, NO_MARKS } from "../../src/core/mindText";
import { FORMULA_VERSION } from "../../src/shared/formula";

const figure: CalculatedFigure = {
  label: "Total",
  formula: "",
  inputs: [],
  value: 1482.6,
  unit: { kind: "plain" },
  approximate: false,
  shown: "1,482.6",
  show: { language: "en", as: "number", decimals: 1, scale: null },
  literals: [],
  engine: FORMULA_VERSION,
  written: null,
  analysis: { analysis: 1, result: "total" },
};

const one: Footnote = { source: "One, p. 1", unverified: false };
const two: Footnote = { source: "Two, p. 2", unverified: false };
const work = { documentId: "one", documentName: "One", location: null };

const citation = (footnote: Footnote): Inline => ({ kind: "citation", footnote, work });
const text = (value: string): Inline => ({ kind: "text", text: value, marks: NO_MARKS });
const paragraph = (...content: Inline[]): Block => ({ kind: "paragraph", content });
const figureNode: Inline = { kind: "figure", figure, sources: null, analysis: null };

const attributesOf = new Map<Footnote, Partial<CitationAttributes>>([
  [one, { documentId: "one", location: { kind: "page", from: 1, to: 1 } }],
  [two, { documentId: "two", location: { kind: "page", from: 2, to: 2 } }],
]);

const blocks = [
  paragraph(
    text("Revenue was "),
    citation(one),
    text(" and the total "),
    figureNode,
    text(" as well "),
    citation(two),
  ),
];

describe("the source pack's Citation numbers", () => {
  // protects=the pack numbers a figure in the same series as the Note and its exports; fails_when=a figure takes no number, so the Citations read 1, 2 (#2313).
  test("a calculated figure takes the next number, so the Citations after it read 1 and 3", () => {
    expect(numberCitations(blocks, "numbered", attributesOf).map((each) => each.number)).toEqual([
      1, 3,
    ]);
  });

  // protects=a style that cites in the text numbers a figure in the shared cited ordinal; fails_when=the figure takes no place, so the Citations read 1, 2 (#2313).
  test("in a style that cites in the text, a figure takes a cited ordinal", () => {
    expect(numberCitations(blocks, "in-text", attributesOf).map((each) => each.number)).toEqual([
      1, 3,
    ]);
  });

  // protects=a note style gives a figure a footnote number in the shared series; fails_when=the figure takes no number, so the Citations read 1, 2 (#2313).
  test("in a note style, a figure takes a footnote number", () => {
    expect(numberCitations(blocks, "note", attributesOf).map((each) => each.number)).toEqual([
      1, 3,
    ]);
  });
});
