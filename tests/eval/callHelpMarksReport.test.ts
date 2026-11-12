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
import type { ArmRun, RequestTiming } from "../../eval/speed/paired";
import { type PairedRow, sentPair } from "../../eval/speed/pairedReport";

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
    requests: [request({})],
    ...given,
  };
}

function request(given: Partial<RequestTiming>): RequestTiming {
  return {
    kind: "model",
    step: null,
    model: "claude-sonnet-5-5",
    reasoning: null,
    startMs: 10,
    firstByteMs: 500,
    firstReasoningMs: null,
    firstTextMs: 500,
    firstToolMs: null,
    endMs: 3900,
    inputTokens: 1000,
    outputTokens: 100,
    outcome: "finished",
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
    const sent = (transcript: string, temperature = 0) => {
      const messages = JSON.stringify([
        { role: "user", content: `<live-transcript>${transcript}</live-transcript>` },
      ]);
      const asSet = setup.replace(/}$/, `,"temperature":${temperature}}`);
      return { prompt: `${asSet}${messages}`, setup: asSet, messages };
    };
    // One pair of each kind, as the runner records it: the same messages, and messages a
    // transcript line split otherwise; and a setup that changed, which 4a fails.
    const asked = "[0:04 Them] Can we start in June?";
    const alike = sentPair(sent(asked), sent(asked));
    const split = sentPair(sent(asked), sent("[0:04 Them] Can we start\n[0:06 Them] in June?"));
    const otherSetup = sentPair(sent(asked), sent(asked, 1));
    console.log(`The same messages: ${JSON.stringify(alike)}`);
    console.log(`Messages a split line changed: ${JSON.stringify(split)}`);
    expect(alike).toEqual({ sameRequest: true, sameSetup: true, messageDifference: null });
    expect(split).toMatchObject({ sameRequest: false, sameSetup: true });
    expect(split.messageDifference).toContain("Can we start in June?");
    expect(split.messageDifference).toContain("[0:06 Them] in June?");
    expect(otherSetup).toMatchObject({ sameSetup: false, messageDifference: null });
    expect(sentPair(sent(asked), null)).toEqual({
      sameRequest: false,
      sameSetup: false,
      messageDifference: "a request missing",
    });
    const difference = split.messageDifference;

    const made = rows().map((row, index) =>
      row.language === "en" && index < 4 ? { ...row, messageDifference: difference } : row,
    );
    const section = marksSection(made) ?? "";
    expect(section).toContain("in 40 of 40 pairs: holds.");
    expect(section).toContain("Reported: 4 pairs whose messages differed.");
    expect(section).toContain(`- anthropic/claude-sonnet-5-5 · en run 1, en-0: ${difference}`);
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

  test("bar 3 allows main's chance range and no more, and bar 5 fails a press the branch alone didn't finish", () => {
    const fewer = (cited: number, right: number) =>
      rows().map((row, index) =>
        row.language === "en"
          ? {
              ...row,
              candidate: {
                ...row.candidate,
                cited: index >= cited,
                grade: index >= right ? row.candidate.grade : ("wrong" as const),
              },
            }
          : row,
      );
    // Sonnet in English allows 2 fewer: 2 holds, 3 fails, on cited and on judged right alike.
    expect(marksSection(fewer(2, 0))).toContain(
      "cited 20 → 18 (≥ −2), judged right 20 → 20 (≥ −2), every Citation found 20 → 20 (≥ −2): holds.",
    );
    expect(marksSection(fewer(3, 0))).toContain("cited 20 → 17 (≥ −2)");
    expect(marksSection(fewer(3, 0))).toContain("(≥ −2): **fails**.");
    expect(marksSection(fewer(0, 3))).toContain("judged right 20 → 17 (≥ −2)");

    const failed = rows().map((row, index) =>
      index === 0 ? { ...row, candidate: { ...row.candidate, status: "failed" as const } } : row,
    );
    const section = marksSection(failed) ?? "";
    expect(section).toContain(
      "5, presses that failed on the branch where main finished: 1: **fails**.",
    );
    expect(section).toContain(
      "5, presses that failed on the branch where main finished: 0: holds.",
    );
  });

  test("a run is void when a request failed or kept no outcome, and a branch failure with its requests finished is bar 5's", () => {
    const requests = "**Requests, anthropic/claude-sonnet-5-5:**";
    const clean = marksSection(rows()) ?? "";
    expect(clean).toContain(
      `${requests} 80 model requests in the record, 0 of them ended other than finished.`,
    );
    expect(clean).not.toContain("**Void");

    const firstOnBranch = (candidate: Partial<ArmRun>) =>
      rows().map((row, index) =>
        index === 0 ? { ...row, candidate: { ...row.candidate, ...candidate } } : row,
      );
    const refused = marksSection(
      firstOnBranch({ requests: [request({ step: "answer-check", outcome: "failed" })] }),
    );
    expect(refused).toContain(
      `${requests} 80 model requests in the record, 1 of them ended other than finished.`,
    );
    expect(refused).toContain(
      "**Void, anthropic/claude-sonnet-5-5: its bars are not read, and it isn't run again before its reasons are read.** the branch, en-0 run 1: a request (answer-check) failed.",
    );

    const unrecorded = marksSection(firstOnBranch({ requests: [request({ outcome: undefined })] }));
    expect(unrecorded).toContain("1 of them ended other than finished.");
    expect(unrecorded).toContain(
      "the branch, en-0 run 1: a request (the reply) with no outcome recorded.",
    );

    const judge = marksSection(
      firstOnBranch({ status: "failed", error: "The judge's request failed: Overloaded" }),
    );
    expect(judge).toContain(
      "**Void, anthropic/claude-sonnet-5-5: its bars are not read, and it isn't run again before its reasons are read.** the branch, en-0 run 1: The judge's request failed: Overloaded.",
    );

    const unsettled = marksSection(
      firstOnBranch({
        status: "failed",
        error: "Its marks hadn't settled 60 s after the reply ended.",
      }),
    );
    expect(unsettled).toContain("0 of them ended other than finished.");
    expect(unsettled).not.toContain("**Void");
    expect(unsettled).toContain(
      "Failed with every request finished, so bar 5's and not a void: the branch, en-0 run 1: failed: Its marks hadn't settled 60 s after the reply ended.",
    );
    expect(unsettled).toContain(
      "5, presses that failed on the branch where main finished: 1: **fails**.",
    );
  });

  test("the fresh slice is counted by place: W0, main's rule, W1, the ✓ themselves, and by number beside it", () => {
    const place = (shown: boolean, unbacked: boolean, found = true) => ({
      id: "p1",
      number: 1,
      marker: 1,
      at: 0,
      sentence: "A sentence",
      quotes: [],
      found,
      shown,
      unbacked,
    });
    const made: PairedRow[] = [];
    for (const language of ["en", "zh-CN"] as const) {
      for (const run of [1, 2]) {
        for (let press = 0; press < 5; press++) {
          // Presses 0 to 3 have an unbacked place with a found quote; main shows ✓ on 0 to 2; the branch on 0 only.
          const unbacked = press < 4;
          made.push({
            set: "call-help-marks-4",
            id: `${language}-${press}`,
            kind: "answer-newest",
            language,
            model: "anthropic/claude-sonnet-5-5",
            run,
            first: press % 2 === 0 ? 0 : 1,
            sameRequest: true,
            sameSetup: true,
            messageDifference: null,
            baseline: arm({ places: [place(press < 3, unbacked)] }),
            candidate: arm({ places: [place(press === 0, unbacked), place(true, false)] }),
          });
        }
      }
    }

    const section = marksSection(made) ?? "";

    expect(section).toContain("## The fresh slice by place");
    expect(section).toContain("20 presses: W0 16, main's rule 12, W1 4, at most 8: bar 3 holds.");
    expect(section).toContain("of 24 places the new rule shows ✓, the judge finds 4 unbacked.");
    expect(section).toContain("Chinese W1 2, English W1 2, the branch's flips 0: holds.");
  });
});
