import { describe, expect, test } from "vitest";
import { ALL_PROBES, requestOf } from "../../eval/everyday/claimProbes";
import { movesOf, PRIVACY_PROBES, type Row } from "../../eval/everyday/privacyMoves";

const row = (probe: string, run: number, arm: string, flagged: boolean, counted = true): Row => ({
  probe,
  run,
  arm,
  expected: true,
  flagged,
  counted,
  failed: false,
  refused: [],
  inputTokens: 0,
  outputTokens: 0,
});
const three = (probe: string, arm: string, flags: boolean[], counted = [true, true, true]) =>
  flags.map((flagged, at) => row(probe, at + 1, arm, flagged, counted[at]));

// The gate's rule (#2969): a probe moves when the branch's flag differs from main's in at least 2 of
// its 3 runs, and a probe main itself splits on is noisy and decides nothing.
describe("when a probe moves", () => {
  test("the branch's flag differs from main's in two of three runs", () => {
    const rows = [
      ...three("a", "main", [true, true, true]),
      ...three("a", "branch", [false, false, true]),
    ];
    expect(movesOf(rows, "branch")).toEqual({ moved: ["a"], noisy: [] });
  });

  test("one run apart is not a move", () => {
    const rows = [
      ...three("a", "main", [true, true, true]),
      ...three("a", "branch", [false, true, true]),
    ];
    expect(movesOf(rows, "branch")).toEqual({ moved: [], noisy: [] });
  });

  test("a probe main splits on is noisy, whatever the branch does", () => {
    const rows = [
      ...three("a", "main", [true, false, true]),
      ...three("a", "branch", [false, true, false]),
    ];
    expect(movesOf(rows, "branch")).toEqual({ moved: [], noisy: ["a"] });
  });

  test("a check that wasn't counted is no run of either arm", () => {
    const rows = [
      ...three("a", "main", [true, true, true], [true, true, false]),
      ...three("a", "branch", [false, false, false], [true, false, true]),
    ];
    expect(movesOf(rows, "branch")).toEqual({ moved: [], noisy: [] });
  });

  test("each arm is held against main alone", () => {
    const rows = [
      ...three("a", "main", [false, false, false]),
      ...three("a", "branch", [false, false, false]),
      ...three("a", "nosentences", [true, true, false]),
    ];
    expect(movesOf(rows, "branch").moved).toEqual([]);
    expect(movesOf(rows, "nosentences").moved).toEqual(["a"]);
  });
});

describe("the probes of the gate", () => {
  test("are all there, each once, with a request", () => {
    expect(new Set(PRIVACY_PROBES).size).toBe(PRIVACY_PROBES.length);
    for (const id of PRIVACY_PROBES) {
      expect(ALL_PROBES.some((probe) => probe.id === id)).toBe(true);
      expect(requestOf(id)).not.toBe("");
    }
  });
});
