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
/** A figure the core didn't work out again: the table's words, "From the Analysis · not recalculated". */
const notRecalculated: ClaimCheckShown = { state: "not-checked", reason: "analysis" };
/** A figure whose run the Note no longer keeps: "The Analysis it came from is no longer available". */
const gone: ClaimCheckShown = { state: "not-checked", reason: "analysis-gone" };
const versions = new Map([["source", "v1"]]);

const misnamed = {
  kind: "analysis-name" as const,
  reason: "The sentence doesn’t say this figure is Total yield",
  covered: null,
  uncovered: null,
  found: true as const,
};

test("a figure worked out again has no verdict of its own until a check reads its sentence as naming it (#2378)", () => {
  expect(analysisFigureShown(unchecked, { run, result: "total", versions })).toEqual(unchecked);
  expect(
    analysisFigureShown(
      { state: "supported" },
      {
        run,
        result: "total",
        versions,
        check: { state: "supported", unsupported: null, named: true },
      },
    ),
  ).toEqual({ state: "supported" });
});

test("a check stands for the figure only as the claim judge read its naming", () => {
  // Supported without the judge's reading, as an earlier build stored it: not a name anyone read.
  expect(
    analysisFigureShown(
      { state: "supported" },
      { run, result: "total", versions, check: { state: "supported", unsupported: null } },
    ),
  ).toEqual(unchecked);
  // An Unsupported against the Documents' text, which never holds the figure, isn't its name.
  for (const claim of [{ state: "unsupported" }, { state: "contradicted" }] as const)
    expect(
      analysisFigureShown(claim, {
        run,
        result: "total",
        versions,
        check: { state: claim.state, unsupported: { ...misnamed, kind: "unbacked-cause" } },
      }),
    ).toEqual(unchecked);
  expect(
    analysisFigureShown(
      { state: "unsupported" },
      { run, result: "total", versions, check: { state: "unsupported", unsupported: misnamed } },
    ),
  ).toEqual({ state: "unsupported" });
  // Once the sentence's words changed, it waits for the next Check, whatever was read before.
  expect(
    analysisFigureShown(
      { state: "needs-recheck", why: "edited" },
      {
        run,
        result: "total",
        versions,
        check: { state: "supported", unsupported: null, named: true },
      },
    ),
  ).toEqual({ state: "needs-recheck", why: "edited" });
  const total = run.values[0];
  if (!total) throw new Error("Missing fixture");
  const fromCode: RetainedFigureAnalysis = { ...run, values: [{ ...total, check: undefined }] };
  expect(
    analysisFigureShown(
      { state: "supported" },
      {
        run: fromCode,
        result: "total",
        versions,
        check: { state: "supported", unsupported: null, named: true },
      },
    ),
  ).toEqual(notRecalculated);
});

test("a total that doesn't add up, or a wall the Note is outside, stands whatever the judge read", () => {
  const named = { state: "supported" as const, unsupported: null, named: true as const };
  expect(
    analysisFigureShown({ state: "unsupported" }, { run, result: "total", versions, check: named }),
  ).toEqual({ state: "unsupported" });
  expect(
    analysisFigureShown(
      { state: "not-checked", reason: "kept-inside" },
      { run, result: "total", versions, check: named },
    ),
  ).toEqual({ state: "not-checked", reason: "kept-inside" });
});

test("a figure whose Document changed or went needs a re-check, as a calculated figure does", () => {
  expect(
    analysisFigureShown(unchecked, {
      run,
      result: "total",
      versions: new Map([["source", "v2"]]),
    }),
  ).toEqual({ state: "needs-recheck", why: "new-version" });
  expect(
    analysisFigureShown(unchecked, {
      run,
      result: "total",
      versions: new Map(),
    }),
  ).toEqual({ state: "needs-recheck", why: "document-removed" });
});

test("versions unknown to the reader never turn a check into a re-check", () => {
  expect(
    analysisFigureShown(
      { state: "supported" },
      {
        run,
        result: "total",
        versions: null,
        check: { state: "supported", unsupported: null, named: true },
      },
    ),
  ).toEqual({ state: "supported" });
});

test("a check that differs, could not be made, or is missing leaves the figure as it showed", () => {
  const total = run.values[0];
  if (!total) throw new Error("Missing fixture");
  const differs: RetainedFigureAnalysis = {
    ...run,
    values: [{ ...total, check: { kind: "differs", value: 198250 } }],
  };
  expect(analysisFigureShown(unchecked, { run: differs, result: "total", versions })).toEqual(
    notRecalculated,
  );
  const failed: RetainedFigureAnalysis = {
    ...run,
    values: [{ ...total, check: { kind: "unchecked", reason: "no row 241" } }],
  };
  expect(analysisFigureShown(unchecked, { run: failed, result: "total", versions })).toEqual(
    notRecalculated,
  );
  expect(analysisFigureShown(unchecked, { run: null, result: "total", versions })).toEqual(gone);
});

test("an Analysis figure whose record the Note no longer keeps never shows checked (#2378)", () => {
  expect(
    analysisFigureShown({ state: "supported" }, { run: null, result: "total", versions }),
  ).toEqual(gone);
  expect(
    analysisFigureShown({ state: "contradicted" }, { run: null, result: "total", versions }),
  ).toEqual(gone);
  const withoutTheValue: RetainedFigureAnalysis = { ...run, values: [] };
  expect(
    analysisFigureShown(
      { state: "supported" },
      { run: withoutTheValue, result: "total", versions },
    ),
  ).toEqual(gone);
});

test("the User's own kept view of the sentence still shows when the record is gone", () => {
  expect(analysisFigureShown({ state: "kept" }, { run: null, result: "total", versions })).toEqual({
    state: "kept",
  });
});

test("a figure with no Analysis keeps its sentence's own check: there is no record to miss", () => {
  expect(
    analysisFigureShown({ state: "supported" }, { run: null, result: null, versions }),
  ).toEqual({ state: "supported" });
});
