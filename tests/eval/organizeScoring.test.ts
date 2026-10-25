import { describe, expect, test } from "vitest";
import {
  breakdown,
  f1,
  type Labelled,
  mistakes,
  type Prediction,
  perTag,
  precision,
  recall,
  summarise,
  thresholdSweep,
} from "../../eval/organize/lib/scoring";
import { definitions } from "../../eval/organize/lib/set";

const predicted = (
  id: string,
  folder: string | null,
  tags: string[],
  extra: Partial<Prediction> = {},
): Prediction => ({
  id,
  folder,
  tags: tags.map((key) => ({
    key: key.replace("?", ""),
    confidence: null,
    needsReview: key.endsWith("?"),
  })),
  error: null,
  ms: 1000,
  renderMs: 0,
  model: "m",
  images: false,
  ...extra,
});

describe("the Organize benchmark's scoring", () => {
  const a: Labelled = { id: "a", folder: "finance", tags: ["invoice"] };
  const b: Labelled = {
    id: "b",
    folder: "reports",
    alsoFolder: "finance",
    tags: ["slides", "report"],
  };
  const c: Labelled = { id: "c", folder: null, tags: ["notes"] };
  const d: Labelled = { id: "d", folder: "contracts", tags: ["contract"] };

  test("counts Folders strictly and leniently, and Tags micro-averaged with every applied Tag", () => {
    const pairs = [
      { doc: a, prediction: predicted("a", "finance", ["invoice"]) },
      // The second Folder: wrong strictly, right leniently. One Tag missed, one extra under review.
      { doc: b, prediction: predicted("b", "finance", ["slides", "notes?"]) },
      // Unsorted is a Folder like any other.
      { doc: c, prediction: predicted("c", null, ["notes"]) },
      // A failed request: wrong Folder, no Tags, and no time counted.
      {
        doc: d,
        prediction: predicted("d", undefined as unknown as null, [], {
          error: "timeout",
          ms: 99_000,
        }),
      },
    ];
    const s = summarise(pairs);
    expect(s).toMatchObject({
      count: 4,
      errors: 1,
      folderCorrect: 2,
      folderLenient: 3,
      tp: 3,
      fp: 1,
      fn: 2,
      exact: 2,
      review: 1,
      reviewCorrect: 0,
      msMedian: 1000,
    });
    expect(precision(s)).toBeCloseTo(0.75);
    expect(recall(s)).toBeCloseTo(0.6);
    expect(f1(s)).toBeCloseTo((2 * 0.75 * 0.6) / 1.35);
  });

  test("lists mistakes with what was missing and extra, and splits results by a key", () => {
    const pairs = [
      { doc: a, prediction: predicted("a", "finance", ["invoice"]) },
      { doc: b, prediction: predicted("b", "reports", ["slides"]) },
      { doc: c, prediction: predicted("c", "meetings", ["notes", "report"]) },
    ];
    expect(mistakes(pairs).map(({ id, missing, extra }) => ({ id, missing, extra }))).toEqual([
      { id: "b", missing: ["report"], extra: [] },
      { id: "c", missing: [], extra: ["report"] },
    ]);
    const byFolder = breakdown(pairs, (doc) => doc.folder ?? "unsorted");
    expect(byFolder.map(([key, s]) => [key, s.count, s.folderCorrect])).toEqual([
      ["finance", 1, 1],
      ["reports", 1, 1],
      ["unsorted", 1, 0],
    ]);
    expect(perTag(pairs, ["report", "notes"])).toEqual([
      ["report", { tp: 0, fp: 1, fn: 1 }],
      ["notes", { tp: 1, fp: 0, fn: 0 }],
    ]);
  });

  test("scores Tags at each threshold from the probabilities of every Tag", () => {
    const pairs = [
      {
        doc: b,
        prediction: predicted("b", "reports", [], {
          scores: { slides: 0.9, report: 0.4, notes: 0.6 },
        }),
      },
      { doc: d, prediction: predicted("d", "contracts", [], { scores: { contract: 0.7 } }) },
      // A failed request applies nothing, whatever it carries.
      {
        doc: a,
        prediction: predicted("a", undefined as unknown as null, [], {
          error: "timeout",
          scores: { invoice: 0.99 },
        }),
      },
    ];
    const [low, high] = thresholdSweep(pairs, [0.5, 0.8]);
    expect(low).toMatchObject({ threshold: 0.5 });
    expect(low?.p).toBeCloseTo(2 / 3);
    expect(low?.r).toBeCloseTo(2 / 4);
    expect(high?.p).toBe(1);
    expect(high?.r).toBeCloseTo(1 / 4);
  });

  test("uses the app's own starter Folders and preset Tags, in either language", () => {
    const english = definitions("en");
    expect(english.folders.map((folder) => folder.id)).toEqual([
      "research",
      "reports",
      "contracts",
      "finance",
      "meetings",
    ]);
    expect(english.folders[3]?.name).toBe("Finance");
    expect(english.tags.map((tag) => tag.id)).toContain("invoice");
    expect(definitions("zh-CN").tags.find((tag) => tag.id === "invoice")?.name).toBe("发票");
  });
});
