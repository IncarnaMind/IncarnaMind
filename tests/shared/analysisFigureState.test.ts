import { expect, test } from "vitest";
import type { Citation, RetainedFigureAnalysis } from "../../src/core/api";
import { analysisFigureShown, type ClaimCheckShown } from "../../src/shared/claimChecks";

const citation: Citation = {
  documentId: "source",
  passageId: "passage",
  documentName: "Greenhouse Harvests 2026",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "rows", sheet: "Harvests", from: 1, to: 240 },
  quote: "Plot\tYield",
  check: "found",
  checkReason: null,
};

const run: RetainedFigureAnalysis = {
  id: "run",
  title: "Total yield",
  language: "python",
  code: 'figure("total", df["Yield"], "sum")',
  codeSha256: "a".repeat(64),
  ranAt: "2026-11-01T12:00:00.000Z",
  versions: null,
  inputs: [
    {
      kind: "range",
      name: "harvests",
      citation,
      range: "A1:B240",
      rows: 240,
      columns: 2,
      rowCount: 240,
      cut: false,
      sha256: "b".repeat(64),
    },
  ],
  values: [
    {
      kind: "figure",
      name: "total",
      label: "Total yield",
      value: 198854.9,
      unit: null,
      check: { kind: "same", value: 198854.9 },
    },
  ],
};

const unchecked: ClaimCheckShown = { state: "not-checked", reason: "unread" };
const versions = new Map([["source", "v1"]]);

test("a figure the core worked out again shows checked while its Document is as it was", () => {
  expect(
    analysisFigureShown(unchecked, { checked: false, run, result: "total", versions }),
  ).toEqual({ state: "supported" });
});

test("a check that ran over the figure but left it unread never shows it checked", () => {
  expect(analysisFigureShown(unchecked, { checked: true, run, result: "total", versions })).toEqual(
    unchecked,
  );
});

test("a figure whose Document changed or went needs a re-check, as a calculated figure does", () => {
  expect(
    analysisFigureShown(unchecked, {
      checked: false,
      run,
      result: "total",
      versions: new Map([["source", "v2"]]),
    }),
  ).toEqual({ state: "needs-recheck", why: "new-version" });
  expect(
    analysisFigureShown(unchecked, {
      checked: false,
      run,
      result: "total",
      versions: new Map(),
    }),
  ).toEqual({ state: "needs-recheck", why: "document-removed" });
});

test("versions unknown to the reader never turn a check into a re-check", () => {
  expect(
    analysisFigureShown(unchecked, { checked: false, run, result: "total", versions: null }),
  ).toEqual({ state: "supported" });
});

test("a check that differs, could not be made, or is missing leaves the figure as it showed", () => {
  const total = run.values[0];
  if (!total) throw new Error("Missing fixture");
  const differs: RetainedFigureAnalysis = {
    ...run,
    values: [{ ...total, check: { kind: "differs", value: 198250 } }],
  };
  expect(
    analysisFigureShown(unchecked, { checked: false, run: differs, result: "total", versions }),
  ).toEqual(unchecked);
  const failed: RetainedFigureAnalysis = {
    ...run,
    values: [{ ...total, check: { kind: "unchecked", reason: "no row 241" } }],
  };
  expect(
    analysisFigureShown(unchecked, { checked: false, run: failed, result: "total", versions }),
  ).toEqual(unchecked);
  expect(
    analysisFigureShown(unchecked, { checked: false, run: null, result: "total", versions }),
  ).toEqual(unchecked);
});
