import { expect, test } from "vitest";
import { rejectedLine } from "../../eval/lib/citations";

test("the eval report distinguishes an ambiguous quote from an unknown Passage", () => {
  expect(rejectedLine([{ marker: 1, passage: "P1", reason: "quote-context" }])).toBe(
    '[^1] "P1" (ambiguous quote)',
  );
});
