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

const attributesOf = new Map<Footnote, Partial<CitationAttributes>>([
  [one, { documentId: "one", location: { kind: "page", from: 1, to: 1 } }],
  [two, { documentId: "two", location: { kind: "page", from: 2, to: 2 } }],
]);

describe("the source pack's Citation numbers", () => {
  // protects=a Note's Citation numbers match in the pack and in the Note; fails_when=a figure's note takes a footnote number, so a later Citation skips one (#2313).
  test("a calculated figure takes no footnote number, so a Citation after it does not skip one", () => {
    const blocks = [
      paragraph(
        text("Revenue was "),
        citation(one),
        text(" and the total "),
        { kind: "figure", figure, sources: null, analysis: null },
        text(" as well "),
        citation(two),
      ),
    ];
    expect(numberCitations(blocks, "numbered", attributesOf).map((each) => each.number)).toEqual([
      1, 2,
    ]);
  });
});
