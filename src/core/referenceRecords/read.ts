/**
 * Reading a Document's reference record from its file (#286), offline: a
 * PDF's Info dictionary and XMP metadata, an Office file's core properties,
 * a DOI or arXiv id printed on its first pages, and what a PDF's first page
 * prints where its metadata says nothing (./firstPage). Pure: the processing
 * worker reads the file and hands the parts over (see `readMetadataOf` in
 * ../documents/processing). What isn't found is left out, never guessed: a
 * field the file doesn't give stays empty for the User or Look up to fill.
 */
import { looksMachineMade } from "../../shared/documentNames";
import {
  ARXIV_ID,
  arxivUrl,
  normalizeDoi,
  parseIssued,
  parseName,
  parseWrittenNames,
} from "../../shared/references";
import type { DocumentKind, ReferenceFields, ReferenceName } from "../api";
import type { PageLine } from "../documents/extract";
import { elements, parseXml, textOf, type XmlElement } from "../documents/formats/xml";
import { detectLanguage, type TextLanguage } from "../documents/textLanguage";
import { readFirstPage, withoutAffiliationMarks } from "./firstPage";

/** What a file's reading gives: only the fields it found, and always a type. */
export type FileReference = Partial<ReferenceFields> & Pick<ReferenceFields, "type">;

/** The parts of a file the reference is read from. */
export interface FileMetadata {
  kind: DocumentKind;
  /** A PDF's Info dictionary entries, as pdf.js decodes them. */
  info?: { title: string | null; author: string | null };
  /** A PDF's XMP metadata packet, as written. */
  xmp?: string | null;
  /** An Office file's core properties. */
  office?: { title: string | null; creator: string | null; language: string | null };
  /**
   * The text of its first pages (a PDF's first two, else its first Unit), as
   * extracted: before running headers and footers are taken out, as a DOI
   * often sits in them.
   */
  firstPages: readonly string[];
  /** A PDF's first page's lines, with their sizes. */
  firstPageLines?: readonly PageLine[];
}

/** A web page's own description of itself, as saved with it (#261). */
export interface WebPageFacts {
  address: string;
  siteName: string;
  author: string | null;
  /** When the page says it was published, as it gives it. */
  published: string | null;
}

/** Author names software writes when it knows no better, never a work's author. */
const PLACEHOLDER_AUTHOR =
  /^(?:admin(?:istrator)?|user|owner|author|unknown|anonymous|guest|default|root|test|microsoft (?:office |word )?user|windows user|office user|作者|用户|管理员|微软用户|lenovo|dell|hp|asus|acer|thinkpad)$/i;

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/** A name the file gives that a person or an organisation could have. */
const realName = (name: ReferenceName) => {
  const text = "literal" in name ? name.literal : `${name.given} ${name.family}`;
  return !PLACEHOLDER_AUTHOR.test(tidy(text)) && !text.includes("@") && !looksMachineMade(text);
};

/**
 * A title a file's properties give, unless it is software's: a file name
 * ("Microsoft Word - draft3.docx", "paper.pdf"), "Untitled", a code.
 */
function titleOf(property: string | null | undefined): string | null {
  if (!property) return null;
  const title = tidy(property);
  if (title.length < 2 || looksMachineMade(title)) return null;
  if (/^microsoft (?:word|powerpoint|excel) - /i.test(title)) return null;
  if (/\.(?:docx?|pdf|pptx?|xlsx?|tex|dvi|ps|rtf|odt|txt|md|indd|qxd)$/i.test(title)) return null;
  return title;
}

/** The languages `detectLanguage` names, as BCP 47 tags. */
const LANGUAGE_TAGS: Readonly<Record<TextLanguage, string>> = {
  English: "en",
  Chinese: "zh",
  Japanese: "ja",
  Korean: "ko",
  French: "fr",
  German: "de",
  Spanish: "es",
  Italian: "it",
  Portuguese: "pt",
  Dutch: "nl",
};

/** A language tag as a file writes it ("en-US", "zh_CN"), checked; null if it isn't one. */
function languageTag(value: string | null | undefined): string | null {
  const tag = value?.trim().replace(/_/g, "-");
  return tag && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag) && tag.toLowerCase() !== "x-none"
    ? tag
    : null;
}

/** "DOI", "doi:", "doi.org/": a label that says the DOI next to it is the work's own. */
const LABELLED_DOI = /(?:\bdoi\b\s*[:：]?\s*|doi\.org\/)(10\.\d{4,9}\/[^\s"<>]+)/gi;
const ANY_DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/g;
const ARXIV = new RegExp(`\\barXiv\\s*:\\s*${ARXIV_ID.source}`, "i");

/**
 * The work's DOI as its first pages print it: on the first page, the first
 * one labelled as a DOI, else the first one; on the second, only a labelled
 * one (an unlabelled DOI there is more likely a reference's).
 */
function doiPrinted(pages: readonly string[]): string | null {
  const [first = "", second = ""] = pages;
  const pick = (text: string, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const doi = normalizeDoi(match[1] as string);
      if (doi) return doi;
    }
    return null;
  };
  return pick(first, LABELLED_DOI) ?? pick(first, ANY_DOI) ?? pick(second, LABELLED_DOI);
}

/** XMP's properties, by their qualified names, from every rdf:Description, as elements or attributes. */
export function xmpProperties(raw: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let root: XmlElement;
  try {
    root = parseXml(raw.replace(/^[^<]*/, ""));
  } catch {
    return found; // Malformed metadata is no metadata.
  }
  const add = (name: string, values: string[]) => {
    const kept = values.map(tidy).filter((value) => value !== "");
    if (kept.length > 0 && !found.has(name)) found.set(name, kept);
  };
  const visit = (element: XmlElement) => {
    if (element.name === "rdf:Description") {
      for (const [name, value] of Object.entries(element.attrs)) {
        if (!name.startsWith("rdf:") && !name.startsWith("xmlns")) add(name, [value]);
      }
      for (const property of elements(element)) {
        // A list (rdf:Seq, rdf:Bag, rdf:Alt) holds one value per rdf:li.
        const list = elements(property).find((child) => /^rdf:(?:Seq|Bag|Alt)$/.test(child.name));
        if (list) {
          const items = elements(list).filter((item) => item.name === "rdf:li");
          // In an rdf:Alt, the default language first.
          const ordered =
            list.name === "rdf:Alt"
              ? [...items].sort(
                  (a, b) =>
                    Number(b.attrs["xml:lang"] === "x-default") -
                    Number(a.attrs["xml:lang"] === "x-default"),
                )
              : items;
          add(property.name, ordered.map(textOf));
        } else if (elements(property).length === 0) {
          add(property.name, [textOf(property)]);
        }
      }
    }
    for (const child of elements(element)) visit(child);
  };
  visit(root);
  return found;
}

const first = (properties: Map<string, string[]>, ...names: string[]) => {
  for (const name of names) {
    const value = properties.get(name)?.[0];
    if (value) return value;
  }
  return null;
};

/**
 * A Document's reference record as its file gives it. A thesis says so on its
 * first page; a DOI, a journal's name in the XMP or a Chinese journal's article
 * marks make it a journal article; an arXiv id, a preprint; a report's first
 * page says so too; else it is Other, which nothing flags as needing details.
 */
export function readReference(meta: FileMetadata): FileReference {
  const read: Partial<ReferenceFields> = {};
  const xmp = meta.xmp ? xmpProperties(meta.xmp) : new Map<string, string[]>();
  const page = meta.firstPageLines ? readFirstPage(meta.firstPageLines) : {};

  const title =
    titleOf(first(xmp, "dc:title")) ??
    titleOf(meta.info?.title) ??
    titleOf(meta.office?.title) ??
    titleOf(page.title);
  if (title) read.title = title;

  const creators = xmp.get("dc:creator");
  const written = meta.info?.author ?? meta.office?.creator ?? null;
  // XMP lists one author per item; the Info dictionary and Office write them in one string.
  const authors = (
    creators
      ? creators.map(parseName).filter((name): name is ReferenceName => name !== null)
      : written
        ? parseWrittenNames(withoutAffiliationMarks(written))
        : []
  ).filter(realName);
  const printedAuthors = (page.authors ?? []).filter(realName);
  if (authors.length > 0) read.authors = authors;
  else if (printedAuthors.length > 0) read.authors = printedAuthors;

  const arxiv = ARXIV.exec(meta.firstPages[0] ?? "")?.[1];
  const issued =
    parseIssued(
      first(xmp, "prism:coverDate", "prism:publicationDate", "prism:coverDisplayDate") ?? "",
    ) ?? (page.issued ? parseIssued(page.issued) : null);
  if (issued) read.issued = issued;

  const journal = first(xmp, "prism:publicationName");
  if (journal) read.containerTitle = journal;
  const volume = first(xmp, "prism:volume");
  if (volume) read.volume = volume;
  const issue = first(xmp, "prism:number", "prism:issueIdentifier");
  if (issue) read.issue = issue;
  const start = first(xmp, "prism:startingPage");
  const end = first(xmp, "prism:endingPage");
  const pages = start
    ? end && end !== start
      ? `${start}–${end}`
      : start
    : first(xmp, "prism:pageRange");
  if (pages) read.pages = pages;
  const identifier = first(xmp, "dc:identifier");
  const doi =
    normalizeDoi(first(xmp, "prism:doi", "prism:DOI", "pdfx:doi", "crossmark:DOI") ?? "") ??
    (identifier ? normalizeDoi(identifier) : null) ??
    doiPrinted(meta.firstPages);
  if (doi) read.doi = doi;

  // What a first page suggests never outweighs a DOI or a journal the metadata names.
  const type = doi || journal ? "article-journal" : arxiv ? "article" : (page.type ?? "document");
  // A thesis is published by the university that grants it, a report by its organisation,
  // which is also a report's author when no person is named.
  const publisher =
    first(xmp, "dc:publisher") ??
    (type === "thesis" || type === "report" ? (page.institution ?? null) : null);
  if (publisher) read.publisher = publisher;
  if (type === "report" && !read.authors && page.institution) {
    read.authors = [{ literal: page.institution }];
  }

  const url = first(xmp, "prism:url");
  if (arxiv) read.url = arxivUrl(arxiv);
  else if (url && /^https?:\/\//i.test(url)) read.url = url;

  const language =
    languageTag(first(xmp, "dc:language")) ??
    languageTag(meta.office?.language) ??
    LANGUAGE_TAGS[detectLanguage(meta.firstPages.join("\n").slice(0, 4000)) ?? ""];
  if (language) read.language = language;

  return { ...read, type };
}

/** A web page's reference record (#261): its title, author, site, date and address. */
export function webPageReference(page: WebPageFacts, title: string | null): FileReference {
  const read: FileReference = { type: "webpage", url: page.address };
  const own = titleOf(title);
  if (own) read.title = own;
  const authors = page.author ? parseWrittenNames(page.author).filter(realName) : [];
  if (authors.length > 0) read.authors = authors;
  const issued = page.published ? parseIssued(page.published) : null;
  if (issued) read.issued = issued;
  if (page.siteName.trim() !== "") read.containerTitle = tidy(page.siteName);
  return read;
}
