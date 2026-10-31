/**
 * Citation styles (#289, ADR-0016): a Mind's Citations and Bibliography in a style, from the
 * cited Documents' reference records (#286). The editor asks for them through
 * `CoreApi.formatCitations`, and the exports format with the same function, so the two agree.
 */
import { join } from "node:path";
import type { ResolvedCitationStyle } from "../../shared/citationStyles";
import { displayName, titleWithoutSite } from "../../shared/documentNames";
import { missingDetails } from "../../shared/references";
import type {
  BibliographyEntry,
  CitationFormatRequest,
  CitedWork,
  Document,
  FormattedCitations,
  StyledRun,
} from "../api";
import { createCatalogue } from "./catalogue";
import { type CslItem, cslItemOf, locatorOf, nameOnlyItem, restoreHyphens } from "./csl";
import { CitationFormatError, type CitationStyleEngine, createWorkerEngine } from "./engine";
import type { FormatJob } from "./format";
import type { EngineStyle } from "./protocol";
import { parseRequest } from "./request";

export { CitationFormatError } from "./engine";

export interface CitationStylesOptions {
  /** resources/citation-styles: the engine and the style pack; none: Numbered only. */
  folder: string | undefined;
  /** The live Document, or undefined for one deleted since it was cited. */
  document(id: string): Document | undefined;
}

/** Answers to the last requests, which a Mind asks for again as it is edited. */
const CACHE_SIZE = 24;

/** A cited work's reference: its record, else its name, and whether that is too thin to cite. */
interface Reference {
  item: CslItem;
  documentId: string | null;
  /** The Document the Citation names, which stays after it leaves the Library. */
  workDocumentId: string | null;
  /** The Document's name, as the app shows it, or as it was when cited. */
  name: string;
  needsDetails: boolean;
  /** Its record gives nothing to cite it by, or its Document is gone: its entry is its name. */
  bare: boolean;
}

/** Whether a record gives nothing to cite by, so the style has only the name to print. */
function hasNoDetails(document: Document): boolean {
  const fields = document.reference?.fields;
  if (!fields) return true;
  return (
    fields.title === "" &&
    fields.authors.length === 0 &&
    fields.issued === "" &&
    fields.containerTitle === "" &&
    fields.publisher === "" &&
    fields.doi === "" &&
    fields.url === ""
  );
}

/**
 * Whether a record is too thin to cite well: none at all, a work missing what its type needs
 * (`missingDetails`), or one with neither authors nor a date, whatever its type.
 */
function thin(document: Document | undefined): boolean {
  const record = document?.reference;
  if (!record) return true;
  if (missingDetails(record).length > 0) return true;
  return record.fields.authors.length === 0 && record.fields.issued === "";
}

function referenceOf(work: CitedWork, document: Document | undefined): Reference {
  const name = (document && displayName(document)) || work.documentName || "";
  if (!document) {
    return {
      item: nameOnlyItem(
        work.documentId !== null ? `gone:${work.documentId}` : `name:${name}`,
        name,
      ),
      documentId: null,
      workDocumentId: work.documentId,
      name,
      needsDetails: true,
      bare: true,
    };
  }
  const fields = document.reference?.fields;
  const fetched = webVersionOf(work, document)?.fetchedAt;
  const id = fetched ? versionKey(document.id, work) : document.id;
  const item = fields ? cslItemOf(id, fields) : nameOnlyItem(id, name);
  // A work with no title is cited by its Document's name rather than by nothing.
  if (!item.title) item.title = name;
  // A web page's site is its own field, so its title doesn't name the site again.
  const site = item["container-title"];
  if (document.web && typeof site === "string") item.title = titleWithoutSite(item.title, site);
  // A web page is cited as it read on the day the quoted version was fetched (#100).
  if (fetched) item.accessed = { "date-parts": [localDay(fetched)] };
  return {
    item,
    documentId: document.id,
    workDocumentId: work.documentId,
    name,
    needsDetails: thin(document),
    bare: hasNoDetails(document),
  };
}

/**
 * The entry for a work with no details, which some styles leave blank (Chicago notes) and the
 * rest print as little more than a title: its name, ended as every shipped style ends an entry,
 * GB/T 7714's included. Nothing the app knows of the file (its format, the day it was added) is
 * a fact to cite it by, so the entry is flagged as needing details instead. The style's own
 * number, if it has one, stays.
 */
function fallbackRuns(reference: Reference): StyledRun[] {
  if (!reference.bare) return [];
  return [{ text: `${reference.name.replace(/[.。]+$/, "")}.` }];
}

/** The version of a web page a Citation quotes, as the page's fetches recorded it. */
const webVersionOf = (work: CitedWork, document: Document) =>
  work.contentHash
    ? document.web?.versions.find((version) => version.contentHash === work.contentHash)
    : undefined;

/** A web page's versions are works of their own: each was read on its own day. */
const versionKey = (documentId: string, work: CitedWork) => `${documentId}@${work.contentHash}`;

/** The day of a moment on this computer's calendar, as CSL's date parts. */
function localDay(at: string): number[] {
  const date = new Date(at);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

/**
 * Numbered, IncarnaMind's own form: the editor numbers its Citations and the exports give
 * each a footnote naming its Document and Location, so only the Bibliography is made here:
 * each cited Document once, by the name its footnotes give it, in alphabetical order. Its
 * reference record isn't used, so none needs details.
 */
function numbered(request: CitationFormatRequest, references: Map<string, Reference>) {
  const collator = new Intl.Collator(["en", "zh-CN"], { sensitivity: "base", numeric: true });
  const bibliography: BibliographyEntry[] = [...references.values()]
    .map((reference) => ({
      documentId: reference.documentId,
      workDocumentId: reference.workDocumentId,
      label: null,
      runs: [{ text: reference.name }],
      needsDetails: false,
    }))
    .sort((a, b) => collator.compare(a.runs[0]?.text ?? "", b.runs[0]?.text ?? ""));
  return {
    style: request.style,
    form: "numbered" as const,
    clusters: request.clusters.map(() => ({ runs: [] })),
    bibliography,
    hangingIndent: false,
  };
}

export function createCitationStyles(options: CitationStylesOptions) {
  const catalogue = createCatalogue(
    options.folder === undefined ? undefined : join(options.folder, "styles.pack"),
  );
  let engine: CitationStyleEngine | undefined;
  const cache = new Map<string, FormattedCitations>();

  const remember = (key: string, value: FormattedCitations) => {
    cache.delete(key);
    cache.set(key, value);
    for (const oldest of cache.keys()) {
      if (cache.size <= CACHE_SIZE) break;
      cache.delete(oldest);
    }
  };

  async function formatWith(
    style: ResolvedCitationStyle & { engine: EngineStyle },
    request: CitationFormatRequest,
    references: Map<string, Reference>,
    keyOf: (work: CitedWork) => string,
  ): Promise<FormattedCitations> {
    const raisedLocators = style.locators === "raised-after";
    const job: FormatJob = {
      items: [...references.values()].map((reference) => reference.item),
      citations: request.clusters.map((cluster, index) => ({
        items: cluster.works.map((work) => ({
          id: (references.get(keyOf(work)) as Reference).item.id,
          ...locatorOf(work.location, style.language, raisedLocators),
        })),
        // Each cluster is one note, numbered through the Mind.
        noteIndex: index + 1,
      })),
      englishTermsForOthers: style.language === "zh-CN",
      raisedLocators,
    };
    if (style.engine.locale) job.locale = style.engine.locale;
    const fallbacks = new Map(
      [...references.values()].map((reference) => [reference.item.id, fallbackRuns(reference)]),
    );
    const key = JSON.stringify([style.engine, job, [...fallbacks.values()]]);
    const known = cache.get(key);
    if (known) {
      remember(key, known);
      return known;
    }
    if (options.folder === undefined) {
      throw new CitationFormatError("The citation styles aren't installed.", true);
    }
    engine ??= createWorkerEngine(options.folder);
    const { description, output } = await engine.format(style.engine, job);
    const byId = new Map(
      [...references.values()].map((reference) => [reference.item.id, reference]),
    );
    const formatted: FormattedCitations = {
      style: style.id,
      form: description.class === "note" ? "note" : "in-text",
      clusters: output.citations.map((runs, cluster) => ({
        runs: runs.map(({ item, ...run }) => {
          if (item === undefined) return run;
          const cite = job.citations[cluster]?.items[item];
          const text =
            cite?.label === "custom" && cite.locator
              ? restoreHyphens(run.text, cite.locator)
              : run.text;
          return { ...run, text, work: item };
        }),
      })),
      bibliography: output.bibliography.map((entry): BibliographyEntry => {
        const reference = byId.get(entry.id);
        const fallback = fallbacks.get(entry.id) ?? [];
        return {
          documentId: reference?.documentId ?? null,
          workDocumentId: reference?.workDocumentId ?? null,
          label: entry.firstField as StyledRun[] | null,
          runs: fallback.length > 0 ? fallback : entry.runs,
          needsDetails: reference?.needsDetails ?? true,
        };
      }),
      hangingIndent: output.hangingIndent,
    };
    remember(key, formatted);
    return formatted;
  }

  return {
    /** Formats a request (see `CoreApi.formatCitations`); `input` is checked first. */
    async format(input: unknown): Promise<FormattedCitations> {
      const request = parseRequest(input);
      const style = catalogue.resolve(request.style, request.language ?? "en");
      const keyOf = (work: CitedWork) => {
        const document = work.documentId !== null ? options.document(work.documentId) : undefined;
        // A Document that left the Library is still its own work: two with one name are two.
        if (!document)
          return work.documentId !== null
            ? `gone:${work.documentId}`
            : `name:${work.documentName ?? ""}`;
        // Numbered lists each Document once, by name; a style cites each version of a web page.
        return style.engine !== null && webVersionOf(work, document)
          ? versionKey(document.id, work)
          : document.id;
      };
      const references = new Map<string, Reference>();
      for (const cluster of request.clusters) {
        for (const work of cluster.works) {
          const key = keyOf(work);
          if (references.has(key)) continue;
          const document = work.documentId !== null ? options.document(work.documentId) : undefined;
          references.set(key, referenceOf(work, document));
        }
      }
      if (style.engine === null) {
        const formatted = numbered(request, references);
        return style.unavailable ? { ...formatted, unavailable: true } : formatted;
      }
      if (references.size === 0) {
        return {
          style: style.id,
          form: style.form,
          clusters: [],
          bibliography: [],
          hangingIndent: false,
        };
      }
      return formatWith({ ...style, engine: style.engine }, request, references, keyOf);
    },

    /** Every style the pack has (see `CoreApi.listCitationStyles`). */
    list: () => catalogue.catalogue(),
    /** How a Mind in a style is formatted, `language` being its text's. */
    resolve: catalogue.resolve,
    /** The licence notice of the pack's styles and locales. */
    notice: () => catalogue.notice(),

    close(): void {
      engine?.close();
      engine = undefined;
      cache.clear();
    },
  };
}

export type CitationStyles = ReturnType<typeof createCitationStyles>;
