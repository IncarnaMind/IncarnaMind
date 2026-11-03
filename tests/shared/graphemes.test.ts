/**
 * Where a cut keeps a character whole (#2220): a surrogate pair, a joined sequence and a mark on
 * its base each stay on one side of it, with the runtime's grapheme segmenter and without.
 */
import { describe, expect, test } from "vitest";
import { graphemeBoundary } from "../../src/shared/graphemes";

const cases = [
  { name: "a surrogate pair", text: `${"a".repeat(198)}😀${"b".repeat(50)}`, end: 199, at: 198 },
  {
    name: "a joined sequence",
    text: `${"a".repeat(196)}👨‍👩‍👧${"b".repeat(50)}`,
    end: 199,
    at: 196,
  },
  {
    name: "a mark on its base",
    text: `${"a".repeat(198)}é${"b".repeat(50)}`,
    end: 199,
    at: 198,
  },
] as const;

for (const example of cases)
  describe(example.name, () => {
    test("the cut moves back to its start", () => {
      // The runtime's segmenter, then the guard for a runtime without one.
      for (const segmenter of [undefined, null]) {
        const cut = graphemeBoundary(example.text, example.end, segmenter);
        expect(cut).toBe(example.at);
        expect(example.text.slice(0, cut)).toBe(example.text.slice(0, example.at));
        expect(example.text.slice(0, cut).isWellFormed()).toBe(true);
      }
    });
  });

test("a cut between characters stays where it is", () => {
  expect(graphemeBoundary("abcdef", 3)).toBe(3);
  expect(graphemeBoundary("abcdef", 6)).toBe(6);
  expect(graphemeBoundary("abcdef", 0)).toBe(0);
});
