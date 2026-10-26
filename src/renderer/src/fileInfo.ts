import type { Document } from "../../core/api";
import type { Language } from "../../core/language";
import { formatDate, formatMonth, formatYear } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { formatBytes, formatCount } from "./linkedFolders";

/** What a Document's kind is called, in the words of the Library's filters. */
export const KIND_LABELS: Record<Document["kind"], MessageKey> = {
  pdf: "library.format.pdf",
  docx: "library.format.docx",
  pptx: "library.format.pptx",
  xlsx: "library.format.xlsx",
  csv: "library.format.csv",
  markdown: "library.format.markdown",
  text: "library.format.text",
  web: "library.format.web",
  transcript: "library.format.transcript",
};

/**
 * A file the User keeps on this computer: every Document but a web page (its
 * snapshot) and a Transcript (kept in the Library, #763). Its path is the
 * User's to see, open and show.
 */
export const userFile = (document: Pick<Document, "kind" | "web">): boolean =>
  document.web === null && document.kind !== "transcript";

/** "Show in Finder" on macOS, "Show in folder" on Windows and Linux: what every action that shows a file says. */
export const showFileLabelKey = (platform: string): MessageKey =>
  /Mac|iPhone|iPad/.test(platform) ? "file.showInFinder" : "file.showInFolder";

/** The default Output location as the system names Documents: 文稿 on macOS, 文档 on Windows and Linux, in Chinese. */
export const defaultFolderLabelKey = (platform: string): MessageKey =>
  /Mac|iPhone|iPad/.test(platform)
    ? "outputLocation.defaultName"
    : "outputLocation.defaultName.other";

/** "Get info" is "Properties" on Windows and Linux, in Chinese. */
export const infoLabelKey = (platform: string): MessageKey =>
  /Mac|iPhone|iPad/.test(platform) ? "info.get" : "info.get.other";

/**
 * A file's own date as its metadata gave it, at the precision it gave ("2019",
 * "2019-03", "2019-03-04", or with a time and an offset), shown as the date it
 * names there, not the day it falls on in another time zone.
 */
export function fileDate(value: string, language: Language): string {
  const precision = /^\d{4}$/.test(value) ? "year" : /^\d{4}-\d{2}$/.test(value) ? "month" : "day";
  const day =
    precision === "year"
      ? `${value}-01-01`
      : precision === "month"
        ? `${value}-01`
        : value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  const format =
    precision === "year" ? formatYear : precision === "month" ? formatMonth : formatDate;
  return format(date, language, { timeZone: "UTC" });
}

/** When something was added, as the day it was on this computer. */
export const addedDate = (iso: string, language: Language): string => formatDate(iso, language);

/** A deck's slides or a workbook's sheets, which the Document itself doesn't hold (only a PDF's pages). */
export interface UnitCount {
  key: "info.slides" | "info.sheets";
  count: number;
}

/**
 * What a Document is, in one line: "PDF · 38 pages · 2.4 MB", with slides for a
 * deck and sheets for a workbook, and no count for a kind that has none.
 */
export function documentSummary(
  document: Pick<Document, "kind" | "pageCount" | "size">,
  units: UnitCount | null,
  t: (key: MessageKey, params?: MessageParams) => string,
  language: Language,
): string {
  const counted = (key: "info.pages" | UnitCount["key"], count: number) =>
    t(`${key}.${count === 1 ? "one" : "other"}`, { count: formatCount(count, language) });
  return [
    t(KIND_LABELS[document.kind]),
    document.pageCount !== null
      ? counted("info.pages", document.pageCount)
      : units && counted(units.key, units.count),
    formatBytes(document.size, t),
  ]
    .filter(Boolean)
    .join(" · ");
}
