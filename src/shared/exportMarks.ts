/**
 * The page numbers and watermark a Note's Word file and PDF carry (#1258). Like its font and
 * citation style they live in the Note's Yjs settings (`MIND_SETTINGS_FIELD`), not in its
 * Blocks, so they go wherever the Note goes; a Note that never chose any has page numbers and
 * no watermark.
 */
import type * as Y from "yjs";
import type { Language } from "../core/language";
import { translate } from "./i18n";
import { isRecord } from "./record";

export const WATERMARK_CHOICES = ["none", "draft", "confidential", "words"] as const;

export type WatermarkChoice = (typeof WATERMARK_CHOICES)[number];

export interface ExportMarks {
  /** A number at the foot of every page. */
  pageNumbers: boolean;
  watermark: WatermarkChoice;
  /** The User's own watermark words, used when `watermark` is "words". */
  words?: string;
}

/** The most a watermark says: one short line across a page. */
export const MAX_WATERMARK_WORDS = 40;

export const DEFAULT_EXPORT_MARKS: ExportMarks = { pageNumbers: true, watermark: "none" };

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

export function isExportMarks(value: unknown): value is ExportMarks {
  if (!isRecord(value)) return false;
  const { pageNumbers, watermark, words } = value;
  if (typeof pageNumbers !== "boolean") return false;
  if (!WATERMARK_CHOICES.some((choice) => choice === watermark)) return false;
  if (words !== undefined && !isWatermarkWords(words)) return false;
  if (watermark === "words" && !isWatermarkWords(words)) return false;
  const known = new Set(["pageNumbers", "watermark", "words"]);
  return Object.keys(value).every((key) => known.has(key));
}

/** The marks a Note carries; anything malformed counts as none of its own. */
export function exportMarksOf(settings: Y.Map<unknown>): ExportMarks {
  const saved = settings.get(MARKS_KEY);
  return isExportMarks(saved) ? saved : DEFAULT_EXPORT_MARKS;
}

const isDefault = (marks: ExportMarks): boolean =>
  marks.pageNumbers === DEFAULT_EXPORT_MARKS.pageNumbers &&
  marks.watermark === DEFAULT_EXPORT_MARKS.watermark;

/** Sets the Note's marks; the default is forgotten, so another Note's default applies again. */
export function writeExportMarks(settings: Y.Map<unknown>, marks: ExportMarks): void {
  const saved: ExportMarks = {
    pageNumbers: marks.pageNumbers,
    watermark: marks.watermark,
    ...(marks.words !== undefined && { words: marks.words }),
  };
  if (isDefault(marks)) {
    if (settings.has(MARKS_KEY)) settings.delete(MARKS_KEY);
  } else if (JSON.stringify(settings.get(MARKS_KEY)) !== JSON.stringify(saved)) {
    settings.set(MARKS_KEY, saved);
  }
}

/** The marks as they are saved: the User's word without its spaces, and no word kept for a preset. */
export function settledMarks(marks: ExportMarks): ExportMarks {
  return marks.watermark === "words"
    ? { pageNumbers: marks.pageNumbers, watermark: "words", words: (marks.words ?? "").trim() }
    : { pageNumbers: marks.pageNumbers, watermark: marks.watermark };
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
