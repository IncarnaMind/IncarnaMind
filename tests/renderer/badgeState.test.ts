import { describe, expect, test } from "vitest";
import {
  type BadgeInput,
  type BadgeShown,
  badgeOf,
  badgeShows,
} from "../../src/renderer/src/editor/badgeState";

/* The check badge (#909, D266): what it shows of a Mind's health and its checks, or nothing. */

const NOTHING: BadgeInput = {
  marks: {},
  checkable: 0,
  toCheck: 0,
  running: false,
  asking: false,
  problem: false,
  checked: null,
};

const QUIET: BadgeShown = {
  marks: 0,
  checkable: 0,
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
    expect(badgeOf({ ...NOTHING, marks: { [part]: 2 }, checkable: 2 })).toEqual({
      marks: [{ part, count: 2 }],
      toCheck: 0,
      running: false,
      checked: null,
    });
  });

  test("puts its marks in the margin's order, contradicted first, and leaves out parts with none", () => {
    const badge = badgeOf({
      ...NOTHING,
      marks: { notChecked: 1, unsupported: 4, contradicted: 1, notFound: 0 },
      checkable: 6,
    });
    expect(badge?.marks).toEqual([
      { part: "contradicted", count: 1 },
      { part: "unsupported", count: 4 },
      { part: "notChecked", count: 1 },
    ]);
  });

  test("shows on every note with a sentence a check reads, whatever its Citations (D266)", () => {
    expect(badgeOf({ ...NOTHING, checkable: 3 })).not.toBeNull();
  });

  test("shows nothing for a note with nothing to check and no problem", () => {
    expect(badgeOf(NOTHING)).toBeNull();
  });

  test("shows while a check runs, while a paid run asks first, and when a check the User started couldn't run", () => {
    expect(badgeOf({ ...NOTHING, running: true })?.running).toBe(true);
    expect(badgeOf({ ...NOTHING, asking: true })).not.toBeNull();
    expect(badgeOf({ ...NOTHING, problem: true })).not.toBeNull();
  });

  test("in the quiet first open, only a run, a question or a problem shows it, never the state alone (#856)", () => {
    const example = { ...NOTHING, marks: { contradicted: 1 }, checkable: 3, quiet: true };
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

  test("a Verify run still says how many it checked, until the User types", () => {
    expect(badgeOf({ ...NOTHING, checked: 24 })?.checked).toBe(24);
    expect(badgeOf({ ...NOTHING, checked: null })).toBeNull();
  });
});

describe("Whether the check badge shows (#1194, #1909, D266)", () => {
  test("a problem, a run, a question or what a run checked shows it", () => {
    expect(badgeShows({ ...QUIET, quiet: false, marks: 1 })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, running: true })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, asking: true })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, problem: true })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, checked: true })).toBe(true);
  });

  test("a note with a sentence a check reads shows it, whatever its Citations (D266)", () => {
    expect(badgeShows({ ...QUIET, quiet: false, checkable: 3 })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, checkable: 0, marks: 1 })).toBe(true);
    expect(badgeShows({ ...QUIET, quiet: false, checkable: 0 })).toBe(false);
  });

  test("the quiet first open hides the state, but not a run, a problem or a question", () => {
    expect(badgeShows({ ...QUIET, checkable: 3 })).toBe(false);
    expect(badgeShows({ ...QUIET, checkable: 3, problem: true })).toBe(true);
  });
});
