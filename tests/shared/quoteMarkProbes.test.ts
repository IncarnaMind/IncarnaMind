/**
 * Quote marks read in many shapes and languages (#2504). Each probe is a page, a quote and whether the
 * quote is the page's words. A quote that isn't must never be found, and one that is is found at the
 * page words `at` names. quote-mark-probes.json was written before the rule it tests; the development
 * set, quote-mark-dev-probes.json, is what the rule was tuned on. A quote that is the page's words may
 * still be missed: these counts say how many are found.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { findQuote } from "../../src/shared/quoteMatch";

interface Probe {
  kind: string;
  lang: string;
  page: string;
  quote: string;
  truth: "in" | "out";
  at?: string;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const probes = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, "tests/fixtures", name), "utf8")) as Probe[];

const covered = ({ page, quote }: Probe) =>
  findQuote(page, quote)
    ?.map((range) => page.slice(range.start, range.end))
    .join(" … ") ?? null;

describe.each([
  ["quote-mark-probes.json", 25],
  ["quote-mark-dev-probes.json", 72],
] as const)("%s", (name, foundIn) => {
  const all = probes(name);

  test("a quote that isn't the page's words is never found", () => {
    const found = all.filter((probe) => probe.truth === "out" && covered(probe) !== null);
    expect(found.map((probe) => `${probe.page} || ${probe.quote}`)).toEqual([]);
  });

  test("a quote that is the page's words is found at the words it names, and this many are found", () => {
    const ins = all.filter((probe) => probe.truth === "in");
    const elsewhere = ins.filter(
      (probe) => probe.at && covered(probe) !== null && covered(probe) !== probe.at,
    );
    expect(elsewhere.map((probe) => `${probe.page} || ${probe.quote}`)).toEqual([]);
    expect(ins.filter((probe) => covered(probe) !== null)).toHaveLength(foundIn);
  });
});
