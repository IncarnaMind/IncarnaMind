/**
 * The earlier-call gate's section of a paired run's report (`gates/call-help-earlier-calls.md`,
 * #3005), read from literal rows: its bars as the file words them, a void, the pilot's sizing and
 * what it reports.
 */
import { describe, expect, test } from "vitest";
import {
  citedOfPlaces,
  earlierCallsSection,
  earlierStartedOf,
} from "../../eval/speed/earlierCallsReport";
import type { ArmRun, RequestTiming } from "../../eval/speed/paired";
import type { PairedRow } from "../../eval/speed/pairedReport";

const MODEL = "anthropic/claude-haiku-5-5";

const request = (outcome: RequestTiming["outcome"] = "finished"): RequestTiming => ({
  kind: "model",
  step: null,
  model: "claude-haiku-5-5",
  reasoning: null,
  startMs: 0,
  firstByteMs: 100,
  firstReasoningMs: null,
  firstTextMs: 200,
  firstToolMs: null,
  endMs: 900,
  inputTokens: 1000,
  outputTokens: 80,
  outcome,
});

function arm(reply: Partial<ArmRun> & { asThis?: boolean; then?: boolean } = {}): ArmRun {
  const { asThis = false, then = false, ...rest } = reply;
  return {
    status: "done",
    error: null,
    firstSignMs: 50,
    firstWordsMs: 300,
    doneMs: 1500,
    modelCalls: 1,
    answerCalls: 1,
    searches: 0,
    inputTokens: 1000,
    outputTokens: 80,
    citations: 1,
    found: 1,
    cited: null,
    grade: "right",
    falseSupported: 0,
    duplicate: false,
    failures: asThis ? ["earlier-as-this"] : [],
    text: asThis ? "★ “Your data stays in Europe, as you need”" : "★ “Let me check that”",
    requests: [request()],
    places: [],
    callReading: { earlierAsThis: asThis, thenWithWhen: then, asThisCall: [] },
    ...rest,
  };
}

let order = 0;
function row(
  kind: string,
  language: "en" | "zh-CN",
  baseline: ArmRun,
  candidate: ArmRun,
): PairedRow {
  order++;
  return {
    set: "call-help-earlier-calls",
    id: `${language}-case-${order}-${kind}`,
    kind,
    language,
    model: MODEL,
    run: 1,
    first: 0,
    baseline,
    candidate,
  };
}

/** `shownOnMain` button presses of main show the fault, `shownOnBranch` of the branch, of 12. */
function buttons(shownOnMain: number, shownOnBranch: number): PairedRow[] {
  return Array.from({ length: 12 }, (_, index) =>
    row(
      ["say", "answer", "check"][index % 3] ?? "say",
      index < 6 ? "en" : "zh-CN",
      arm({ asThis: index < shownOnMain }),
      arm({ asThis: index < shownOnBranch }),
    ),
  );
}

/** Four "last time" questions: `onMain` and `onBranch` of them given as said then, with when, cited. */
function lastTimes(onMain: number, onBranch: number): PairedRow[] {
  return Array.from({ length: 4 }, (_, index) =>
    row(
      "last-time",
      index < 2 ? "en" : "zh-CN",
      arm({ then: index < onMain, cited: true }),
      arm({ then: index < onBranch, cited: true }),
    ),
  );
}

const ARMS = ["calls-unmarked", "today"] as const;

describe("The earlier-call gate's section", () => {
  test("bar 1 holds with main showing 4 and the branch none; it is not shown with main at 3, and fails with the branch at 1", () => {
    expect(earlierCallsSection([...buttons(4, 0), ...lastTimes(3, 3)], ARMS)).toContain(
      "**Bar 1, never this call's, anthropic/claude-haiku-5-5: holds.** Button presses both arms finished: 12. `earlier-as-this`: main 4, the branch 0.",
    );
    expect(earlierCallsSection([...buttons(3, 0), ...lastTimes(3, 3)], ARMS)).toContain(
      "**Bar 1, never this call's, anthropic/claude-haiku-5-5: not shown: main's arm shows 3, fewer than 4, and the branch none. For the proof, not a pass: it is brought for a decision before any larger run. For the guard, it holds.**",
    );
    expect(earlierCallsSection([...buttons(4, 1), ...lastTimes(3, 3)], ARMS)).toContain(
      "**Bar 1, never this call's, anthropic/claude-haiku-5-5: fails.**",
    );
    expect(earlierCallsSection([...buttons(2, 1), ...lastTimes(3, 3)], ARMS)).toContain(
      "**Bar 1, never this call's, anthropic/claude-haiku-5-5: fails.**",
    );
  });

  test("its counts by button and language, each arm's", () => {
    const section = earlierCallsSection([...buttons(4, 0), ...lastTimes(3, 3)], ARMS) ?? "";
    expect(section).toContain("| say | 2 of 2 | 0 of 2 |");
    expect(section).toContain("| answer | 1 of 2 | 0 of 2 |");
    expect(section).toContain("| check | 1 of 2 | 0 of 2 |");
  });

  test("bar 2 counts a reply given as said then, with when, and cited: no fewer than main and at least three quarters", () => {
    expect(earlierCallsSection([...buttons(4, 0), ...lastTimes(3, 3)], ARMS)).toContain(
      '**Bar 2, last time still answered, anthropic/claude-haiku-5-5: holds.** Of 4 "last time" questions both arms finished, given as said then, with when, and cited: main 3, the branch 3 (at least 3 needed).',
    );
    expect(earlierCallsSection([...buttons(4, 0), ...lastTimes(2, 2)], ARMS)).toContain(
      "last time still answered, anthropic/claude-haiku-5-5: fails.",
    );
    expect(earlierCallsSection([...buttons(4, 0), ...lastTimes(4, 3)], ARMS)).toContain(
      "last time still answered, anthropic/claude-haiku-5-5: fails.",
    );
    const uncited = [
      ...buttons(4, 0),
      ...lastTimes(3, 3).map((each) => ({
        ...each,
        candidate: { ...each.candidate, cited: false },
      })),
    ];
    expect(earlierCallsSection(uncited, ARMS)).toContain(
      "main 3, the branch 0 (at least 3 needed)",
    );
  });

  test("a request that failed makes the run void", () => {
    const rows = [...buttons(4, 0), ...lastTimes(3, 3)];
    const first = rows[0];
    if (!first) throw new Error("No row.");
    rows[0] = { ...first, candidate: { ...first.candidate, requests: [request("failed")] } };
    expect(earlierCallsSection(rows, ARMS)).toContain(
      "**Void, anthropic/claude-haiku-5-5: its bars are not read, and it isn't run again before its reasons are read.**",
    );
  });

  test("reports each ✓ beside an earlier call's line in a sentence putting it on this call, and lists every earlier-as-this reply with its places", () => {
    const place = {
      line: "They said their data has to stay in Europe [1]",
      number: 1,
      source: "1 · Transcript · Meeting, 12 November · Them · 0:07 · started 09:00",
      call: "earlier" as const,
      quote: "our data has to stay in Europe",
      found: true,
      passed: true,
    };
    const rows = [
      ...buttons(4, 0),
      ...lastTimes(3, 3),
      row(
        "say",
        "en",
        arm({
          asThis: true,
          places: [place],
          callReading: { earlierAsThis: true, thenWithWhen: false, asThisCall: [1] },
        }),
        arm({ places: [{ ...place, passed: false }] }),
      ),
    ];
    const section = earlierCallsSection(rows, ARMS) ?? "";
    expect(section).toContain("in this call:** main 1 places, the branch 0.");
    expect(section).toContain(
      '  - [1] earlier, ✓: "They said their data has to stay in Europe [1]" (1 · Transcript · Meeting, 12 November · Them · 0:07 · started 09:00; quote "our data has to stay in Europe")',
    );
  });

  test("a pilot of main's path against itself gives main's rate and the runs it needs", () => {
    const rows = buttons(1, 1);
    const section = earlierCallsSection(rows, ["calls-unmarked", "calls-unmarked"]) ?? "";
    expect(section).toContain(
      "**Pilot, anthropic/claude-haiku-5-5: main's path against itself.** 2 of 24 of main's button replies are `earlier-as-this` (8.3%), so a run of the gate's 24 presses an arm expects 2.00 on main's arm.",
    );
    expect(section).toContain("Runs for an expected 6: 3; for an expected 3: 2.");
    expect(section).not.toContain("Bar 1");
  });

  test("counts bar 1 by which call of the pair was the earlier", () => {
    const named = (id: string, onMain: boolean): PairedRow => ({
      ...row("say", "en", arm({ asThis: onMain }), arm()),
      id,
    });
    const section =
      earlierCallsSection(
        [
          named("en-b-then-a-say", true),
          named("en-d-then-c-say", true),
          named("en-a-then-b-say", false),
          named("en-c-then-d-say", true),
        ],
        ARMS,
      ) ?? "";
    expect(section).toContain(
      "By order: main the earlier call brings the changes: 2 of 2; the earlier call said it first: 1 of 2; the branch the earlier call brings the changes: 0 of 2; the earlier call said it first: 0 of 2.",
    );
  });
});

describe("A saved reply judged again", () => {
  const place = (number: number, call: "this" | "earlier", found = true) => ({
    line: `A line [${number}]`,
    number,
    source: `${number} · Transcript · Meeting, 13 November · Them · 0:07${call === "earlier" ? " · started 09:12" : ""}`,
    call,
    quote: `quote ${number}`,
    found,
    passed: false,
  });

  test("gives the judge each number once, its Document and whose call it quotes", () => {
    expect(
      citedOfPlaces([place(1, "this"), place(2, "earlier", false), place(2, "earlier")]),
    ).toEqual([
      "[1] Transcript · Meeting, 13 November (this call): “quote 1” (found)",
      "[2] Transcript · Meeting, 13 November (the earlier call): “quote 2” (not found)",
    ]);
  });

  test("gives the earlier call's start as the reply kept it, else as a source line of that call shows it", () => {
    const kept = row("say", "en", arm(), arm());
    const withKept: PairedRow = {
      ...kept,
      id: "en-a-then-b-say",
      baseline: {
        ...kept.baseline,
        callReading: {
          earlierAsThis: false,
          thenWithWhen: false,
          asThisCall: [],
          earlierStarted: "13 Nov 2026, 09:12",
        },
      },
    };
    expect(earlierStartedOf([withKept], "en-a-then-b")).toBe("13 Nov 2026, 09:12");
    const shown: PairedRow = {
      ...kept,
      id: "en-b-then-a-say",
      baseline: arm({ places: [place(1, "earlier")] }),
    };
    expect(earlierStartedOf([shown], "en-b-then-a")).toBe("09:12");
    expect(earlierStartedOf([shown], "zh-a-then-b")).toBe("");
  });
});
