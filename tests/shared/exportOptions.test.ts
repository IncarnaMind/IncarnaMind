import { describe, expect, test } from "vitest";
import type { CitationPlace, ExportPreferences } from "../../src/core/api";
import {
  chosenParts,
  optionsFor,
  quitCopyOptions,
  withCitationPlace,
  withMarking,
} from "../../src/shared/exportOptions";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const preferences = (
  markAiText: "mark" | "leave" | null,
  citationPlace?: CitationPlace,
): ExportPreferences => ({
  format: "docx",
  ...(citationPlace && { citationPlace }),
  docx: { includeQuestions: false, trackChanges: true, markAiText, commentFailedChecks: true },
  pdf: { includeQuestions: false },
  html: { includeQuestions: false },
  "share-page": { includeQuestions: false, citationCards: true, checkedLine: false },
});

const in_ = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

describe("What an export asks the core for", () => {
  test("a Word export of a note whose marking was never chosen marks the text IncarnaMind wrote (#1945)", () => {
    expect(optionsFor("docx", preferences(null))).toEqual({
      format: "docx",
      includeQuestions: false,
      trackChanges: true,
      markAiText: true,
      commentFailedChecks: true,
      commentOthersFiles: false,
      citationPlace: "footnotes",
    });
  });

  test("someone else's file gets check comments only once the User turns them on for it (#110)", () => {
    expect(optionsFor("docx", { ...preferences(null), commentOthersFiles: true })).toMatchObject({
      commentFailedChecks: true,
      commentOthersFiles: true,
    });
    expect(optionsFor("pdf", preferences(null))).not.toHaveProperty("commentOthersFiles");
  });

  test.each([
    ["mark", true],
    ["leave", false],
  ] as const)(
    "a Word export that has %s marks the text IncarnaMind wrote: %s",
    (answer, marked) => {
      expect(optionsFor("docx", preferences(answer)).markAiText).toBe(marked);
    },
  );

  test("the other formats take no marking at all", () => {
    for (const format of ["pdf", "html", "markdown", "source-pack", "share-page"] as const) {
      expect(optionsFor(format, preferences(null))).not.toHaveProperty("markAiText");
    }
  });
});

describe("Where Word and PDF put the Citations", () => {
  test("footnotes until the User picks a list at the end, and the same answer in every export (#1945)", () => {
    expect(optionsFor("docx", preferences("mark"))).toHaveProperty("citationPlace", "footnotes");
    expect(optionsFor("pdf", preferences(null))).toHaveProperty("citationPlace", "footnotes");
    expect(optionsFor("docx", preferences("mark", "list"))).toMatchObject({
      markAiText: true,
      citationPlace: "list",
    });
    expect(optionsFor("pdf", preferences(null, "list"))).toMatchObject({
      format: "pdf",
      citationPlace: "list",
    });
  });

  test("the other formats never place Citations", () => {
    for (const format of ["html", "markdown", "source-pack", "share-page"] as const) {
      expect(optionsFor(format, preferences("mark", "list"))).not.toHaveProperty("citationPlace");
    }
  });

  test("the copy offered when quitting follows the same choices and defaults", () => {
    expect(quitCopyOptions(preferences(null))).toEqual({
      format: "docx",
      markAiText: true,
      citationPlace: "footnotes",
    });
    expect(quitCopyOptions(preferences("leave", "list"))).toEqual({
      format: "docx",
      markAiText: false,
      citationPlace: "list",
    });
  });
});

describe("What the Saved line says the file was written with (#1945)", () => {
  const parts = (
    language: "en" | "zh-CN",
    citations: number,
    place: CitationPlace,
    marked: boolean | null,
    footnotes = citations,
  ) => chosenParts(in_(language), { places: { citations, footnotes, place }, markAiText: marked });

  test("six Citations as footnotes, with AI text marked, in English and Chinese", () => {
    expect(parts("en", 6, "footnotes", true)).toEqual(["6 footnotes", "AI text marked"]);
    expect(parts("zh-CN", 6, "footnotes", true)).toEqual(["6 个脚注", "已标出 AI 生成的文字"]);
  });

  test("five Citations across two pages are 2 footnotes, as the Word writer wrote them (#2193)", () => {
    expect(parts("en", 5, "footnotes", true, 2)).toEqual(["2 footnotes", "AI text marked"]);
    expect(parts("zh-CN", 5, "footnotes", true, 2)).toEqual(["2 个脚注", "已标出 AI 生成的文字"]);
  });

  test("one Citation, as a list at the end", () => {
    expect(parts("en", 1, "list", true)).toEqual([
      "1 Citation in a list at the end",
      "AI text marked",
    ]);
    expect(parts("zh-CN", 1, "list", true)).toEqual(["1 个引用列在文末", "已标出 AI 生成的文字"]);
    expect(parts("en", 3, "list", false)).toEqual([
      "3 Citations in a list at the end",
      "AI text not marked",
    ]);
    expect(parts("zh-CN", 3, "list", false)).toEqual(["3 个引用列在文末", "未标出 AI 生成的文字"]);
  });

  test("a list counts its Citations even where footnotes would merge them", () => {
    expect(parts("en", 5, "list", null, 2)).toEqual(["5 Citations in a list at the end"]);
    expect(parts("zh-CN", 5, "list", null, 2)).toEqual(["5 个引用列在文末"]);
  });

  test("a file with no Citations says only how its AI text went", () => {
    expect(parts("en", 0, "footnotes", true, 0)).toEqual(["AI text marked"]);
    expect(parts("zh-CN", 0, "footnotes", false, 0)).toEqual(["未标出 AI 生成的文字"]);
  });

  test("a PDF has no marking to say", () => {
    expect(parts("en", 6, "footnotes", null)).toEqual(["6 footnotes"]);
    expect(parts("zh-CN", 6, "footnotes", null)).toEqual(["6 个脚注"]);
  });

  test("a note with neither a Citation nor AI marking to say says nothing", () => {
    expect(chosenParts(in_("en"), { places: null, markAiText: null })).toEqual([]);
  });
});

describe("A choice changed from the Saved line's Change (#1945)", () => {
  test("changing the marking leaves every other choice as it is then", () => {
    const later: ExportPreferences = {
      ...preferences("mark", "list"),
      format: "pdf",
      pdf: { includeQuestions: true },
    };
    expect(withMarking(later, "leave")).toMatchObject({
      format: "pdf",
      pdf: { includeQuestions: true },
      citationPlace: "list",
      docx: { includeQuestions: false, trackChanges: true, markAiText: "leave" },
    });
  });

  test("taking the Citations' place back leaves nothing chosen, and keeps the rest", () => {
    const later: ExportPreferences = { ...preferences("leave", "list"), format: "pdf" };
    const undone = withCitationPlace(later, undefined);
    expect(undone).not.toHaveProperty("citationPlace");
    expect(undone).toMatchObject({ format: "pdf", docx: { markAiText: "leave" } });
    expect(withCitationPlace(undone, "footnotes")).toMatchObject({ citationPlace: "footnotes" });
  });
});
