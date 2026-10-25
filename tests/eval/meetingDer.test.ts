import { describe, expect, test } from "vitest";
import {
  bestMatching,
  DEFAULT_COLLAR,
  diarisationErrorRate,
  type Turn,
  totalDer,
} from "../../eval/meetings/der";

const turn = (speaker: string, start: number, end: number): Turn => ({ speaker, start, end });

describe("Diarisation error rate", () => {
  test("a perfect answer scores 0, whatever it calls its speakers", () => {
    const reference = [turn("A", 0, 10), turn("B", 10, 20), turn("A", 20, 30)];
    const der = diarisationErrorRate(
      reference,
      [turn("2", 0, 10), turn("1", 10, 20), turn("2", 20, 30)],
      0,
    );
    expect(der.rate).toBe(0);
    expect(der.speech).toBeCloseTo(30);
  });

  test("speech with no answer is missed", () => {
    const der = diarisationErrorRate([turn("A", 0, 10)], [], 0);
    expect(der.missed).toBeCloseTo(10);
    expect(der.rate).toBeCloseTo(1);
  });

  test("an answer where the reference is silent is a false alarm", () => {
    const der = diarisationErrorRate([turn("A", 0, 10)], [turn("X", 0, 10), turn("Y", 12, 14)], 0);
    expect(der.falseAlarm).toBeCloseTo(2);
    expect(der.rate).toBeCloseTo(0.2);
  });

  test("one speaker given for two is confusion for the time of one of them", () => {
    const der = diarisationErrorRate([turn("A", 0, 10), turn("B", 10, 20)], [turn("X", 0, 20)], 0);
    expect(der.confusion).toBeCloseTo(10);
    expect(der.missed).toBe(0);
    expect(der.rate).toBeCloseTo(0.5);
  });

  test("overlapped speech is scored: two are expected where two talk", () => {
    const reference = [turn("A", 0, 10), turn("B", 5, 10)];
    const der = diarisationErrorRate(reference, [turn("X", 0, 10)], 0);
    expect(der.speech).toBeCloseTo(15);
    expect(der.missed).toBeCloseTo(5);
    expect(der.rate).toBeCloseTo(1 / 3);
  });

  test("the collar leaves out the time around a reference turn's edges", () => {
    const reference = [turn("A", 0, 10)];
    const hypothesis = [turn("X", 0.2, 9.8)];
    expect(diarisationErrorRate(reference, hypothesis, 0).rate).toBeCloseTo(0.04);
    expect(diarisationErrorRate(reference, hypothesis, DEFAULT_COLLAR).rate).toBe(0);
    expect(diarisationErrorRate(reference, hypothesis, DEFAULT_COLLAR).collar).toBe(0.25);
  });

  test("the best one-to-one matching is made over the whole recording, not turn by turn", () => {
    const reference = [turn("A", 0, 10), turn("B", 10, 12), turn("A", 12, 20)];
    const hypothesis = [turn("X", 0, 10), turn("Y", 10, 12), turn("X", 12, 20)];
    expect(diarisationErrorRate(reference, hypothesis, 0).rate).toBe(0);
  });

  test("recordings add up by the time they hold", () => {
    const short = diarisationErrorRate([turn("A", 0, 10)], [], 0);
    const long = diarisationErrorRate([turn("A", 0, 30)], [turn("X", 0, 30)], 0);
    const both = totalDer([short, long]);
    expect(both.speech).toBeCloseTo(40);
    expect(both.rate).toBeCloseTo(10 / 40);
  });

  test("no reference speech scores 0", () => {
    expect(diarisationErrorRate([], [turn("X", 0, 5)], 0).rate).toBe(0);
  });
});

describe("Matching speakers", () => {
  test("takes the assignment with the most time", () => {
    expect(
      bestMatching([
        [10, 2],
        [3, 9],
      ]),
    ).toEqual([0, 1]);
    expect(
      bestMatching([
        [8, 9],
        [9, 1],
      ]),
    ).toEqual([1, 0]);
  });

  test("finds the largest total on matrices of every small shape, as trying every assignment does", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const best = (weights: number[][], row = 0, taken = new Set<number>()): number => {
      if (row === weights.length) return 0;
      let most = best(weights, row + 1, taken);
      for (let column = 0; column < (weights[0]?.length ?? 0); column++) {
        if (taken.has(column)) continue;
        taken.add(column);
        most = Math.max(most, (weights[row]?.[column] ?? 0) + best(weights, row + 1, taken));
        taken.delete(column);
      }
      return most;
    };
    for (let round = 0; round < 200; round++) {
      const rows = 1 + Math.floor(random() * 5);
      const columns = 1 + Math.floor(random() * 5);
      const weights = Array.from({ length: rows }, () =>
        Array.from({ length: columns }, () => Math.floor(random() * 20)),
      );
      const matching = bestMatching(weights);
      const total = matching.reduce(
        (sum, column, row) => sum + (column >= 0 ? (weights[row]?.[column] as number) : 0),
        0,
      );
      expect(total).toBe(best(weights));
      expect(new Set(matching.filter((column) => column >= 0)).size).toBe(
        matching.filter((column) => column >= 0).length,
      );
    }
  });

  test("leaves a row with no column unmatched, and a column with no row", () => {
    expect(bestMatching([[5], [7]])).toEqual([-1, 0]);
    expect(
      bestMatching([
        [1, 2, 3],
        [3, 2, 1],
      ]),
    ).toEqual([2, 0]);
    expect(bestMatching([])).toEqual([]);
  });
});
