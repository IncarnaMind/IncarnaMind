import type { Document } from "../../core/api";
import type { Language } from "../../core/language";
import { formatBytes } from "../../shared/bytes";
import { formatDate } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { formatCount } from "./linkedFolders";

/** What a Document's kind is called, in the words of the Library's filters. */
export const KIND_LABELS: Record<Document["kind"], MessageKey> = {
  pdf: "library.format.pdf",
  docx: "library.format.docx",
  pptx: "library.format.pptx",
  xlsx: "library.format.xlsx",
  csv: "library.format.csv",
  image: "library.format.image",
  rtf: "library.format.rtf",
  html: "library.format.html",
  markdown: "library.format.markdown",
  text: "library.format.text",
  web: "library.format.web",
  transcript: "library.format.transcript",
};

/**
 * A file the User keeps on this computer: every Document but one whose file
 * IncarnaMind keeps in the Library (a saved web page's snapshot, a Meeting's
 * Transcript, #763). Its path is the User's to see, open and show; a .vtt the
 * User added is theirs, so it counts.
 */
export const userFile = (document: Pick<Document, "keptByApp">): boolean => !document.keptByApp;

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
    // A picture's one page is itself: its size says more.
    document.pageCount !== null && document.kind !== "image"
      ? counted("info.pages", document.pageCount)
      : units && counted(units.key, units.count),
    formatBytes(document.size, t),
  ]
    .filter(Boolean)
    .join(" · ");
}
