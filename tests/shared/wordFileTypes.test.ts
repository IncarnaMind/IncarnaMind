import { describe, expect, test } from "vitest";
import { isWordFile, isWordType } from "../../src/shared/wordFileTypes";

describe("a Word file by its type, before a drop names it", () => {
  test.each([
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.ms-word.document.macroEnabled.12",
    "application/vnd.ms-word.template.macroEnabled.12",
  ])("“%s” is Word's", (type) => {
    expect(isWordType(type)).toBe(true);
  });

  test("another word processor's type is not Word, WordPerfect's among them", () => {
    expect(isWordType("application/vnd.wordperfect")).toBe(false);
    expect(isWordType("application/vnd.oasis.opendocument.text")).toBe(false);
    expect(isWordType("application/pdf")).toBe(false);
    expect(isWordType("")).toBe(false);
  });
});

describe("a Word file by its name", () => {
  test("its own names are Word's", () => {
    for (const name of ["Memo.docx", "Memo.DOC", "Memo.docm", "Memo.dotx", "Memo.dotm"]) {
      expect(isWordFile(name)).toBe(true);
    }
  });

  test("a WordPerfect file's name is not", () => {
    expect(isWordFile("Memo.wpd")).toBe(false);
    expect(isWordFile("Memo.docx.txt")).toBe(false);
  });
});
