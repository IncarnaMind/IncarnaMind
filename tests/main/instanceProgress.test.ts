import { expect, test } from "vitest";
import { InstanceProgress } from "../../src/main/instanceProgress";

test("a starting owner's fresh progress keeps a waiting start beyond the ordinary quit deadline", () => {
  const waiting = new InstanceProgress(10_000, 0);
  waiting.observe("owner", "starting", 0, 0);
  expect(waiting.expired(10_001)).toBe(false);
  waiting.observe("owner", "starting", 1, 59_000);
  expect(waiting.expired(60_001)).toBe(false);
  expect(waiting.expired(119_000)).toBe(true);
});

test("unchanged progress expires, and being ready or quitting restores the ordinary deadline", () => {
  const waiting = new InstanceProgress(10_000, 0);
  waiting.observe("owner", "starting", 0, 0);
  waiting.observe("owner", "starting", 0, 59_000);
  expect(waiting.expired(60_000)).toBe(true);
  waiting.observe("owner", "ready", 0, 60_000);
  expect(waiting.expired(70_000)).toBe(true);
  waiting.observe("owner", "quitting", 0, 70_000);
  expect(waiting.expired(79_999)).toBe(false);
  expect(waiting.expired(80_000)).toBe(true);
});
