import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Language } from "../../src/core/language";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

type PageId = "check" | "data";

const PAGES: Readonly<Record<PageId, Readonly<Record<Language, string>>>> = {
  check: {
    en: read("docs/how-the-check-works.md"),
    "zh-CN": read("docs/how-the-check-works.zh-CN.md"),
  },
  data: {
    en: read("docs/where-your-data-goes.md"),
    "zh-CN": read("docs/where-your-data-goes.zh-CN.md"),
  },
};

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

interface DocQuote {
  readonly page: PageId;
  readonly key: MessageKey;
  /** Sample values for the interface's placeholders, so a page quotes a line as a User sees it. */
  readonly params?: Readonly<Partial<Record<Language, MessageParams>>>;
}

/**
 * Every interface string pages 3 and 4 quote, by its dictionary key (#2051).
 * A string that changes in `src/shared/i18n/` changes what these pages must
 * say, and the test fails until they follow.
 */
const QUOTES: readonly DocQuote[] = [
  {
    page: "check",
    key: "citation.badge.found.on",
    params: { en: { location: "p. 68" }, "zh-CN": { location: "第 68 页" } },
  },
  {
    page: "check",
    key: "citation.badge.notFound.on",
    params: { en: { location: "p. 68" }, "zh-CN": { location: "第 68 页" } },
  },
  { page: "check", key: "citation.badge.cantCheck" },
  { page: "check", key: "citation.meaning" },
  { page: "check", key: "aiStatement.citations.notFound" },
  { page: "check", key: "editor.ai.checkAgainstDocuments" },
  { page: "check", key: "verify.command" },
  { page: "check", key: "mindCheck.command" },
  { page: "check", key: "claim.state.supported" },
  { page: "check", key: "claim.state.unsupported" },
  { page: "check", key: "claim.state.notFound" },
  { page: "check", key: "claim.state.contradicted" },
  { page: "check", key: "claim.state.not-checked" },
  { page: "check", key: "claim.state.needs-recheck" },
  {
    page: "check",
    key: "claim.unsupported.notFound",
    params: { en: { scope: "Leases" }, "zh-CN": { scope: "Leases" } },
  },
  { page: "check", key: "claim.reason.refused" },
  { page: "check", key: "claim.reason.malformed" },
  { page: "check", key: "claim.reason.no-evidence" },
  { page: "check", key: "claim.state.recordCite" },
  { page: "check", key: "opinions.one" },
  { page: "check", key: "claim.reason.consent-revoked" },
  { page: "check", key: "claim.reason.local-mode" },
  { page: "check", key: "claim.recheck.edited" },
  { page: "check", key: "claim.checkAgain" },
  { page: "check", key: "claim.limit" },
  { page: "check", key: "checks.smallModel" },
  { page: "check", key: "claim.courtDecision.body" },
  { page: "check", key: "health.unexamined.one" },
  { page: "data", key: "embeddingProviders.localOnly.label" },
  { page: "data", key: "tagging.automatic.switch" },
  { page: "data", key: "skills.make.command" },
  { page: "data", key: "privacy.skills.body" },
];

const rendered = (quote: DocQuote, language: Language): string =>
  translate(language, quote.key, quote.params?.[language]);

const BACKTICKED = /`([^`\n]+)`/g;

function backticked(text: string): string[] {
  return [...text.matchAll(BACKTICKED)].map((match) => match[1] as string);
}

describe("docs pages 3 and 4 quote the interface", () => {
  test.each(QUOTES)("$page quotes $key in English and Chinese", (quote) => {
    for (const language of ["en", "zh-CN"] as const) {
      expect(
        PAGES[quote.page][language],
        `the ${quote.page} page (${language}) must quote ${quote.key} as “${rendered(quote, language)}”`,
      ).toContain(rendered(quote, language));
    }
  });

  test("the Chinese pages follow the guide's spacing and never say 您", () => {
    for (const page of Object.keys(PAGES) as PageId[]) {
      expect(PAGES[page]["zh-CN"]).not.toContain("您");
      expect(PAGES[page]["zh-CN"]).not.toMatch(
        /[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u,
      );
    }
  });

  test.each(["en", "zh-CN"] as const)(
    "every backticked phrase is an interface string the test knows (%s)",
    (language) => {
      for (const page of Object.keys(PAGES) as PageId[]) {
        const known = new Set(
          QUOTES.filter((quote) => quote.page === page).map((quote) => rendered(quote, language)),
        );
        for (const phrase of backticked(PAGES[page][language])) {
          expect(known.has(phrase), `${page} (${language}) quotes “${phrase}”`).toBe(true);
        }
      }
    },
  );

  test("the data page links to the privacy page", () => {
    for (const language of ["en", "zh-CN"] as const) {
      expect(PAGES.data[language]).toContain("[privacy.md](privacy.md)");
    }
  });

  test("each page links to its other language", () => {
    expect(PAGES.check.en).toContain("[简体中文](how-the-check-works.zh-CN.md)");
    expect(PAGES.check["zh-CN"]).toContain("[English](how-the-check-works.md)");
    expect(PAGES.data.en).toContain("[简体中文](where-your-data-goes.zh-CN.md)");
    expect(PAGES.data["zh-CN"]).toContain("[English](where-your-data-goes.md)");
  });
});
