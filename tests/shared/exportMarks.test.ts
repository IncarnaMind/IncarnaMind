/**
 * A Note's export marks (#1258): what counts as a choice, what a Word file or PDF prints,
 * and how the marks are kept in the Note's own settings so they go where the Note goes.
 */

import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_EXPORT_MARKS,
  exportMarksOf,
  isExportMarks,
  MAX_WATERMARK_WORDS,
  printedMarks,
  settledMarks,
  WATERMARK_CHOICES,
  writeExportMarks,
} from "../../src/shared/exportMarks";

describe("Export mark choices", () => {
  test("every watermark choice is a choice, and page numbers are true or false", () => {
    for (const watermark of WATERMARK_CHOICES) {
      expect(isExportMarks({ pageNumbers: true, watermark })).toBe(watermark !== "words");
    }
    expect(isExportMarks({ pageNumbers: true, watermark: "words", words: "Internal" })).toBe(true);
    expect(isExportMarks({ pageNumbers: false, watermark: "none" })).toBe(true);
  });

  test("a malformed or unknown choice is no choice", () => {
    expect(isExportMarks(null)).toBe(false);
    expect(isExportMarks({ watermark: "none" })).toBe(false);
    expect(isExportMarks({ pageNumbers: true, watermark: "acme" })).toBe(false);
    expect(isExportMarks({ pageNumbers: true, watermark: "none", extra: 1 })).toBe(false);
    expect(isExportMarks({ pageNumbers: true, watermark: "words", words: "" })).toBe(false);
    expect(
      isExportMarks({
        pageNumbers: true,
        watermark: "words",
        words: "x".repeat(MAX_WATERMARK_WORDS + 1),
      }),
    ).toBe(false);
    expect(isExportMarks({ pageNumbers: true, watermark: "words", words: "two\nlines" })).toBe(
      false,
    );
  });

  test("a Note with no marks saved has page numbers and no watermark, in Word and in PDF", () => {
    const settings = new Y.Doc().getMap<unknown>("settings");
    expect(exportMarksOf(settings, "docx")).toEqual(DEFAULT_EXPORT_MARKS);
    expect(exportMarksOf(settings, "pdf")).toEqual(DEFAULT_EXPORT_MARKS);
    settings.set("exportMarks", { pageNumbers: "yes", watermark: "draft" });
    expect(exportMarksOf(settings, "docx")).toEqual(DEFAULT_EXPORT_MARKS);
  });

  test("a choice is kept for every format, and the default is forgotten", () => {
    const settings = new Y.Doc().getMap<unknown>("settings");
    writeExportMarks(settings, { pageNumbers: false, watermark: "draft" });
    expect(exportMarksOf(settings, "docx")).toEqual({ pageNumbers: false, watermark: "draft" });
    expect(exportMarksOf(settings, "pdf")).toEqual({ pageNumbers: false, watermark: "draft" });
    writeExportMarks(settings, { pageNumbers: true, watermark: "none" });
    expect(settings.has("exportMarks")).toBe(false);
  });

  test("a preset prints its word in the export's language, and the User's own word as typed", () => {
    expect(printedMarks({ pageNumbers: true, watermark: "none" }, "en")).toEqual({
      pageNumbers: true,
      watermark: null,
    });
    expect(printedMarks({ pageNumbers: true, watermark: "draft" }, "en").watermark).toBe("DRAFT");
    expect(printedMarks({ pageNumbers: true, watermark: "draft" }, "zh-CN").watermark).toBe("草稿");
    expect(printedMarks({ pageNumbers: true, watermark: "confidential" }, "zh-CN").watermark).toBe(
      "机密",
    );
    expect(
      printedMarks({ pageNumbers: true, watermark: "words", words: "  Internal " }, "zh-CN")
        .watermark,
    ).toBe("Internal");
  });

  test("saving settles the word and drops one a preset replaced", () => {
    expect(settledMarks({ pageNumbers: true, watermark: "words", words: " Acme " })).toEqual({
      pageNumbers: true,
      watermark: "words",
      words: "Acme",
    });
    expect(settledMarks({ pageNumbers: true, watermark: "draft", words: "Acme" })).toEqual({
      pageNumbers: true,
      watermark: "draft",
    });
  });
});
