/**
 * Reference records (#286), the parts the core and the renderer share:
 * names written as text and read back, dates, DOIs and arXiv ids, and what a
 * record still needs before it can be cited. Pure.
 */
import type {
  ReferenceField,
  ReferenceFields,
  ReferenceName,
  ReferenceRecord,
  ReferenceType,
  StyledRun,
} from "../core/api";
import type { Language } from "../core/language";
import { CJK } from "./text";

/** The fields in the order the "Cite as" panel shows them. */
export const referenceFieldOrder: readonly ReferenceField[] = [
  "type",
  "title",
  "authors",
  "issued",
  "containerTitle",
  "volume",
  "issue",
  "pages",
  "publisher",
  "doi",
  "url",
  "language",
];

/** A record with nothing in it: Other, every field empty. */
export function emptyReferenceFields(): ReferenceFields {
  return {
    type: "document",
    title: "",
    authors: [],
    issued: "",
    containerTitle: "",
    volume: "",
    issue: "",
    pages: "",
    publisher: "",
    doi: "",
    url: "",
    language: "",
  };
}

/** Whether a field's value is empty. Type always has one; "Other" counts as none. */
export function isEmptyValue(
  field: ReferenceField,
  value: ReferenceFields[ReferenceField],
): boolean {
  if (field === "type") return value === "document";
  return Array.isArray(value) ? value.length === 0 : value === "";
}

const hasCjk = new RegExp(`[${CJK}]`, "u");

/** Whether a name is written in Chinese, Japanese or Korean: kept whole, family name first. */
export const isCjkName = (text: string) => hasCjk.test(text);

/**
 * Words that make a name an organisation's, kept whole rather than split
 * into given and family names ("World Health Organization").
 */
const ORGANISATION =
  /\b(?:organi[sz]ation|university|universit[äé]|institute|institut|association|society|council|committee|commission|agency|group|ministry|department|bank|foundation|office|centre|center|bureau|board|consortium|inc|ltd|llc|gmbh|corporation|company|government|federation|union|network|team|project|programme|program|authority|service|trust|laboratory|lab)\b/i;

/** Particles that belong to the family name: "Ludwig van Beethoven". */
const PARTICLES = new Set([
  "van",
  "von",
  "de",
  "der",
  "den",
  "da",
  "das",
  "del",
  "della",
  "di",
  "du",
  "la",
  "le",
  "ter",
  "ten",
  "bin",
  "al",
]);

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * One name, read from how it is written: "Family, Given" splits at the
 * comma; a Chinese, Japanese or Korean name, an organisation, or a single
 * word is kept whole, as written; "Given Family" splits before the family
 * name (and the particles before it). Null for nothing.
 */
export function parseName(text: string): ReferenceName | null {
  const name = tidy(text);
  if (name === "") return null;
  if (hasCjk.test(name)) return { literal: name.replace(/\s+/g, "") };
  const comma = name.indexOf(",");
  if (comma > 0) {
    const family = tidy(name.slice(0, comma));
    const given = tidy(name.slice(comma + 1));
    return given === "" ? { literal: family } : { family, given };
  }
  if (ORGANISATION.test(name)) return { literal: name };
  const words = name.split(" ");
  if (words.length < 2 || words.length > 5) return { literal: name };
  let start = words.length - 1;
  while (start > 1 && PARTICLES.has((words[start - 1] as string).toLowerCase())) start--;
  return { family: words.slice(start).join(" "), given: words.slice(0, start).join(" ") };
}

/**
 * Names as the User types them in the "Cite as" panel: one after another,
 * split by semicolons (";" or "；"), the Chinese enumeration comma "、" or
 * new lines, each written "Family, Given" or as a whole.
 */
export function parseTypedNames(text: string): ReferenceName[] {
  return text
    .split(/[;；、\n]/)
    .map(parseName)
    .filter((name): name is ReferenceName => name !== null);
}

/**
 * Names as a file's author property writes them, where writers differ:
 * "Diana E. Bowler; Lisette Buyung-Ali", "Bowler, D. E.", "Diana Bowler,
 * Teri Knight and Andrew Pullin", "张三，李四" or "张三 李四".
 */
export function parseWrittenNames(text: string): ReferenceName[] {
  const written = tidy(text);
  if (written === "") return [];
  // Chinese, Japanese and Korean names have no commas or spaces in them.
  if (hasCjk.test(written)) return splitInto(written, /[,，、;；/\s]+/);
  if (/[;；]/.test(written)) return splitInto(written, /[;；]/);
  if (/\s(?:and|&)\s/i.test(written))
    return splitInto(written, /\s*,\s*(?:and\s+|&\s+)?|\s+(?:and|&)\s+/i);
  const parts = written.split(",").map(tidy);
  // "Bowler, Diana" is one name; "Diana Bowler, Teri Knight" is two.
  if (parts.length === 2 && !(parts[0] as string).includes(" ")) {
    const one = parseName(written);
    return one ? [one] : [];
  }
  if (parts.every((part) => part.includes(" "))) return splitInto(written, /,/);
  const one = parseName(written);
  return one ? [one] : [];
}

const splitInto = (text: string, separator: RegExp) =>
  text
    .split(separator)
    .map(parseName)
    .filter((name): name is ReferenceName => name !== null);

/**
 * A name as the panel shows it, and as `parseTypedNames` reads it back:
 * "Bowler, Diana E.", or a whole name as written. A Chinese name given in
 * parts reads family name first, with no space: "张三".
 */
export function formatName(name: ReferenceName): string {
  if ("literal" in name) return name.literal;
  if (name.given === "") return name.family;
  if (hasCjk.test(name.family) || hasCjk.test(name.given)) return `${name.family}${name.given}`;
  return `${name.family}, ${name.given}`;
}

/** Names as the panel shows them, one after another. */
export function formatNames(names: readonly ReferenceName[], language: Language): string {
  return names.map(formatName).join(language === "zh-CN" ? "；" : "; ");
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * When a work was published, as the record keeps it: "2010", "2010-08" or
 * "2010-08-04", read from what a file or the User writes ("2010", "2010-8-4",
 * "2010/08/04", "2010.08", "2010年8月4日", or an ISO 8601 date and time).
 * Null if it isn't one, or the date can't be.
 */
export function parseIssued(text: string): string | null {
  const match =
    /^(\d{4})(?:\s*年)?(?:\s*[-/.]?\s*(\d{1,2})\s*月?(?:\s*[-/.]?\s*(\d{1,2})\s*日?)?)?(?:[T\s].*)?$/.exec(
      tidy(text),
    );
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1000) return null;
  if (match[2] === undefined) return String(year);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (match[3] === undefined) return `${year}-${pad(month)}`;
  const day = Number(match[3]);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > days) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** A DOI: "10.", a registrant code, "/", and a suffix. */
const DOI = /^10\.\d{4,9}\/\S+$/;

/**
 * A DOI as the record keeps it, from how it is written: without
 * "https://doi.org/", "doi:" or the punctuation a sentence puts after it.
 * Null if it isn't one.
 */
export function normalizeDoi(text: string): string | null {
  let doi = tidy(text)
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi\s*[:：]?\s*/i, "");
  for (;;) {
    const trimmed = doi.replace(/[.,;:\]}>'"”’。，；]+$/u, "");
    // A closing parenthesis is the sentence's unless the DOI opened one: "10.1016/S0140-6736(20)30183-5".
    const unbalanced =
      trimmed.endsWith(")") &&
      (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0);
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (next === doi) break;
    doi = next;
  }
  return DOI.test(doi) ? doi : null;
}

/** An arXiv id: "1706.03762" (from 2007) or "hep-th/9901001" (before). */
export const ARXIV_ID = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/;

/** A preprint's address on arXiv, which the record keeps as its URL. */
export const arxivUrl = (id: string) => `https://arxiv.org/abs/${id}`;

/** The arXiv id in an arxiv.org address, without its version, or null. */
export function arxivIdOf(url: string): string | null {
  const match = new RegExp(
    `^https?://(?:www\\.|export\\.)?arxiv\\.org/(?:abs|pdf)/${ARXIV_ID.source}`,
  ).exec(url.trim());
  return match?.[1] ?? null;
}

/** arXiv's own DOIs, which DataCite registers, not Crossref: "10.48550/arXiv.1706.03762". */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

/**
 * What Look up can fetch the record by: its DOI, from Crossref, or its arXiv
 * id (from an arXiv address, or arXiv's own DOI), from arXiv. Null if neither.
 */
export function lookupIdentifier(
  fields: Pick<ReferenceFields, "doi" | "url">,
): { kind: "doi" | "arxiv"; id: string } | null {
  const arxivDoi = ARXIV_DOI.exec(fields.doi);
  if (arxivDoi?.[1]) return { kind: "arxiv", id: arxivDoi[1] };
  if (fields.doi !== "") return { kind: "doi", id: fields.doi };
  const arxiv = arxivIdOf(fields.url);
  return arxiv ? { kind: "arxiv", id: arxiv } : null;
}

/**
 * The kinds that are a paper or a book: an article, a conference paper, a preprint, a chapter,
 * a book or a thesis.
 */
const PAPER_OR_BOOK: ReadonlySet<ReferenceType> = new Set([
  "article-journal",
  "paper-conference",
  "article",
  "chapter",
  "book",
  "thesis",
]);

/**
 * Whether a Mind citing this record cites a paper or a book (#289, #1910): one of the kinds
 * above, with its authors or its year. A report, a web page or Other never is, whatever else
 * its record says; the kind is the Library's, never a guess from the file's look.
 */
export function isPaperOrBook(record: Pick<ReferenceRecord, "fields"> | null): boolean {
  if (!record) return false;
  const { type, authors, issued } = record.fields;
  return PAPER_OR_BOOK.has(type) && (authors.length > 0 || issued !== "");
}

/** What reading a file guesses at, as a style prints it; not a DOI or an address, found as written. */
const GUESSED: readonly ReferenceField[] = [
  "type",
  "title",
  "authors",
  "issued",
  "containerTitle",
  "volume",
  "issue",
  "pages",
  "publisher",
];

/**
 * What was read from the file and is waiting for the User to check it: each field a style
 * prints that reading gave ("file") a value. A field the User edited, or Look up or an import
 * filled, isn't one.
 */
export function fieldsToCheck(
  record: Pick<ReferenceRecord, "fields" | "sources">,
): ReferenceField[] {
  return GUESSED.filter(
    (field) => record.sources[field] === "file" && !isEmptyValue(field, record.fields[field]),
  );
}

/**
 * Whether a record shows "Needs checking" (需要核对) on its Library row: a work of a known type
 * with something read from its file not yet checked. A record of type Other (a contract, a deck)
 * keeps the check to its "Cite as" panel.
 */
export const needsCheck = (record: Pick<ReferenceRecord, "fields" | "sources">): boolean =>
  record.fields.type !== "document" && fieldsToCheck(record).length > 0;

/**
 * What a record still needs before it can be cited: its title, authors and
 * date, of a work of a known type (a web page needs only its title: its
 * site stands in for authors, and it may have no date). Empty for a record
 * of type Other, which nothing has said is a work to cite: a contract or an
 * invoice isn't flagged.
 */
export function missingDetails(record: Pick<ReferenceRecord, "fields">): ReferenceField[] {
  const { fields } = record;
  if (fields.type === "document") return [];
  const missing: ReferenceField[] = [];
  if (fields.title === "") missing.push("title");
  if (fields.type !== "webpage") {
    if (fields.authors.length === 0) missing.push("authors");
    if (fields.issued === "") missing.push("issued");
  }
  return missing;
}

/** Full-width punctuation, which carries its own space. */
const FULL_WIDTH = /[\u3000-\u303f\uff00-\uffef]/u;

/**
 * A Bibliography entry too thin to cite, as the References' Copy writes it: with `mark` after
 * it ("[needs details]", "[信息待补充]"). An export leaves the mark out (#1910).
 */
export function withNeedsDetailsMark(runs: readonly StyledRun[], mark: string): StyledRun[] {
  const last = runs.at(-1)?.text ?? "";
  const space = FULL_WIDTH.test(last.slice(-1)) || FULL_WIDTH.test(mark[0] ?? "") ? "" : " ";
  return [...runs, { text: `${space}${mark}` }];
}
