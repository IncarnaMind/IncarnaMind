/**
 * The form's held-out gate reads its cases and slots only when asked for, and checks them first
 * (#2847): the stand-in it is dry-run on passes, and a case file with a field left empty, a rest its
 * Document doesn't hold, a template button without its template or a probe with nothing to avoid
 * stops the run before anything is sent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { caseProblems, slotsOf } from "../../eval/speed/callHelp";
import { CALL_HELP_FACT_LINES_STAND_IN } from "../../eval/speed/callHelpFactLinesStandIn";

const slots = slotsOf(
  readFileSync(join(__dirname, "../../eval/speed/callHelpFactLinesStandIn.slots.md"), "utf8"),
);

describe("the form's gate cases are checked before a run (#2847)", () => {
  // protects=the stand-in's 40 cases match its 20 slots and hold every field, so its dry run reads like the gate's; fails_when=a slot or case goes missing, or a field is empty; no_claim=what the cases say.
  test("the stand-in passes, slot for slot", () => {
    expect(slots).toHaveLength(20);
    expect(slots.filter((slot) => slot.marks.includes("P")).map((slot) => slot.slot)).toEqual([
      3, 5, 6, 7, 9, 13, 19, 20,
    ]);
    expect(caseProblems(CALL_HELP_FACT_LINES_STAND_IN, slots)).toEqual([]);
  });

  // protects=a case with its answer empty, a rest its Document doesn't hold, a template button without its template, a probe with nothing to avoid, or a slot with no case, each stops the run with its own line; fails_when=any of them passes the check; no_claim=none beyond protects.
  test("each kind of fault stops the run", () => {
    const [first, second, , , fifth, , , , ninth] = CALL_HELP_FACT_LINES_STAND_IN;
    if (!first || !second || !fifth || !ninth) throw new Error("The stand-in is short.");
    const broken = [
      { ...first, answer: "" },
      {
        ...second,
        rests: [[{ in: second.documents[0]?.file ?? "", line: "Not in the Document." }]],
      },
      { ...fifth, avoid: undefined },
      { ...ninth, template: undefined },
      ...CALL_HELP_FACT_LINES_STAND_IN.slice(9).filter(
        (each) => each.id !== "standin-zh-20-answer",
      ),
    ];
    const problems = caseProblems(broken, slots).join("\n");
    expect(problems).toContain(`${first.id}: its answer is empty.`);
    expect(problems).toContain(`${second.id}: “Not in the Document.” isn't in`);
    expect(problems).toContain(`${fifth.id}: its avoid is empty.`);
    expect(problems).toContain(`${ninth.id}: a objection press needs the sales template.`);
    expect(problems).toContain("no case standin-zh-20-answer");
  });
});
