/**
 * The call-help marks gate's bars as the paired run's report computes them (#2847), on scripted
 * rows: nothing is sent anywhere. The numbers are the gate file's rules worked by hand.
 */
import { describe, expect, test } from "vitest";
import {
  fisherOneSided,
  marksSection,
  median,
  signTestP,
} from "../../eval/speed/callHelpMarksReport";
import type { ArmRun } from "../../eval/speed/paired";
import { messageDifference, type PairedRow, sameRequestOf } from "../../eval/speed/pairedReport";

type Marks = NonNullable<ArmRun["marks"]>;

function arm(given: Partial<ArmRun> & { marks?: Marks }): ArmRun {
  return {
    status: "done",
    error: null,
    firstSignMs: 10,
    firstWordsMs: 1000,
    doneMs: 4000,
    modelCalls: 2,
    answerCalls: 2,
    searches: 0,
    inputTokens: 1000,
    outputTokens: 100,
    citations: 2,
    found: 2,
    cited: true,
    grade: "right",
    falseSupported: 0,
    duplicate: false,
    failures: [],
    text: "★ An option [1]",
    ...given,
  };
}

const marks = (given: Partial<Marks>): Marks => ({
  held: 1,
  checked: 1,
  judged: 1,
  missed: {},
  listed: 0,
  listedChecked: 0,
  settledMs: 1500,
  judge: { grade: "right", unstated: [] },
  numbers: [],
  ...given,
});

/**
 * Ten presses an arm and language, two runs, on one model. On main's arm presses 0 to 5 show a
 * wrong ✓ in run 1 and 0 to 4 in run 2. On the branch's own replies the judge lists a found
 * number in the same presses (W0); the check clears all but press 0's in run 1 (W1); held numbers
 * keep their ✓ but one press's; and the branch is slower in 7 of the 10 pairs of each run.
 */
function rows(): PairedRow[] {
  const made: PairedRow[] = [];
  for (const language of ["en", "zh-CN"] as const) {
    for (const run of [1, 2]) {
      for (let press = 0; press < 10; press++) {
        const wrong = press < (run === 1 ? 6 : 5);
        made.push({
          set: "call-help-marks",
          id: `${language}-${press}`,
          kind: "answer-newest",
          language,
          model: "anthropic/claude-sonnet-5-5",
          run,
          first: press % 2 === 0 ? 0 : 1,
          sameRequest: true,
          sameSetup: true,
          messageDifference: null,
          baseline: arm({
            falseSupported: wrong ? 1 : 0,
            doneMs: 4000,
            marks: marks({ listed: wrong ? 1 : 0, listedChecked: wrong ? 1 : 0 }),
          }),
          candidate: arm({
            falseSupported: wrong && press === 0 && run === 1 ? 1 : 0,
            doneMs: press < 7 ? 4100 : 3900,
            marks: marks({
              listed: wrong ? 1 : 0,
              listedChecked: wrong && press === 0 && run === 1 ? 1 : 0,
              checked: press === 9 ? 0 : 1,
              judged: press === 9 ? 0 : 1,
              missed: press === 9 ? { "not-checked:no reason": 1 } : {},
              settledMs: 1000 + press * 1000,
            }),
          }),
        });
      }
    }
  }
  return made;
}

describe("the call-help marks gate's report", () => {
  test("its statistics agree with their textbook values", () => {
    expect(fisherOneSided(8, 2, 1, 5)).toBeCloseTo(0.024476, 5);
    expect(fisherOneSided(5, 5, 5, 5)).toBeCloseTo(0.671859, 5);
    expect(signTestP(22, 30)).toBeCloseTo(0.008062, 5);
    expect(signTestP(21, 30)).toBeCloseTo(0.021387, 5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });

  test("it prints W0, W1, the Fisher p and the sign counts for each bar", () => {
    const section = marksSection(rows()) ?? "";
    console.log(section);

    // W0: 6 + 5 presses a language, both languages: 22; W1: one press a language: 2, at most 11.
    expect(section).toContain("40 presses: W0 22, W1 2, at most 11: 1a holds.");
    // Held numbers: 40, 36 with ✓; listed: 22, 2 with ✓.
    expect(section).toContain("✓ among held numbers 36 of 40 (90%), among listed 2 of 22 (9%)");
    expect(section).toContain("1b holds");
    expect(section).toContain("main's arm gave a wrong ✓ in 22 presses (its flips 2)");
    expect(section).toContain("Chinese W1 1, English W1 1, the branch's flips 1: Closes #2847.");
    expect(section).toContain("2, kept ✓: 18 of 20 (90%), at least a third: holds.");
    expect(section).toContain("the branch slower in 14 of 20 pairs, sign test p = 0.0577: holds.");
    expect(section).toContain("within 3 s 6 of 20 (30%), 5 s 10 of 20 (50%), 10 s 20 of 20 (100%)");
    expect(section).toContain(
      "Bar 4a: the same model, system prompt, Tools and parameters in 40 of 40 pairs: holds.",
    );
    expect(section).toContain("Reported: 0 pairs whose messages differed.");
  });

  test("a check that shows no ✓, or one slower in 22 of 30 pairs, fails its bar", () => {
    const none = rows().map((row) => ({
      ...row,
      candidate: {
        ...row.candidate,
        marks: { ...(row.candidate.marks as Marks), checked: 0, listedChecked: 0 },
      },
    }));
    expect(marksSection(none)).toContain("at least a third: **fails**");
    expect(marksSection(none)).toContain("1b **fails**");

    const slow = rows()
      .filter((row) => row.language === "en")
      .flatMap((row) => [row, { ...row, id: `${row.id}-again` }, { ...row, id: `${row.id}-more` }])
      .slice(0, 30)
      .map((row, index) => ({
        ...row,
        candidate: { ...row.candidate, doneMs: index < 22 ? 4100 : 3900 },
      }));
    expect(marksSection(slow)).toContain(
      "the branch slower in 22 of 30 pairs, sign test p = 0.00806: **fails**",
    );
  });

  test("bar 4a gates the setup in every pair, and lists pairs whose messages alone differ", () => {
    const setup = JSON.stringify({
      model: "anthropic/claude-sonnet-5-5",
      system: ["Help"],
      tools: [],
    });
    const sent = (transcript: string) => ({
      setup,
      messages: JSON.stringify([
        { role: "user", content: `<live-transcript>${transcript}</live-transcript>` },
      ]),
    });
    // One pair of each kind: the same messages, and messages a transcript line split otherwise.
    const alike = [
      sent("[0:04 Them] Can we start in June?"),
      sent("[0:04 Them] Can we start in June?"),
    ];
    const split = [
      sent("[0:04 Them] Can we start in June?"),
      sent("[0:04 Them] Can we start\n[0:06 Them] in June?"),
    ];
    expect(messageDifference(alike[0]?.messages ?? "", alike[1]?.messages ?? "")).toBeNull();
    const difference = messageDifference(split[0]?.messages ?? "", split[1]?.messages ?? "");
    console.log(`A pair whose messages differ: ${difference}`);
    expect(difference).toContain("start");
    expect(sameRequestOf(split[0]?.setup ?? null, split[1]?.setup ?? null)).toBe(true);

    const made = rows().map((row, index) =>
      row.language === "en" && index < 4 ? { ...row, messageDifference: difference } : row,
    );
    const section = marksSection(made) ?? "";
    expect(section).toContain("in 40 of 40 pairs: holds.");
    expect(section).toContain("Reported: 4 pairs whose messages differed.");
    expect(section).toContain(
      "**More than 3 pairs of a cell had messages that differed, so 4b is weaker there:** anthropic/claude-sonnet-5-5 · en: 4 of 20.",
    );
    const changed = rows().map((row, index) => (index === 0 ? { ...row, sameSetup: false } : row));
    expect(marksSection(changed)).toContain("in 39 of 40 pairs: **fails**.");
  });

  test("1b is not readable below 4 listed numbers, and 1a's rule for few stands", () => {
    const few = rows().map((row) => ({
      ...row,
      candidate: {
        ...row.candidate,
        marks: {
          ...(row.candidate.marks as Marks),
          listed: row.id === "en-0" && row.run === 1 ? 2 : 0,
          listedChecked: 0,
        },
      },
    }));
    const section = marksSection(few) ?? "";
    expect(section).toContain("40 presses: W0 1, W1 0, at most 1: 1a holds.");
    expect(section).toContain("1b not readable: 2 listed, so 1a's rule for few stands");
  });
});
