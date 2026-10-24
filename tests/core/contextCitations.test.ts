import { describe, expect, test } from "vitest";
import { createContextCitations, writtenIds } from "../../src/core/answers/contextCitations";

const cited = {
  passageId: "p1",
  documentId: "d1",
  contentHash: "h1",
  pageFrom: 3,
  pageTo: 3,
  quote: "Spring tides come at full moon.",
};

describe("The Citations a Question context shows, by id (#1800)", () => {
  // protects=one Citation read twice has one id, and the same quote at another place of the Passage is another Citation with its own; fails_when=two places share an id, so keeping one keeps the other's place; no_claim=none beyond protects.
  test("the same Citation has one id; the same quote elsewhere has its own", () => {
    const ids = createContextCitations();
    const rows = { ...cited, location: { kind: "rows", sheet: "Tides", from: 2, to: 2 } };
    const lower = { ...rows, location: { kind: "rows", sheet: "Tides", from: 9, to: 9 } };

    expect([ids.idOf(rows), ids.idOf(rows), ids.idOf(lower)]).toEqual(["C1", "C1", "C2"]);
    expect(ids.get("c2")?.location).toEqual(lower.location);
    expect(ids.idOf({ quote: "No Document." })).toBeNull();
  });

  // protects=an id is found as the model reads it or as ids alone, never in code or in a bracket that only says C and a number; fails_when=a Citation's id stays in the text, or ordinary text is taken for one; no_claim=none beyond protects.
  test("ids written as text are found as the model writes them, and nothing else", () => {
    const text =
      "Tides [Tides, p. 3 · C1]. Both [C2; C3]. Footnote [^C4]. A grade [C5 grade] and `[Tides · C6]`.";

    expect(writtenIds(text).map((each) => each.ids)).toEqual([["C1"], ["C2", "C3"], ["C4"]]);
  });
});
