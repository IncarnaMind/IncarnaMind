import { describe, expect, test } from "vitest";
import {
  type BadgeInput,
  type BadgeShown,
  badgeOf,
  badgeShows,
} from "../../src/renderer/src/editor/badgeState";

/* The check badge (#909): what it shows of a Mind's health and its checks, or nothing. */

const NOTHING: BadgeInput = {
  marks: {},
  toCheck: 0,
  citable: 0,
  running: false,
  asking: false,
  problem: false,
  checked: null,
};

const QUIET: BadgeShown = {
  marks: 0,
  toCheck: 0,
  citable: 0,
  running: false,
  asking: false,
  problem: false,
  checked: false,
  quiet: true,
};

describe("The check badge", () => {
  test.each([
    ["a contradicted sentence", "contradicted"],
    ["an unsupported sentence", "unsupported"],
    ["a Citation not found", "notFound"],
  ] as const)("shows %s, with its mark and count", (_, part) => {
    expect(badgeOf({ ...NOTHING, marks: { [part]: 2 } })).toEqual({
      marks: [{ part, count: 2 }],
      toCheck: 0,
      running: false,
      checked: null,
    });
  });

  test("shows the sentences to check, when one of them has a Citation or an Answer's words (#1194)", () => {
    expect(badgeOf({ ...NOTHING, toCheck: 3, citable: 1 })?.toCheck).toBe(3);
  });

  test("puts its marks in the margin's order, contradicted first, and leaves out parts with none", () => {
    const badge = badgeOf({
      ...NOTHING,
      marks: { notChecked: 1, unsupported: 4, contradicted: 1, notFound: 0 },
      toCheck: 2,
      citable: 2,
    });
    expect(badge?.marks).toEqual([
      { part: "contradicted", count: 1 },
      { part: "unsupported", count: 4 },
      { part: "notChecked", count: 1 },
    ]);
    expect(badge?.toCheck).toBe(2);
  });

  test("shows nothing for a Mind with nothing to check: Citations found and sentences with no Citation alone keep the page bare", () => {
    expect(badgeOf(NOTHING)).toBeNull();
    expect(badgeOf({ ...NOTHING, toCheck: 3 })).toBeNull();
  });

  test("shows while a check runs, while a paid run asks first, and when a check the User started couldn't run", () => {
    expect(badgeOf({ ...NOTHING, running: true })?.running).toBe(true);
    expect(badgeOf({ ...NOTHING, asking: true })).not.toBeNull();
    expect(badgeOf({ ...NOTHING, problem: true })).not.toBeNull();
  });

  test("in the quiet first open, only a run, a question or a problem shows it, never the marks alone (#856)", () => {
    const example = { ...NOTHING, marks: { contradicted: 1 }, toCheck: 3, citable: 3, quiet: true };
    expect(badgeOf(example)).toBeNull();
    expect(badgeOf({ ...example, running: true })).toEqual({
      marks: [],
      toCheck: 0,
      running: true,
      checked: null,
    });
    expect(badgeOf({ ...example, asking: true })).not.toBeNull();
    expect(badgeOf({ ...example, problem: true })).not.toBeNull();
    expect(badgeOf({ ...example, checked: 4 })?.checked).toBe(4);
  });

  test("says how many a check the User started checked, until they type", () => {
    expect(badgeOf({ ...NOTHING, checked: 24 })?.checked).toBe(24);
    expect(badgeOf({ ...NOTHING, checked: null })).toBeNull();
  });
});

describe("Whether the check badge shows (#1194, #1909)", () => {
  test("a problem, a run, a question or what a run checked shows it", () => {
    expect(badgeShows({ ...QUIET, quiet: false, marks: 1 })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, running: true })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, asking: true })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, problem: true })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, checked: true })).toBe(true);
  });

  test("sentences to check show it only when one has a Citation or an Answer's words: a Mind of plain notes stays bare", () => {
    expect(badgeShows({ ...QUIET, quiet: false, toCheck: 3, citable: 0 })).toBe(false);
    expect(badgeShows({ ...QUIET, quiet: false, toCheck: 3, citable: 1 })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, toCheck: 0, citable: 0 })).toBe(false);
  });

  test("the quiet first open hides the marks and the count, but not a run, a problem or a question", () => {
    expect(badgeShows({ ...QUIET, marks: 1, toCheck: 3, citable: 3 })).toBe(false);
    expect(badgeShows({ ...QUIET, toCheck: 3, citable: 3, problem: true })).toBe(true);
  });
});
