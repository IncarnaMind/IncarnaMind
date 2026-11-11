/**
 * The repeated checks' scoring (eval/repeats): how a mark's card shows, and
 * what a run of checks of an unchanged Mind comes to.
 */
import { describe, expect, test } from "vitest";
import { SETS } from "../../eval/repeats/cases";
import { type Outcome, outcomeOf } from "../../eval/repeats/repeat";
import {
  meetsExpected,
  type RepeatRow,
  report,
  savedRows,
  sortsBy,
  summarise,
} from "../../eval/repeats/score";
import type { ClaimCheckAttributes } from "../../src/core";

const QUOTE = {
  passageId: "p1",
  documentId: "d1",
  documentName: "Agreement",
  contentHash: "h1",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "The Employee may work from home two days a week",
  check: "found" as const,
  checkReason: null,
};

const mark = (change: Partial<ClaimCheckAttributes>): ClaimCheckAttributes => ({
  id: "c1",
  request: "r1",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  providerId: null,
  modelId: null,
  text: "Staff may work from home two days a week.",
  evidence: null,
  says: null,
  unsupported: { reason: null, covered: null, uncovered: null },
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-22T20:00:00.000Z",
  ...change,
});

const RUN = { commit: "abc", spent: 0, repeats: 1 };

/** A check's row; its sort is its own unless one is given, and none when `sort` is null (a result file made before #2964). */
const row = (
  repeat: number,
  key: string,
  outcome: Outcome,
  set = "en",
  sort: number | null = repeat,
): RepeatRow => {
  const sentence = SETS.find((each) => each.id === set)?.sentences.find((each) => each.key === key);
  if (!sentence) throw new Error(`No sentence ${key}`);
  return {
    repeat,
    ...(sort !== null && { sort }),
    sentence: sentence.text,
    outcome,
    says: null,
    covered: null,
    uncovered: null,
    quote: null,
    failure: null,
    set,
    model: "anthropic/claude-haiku-5-5",
    key,
    kind: sentence.kind,
    expected: sentence.expected,
    ...(sentence.knownMiss !== undefined && { knownMiss: sentence.knownMiss }),
  };
};

describe("the repeated checks", () => {
  test("name an Unsupported card by what it shows: a quoted part, a different line, or absent", () => {
    const partly = { reason: null, covered: "two days a week", uncovered: "all staff" };
    expect(outcomeOf(mark({ unsupported: { ...partly, quoted: QUOTE } }))).toBe("partly");
    expect(outcomeOf(mark({ unsupported: partly }))).toBe("absent");
    expect(outcomeOf(mark({ evidence: QUOTE, unsupported: { ...partly, quoted: QUOTE } }))).toBe(
      "differs",
    );
    expect(outcomeOf(mark({}))).toBe("absent");
    expect(outcomeOf(mark({ state: "supported" }))).toBe("supported");
    expect(outcomeOf(mark({ state: "not-checked", reason: "failed" }))).toBe("not-checked");
    expect(outcomeOf(undefined)).toBe("no-mark");
  });

  test("say Unsupported, not Not found, for a check that found a Passage about the sentence and quotes none", () => {
    const found = mark({
      unsupported: { reason: null, covered: null, uncovered: null, found: true },
    });
    expect(outcomeOf(found)).toBe("unsupported");
    expect(meetsExpected({ outcome: outcomeOf(found), expected: "absent" })).toBe(false);
    expect(meetsExpected({ outcome: outcomeOf(found), expected: "unsupported" })).toBe(true);

    const absent = mark({});
    expect(outcomeOf(absent)).toBe("absent");
    expect(meetsExpected({ outcome: outcomeOf(absent), expected: "absent" })).toBe(true);

    const partly = mark({
      unsupported: {
        reason: null,
        covered: "two days a week",
        uncovered: "all staff",
        found: true,
        quoted: QUOTE,
      },
    });
    expect(outcomeOf(partly)).toBe("partly");
  });

  test("count false Supported, absent on a stated sentence, and checks that differ from the one before", () => {
    const [summary] = summarise([
      row(1, "notice", "supported"),
      row(1, "car", "absent"),
      row(2, "notice", "partly"),
      row(2, "car", "absent"),
      row(3, "notice", "absent"),
      row(3, "car", "supported"),
    ]);

    expect(summary).toMatchObject({
      repeats: 3,
      sorts: 3,
      sorting: "fresh",
      falseSupported: { count: 1, checks: 3, sorts: 3 },
      unsupportedOnStated: { count: 1, checks: 3, sorts: 3 },
      partlyOnAbsent: { count: 0, checks: 3, sorts: 3 },
      disagreeing: { count: 2, checks: 2, sorts: 2 },
    });
    expect(summary?.sentences.find((each) => each.key === "notice")).toMatchObject({
      steady: 2,
      outcomes: { supported: 1, partly: 1, absent: 1 },
    });
    expect(summary?.misses.map((each) => [each.repeat, each.key])).toEqual([
      [2, "notice"],
      [3, "notice"],
      [3, "car"],
    ]);
  });

  test("count a stated sentence that comes back Unsupported with the Not found ones", () => {
    const [summary] = summarise([
      row(1, "notice", "absent"),
      row(2, "notice", "unsupported"),
      row(3, "notice", "partly"),
    ]);
    expect(summary?.unsupportedOnStated).toEqual({ count: 2, checks: 3, sorts: 3 });
    expect(summary?.misses).toHaveLength(3);
  });

  test("expect the partly-supported card for a general word for the agreement's term", () => {
    const [summary] = summarise([
      row(1, "staff-home", "partly"),
      row(2, "staff-home", "supported"),
    ]);
    expect(summary?.misses.map((each) => [each.repeat, each.outcome])).toEqual([[2, "supported"]]);
    expect(summary?.falseSupported).toEqual({ count: 0, checks: 0, sorts: 0 });
  });

  test("expect the not-found card for a figure for a year the agreement doesn't cover", () => {
    const rows = (["absent", "differs", "contradicted", "partly"] as const).map((outcome, index) =>
      row(index + 1, "period-not-covered", outcome, "en-near-misses"),
    );
    expect(rows.filter((each) => !meetsExpected(each)).map((each) => each.outcome)).toEqual([
      "differs",
      "contradicted",
      "partly",
    ]);
    const [summary] = summarise(rows);
    expect(summary?.known).toHaveLength(4);
    expect(summary?.misses).toEqual([]);
    expect(summary?.unsupportedOnStated).toEqual({ count: 0, checks: 0, sorts: 0 });
  });

  test("count a genuine conflict Supported as a false Supported, and a known miss apart", () => {
    const [summary] = summarise([
      row(1, "prior-year-wrong", "contradicted", "zh-periods"),
      row(2, "prior-year-wrong", "supported", "zh-periods"),
      row(1, "prior-year", "supported", "zh-periods"),
      row(1, "term-year-wrong", "differs", "zh-periods"),
    ]);
    expect(summary).toMatchObject({
      falseSupported: { count: 1, checks: 2, sorts: 2 },
      conflicts: { count: 1, checks: 2, sorts: 2 },
    });
    expect(summary?.misses.map((each) => [each.key, each.repeat])).toEqual([
      ["prior-year-wrong", 2],
    ]);
    expect(summary?.known.map((each) => [each.key, each.knownMiss])).toEqual([
      ["term-year-wrong", 1708],
    ]);
    const shown = report(
      summarise([
        row(1, "term-year-wrong", "no-mark", "zh-periods"),
        row(2, "term-year-wrong", "contradicted", "zh-periods"),
      ]),
      RUN,
    );
    expect(shown).toContain("### Known misses (#1708), outside the counts above");
    expect(shown).toContain(
      "- term-year-wrong: 1 of 2 checks, 2 sorts Contradicted, 0 Supported, 0 unsupported, 1 not checked or not named",
    );
    expect(shown).not.toContain("Genuine conflicts Contradicted");
  });

  test("count must for may, reversed parties and the negation as ordinary conflicts, none of them apart", () => {
    const conflicts = (id: string) => SETS.find((each) => each.id === id)?.sentences ?? [];
    const known = (id: string) =>
      conflicts(id)
        .filter((each) => each.knownMiss !== undefined)
        .map((each) => [each.key, each.knownMiss]);
    for (const id of ["en-conflicts", "zh-conflicts"]) {
      expect(known(id)).toEqual([]);
      expect(conflicts(id).map((each) => each.key)).toEqual(
        expect.arrayContaining(["duty-home", "permission", "party-secret", "negation"]),
      );
    }
  });

  test("expect every genuine conflict to be Contradicted, a dozen kinds in each language", () => {
    for (const id of ["en-conflicts", "zh-conflicts"]) {
      const sentences = SETS.find((each) => each.id === id)?.sentences ?? [];
      expect(sentences.length).toBeGreaterThanOrEqual(12);
      expect(new Set(sentences.map((each) => each.expected))).toEqual(new Set(["contradicted"]));
    }
  });

  test("give every set's sentences a verdict to expect, the same keys in English and Chinese", () => {
    const keys = (id: string) => SETS.find((each) => each.id === id)?.sentences.map((s) => s.key);
    expect(keys("en")).toEqual(keys("zh"));
    expect(keys("en-control")).toEqual(keys("zh-control"));
    expect(keys("en-periods")).toEqual(keys("zh-periods"));
  });
});

describe("a sentence that may read either way but never Contradicted (#1708)", () => {
  test("meets its label Supported or Unsupported, and is no false Supported", () => {
    const expected = "not-contradicted" as const;
    expect(
      (["supported", "partly", "differs", "contradicted", "not-checked"] as const).map((outcome) =>
        meetsExpected({ outcome, expected }),
      ),
    ).toEqual([true, true, true, false, false]);
    const [summary] = summarise([
      { ...row(1, "notice", "supported"), expected },
      { ...row(2, "notice", "contradicted"), expected },
    ]);
    expect(summary?.falseSupported).toEqual({ count: 0, checks: 0, sorts: 0 });
    expect(summary?.misses.map((each) => each.outcome)).toEqual(["contradicted"]);
  });
});

describe("checks and sorts (#2964)", () => {
  // protects=every count of a report says how many checks and sorts it is of, per sentence and per set (#2964); fails_when=a count shows no sorts, or the wrong number; no_claim=what a real model says.
  test("a report of checks that each sorted afresh gives both numbers for every count", () => {
    const shown = report(
      summarise([
        row(1, "notice", "supported"),
        row(1, "car", "absent"),
        row(2, "notice", "supported"),
        row(2, "car", "supported"),
      ]),
      RUN,
    );
    expect(shown).toContain("## en · anthropic/claude-haiku-5-5 · 2 checks, 2 sorts");
    expect(shown).toContain("Each check sorted the sentences afresh, in a Note of its own.");
    expect(shown).toContain("| 2 of 2 checks, 2 sorts |");
    expect(shown).toContain("- False Supported: 1 of 2 checks, 2 sorts");
    expect(shown).toContain(
      "- Checks whose verdicts differ from the one before: 1 of 1 checks, 1 sort",
    );
  });

  // protects=a run whose checks reused one sort says so beside its counts (#2964); fails_when=it reads as fresh sorts; no_claim=what a real model says.
  test("a report of checks that reused one sort says so", () => {
    const shown = report(
      summarise([row(1, "notice", "supported", "en", 1), row(2, "notice", "supported", "en", 1)]),
      RUN,
    );
    expect(shown).toContain("· 2 checks, 1 sort");
    expect(shown).toContain("One sort reused by every check");
    expect(shown).toContain("| 2 of 2 checks, 1 sort |");
  });

  // protects=a result file made before #2964 stays readable, and its report says its sorts were reused (#2964); fails_when=it fails to read, or reads as one sort a check; no_claim=what a real model says.
  test("a result file made before the sorts were counted reads back as one sort reused", () => {
    const rows = savedRows({
      model: "anthropic/claude-haiku-5-5",
      rows: [
        row(1, "notice", "supported", "en", null),
        row(2, "notice", "absent", "en", null),
        row(3, "notice", "supported", "en", null),
      ],
    });
    const [summary] = summarise(rows);
    expect(summary).toMatchObject({
      repeats: 3,
      sorts: 1,
      sorting: "before",
      unsupportedOnStated: { count: 1, checks: 3, sorts: 1 },
    });
    expect(report(summarise(rows), RUN)).toContain(
      "Made before #2964: every check reused its run's one sort",
    );
    expect(() => savedRows({ model: "x" })).toThrow("it has no list of rows");
    expect(sortsBy(rows, (each) => each.set)).toEqual({ en: 1 });
    expect(
      sortsBy([row(1, "notice", "supported"), row(2, "notice", "absent")], (each) => each.set),
    ).toEqual({ en: 2 });
  });
});
