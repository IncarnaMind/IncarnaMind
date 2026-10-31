/**
 * The credit example's own Documents (src/core/exampleSets.ts): the words a
 * new User reads at the foot of the page, and the quotes the example's
 * Citations and checked sentence must keep finding (#2316).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { extractText } from "../../src/core/documents/extract";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import { findQuote } from "../../src/shared/quoteMatch";

const EXAMPLES = resolve(__dirname, "../../resources/examples");
const CREDIT = EXAMPLE_SETS.credit;

const SETS = [
  { set: CREDIT.en, language: "en", wording: /example note/ },
  { set: CREDIT["zh-CN"], language: "zh-CN", wording: /示例笔记/ },
] as const;

describe("the credit example's Documents", () => {
  for (const { set, language, wording } of SETS) {
    test(`say the Note's name, and keep every quote the example cites (${language})`, async () => {
      const quotes = [
        ...set.quotes,
        ...(set.ready?.quotes ?? []),
        ...(set.checks ?? []).map((check) => check.evidence),
      ];
      const named = new Set([...quotes.map((quote) => quote.document)]);
      expect(named.size).toBe(2);

      const pages = new Map<string, string[]>();
      for (const name of named) {
        const bytes = readFileSync(resolve(EXAMPLES, set.source, `${name}.pdf`));
        const read = await extractText("pdf", bytes);
        const text = read.units.map((unit) => unit.text).join("\n");
        expect(text.replaceAll("IncarnaMind", "")).not.toContain("Mind");
        expect(text).toMatch(wording);
        pages.set(
          name,
          read.units.map((unit) => unit.text),
        );
      }

      for (const quote of quotes) {
        const found = (pages.get(quote.document) ?? []).some(
          (page) => findQuote(page, quote.quote) !== null,
        );
        expect(found, `${quote.document}: ${quote.quote}`).toBe(true);
      }
    });
  }
});
