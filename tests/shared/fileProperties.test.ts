import { expect, test } from "vitest";
import type { FileProperties } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { fileDates, propertyRow, shownFileDate } from "../../src/shared/fileProperties";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

const own = (properties: Partial<FileProperties>): FileProperties => ({
  created: null,
  modified: null,
  author: null,
  sheets: null,
  ...properties,
});

const document = {
  keptByApp: false,
  creationDate: "2026-10-01T08:00:00Z",
  fileCreatedAt: "2026-11-01T12:00:00.000Z",
  modifiedAt: "2026-11-03T12:00:00.000Z",
};

test("a file's own dates are shown when it records any, this computer's only when it records none, never both", () => {
  expect(fileDates({ ...document, properties: own({ created: "2026-10-01T08:00:00Z" }) })).toEqual({
    created: "2026-10-01T08:00:00Z",
    modified: null,
    from: "file",
  });
  expect(fileDates({ ...document, properties: own({}) })).toEqual({
    created: "2026-11-01T12:00:00.000Z",
    modified: "2026-11-03T12:00:00.000Z",
    from: "computer",
  });
  // Properties not read yet, or unreadable: only the creation date the file's metadata gave.
  expect(fileDates({ ...document, properties: null })).toEqual({
    created: "2026-10-01T08:00:00Z",
    modified: null,
    from: "file",
  });
  // A year the text writes is no date of the file's.
  expect(fileDates({ ...document, creationDate: "2019", properties: null })).toBeNull();
});

test("a file's own date is the day it names where it was saved; this computer's, the day here", () => {
  expect(shownFileDate("2026-11-02T23:30:00-08:00", "file", "en")).toBe("2 Nov 2026");
  expect(shownFileDate("2026-11-02T23:30:00-08:00", "file", "zh-CN")).toBe("2026年11月2日");
  expect(shownFileDate("2026-11-02T12:00:00.000Z", "computer", "en")).toBe("2 Nov 2026");
});

test("a check's row names the property and whose date it is, in both languages", () => {
  const modified = {
    kind: "properties",
    property: "modified",
    value: "2026-11-02T09:00:00Z",
  } as const;
  expect(propertyRow(modified, "Services agreement.docx", t("en"), "en")).toBe(
    "Properties of “Services agreement.docx”: Modified 2 Nov 2026 (the file’s own date)",
  );
  expect(propertyRow(modified, "Services agreement.docx", t("zh-CN"), "zh-CN")).toBe(
    "“Services agreement.docx”的文件属性：修改时间 2026年11月2日（文件本身的日期）",
  );
  const slides = { kind: "properties", property: "slides", value: "4" } as const;
  expect(propertyRow(slides, "Board pack", t("en"), "en")).toBe(
    "Properties of “Board pack”: 4 slides",
  );
  expect(propertyRow(slides, "Board pack", t("zh-CN"), "zh-CN")).toBe(
    "“Board pack”的文件属性：4 张幻灯片",
  );
});

test("the info panel's dates read as the ruling words them", () => {
  expect(translate("en", "info.fileDate", { date: "2 Nov 2026" })).toBe(
    "2 Nov 2026 (the file’s own date)",
  );
  expect(translate("zh-CN", "info.fileDate", { date: "2026年11月2日" })).toBe(
    "2026年11月2日（文件本身的日期）",
  );
  expect(
    translate("en", "info.computerDate", {
      date: "2 Nov 2026",
      note: translate("en", "info.onComputer"),
    }),
  ).toBe("2 Nov 2026 (on this computer)");
  expect(
    translate("zh-CN", "info.computerDate", {
      date: "2026年11月2日",
      note: translate("zh-CN", "info.onComputer"),
    }),
  ).toBe("2026年11月2日（这台电脑记录的日期）");
  expect(translate("en", "info.onComputer.tooltip")).toBe(
    "Copying or downloading a file changes this date",
  );
  expect(translate("zh-CN", "info.onComputer.tooltip")).toBe("复制或下载文件会改变这个日期");
});
