import { describe, expect, test } from "vitest";
import { holds } from "../../eval/repeats/wholeReadScore";

describe("whole-read scoring", () => {
  test.each(["unsupported", "contradicted-or-unsupported"] as const)(
    "a missing mark never holds %s",
    (expected) => {
      expect(holds({ expected, outcome: "no-mark", readAll: false })).toBe(false);
    },
  );
});
