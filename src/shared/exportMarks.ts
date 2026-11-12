/**
 * The page numbers and watermark a Note's Word file and PDF carry (#1258). Like its font and
 * citation style they live in the Note's Yjs settings (`MIND_SETTINGS_FIELD`), not in its
 * Blocks, so they go wherever the Note goes. A choice is one choice for every format. A Note that
 * never chose any has no watermark, and page numbers, except in the Word file of a Note made from
 * one: the User's own file gains nothing they didn't ask for, and its PDF loses nothing (#1741).
 * A mark the User didn't change isn't their choice, so a choice may hold a watermark alone, and
 * each format then keeps its own page numbers.
 */
import type * as Y from "yjs";
import type { Language } from "../core/language";
import { translate } from "./i18n";
import { isRecord } from "./record";
import { wordFileOf } from "./wordFiles";

export const WATERMARK_CHOICES = ["none", "draft", "confidential", "words"] as const;

export type WatermarkChoice = (typeof WATERMARK_CHOICES)[number];

export interface ExportMarks {
  /** A number at the foot of every page. */
  pageNumbers: boolean;
  watermark: WatermarkChoice;
  /** The User's own watermark words, used when `watermark` is "words". */
  words?: string;
}

/** The marks a Note keeps as its choice: without page numbers when the User never chose them. */
export type ExportMarksChoice = Omit<ExportMarks, "pageNumbers"> & { pageNumbers?: boolean };

/** The most a watermark says: one short line across a page. */
export const MAX_WATERMARK_WORDS = 40;

export const DEFAULT_EXPORT_MARKS: ExportMarks = { pageNumbers: true, watermark: "none" };

const WORD_FILE_MARKS: ExportMarks = { pageNumbers: false, watermark: "none" };

/** The formats whose pages carry the marks: a Word file, and a PDF, printed or saved. */
export type MarkedFormat = "docx" | "pdf";

export const isMarkedFormat = (value: unknown): value is MarkedFormat =>
  value === "docx" || value === "pdf";

const MARKS_KEY = "exportMarks";

const hasControlCharacter = (text: string) =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

const isWatermarkWords = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.trim().length <= MAX_WATERMARK_WORDS &&
  !hasControlCharacter(value);

export function isExportMarksChoice(value: unknown): value is ExportMarksChoice {
  if (!isRecord(value)) return false;
  const { pageNumbers, watermark, words } = value;
  if (pageNumbers !== undefined && typeof pageNumbers !== "boolean") return false;
  if (!WATERMARK_CHOICES.some((choice) => choice === watermark)) return false;
  if (words !== undefined && !isWatermarkWords(words)) return false;
  if (watermark === "words" && !isWatermarkWords(words)) return false;
  const known = new Set(["pageNumbers", "watermark", "words"]);
  return Object.keys(value).every((key) => known.has(key));
}

const fromWordFile = (settings: Y.Map<unknown>): boolean =>
  settings.doc !== null && wordFileOf(settings.doc) !== null;

/** The Note's own choice; anything malformed counts as none. */
export function chosenExportMarks(settings: Y.Map<unknown>): ExportMarksChoice | null {
  const saved = settings.get(MARKS_KEY);
  return isExportMarksChoice(saved) ? saved : null;
}

/**
 * The marks a Note's file in `format` carries. `settings` must be the Note's own Y.Doc's, which
 * says whether it came from a Word file.
 */
export function exportMarksOf(settings: Y.Map<unknown>, format: MarkedFormat): ExportMarks {
  const byDefault =
    format === "docx" && fromWordFile(settings) ? WORD_FILE_MARKS : DEFAULT_EXPORT_MARKS;
  const chosen = chosenExportMarks(settings);
  return chosen
    ? { ...chosen, pageNumbers: chosen.pageNumbers ?? byDefault.pageNumbers }
    : byDefault;
}

/**
 * Sets the Note's marks. A choice without page numbers keeps the page numbers the Note chose
 * before, if it did. A choice that is every format's default is forgotten, so a change to the
 * defaults reaches it; a Note made from a Word file starts differently in each, so it keeps any
 * choice of page numbers.
 */
export function writeExportMarks(settings: Y.Map<unknown>, marks: ExportMarksChoice): void {
  const pageNumbers = marks.pageNumbers ?? chosenExportMarks(settings)?.pageNumbers;
  const saved: ExportMarksChoice = {
    ...(pageNumbers !== undefined && { pageNumbers }),
    watermark: marks.watermark,
    ...(marks.words !== undefined && { words: marks.words }),
  };
  const noPageNumbersChosen =
    pageNumbers === undefined ||
    (!fromWordFile(settings) && pageNumbers === DEFAULT_EXPORT_MARKS.pageNumbers);
  if (noPageNumbersChosen && marks.watermark === DEFAULT_EXPORT_MARKS.watermark) {
    if (settings.has(MARKS_KEY)) settings.delete(MARKS_KEY);
  } else if (JSON.stringify(settings.get(MARKS_KEY)) !== JSON.stringify(saved)) {
    settings.set(MARKS_KEY, saved);
  }
}

/** The marks as they are saved: the User's word without its spaces, and no word kept for a preset. */
export function settledMarks(marks: ExportMarksChoice): ExportMarksChoice {
  const pageNumbers = marks.pageNumbers !== undefined && { pageNumbers: marks.pageNumbers };
  return marks.watermark === "words"
    ? { ...pageNumbers, watermark: "words", words: (marks.words ?? "").trim() }
    : { ...pageNumbers, watermark: marks.watermark };
}

/** What a Word file or a PDF prints for the marks: the watermark's words in the export's language, or none. */
export interface PrintedMarks {
  pageNumbers: boolean;
  watermark: string | null;
}

export function printedMarks(marks: ExportMarks, language: Language): PrintedMarks {
  switch (marks.watermark) {
    case "none":
      return { pageNumbers: marks.pageNumbers, watermark: null };
    case "draft":
      return {
        pageNumbers: marks.pageNumbers,
        watermark: translate(language, "export.watermark.draftText"),
      };
    case "confidential":
      return {
        pageNumbers: marks.pageNumbers,
        watermark: translate(language, "export.watermark.confidentialText"),
      };
    case "words":
      return { pageNumbers: marks.pageNumbers, watermark: marks.words?.trim() || null };
  }
}
