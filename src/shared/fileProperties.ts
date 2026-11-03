/**
 * A Document's file properties as the User sees them (#2458): the dates its info panel shows, and
 * how a check's row names the property that decided a sentence. Shared by the core, which writes
 * the line a check gives when only this computer's date is known, and the renderer.
 */
import type { CitationLocation, Document } from "../core/api";
import type { Language } from "../core/language";
import { formatBytes } from "./bytes";
import { type DateOptions, formatDate, formatMonth, formatTime, formatYear } from "./dates";
import type { Translate } from "./locations";

/** The zone a date is shown in: this computer's unless a test names one. */
type Zone = Pick<DateOptions, "timeZone">;

/** A time written in UTC, as Office writes every date it keeps ("2026-11-02T23:30:00Z"). */
const IN_UTC = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]00:00)$/;

/**
 * A file's own date as the User's own apps show it: a time written in UTC on this computer's
 * clock, as Word's File › Info and Finder show it; a time written with another offset as the day it
 * names there; a day, month or year alone at the precision given.
 */
export function fileDate(value: string, language: Language, zone: Zone = {}): string {
  if (IN_UTC.test(value)) return formatDate(value, language, zone);
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

/**
 * The dates a Document's info panel shows and a check may name: the file's own, when it records
 * any; else this computer's, which copying or downloading a file changes. Never both.
 */
export interface FileDates {
  created: string | null;
  modified: string | null;
  from: "file" | "computer";
}

type Dated = Pick<
  Document,
  "properties" | "creationDate" | "modifiedAt" | "fileCreatedAt" | "keptByApp"
>;

/** Null when nothing gives a date. A year alone is one the Document's text wrote, never the file's. */
export function fileDates(document: Dated): FileDates | null {
  const { properties } = document;
  // A web page's or a Transcript's file is IncarnaMind's own: its date is the one the page states.
  if (document.keptByApp || properties === null) {
    const stated =
      document.creationDate !== null && (document.keptByApp || document.creationDate.length > 4);
    return stated ? { created: document.creationDate, modified: null, from: "file" } : null;
  }
  if (properties.created !== null || properties.modified !== null) {
    return { created: properties.created, modified: properties.modified, from: "file" };
  }
  if (document.fileCreatedAt === null && document.modifiedAt === null) return null;
  return { created: document.fileCreatedAt, modified: document.modifiedAt, from: "computer" };
}

/** A date of `dates` as the panel shows it: the file's own as its apps show it, this computer's on its clock. */
export const shownFileDate = (
  value: string,
  from: FileDates["from"],
  language: Language,
  zone: Zone = {},
) => (from === "file" ? fileDate(value, language, zone) : formatDate(value, language, zone));

/**
 * A time written in UTC as a check's model is told it beside the value: its day and time on this
 * computer's clock, the day the User's own apps show. Null for a date written any other way.
 */
export function onThisClock(value: string, zone: Zone = {}): string | null {
  if (!IN_UTC.test(value)) return null;
  return `${formatDate(value, "en", zone)} ${formatTime(value, "en", { ...zone, twelveHour: false })}`;
}

type Properties = Extract<CitationLocation, { kind: "properties" }>;

/** A property as a check's row names it: "Modified 2 Nov 2026 (the file’s own date)", "12 slides". */
export function propertyWords(
  location: Properties,
  t: Translate,
  language: Language,
  zone: Zone = {},
): string {
  const { value } = location;
  const count = (key: "info.pages" | "info.slides" | "info.sheets") => {
    const number = Number(value);
    return t(`${key}.${number === 1 ? "one" : "other"}`, {
      count: new Intl.NumberFormat(language).format(number),
    });
  };
  switch (location.property) {
    case "created":
      return t("claim.properties.created", { date: fileDate(value, language, zone) });
    case "modified":
      return t("claim.properties.modified", { date: fileDate(value, language, zone) });
    case "author":
      return t("claim.properties.author", { author: value });
    case "pages":
      return count("info.pages");
    case "slides":
      return count("info.slides");
    case "sheets":
      return count("info.sheets");
    case "size":
      return t("claim.properties.size", { size: formatBytes(Number(value), t) });
    case "name":
      return t("claim.properties.name", { name: value });
  }
}

/** A check's row for a property: "Properties of “Services agreement.docx”: Modified 2 Nov 2026 (the file’s own date)". */
export const propertyRow = (
  location: Properties,
  document: string,
  t: Translate,
  language: Language,
  zone: Zone = {},
): string =>
  t("claim.properties.row", { document, property: propertyWords(location, t, language, zone) });
