import { describe, expect, test } from "vitest";
import {
  checkPressOf,
  type EstimateSettled,
  estimateShown,
} from "../../src/renderer/src/editor/checkEstimateState";
import type { Planned } from "../../src/renderer/src/mindCheck";

const plan = {} as Planned;
const other = {} as Planned;
const line = { parts: ["About $1.40"], title: "About $1.40" };

// protects=#2313: a plan since changed shows pending until its own estimate lands; fails_when=the last plan's cheap result lets a press run unpriced; no_claim=the same plan's settled result.
test("a plan since changed shows pending, and the same plan keeps its settled result", () => {
  const cheap: EstimateSettled = { planned: plan, line: null, state: "none" };
  expect(estimateShown(cheap, other)).toEqual({ line: null, state: "pending" });
  expect(estimateShown(cheap, plan)).toEqual({ line: null, state: "none" });
  const priced: EstimateSettled = { planned: plan, line, state: "price" };
  expect(estimateShown(priced, other)).toEqual({ line: null, state: "pending" });
  expect(estimateShown(priced, plan)).toEqual({ line, state: "price" });
});

describe("A press with no price asks before it runs", () => {
  // protects=#2313: no price yet or none could be had asks; fails_when=the card's press runs unpriced; no_claim=the priced and cheap runs.
  test("pending and unknown ask; price and none run", () => {
    expect(checkPressOf("pending")).toBe("ask");
    expect(checkPressOf("unknown")).toBe("ask");
    expect(checkPressOf("price")).toBe("run");
    expect(checkPressOf("none")).toBe("run");
  });
});
