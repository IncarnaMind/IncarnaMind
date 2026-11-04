import { describe, expect, test } from "vitest";
import {
  addedDate,
  defaultFolderLabelKey,
  documentSummary,
  infoLabelKey,
  showFileLabelKey,
} from "../../src/renderer/src/fileInfo";
import { fileDate } from "../../src/shared/fileProperties";
import { translate } from "../../src/shared/i18n";

test("when something was added is a date in the app's one style", () => {
  expect(addedDate("2026-10-13T12:00:00Z", "en")).toBe("13 Oct 2026");
  expect(addedDate("2026-10-13T12:00:00Z", "zh-CN")).toBe("2026年10月13日");
});

describe("a Document's summary line", () => {
  const english = (
    key: Parameters<typeof translate>[1],
    params?: Parameters<typeof translate>[2],
  ) => translate("en", key, params);
  const chinese = (
    key: Parameters<typeof translate>[1],
    params?: Parameters<typeof translate>[2],
  ) => translate("zh-CN", key, params);

  test("gives a PDF's pages, a deck's slides and a workbook's sheets, and nothing for a Word file", () => {
    expect(
      documentSummary({ kind: "pdf", pageCount: 38, size: 2_400_000 }, null, english, "en"),
    ).toBe("PDF · 38 pages · 2.4 MB");
    expect(
      documentSummary(
        { kind: "pptx", pageCount: null, size: 48_000 },
        { key: "info.slides", count: 1 },
        english,
        "en",
      ),
    ).toBe("PowerPoint · 1 slide · 48 KB");
    expect(
      documentSummary(
        { kind: "xlsx", pageCount: null, size: 9_000 },
        { key: "info.sheets", count: 3 },
        chinese,
        "zh-CN",
      ),
    ).toBe("Excel · 3 个工作表 · 9 KB");
    expect(
      documentSummary({ kind: "docx", pageCount: null, size: 12_000 }, null, english, "en"),
    ).toBe("Word · 12 KB");
  });
});

describe("a file's own date", () => {
  test("is shown at the precision the file gave", () => {
    expect(fileDate("2019", "en")).toBe("2019");
    expect(fileDate("2019-03", "en")).toBe("March 2019");
    expect(fileDate("2019-03-04", "en")).toBe("4 Mar 2019");
    expect(fileDate("2019-03-04", "zh-CN")).toBe("2019年3月4日");
    expect(fileDate("2019-03", "zh-CN")).toBe("2019年3月");
  });

  test("is the day the file names, whatever its offset from UTC", () => {
    expect(fileDate("2019-03-04T23:30:00-08:00", "en")).toBe("4 Mar 2019");
    expect(fileDate("2019-03-04T00:30:00+09:00", "en")).toBe("4 Mar 2019");
  });

  test("is left as it is when it isn't a date", () => {
    expect(fileDate("sometime", "en")).toBe("sometime");
  });
});

test("every action that shows a file says Finder on macOS and folder on Windows and Linux, in both languages", () => {
  const says = (platform: string, language: "en" | "zh-CN") =>
    translate(language, showFileLabelKey(platform));
  expect(says("MacIntel", "en")).toBe("Show in Finder");
  expect(says("MacIntel", "zh-CN")).toBe("在访达中显示");
  for (const platform of ["Win32", "Linux x86_64"]) {
    expect(says(platform, "en")).toBe("Show in folder");
    expect(says(platform, "zh-CN")).toBe("在文件夹中显示");
  }
});

test("the default Output location is in 文稿 on macOS and 文档 on Windows and Linux, in Chinese", () => {
  const says = (platform: string, language: "en" | "zh-CN") =>
    translate(language, defaultFolderLabelKey(platform));
  expect(says("MacIntel", "zh-CN")).toBe("文稿 › IncarnaMind");
  for (const platform of ["Win32", "Linux x86_64"]) {
    expect(says(platform, "zh-CN")).toBe("文档 › IncarnaMind");
  }
  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    expect(says(platform, "en")).toBe("Documents › IncarnaMind");
  }
});

test("Get info is Properties in Chinese on Windows and Linux only", () => {
  expect(infoLabelKey("MacIntel")).toBe("info.get");
  expect(infoLabelKey("Win32")).toBe("info.get.other");
  expect(infoLabelKey("Linux x86_64")).toBe("info.get.other");
});
