import { expect, test } from "vitest";
import type { FileProperties } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { formatBytes } from "../../src/shared/bytes";
import { formatDate } from "../../src/shared/dates";
import {
  fileDate,
  fileDates,
  onThisClock,
  propertyRow,
  shownFileDate,
} from "../../src/shared/fileProperties";
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
  // This computer's is the day it was here, in its own time zone.
  expect(shownFileDate("2026-11-02T12:00:00.000Z", "computer", "en")).toBe(
    formatDate("2026-11-02T12:00:00.000Z", "en"),
  );
});

test("a check's row names the property and whose date it is, in both languages", () => {
  const modified = {
    kind: "properties",
    property: "modified",
    value: "2026-11-02T09:00:00Z",
  } as const;
  const london = { timeZone: "Europe/London" };
  expect(propertyRow(modified, "Services agreement.docx", t("en"), "en", london)).toBe(
    "Properties of “Services agreement.docx”: Modified 2 Nov 2026 (the file’s own date)",
  );
  expect(propertyRow(modified, "Services agreement.docx", t("zh-CN"), "zh-CN", london)).toBe(
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
      whose: translate("en", "info.onComputer"),
    }),
  ).toBe("2 Nov 2026 (on this computer)");
  expect(
    translate("zh-CN", "info.computerDate", {
      date: "2026年11月2日",
      whose: translate("zh-CN", "info.onComputer"),
    }),
  ).toBe("2026年11月2日（这台电脑记录的日期）");
  expect(translate("en", "info.onComputer.tooltip")).toBe(
    "Copying or downloading a file changes this date",
  );
  expect(translate("zh-CN", "info.onComputer.tooltip")).toBe("复制或下载文件会改变这个日期");
});

// protects=Office writes every date in UTC: the day shown, in the panel, the row and the line the model reads, is the one this computer's clock gives, as Word and Finder show it; fails_when=a save early on 3 November in Shanghai reads as 2 November, or a late-evening one in New York as the next day.
test.each([
  {
    zone: "Asia/Shanghai",
    saved: "early in the morning",
    value: "2026-11-02T23:30:00Z",
    en: "3 Nov 2026",
    zh: "2026年11月3日",
    clock: "3 Nov 2026 07:30",
  },
  {
    zone: "Asia/Shanghai",
    saved: "late in the evening",
    value: "2026-11-02T15:00:00Z",
    en: "2 Nov 2026",
    zh: "2026年11月2日",
    clock: "2 Nov 2026 23:00",
  },
  {
    zone: "America/New_York",
    saved: "early in the morning",
    value: "2026-11-03T11:00:00Z",
    en: "3 Nov 2026",
    zh: "2026年11月3日",
    clock: "3 Nov 2026 06:00",
  },
  {
    zone: "America/New_York",
    saved: "late in the evening",
    value: "2026-11-03T01:00:00Z",
    en: "2 Nov 2026",
    zh: "2026年11月2日",
    clock: "2 Nov 2026 20:00",
  },
])(
  "a UTC date saved $saved in $zone is the day this computer's clock gives",
  ({ zone, value, en, zh, clock }) => {
    const here = { timeZone: zone };
    const modified = { kind: "properties", property: "modified", value } as const;
    expect(fileDate(value, "en", here)).toBe(en);
    expect(shownFileDate(value, "file", "zh-CN", here)).toBe(zh);
    expect(propertyRow(modified, "Lease", t("en"), "en", here)).toBe(
      `Properties of “Lease”: Modified ${en} (the file’s own date)`,
    );
    expect(propertyRow(modified, "Lease", t("zh-CN"), "zh-CN", here)).toBe(
      `“Lease”的文件属性：修改时间 ${zh}（文件本身的日期）`,
    );
    expect(onThisClock(value, here)).toBe(clock);
  },
);

test("a date written with another offset, or with no time, is the day it names, in any zone", () => {
  const shanghai = { timeZone: "Asia/Shanghai" };
  expect(fileDate("2026-11-02T23:30:00-08:00", "en", shanghai)).toBe("2 Nov 2026");
  expect(fileDate("2026-11-02", "en", shanghai)).toBe("2 Nov 2026");
  expect(onThisClock("2026-11-02T23:30:00-08:00", shanghai)).toBeNull();
  expect(onThisClock("2026-11-02", shanghai)).toBeNull();
  expect(onThisClock("2026-11-02T23:30:00+00:00", shanghai)).toBe("3 Nov 2026 07:30");
});

test("a size reads in decimal units, and in the binary ones Windows shows", () => {
  expect(formatBytes(4_194_304, t("en"))).toBe("4.2 MB");
  expect(formatBytes(4_194_304, t("en"), 1024)).toBe("4 MB");
  expect(formatBytes(1_536, t("en"), 1024)).toBe("2 KB");
});
