import { describe, expect, test } from "vitest";
import { withAnalysisResults } from "../../src/core/analysis/markers";
import type { AnswerAnalysis } from "../../src/core/api";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { withAnalysisPictures } from "../../src/shared/analysisPictures";

/** An Analysis of one Answer, giving table 1 and picture 1 of its own. */
function analysis(title: string, row: (string | number)[], picture: string): AnswerAnalysis {
  return {
    number: 1,
    title,
    language: "python",
    code: "result('by_region', series)",
    inputs: [],
    versions: null,
    codeSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    end: { kind: "done" },
    output: {
      ...noAnalysisOutput(),
      results: [
        {
          kind: "table",
          name: "by_region",
          label: title,
          unit: null,
          table: { columns: ["Region", "Revenue"], rows: [row], rowCount: 1, columnCount: 2 },
        },
      ],
      pictures: [{ title: picture, png: "iVBORw0KGgo=", width: 10, height: 10 }],
    },
    ms: 1,
    ranAt: "2026-11-01T00:00:00.000Z",
    markers: {
      figures: [],
      tables: [{ result: "by_region", marker: 1 }],
      charts: [],
      pictures: [1],
    },
  };
}

describe("an Analysis marker written into a Note (#2378)", () => {
  // protects=markers numbered the same in two Answers name this Answer's Analysis first, so a later turn's Answer can't take this one's table or picture; fails_when=the second Answer's table or picture replaces the first's.
  test("the first Analysis that gave a marker names it", () => {
    const current = analysis("This Answer", ["North", 10], "This Answer's plot");
    const earlier = analysis("Last Answer", ["South", 20], "Last Answer's plot");

    const table = withAnalysisResults("Revenue:\n\n[=table 1]", [current, earlier], "en");
    expect(table).toContain("| North | 10 |");
    expect(table).not.toContain("South");

    const pictures = withAnalysisPictures(
      [{ type: "paragraph", content: [{ type: "text", text: "[=picture 1]" }] }],
      [current, earlier],
    );
    expect(pictures).toEqual([
      expect.objectContaining({
        type: "picture",
        attrs: expect.objectContaining({ alt: "This Answer's plot" }),
      }),
    ]);
  });
});
