import { describe, expect, test } from "vitest";
import {
  bars,
  kindOf,
  type Outcome,
  problemsOf,
  scoreNewUser,
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

  test("says PASS or FAIL against each bar", () => {
    const result = bars(scoreNewUser(outcomes, folders, verdicts));
    expect(result.map((each) => [each.value, each.pass])).toEqual([
      ["5/6 (83%)", true],
      ["1 (sizes 3, 1, 2)", false],
      ["1/4 (25%)", false],
      ["2/6 (33%)", false],
      ["0.77 (P 0.83, R 0.71)", false],
      ["1/2 (50%)", false],
      ["7", true],
    ]);
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
