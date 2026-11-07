/**
 * What the engine is given (ADR-0016): each cited Document's reference record (#286) as a CSL
 * JSON item, and each Citation's Location as a CSL locator.
 */
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { formatLocation } from "../../shared/locations";
import { CJK } from "../../shared/text";
import type { CitationLocation, ReferenceFields, ReferenceName } from "../api";
import type { Language } from "../language";

/** A reference as CSL JSON. The fields IncarnaMind writes are typed; an imported item may carry more. */
export interface CslItem {
  id: string;
  type: string;
  language?: string;
  title?: string;
  [field: string]: unknown;
}

const hasCjk = new RegExp(`[${CJK}]`, "u");

const name = (each: ReferenceName) =>
  "literal" in each ? { literal: each.literal } : { family: each.family, given: each.given };

/** "2010-08-04" as CSL's date parts. */
function dateParts(issued: string): { "date-parts": number[][] } | undefined {
  const parts = issued.split("-").map(Number);
  return parts.length > 0 && parts.every((part) => Number.isInteger(part) && part > 0)
    ? { "date-parts": [parts] }
    : undefined;
}

/** A Document's reference record as a CSL JSON item. Empty fields are left out. */
export function cslItemOf(id: string, fields: ReferenceFields): CslItem {
  const item: CslItem = { id, type: fields.type };
  if (fields.title) item.title = fields.title;
  if (fields.authors.length > 0) item.author = fields.authors.map(name);
  const issued = fields.issued ? dateParts(fields.issued) : undefined;
  if (issued) item.issued = issued;
  if (fields.containerTitle) item["container-title"] = fields.containerTitle;
  if (fields.volume) item.volume = fields.volume;
  if (fields.issue) item.issue = fields.issue;
  // CSL reads a range written with a hyphen, and each style draws its own dash.
  if (fields.pages) item.page = fields.pages.replace(/\s*[–—]\s*/g, "-");
  if (fields.publisher) item.publisher = fields.publisher;
  if (fields.doi) item.DOI = fields.doi;
  if (fields.url) item.URL = fields.url;
  if (fields.language) item.language = fields.language;
  return item;
}

/**
 * A work known only by its Document's name: the Document has no reference record yet, or was
 * deleted after it was cited. The style prints what it can, a title and "n.d.".
 */
export const nameOnlyItem = (id: string, documentName: string): CslItem => ({
  id,
  type: "document",
  title: documentName,
});

/** Whether a reference is Chinese: by its language, or, with none, by its title. */
export function isChineseItem(item: Pick<CslItem, "language" | "title">): boolean {
  if (typeof item.language === "string" && item.language !== "") {
    return /^zh\b/i.test(item.language);
  }
  return typeof item.title === "string" && hasCjk.test(item.title);
}

/** Where a Citation points, as a CSL locator. */
export interface Locator {
  locator?: string;
  label?: string;
}

const span = (from: number, to: number) => (to > from ? `${from}-${to}` : String(from));

const RANGE_MARK = /[-–—]/;

/**
 * A Citation's Location as a locator: pages and lines as CSL's own ("p. 4", "pp. 4–5"); a slide,
 * rows of a sheet or a section as the Location's own words in the style's language ("slide 4",
 * "§ History"), which the style prints with no label rather than as an invented page. So is a page
 * a PDF names with letters or a hyphen ("A-3", "iii–iv"): CSL reads a hyphen in a locator as a
 * range, and only of numbers. Such a range still reads "pp." like a range of numbers, though the
 * app's own labels say "p." for any range.
 * `raised`: written after the work with no label (`FormatJob.raisedLocators`), where a bare
 * number reads as a page, so lines are words too ("第 3–4 行").
 */
export function locatorOf(
  location: CitationLocation | null,
  language: Language,
  raised = false,
): Locator {
  if (!location) return {};
  if (location.kind === "lines" && !raised) {
    return { locator: span(location.from, location.to), label: "line" };
  }
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  if (location.kind === "page") {
    const from = location.printed?.from ?? String(location.from);
    const to = location.printed?.to ?? String(location.to);
    const single = from === to;
    const plain = single ? !RANGE_MARK.test(from) : /^\d+$/.test(from) && /^\d+$/.test(to);
    if (plain) return { locator: single ? from : `${from}-${to}`, label: "page" };
    return {
      locator: single
        ? t("location.page", { range: from })
        : t("location.pages", { range: `${from}–${to}` }),
      label: "custom",
    };
  }
  return { locator: formatLocation(location, t, { speaker: false }), label: "custom" };
}

/**
 * A custom locator as the engine wrote it into a run's text: the engine turns a hyphen between
 * digits into an en dash, so a page the PDF names "1-3" or a section headed "2023-24" would read
 * as a range. Put the label's own hyphen back.
 */
export function restoreHyphens(text: string, locator: string): string {
  const written = locator.replace(/(\d)-(?=\d)/g, "$1–");
  return written === locator ? text : text.replace(written, locator);
}
