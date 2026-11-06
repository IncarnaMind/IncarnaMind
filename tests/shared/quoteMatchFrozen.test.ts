/**
 * The matcher reads the frozen development probes of #2504 exactly as main did when they were
 * recorded (`quote-mark-dev-probes.main.json`): asking once about nested quotation marks
 * (src/core/answers/exactMarks.ts) reads them a second time only in its own module, so no quote
 * is found here that main didn't find, at a place main didn't find it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findQuote, type TextRange } from "../../src/shared/quoteMatch";

const fixtures = join(__dirname, "..", "fixtures");
const probes = JSON.parse(readFileSync(join(fixtures, "quote-mark-dev-probes.json"), "utf8")) as {
  page: string;
  quote: string;
}[];
const recorded = JSON.parse(
  readFileSync(join(fixtures, "quote-mark-dev-probes.main.json"), "utf8"),
) as (TextRange[] | null)[];

test("every probe reads as main read it: the same ranges, or not found", () => {
  expect(probes).toHaveLength(266);
  expect(probes.map(({ page, quote }) => findQuote(page, quote))).toEqual(recorded);
  expect(recorded.filter((ranges) => ranges !== null)).toHaveLength(21);
});
