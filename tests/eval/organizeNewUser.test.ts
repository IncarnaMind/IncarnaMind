import { describe, expect, test } from "vitest";
import {
  bars,
  kindOf,
  type Outcome,
  problemsOf,
  scoreNewUser,
  splitByArea,
  type TopicVerdict,
} from "../../eval/organize/lib/newUser";

const outcome = (
  id: string,
  label: string | null,
  kinds: string[],
  folder: string | null,
  tags: string[],
  readable = true,
): Outcome => ({
  doc: { id, folder: label, tags: kinds },
  readable,
  folder,
  tags,
  status: readable ? "classified" : "waiting",
  error: null,
});

const folders = [
  { id: "f1", name: "Studies", description: "" },
  { id: "f2", name: "Money", description: "" },
  { id: "f3", name: "Misc", description: "" },
];

describe("the Organize benchmark's new-User scores", () => {
  test("reads the preset Tags' names in either language and their plain synonyms as kinds", () => {
    expect(kindOf("Paper")).toBe("paper");
    expect(kindOf(" meeting  NOTES ")).toBe("notes");
    expect(kindOf("会议记录")).toBe("notes");
    expect(kindOf("幻灯片")).toBe("slides");
    expect(kindOf("Invoices")).toBe("invoice");
    expect(kindOf("Sleep research")).toBeNull();
  });

  const outcomes = [
    outcome("a", "research", ["paper"], "f1", ["Paper", "Sleep"]),
    outcome("b", "research", ["paper", "report"], "f1", ["Report"]),
    outcome("c", "research", ["slides"], null, ["Slides"]),
    outcome("d", "finance", ["invoice"], "f2", ["Invoice", "Sleep"]),
    outcome("e", "finance", ["report"], "f1", ["Notes"]),
    // Fits no Folder: counted as filed or not, never in a pair.
    outcome("f", null, ["book"], "f3", ["Book"]),
    // A scan with no text: left out of every measure but a Folder's size.
    outcome("g", "finance", ["invoice"], "f3", [], false),
  ];
  const verdicts: TopicVerdict[] = [
    { id: "a", tag: "Sleep", about: true },
    { id: "d", tag: "Sleep", about: false },
  ];

  test("scores filing, pairs, kinds, topics and names over the readable Documents", () => {
    const scores = scoreNewUser(outcomes, folders, verdicts);
    expect(scores).toMatchObject({
      readable: 6,
      filed: 5,
      samePairs: 4,
      sameShared: 1,
      sameTogether: 1,
      differentPairs: 6,
      differentShared: 2,
      kinds: { tp: 5, fp: 1, fn: 2 },
      topic: 2,
      offTopic: 1,
      unanswered: 0,
      names: 7,
      labelledKinds: 5,
    });
    expect(scores.folderSizes.map((each) => each.size)).toEqual([3, 1, 2]);
  });

  test("says PASS or FAIL against each bar, and reports the kinds both ways", () => {
    const result = bars(scoreNewUser(outcomes, folders, verdicts));
    expect(result.map((each) => [each.value, each.pass, each.reported ?? false])).toEqual([
      ["5/6 (83%)", true, false],
      ["1 (sizes 3, 1, 2)", false, false],
      ["1/4 (25%)", false, false],
      ["1/4 (25%)", false, false],
      ["2/6 (33%)", false, false],
      ["0.83 (P 0.83, R 0.83)", true, false],
      ["0.77 (P 0.83, R 0.71)", false, true],
      ["0", true, true],
      ["1/2 (50%)", false, false],
      ["7", true, false],
    ]);
    // With the labels as written gating instead, the one-kind score is the one reported.
    const written = bars(scoreNewUser(outcomes, folders, verdicts), "as-written");
    expect(written.slice(5, 7).map((each) => each.reported ?? false)).toEqual([true, false]);
  });

  describe("kind Tag F1 with one kind a Document, the rule settled on 2026-11-08", () => {
    const kinds = (...each: Outcome[]) => scoreNewUser(each, folders, []);

    test("a Document labelled two kinds is one pair: a hit with either, one miss with neither", () => {
      expect(
        kinds(
          outcome("a", "reports", ["slides", "report"], "f1", ["Report"]),
          outcome("b", "reports", ["slides", "report"], "f1", ["Slides"]),
        ).oneKind,
      ).toEqual({ tp: 2, fp: 0, fn: 0 });
      expect(
        kinds(outcome("c", "reports", ["slides", "report"], "f1", ["Invoice"])).oneKind,
      ).toEqual({ tp: 0, fp: 1, fn: 1 });
    });

    test("a Document labelled only kinds outside the list has no pair: no kind Tag adds nothing, one is a false positive", () => {
      const garden = (tags: string[]) => outcome("g", null, ["notes"], null, tags);
      expect(kinds(garden([])).oneKind).toEqual({ tp: 0, fp: 0, fn: 0 });
      expect(kinds(garden(["Report"])).oneKind).toEqual({ tp: 0, fp: 1, fn: 0 });
      expect(kinds(garden([]))).toMatchObject({ noKind: 1, noKindExpected: 1 });
    });

    test("every other Document with no kind Tag is a miss", () => {
      expect(kinds(outcome("p", "research", ["paper"], "f1", ["Sleep"])).oneKind).toEqual({
        tp: 0,
        fp: 0,
        fn: 1,
      });
      expect(kinds(outcome("p", "research", ["paper"], "f1", []))).toMatchObject({
        noKind: 1,
        noKindExpected: 0,
      });
    });

    test("Meeting notes stands for the labels' notes on a meeting's Document", () => {
      expect(
        kinds(
          outcome("m", "meetings", ["notes"], "f1", ["Meeting notes"]),
          outcome("n", "meetings", ["slides", "notes"], "f1", ["会议记录"]),
        ).oneKind,
      ).toEqual({ tp: 2, fp: 0, fn: 0 });
    });
  });

  test("passes a proposal that keeps the labels together in Folders of three", () => {
    const good = [
      outcome("a", "research", ["paper"], "f1", ["Paper"]),
      outcome("b", "research", ["paper"], "f1", ["Paper", "Sleep"]),
      outcome("c", "research", ["paper"], "f1", ["Paper"]),
      outcome("d", "finance", ["invoice"], "f2", ["Invoice"]),
      outcome("e", "finance", ["invoice"], "f2", ["Invoice"]),
      outcome("f", "finance", ["invoice"], "f2", ["Invoice"]),
    ];
    const result = bars(
      scoreNewUser(good, folders.slice(0, 2), [{ id: "b", tag: "Sleep", about: true }]),
    );
    expect(result.every((each) => each.pass)).toBe(true);
  });

  describe("the same-label bar's allowance for a split by area", () => {
    const part = (prefix: string, label: string, kinds: string[], folder: string, count: number) =>
      Array.from({ length: count }, (_, at) => outcome(`${prefix}${at}`, label, kinds, folder, []));
    const scored = (each: Outcome[]) => {
      const scores = scoreNewUser(each, folders, []);
      return [scores.samePairs, scores.sameShared, scores.sameTogether];
    };

    test("a label in two Folders of 3 or more, each at least 90% the label, counts as together", () => {
      const split = [
        ...part("a", "meetings", ["notes"], "f1", 3),
        ...part("b", "meetings", ["notes"], "f2", 3),
      ];
      expect([...splitByArea(split)]).toEqual(["meetings"]);
      expect(scored(split)).toEqual([15, 6, 15]);
    });

    test("a split in three doesn't count", () => {
      const three = [
        ...part("a", "meetings", ["notes"], "f1", 3),
        ...part("b", "meetings", ["notes"], "f2", 3),
        ...part("c", "meetings", ["notes"], "f3", 3),
      ];
      expect(splitByArea(three).size).toBe(0);
      expect(scored(three)).toEqual([36, 9, 9]);
    });

    test("a part under 90% the label doesn't count", () => {
      const mixed = [
        ...part("a", "meetings", ["notes"], "f1", 8),
        outcome("x", "finance", ["invoice"], "f1", []),
        ...part("b", "meetings", ["notes"], "f2", 3),
      ];
      expect(splitByArea(mixed).size).toBe(0);
      expect(scored(mixed)).toEqual([55, 31, 31]);
    });

    test("a part of fewer than 3 doesn't count", () => {
      const small = [
        ...part("a", "meetings", ["notes"], "f1", 4),
        ...part("b", "meetings", ["notes"], "f2", 2),
      ];
      expect(splitByArea(small).size).toBe(0);
      expect(scored(small)).toEqual([15, 7, 7]);
    });

    test("a split by kind never counts", () => {
      const byKind = [
        ...part("a", "research", ["paper"], "f1", 3),
        ...part("b", "research", ["paper", "report"], "f2", 3),
      ];
      expect(splitByArea(byKind).size).toBe(0);
      expect(scored(byKind)).toEqual([15, 6, 6]);
    });
  });

  test("names what is wrong with a Document by its labels", () => {
    const problems = Object.fromEntries(
      outcomes.map((each) => [each.doc.id, problemsOf(each, outcomes, verdicts)]),
    );
    expect(problems).toEqual({
      a: [],
      b: ["kind missing: paper"],
      c: ["not filed"],
      d: ["off-topic: Sleep"],
      e: ["in a Folder mostly of research", "kind missing: report", "kind not labelled: notes"],
      f: [],
      g: [],
    });
  });
});
