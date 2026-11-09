/**
 * The judge is told that a Document's default unit ("unless otherwise stated") is no condition only
 * in the check of a sentence that names a unit (#2889). Every sentence of #2515's near-copy cases
 * and of the repeated-checks sets names none, so their checks are sent exactly what they were.
 */
import { describe, expect, test } from "vitest";
import { SETS } from "../../eval/repeats/cases";
import { VERDICT_SETS } from "../../eval/repeats/verdictCases";
import { checkInstructions } from "../../src/core/answers/checks/prompt";
import { readStatedUnits } from "../../src/shared/figures";
import { OTHERWISE_DECOYS } from "../live/defaultUnitsOtherwise.cases";
import { AMENDED_SETS } from "../live/nearCopyAmended.cases";
import { ASK_PATHS_SETS } from "../live/nearCopyAskPaths.cases";
import { BEYOND_EXAMPLES_SETS } from "../live/nearCopyBeyondExamples.cases";
import { CONDITION_FORMS_SETS } from "../live/nearCopyConditionForms.cases";
import { CONFIRMED_SETS } from "../live/nearCopyConfirmed.cases";
import { NEAR_COPY_SETS } from "../live/nearCopyHeldout.cases";
import { ROOT_CAUSE_SETS } from "../live/nearCopyRootCause.cases";
import { SECOND_LOOK_SETS } from "../live/nearCopySecondLook.cases";
import { WALK_SHAPE_SETS } from "../live/nearCopyWalkShape.cases";

const DEFAULT_RULE = "gives the Document's default, not a condition on the sentence";

const instructions = (claim: string) =>
  checkInstructions("tools", "en", "", false, false, true, true, claim);

describe("a Document's default unit (#2889)", () => {
  // protects=the unit rule, with the line's default, is told only in the check of a sentence that names a unit, in English and Chinese; fails_when=a unit line goes without it, or a sentence about a right or a duty is told it; no_claim=a real model's verdict, which tests/live/defaultUnits.live.test.ts measures.
  test.each([
    ["Figures are in GBP million, as the Westmoor documents give them.", true],
    ["数字单位为人民币百万元，与嘉陵水务的文件一致。", true],
    ["The Tenant may sublet the flat with the Landlord's consent.", false],
    ["承租人经出租人同意后可以转租。", false],
  ])("%s: %s", (claim, told) => {
    expect(instructions(claim).includes(DEFAULT_RULE)).toBe(told);
  });

  // protects=each decoy of a duty or right whose own condition is an "otherwise" clause names a unit, so its check is told the default rule and the decoy tries it; fails_when=a decoy names no unit and tests nothing; no_claim=its real-model verdict, which tests/live/defaultUnits.live.test.ts measures.
  test.each(OTHERWISE_DECOYS.map(({ sentence }) => sentence))("%s is told the rule", (sentence) => {
    expect(instructions(sentence).includes(DEFAULT_RULE)).toBe(true);
  });

  // protects=#2515's near-copy cases and the repeated-checks sets are sent the instructions they were, word for word: none of their sentences names a unit, so none is told the default rule; fails_when=the rule reaches a sentence about a right, a duty or a condition; no_claim=none beyond protects.
  test("#2515's sentences are sent what they were", () => {
    const sentences = [
      ...[...NEAR_COPY_SETS, ...CONFIRMED_SETS, ...BEYOND_EXAMPLES_SETS].flatMap((set) =>
        set.cases.map((each) => each.text),
      ),
      ...[
        ...AMENDED_SETS,
        ...ASK_PATHS_SETS,
        ...CONDITION_FORMS_SETS,
        ...ROOT_CAUSE_SETS,
        ...SECOND_LOOK_SETS,
      ].flatMap((set) => set.cases.map((each) => each.text)),
      ...WALK_SHAPE_SETS.flatMap((set) => set.cases.map((each) => each.sentence)),
      ...[...SETS, ...VERDICT_SETS].flatMap((set) => set.sentences.map((each) => each.text)),
    ];
    expect(sentences.length).toBeGreaterThan(400);
    const asBefore = instructions("");
    expect(sentences.filter((claim) => instructions(claim) !== asBefore)).toEqual([]);
    // A reply is read with a unit line's default as no condition only where its sentence names a unit.
    expect(sentences.filter((claim) => readStatedUnits(claim).length > 0)).toEqual([]);
  });
});
