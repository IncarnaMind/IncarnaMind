/**
 * A Document's file properties as the User sees them (#2458): the dates its info panel shows, and
 * how a check's row names the property that decided a sentence. Shared by the core, which writes
 * the line a check gives when only this computer's date is known, and the renderer.
 */
import type { CitationLocation, Document } from "../core/api";
import type { Language } from "../core/language";
import { formatBytes } from "./bytes";
import { formatDate, formatMonth, formatYear } from "./dates";
import type { Translate } from "./locations";

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

/** A date of `dates` as the panel shows it: the file's own as written, this computer's on its clock. */
export const shownFileDate = (value: string, from: FileDates["from"], language: Language) =>
  from === "file" ? fileDate(value, language) : formatDate(value, language);

type Properties = Extract<CitationLocation, { kind: "properties" }>;

/** A property as a check's row names it: "Modified 2 Nov 2026 (the file’s own date)", "12 slides". */
export function propertyWords(location: Properties, t: Translate, language: Language): string {
  const { value } = location;
  const count = (key: "info.pages" | "info.slides" | "info.sheets") => {
    const number = Number(value);
    return t(`${key}.${number === 1 ? "one" : "other"}`, {
      count: new Intl.NumberFormat(language).format(number),
    });
  };
  switch (location.property) {
    case "created":
      return t("claim.properties.created", { date: fileDate(value, language) });
    case "modified":
      return t("claim.properties.modified", { date: fileDate(value, language) });
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
): string =>
  t("claim.properties.row", { document, property: propertyWords(location, t, language) });
