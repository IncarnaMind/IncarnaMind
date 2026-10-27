import { expect, test } from "vitest";
import {
  CALCULATED_FIGURE_NODE,
  type CalculatedFigure,
  type Citation,
  type FigureInput,
} from "../../src/core/api";
import {
  calculatedFigureNode,
  MAX_INPUTS_PER_FIGURE,
  readCalculatedFigure,
  readCalculatedFigureAttributes,
  readFigureCitation,
  readFigureInput,
} from "../../src/shared/calculatedFigures";
import { FORMULA_MAX_LENGTH, FORMULA_VERSION } from "../../src/shared/formula";
import { firstLineOfBlocks } from "../../src/shared/noteBlocks";

function citation(): Citation {
  return {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Accounts.xlsx",
    contentHash: "a".repeat(64),
    pageFrom: 4,
    pageTo: 4,
    location: { kind: "rows", sheet: "Accounts", from: 4, to: 4 },
    quote: "📈 Revenue was £1,234.50 million.",
    check: "found",
    checkReason: null,
  };
}

function input(): FigureInput {
  return {
    name: "revenue",
    label: "Revenue in the current period",
    citation: citation(),
    number: {
      chars: "£1,234.50 million",
      at: 15,
      value: 1_234_500_000,
      scale: 1_000_000,
      scaleWord: "million",
      unit: { kind: "currency", code: "GBP" },
      decimals: 2,
      approximate: false,
      reading: 2,
    },
    cell: { sheet: "Accounts", ref: "$C$4", stored: 1234.5 },
    unitStatement: {
      citation: { ...citation(), quote: "All amounts in millions of pounds." },
      scale: 1_000_000,
      scaleWord: "million",
      currency: "GBP",
    },
  };
}

function figure(): CalculatedFigure {
  const prior = input();
  prior.name = "prior";
  prior.label = "Revenue in the prior period";
  prior.citation.quote = "Prior was £1,000.00 million.";
  prior.number = { ...prior.number, chars: "£1,000.00 million", at: 10, value: 1_000_000_000 };
  prior.cell = null;
  return {
    label: "Revenue growth",
    formula: "revenue / prior - 1",
    inputs: [input(), prior],
    value: 0.2345,
    unit: { kind: "ratio" },
    approximate: false,
    shown: "23.5%",
    show: { language: "en", as: "percent", decimals: 1, scale: null },
    literals: [{ text: "1", value: 1, at: 18 }],
    engine: FORMULA_VERSION,
    written: "24%",
  };
}

test("a complete existing figure preserves every input, raw cell, chosen reading and unit Citation", () => {
  const original = figure();
  const serialized: unknown = JSON.parse(JSON.stringify(original));
  expect(readCalculatedFigure(serialized)).toEqual(original);
  expect(readFigureInput(input())).toEqual(input());
  expect(readFigureCitation(citation())).toEqual(citation());
});

test("Chinese shown scales and quoted character offsets survive without unit conversion", () => {
  const revenue: FigureInput = {
    ...input(),
    name: "收入",
    label: "本期收入",
    citation: { ...citation(), quote: "本期收入为1.2亿元。" },
    number: {
      chars: "1.2亿元",
      at: 5,
      value: 120_000_000,
      scale: 100_000_000,
      scaleWord: "亿",
      unit: { kind: "currency", code: "CNY" },
      decimals: 1,
      approximate: true,
      reading: null,
    },
    cell: null,
    unitStatement: null,
  };
  const value: CalculatedFigure = {
    ...figure(),
    label: "季度收入",
    formula: "收入 / 4",
    inputs: [revenue],
    value: 30_000_000,
    unit: { kind: "currency", code: "CNY" },
    approximate: true,
    shown: "约3,000万元",
    show: { language: "zh-CN", as: null, decimals: 0, scale: "万元" },
    literals: [{ text: "4", value: 4, at: 5 }],
    written: null,
  };
  expect(readCalculatedFigure(value)).toEqual(value);
});

test("missing nullable presentation fields normalize without deriving any new displayed value", () => {
  const { written: _written, show: _show, ...value } = figure();
  expect(readCalculatedFigure({ ...value, show: { language: "en" } })).toEqual({
    ...value,
    written: null,
    show: { language: "en", as: null, decimals: null, scale: null },
  });
});

test("a Citation retains its reason and quoted words through the shared readers", () => {
  const value = {
    ...citation(),
    check: "not-found",
    checkReason: "quoted-words-not-on-pages",
    quotedWords: {
      answer: [{ text: "The wrong quoted words", found: false }],
      closest: [{ text: "The source's words", found: true }],
    },
  };
  expect(readFigureCitation(value)).toEqual(value);
  expect(readFigureCitation({ ...value, location: JSON.stringify(value.location) })).toEqual(value);
});

test("missing nullable Citation fields normalize without inventing found evidence", () => {
  const {
    pageFrom: _from,
    pageTo: _to,
    location: _location,
    checkReason: _reason,
    ...value
  } = citation();
  expect(readFigureCitation(value)).toEqual({
    ...value,
    pageFrom: null,
    pageTo: null,
    location: null,
    checkReason: null,
  });
  expect(readFigureCitation({ ...value, check: undefined })).toBeNull();
});

test.each([
  { documentId: "" },
  { quote: 12 },
  { pageFrom: Number.NaN },
  { pageFrom: 0 },
  { pageTo: 3 },
  { location: { kind: "lines", from: 2, to: 1 } },
  { location: { kind: "rows", sheet: "Accounts", from: -1, to: 4 } },
  { location: { kind: "time", from: Number.POSITIVE_INFINITY, to: 500 } },
  { location: { kind: "page", from: 1, to: 1, printed: { from: {}, to: "2" } } },
  { location: { kind: "section", heading: "Revenue", paragraphs: { from: 0, to: 2 } } },
  { check: "verified" },
  { checkReason: "correct" },
])("malformed critical Citation fields are rejected: %j", (patch) => {
  expect(readFigureCitation({ ...citation(), ...patch })).toBeNull();
});

test.each([
  { at: 14 },
  { at: -1 },
  { at: 1.5 },
  { chars: "£1,234.50 million trailing words" },
  { value: Number.NaN },
  { scale: 0 },
  { scale: Number.POSITIVE_INFINITY },
  { reading: 0 },
  { decimals: -1 },
  { approximate: "false" },
  { unit: { kind: "currency", code: "£" } },
  { unit: { kind: "ratio" } },
])("input numbers require exact UTF-16 spans and finite readings: %j", (patch) => {
  const value = input();
  expect(readFigureInput({ ...value, number: { ...value.number, ...patch } })).toBeNull();
});

test("missing nullable input details normalize and a stored raw zero is preserved", () => {
  const value = input();
  const { cell: _cell, unitStatement: _unit, ...plain } = value;
  const { scaleWord: _word, reading: _reading, ...number } = plain.number;
  expect(readFigureInput({ ...plain, number })).toEqual({
    ...plain,
    number: { ...number, scaleWord: null, reading: null },
    cell: null,
    unitStatement: null,
  });
  const zero = { ...value, cell: { sheet: null, ref: "C4", stored: 0 } };
  expect(readFigureInput(zero)).toEqual(zero);
});

test.each([
  { cell: { ref: "A0", sheet: null, stored: 1 } },
  { cell: { ref: "A1:B2", sheet: null, stored: 1 } },
  { cell: { ref: "C4", sheet: null, stored: Number.NaN } },
  { cell: { ref: "C4", sheet: 1, stored: 1234.5 } },
  { unitStatement: { ...input().unitStatement, scale: -1 } },
  { unitStatement: { ...input().unitStatement, currency: "pounds" } },
  { unitStatement: { ...input().unitStatement, citation: { ...citation(), documentId: null } } },
])("malformed workbook or unit-line provenance is rejected: %j", (patch) => {
  expect(readFigureInput({ ...input(), ...patch })).toBeNull();
});

test.each([
  { value: Number.NaN },
  { value: Number.POSITIVE_INFINITY },
  { unit: { kind: "currency", code: "pounds" } },
  { unit: { kind: "rate", of: "GBP", per: "?" } },
  { approximate: 1 },
  { show: { ...figure().show, language: "fr" } },
  { show: { ...figure().show, decimals: 11 } },
  { show: { ...figure().show, decimals: 1.5 } },
  { show: { ...figure().show, as: "verified" } },
  { engine: 0 },
  { engine: 1.5 },
  { formula: "" },
  { formula: "a".repeat(FORMULA_MAX_LENGTH + 1) },
  { inputs: [] },
  { inputs: [null] },
  { literals: [{ text: "1", value: 1, at: 17 }] },
  { literals: [{ text: "1", value: Number.NaN, at: 18 }] },
])("malformed figure fields are rejected without an evaluator run: %j", (patch) => {
  expect(readCalculatedFigure({ ...figure(), ...patch })).toBeNull();
});

test("input names are unique ignoring case and use valid evaluator identifiers", () => {
  const value = figure();
  expect(
    readCalculatedFigure({ ...value, inputs: [input(), { ...input(), name: "REVENUE" }] }),
  ).toBeNull();
  expect(readFigureInput({ ...input(), name: "1revenue" })).toBeNull();
  expect(readFigureInput({ ...input(), name: "TRUE" })).toBeNull();
  expect(readFigureInput({ ...input(), name: "收入_1" })).not.toBeNull();
});

test("the one canonical input count bound accepts its edge and rejects one more", () => {
  const inputs = Array.from({ length: MAX_INPUTS_PER_FIGURE }, (_, index) => ({
    ...input(),
    name: `revenue${index}`,
  }));
  expect(readCalculatedFigure({ ...figure(), inputs })).not.toBeNull();
  expect(
    readCalculatedFigure({ ...figure(), inputs: [...inputs, { ...input(), name: "extra" }] }),
  ).toBeNull();
});

test("Boolean results and future engines survive without any forged check receipt", () => {
  const boolean = {
    ...figure(),
    formula: "revenue > prior",
    value: true,
    unit: { kind: "yes-no" },
    shown: "yes",
    literals: [],
  };
  expect(readCalculatedFigure(boolean)).toEqual(boolean);
  const future = { ...figure(), value: 99, shown: "99.0", engine: FORMULA_VERSION + 1 };
  expect(
    readCalculatedFigure({ ...future, checked: true, check: "supported", recalculated: true }),
  ).toEqual(future);
});

test("Analysis provenance alone allows an empty formula and empty input list", () => {
  const analysis = {
    ...figure(),
    formula: "",
    inputs: [],
    literals: [],
    analysis: { analysis: 2, result: "revenue_growth" },
  };
  expect(readCalculatedFigure(analysis)).toEqual(analysis);
  expect(
    readCalculatedFigure({ ...analysis, analysis: { analysis: 0, result: "revenue_growth" } }),
  ).toBeNull();
  expect(
    readCalculatedFigureAttributes({ id: "figure-1", figure: analysis, analysisId: "run-1" }),
  ).toEqual({ id: "figure-1", figure: analysis, analysisId: "run-1" });
  expect(readCalculatedFigureAttributes({ id: "figure-1", figure: analysis })).toBeNull();
});

test("a node builder uses only the caller's id and normalized provenance", () => {
  const value = figure();
  const node = calculatedFigureNode(value, "figure-1");
  expect(node).toEqual({
    type: CALCULATED_FIGURE_NODE,
    attrs: { id: "figure-1", figure: value, analysisId: null },
  });
  expect(readCalculatedFigureAttributes({ ...node.attrs, checked: true })).toEqual(node.attrs);
  expect(readCalculatedFigureAttributes({ id: "", figure: value })).toBeNull();
  expect(
    readCalculatedFigureAttributes({ id: "figure-1", figure: value, analysisId: "unrelated-run" }),
  ).toBeNull();
  expect(() => calculatedFigureNode(value, "")).toThrow();
});

test.each([null, true, 1, "{}", []])("non-record input is rejected: %j", (value) => {
  expect(readFigureCitation(value)).toBeNull();
  expect(readFigureInput(value)).toBeNull();
  expect(readCalculatedFigure(value)).toBeNull();
  expect(readCalculatedFigureAttributes(value)).toBeNull();
});

test("an unnamed note added from an Answer is named with its figure's shown text", () => {
  const shown = figure().shown;
  expect(
    firstLineOfBlocks([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Revenue grew " },
          calculatedFigureNode(figure(), "figure"),
          { type: "text", text: " on the year." },
        ],
      },
    ]),
  ).toBe(`Revenue grew ${shown} on the year.`);
});
