import { describe, expect, test } from "vitest";
import type { ExportPreferences } from "../../src/core/api";
import { citedCountText, optionsFor, quitCopyOptions } from "../../src/shared/exportOptions";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const preferences = (
  markAiText: "mark" | "leave" | null,
  citationPlace?: "footnotes" | "list",
): ExportPreferences => ({
  format: "docx",
  ...(citationPlace && { citationPlace }),
  docx: { includeQuestions: false, trackChanges: true, markAiText, commentFailedChecks: true },
  pdf: { includeQuestions: false },
  html: { includeQuestions: false },
  "share-page": { includeQuestions: false, citationCards: true, checkedLine: false },
});

describe("What an export asks the core for", () => {
  test("a Word export waits until the User has said whether to mark the text IncarnaMind wrote", () => {
    expect(optionsFor("docx", preferences(null))).toBeNull();
  });

  test.each([
    ["mark", true],
    ["leave", false],
  ] as const)("a Word export that %s the text IncarnaMind wrote asks for %s", (answer, marked) => {
    expect(optionsFor("docx", preferences(answer))).toEqual({
      format: "docx",
      includeQuestions: false,
      trackChanges: true,
      markAiText: marked,
      commentFailedChecks: true,
    });
  });

  test("the other formats don't wait for it", () => {
    for (const format of ["pdf", "html", "markdown", "source-pack", "share-page"] as const) {
      expect(optionsFor(format, preferences(null))).not.toBeNull();
    }
  });
});

describe("Where Word and PDF put the Citations", () => {
  test("asks for what the User chose, and for nothing before they have", () => {
    expect(optionsFor("docx", preferences("mark"))).not.toHaveProperty("citationPlace");
    expect(optionsFor("pdf", preferences(null))).not.toHaveProperty("citationPlace");
    expect(optionsFor("docx", preferences("mark", "list"))).toMatchObject({
      markAiText: true,
      citationPlace: "list",
    });
    expect(optionsFor("pdf", preferences(null, "footnotes"))).toMatchObject({
      format: "pdf",
      citationPlace: "footnotes",
    });
  });

  test("the other formats never ask for it", () => {
    for (const format of ["html", "markdown", "source-pack", "share-page"] as const) {
      expect(optionsFor(format, preferences("mark", "list"))).not.toHaveProperty("citationPlace");
    }
  });

  test("the copy offered when quitting follows the answer when there is one", () => {
    expect(quitCopyOptions(preferences("mark"))).toEqual({ format: "docx", markAiText: true });
    expect(quitCopyOptions(preferences("leave", "list"))).toEqual({
      format: "docx",
      markAiText: false,
      citationPlace: "list",
    });
  });

  test("the count the question gives, in English and Chinese", () => {
    const in_ = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
      translate(language, key, params);
    expect(citedCountText(in_("en"), { citations: 19, documents: 1 })).toBe(
      "19 Citations from 1 Document",
    );
    expect(citedCountText(in_("en"), { citations: 1, documents: 2 })).toBe(
      "1 Citation from 2 Documents",
    );
    expect(citedCountText(in_("zh-CN"), { citations: 19, documents: 1 })).toBe(
      "19 个引用，来自 1 个文档",
    );
    expect(citedCountText(in_("zh-CN"), { citations: 1, documents: 3 })).toBe(
      "1 个引用，来自 3 个文档",
    );
  });
});
