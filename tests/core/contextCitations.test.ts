import { describe, expect, test } from "vitest";
import {
  createContextCitations,
  replaceWritten,
  writtenIds,
} from "../../src/core/answers/contextCitations";

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

  // protects=an id this Answer issued is found as the model may write it (as read, full-width, round, alone), and nothing else: not an id it never issued, another case, words around it, or code; fails_when=an issued id stays in the text, or ordinary text is rewritten; no_claim=none beyond protects.
  test("only ids issued, in their issued form, are found as the model writes them", () => {
    const issued = (id: string) => ["C1", "C2", "C3", "C4", "C5", "C6", "C7"].includes(id);
    const text =
      "Tides [Tides, p. 3 · C1]. Both [C2; C3]. Footnote [^C4]. 潮汐【Tides, p. 3 · C5】（Tides · C6）. Round (C7). Never issued [C9] or [Tides · C9]. Lower [c1]. A grade [C5 grade] and `[Tides · C6]`.";

    expect(writtenIds(text, issued).map((each) => each.ids)).toEqual([
      ["C1"],
      ["C2", "C3"],
      ["C4"],
      ["C5"],
      ["C6"],
      ["C7"],
    ]);
  });

  // protects=a remark in round brackets that ends in a cited id keeps its words: only the id's own bracket becomes the marker, in English and Chinese; fails_when=the whole remark is taken out with the id; no_claim=none beyond protects.
  test.each([
    [
      "Revenue grew (up 12% year on year, as the report says [Annual report, p. 3 · C1]).",
      "Revenue grew (up 12% year on year, as the report says[^1]).",
    ],
    ["收入增长了（同比增长 12%，见【年报, p. 3 · C1】）。", "收入增长了（同比增长 12%，见[^1]）。"],
  ])("a remark in round brackets keeps its words: %s", (text, kept) => {
    const issued = (id: string) => id === "C1";

    expect(replaceWritten(text, writtenIds(text, issued), () => "[^1]")).toBe(kept);
  });
});
