/**
 * Find sources (#296, ADR-0018): searching public Source providers for works
 * and adding them to the Library. Searches go to each provider asked, with
 * the words and filters only, after the User has allowed the "find-sources"
 * flow to it (../consent), never in local mode; their results are merged
 * (./merge) and kept for this session, so the work the User adds is the one
 * they saw. Adding downloads an open copy (only open-access ones, never
 * from behind a paywall) into the data folder's "Sources", or saves one that
 * is a web page as web pages are saved (#261), and adds it as a Document,
 * its reference record filled from the providers' records and where it came
 * from recorded (./store); with no open copy, the reference record alone is
 * kept. The Answer's Tool (./tool) runs the same search.
 */
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanApiKey } from "../../shared/apiKey";
import { arxivIdOf, normalizeDoi } from "../../shared/references";
import type {
  AddFoundSourceResult,
  DataKind,
  Document,
  ExternalService,
  FindSourcesResult,
  FoundSource,
  SourceAccess,
  SourceFailureReason,
  SourceProviderInfo,
  SourceProviderOutcome,
} from "../api";
import type { Consent } from "../consent";
import { isInside } from "../documents/files";
import {
  ConsentDeclinedError,
  ConsentRevokedError,
  InvalidInputError,
  isRecord,
  LocalModeError,
} from "../errors";
import { safeFileName, writeNewFile } from "../fileNames";
import { readApiKey } from "../providers/apiKey";
import { fillReference, linkReference, writeUnlinkedReference } from "../referenceRecords/store";
import type { Secrets } from "../secrets";
import { createSendGate } from "../sendGate";
import type { Database } from "../storage";
import type { Tool } from "../tools";
import { cfrId, parseCfr, parseUsc, uscId } from "./citations";
import { downloadOpenPdf, fileOf } from "./fullText";
import { gatedHttp, SourceError, type SourceHttp } from "./http";
import { licenceOf } from "./licences";
import { type MergedWork, mergeWorks } from "./merge";
import { sourceKeySecret } from "./providers";
import { forgetFoundFile, inLibrary, purgedFoundFiles, recordFoundSource } from "./store";
import { sourcesTool } from "./tool";
import type {
  FullText,
  FullTextLocation,
  ProviderWork,
  SourceProvider,
  WorkIdentifier,
} from "./types";

export type { SourceProvider } from "./types";

/** What the "find-sources" flow sends: the search words and filters, and the IDs of works added. */
export const FIND_SOURCES_SENDS: readonly DataKind[] = ["search-terms", "work-ids"];

/** For a row whose provider is unknown: never expected, as every work was found by one. */
const UNKNOWN = { id: "unknown", name: "" };

const LOCAL_MODE: AddFoundSourceResult = {
  outcome: "failed",
  reason: "local-mode",
  message: "“Keep everything on this computer” is on.",
};

/** How many works each provider is asked for. */
const RESULTS_PER_PROVIDER = 10;

/** How long a search's results answer the same search again, without asking the providers. */
const SEARCH_TTL_MS = 30 * 60 * 1000;

/** The most searches and works kept for the session. */
const MAX_SEARCHES = 50;
const MAX_WORKS = 1000;

/** The longest query sent. */
const MAX_QUERY_LENGTH = 500;

export interface SourcesOptions {
  db: Database;
  now: () => string;
  /** For how long results are kept. */
  clock: () => number;
  consent: Consent;
  /** Keeps the User's own keys for the providers that take one. */
  secrets: Secrets;
  /** Local mode is on: nothing is sent. */
  localOnly(): boolean;
  providers: readonly SourceProvider[];
  http: SourceHttp;
  /** Where downloaded copies are kept: the data folder's "Sources". */
  folder: string;
  /** Throws for a Folder that doesn't exist; null is Not in a Folder. */
  checkFolder(folderId: string | null): void;
  /**
   * Adds a file as a Document in a Folder, as Add Documents does; `added`
   * hears its id as it is stored, before it is processed. Null if the file
   * couldn't be added.
   */
  addFile(
    path: string,
    folderId: string | null,
    added: (documentId: string) => void,
  ): Promise<Document | null>;
  /**
   * Saves a web page as a Document in a Folder, as Add a web page does;
   * `added` hears a new one's id as it is stored, before it is processed.
   * Null if the page couldn't be saved.
   */
  savePage(
    address: string,
    folderId: string | null,
    added: (documentId: string) => void,
  ): Promise<{ document: Document; existing: boolean } | null>;
  /** The live Document. */
  document(id: string): Document;
  /** Aborted when the core closes. */
  signal: AbortSignal;
  reportError(error: unknown): void;
}

interface ParsedInput {
  query: string;
  fromYear: number | null;
  toYear: number | null;
  openAccessOnly: boolean;
  providers: string[] | null;
}

function parseYear(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > 9999) {
    throw new InvalidInputError(`${what} must be a year.`);
  }
  return value;
}

export function parseFindInput(input: unknown): ParsedInput {
  if (!isRecord(input) || typeof input.query !== "string") {
    throw new InvalidInputError("findSources expects a query.");
  }
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  if (query === "") throw new InvalidInputError({ key: "error.sources.nothingToFind" });
  const fromYear = parseYear(input.fromYear, "fromYear");
  const toYear = parseYear(input.toYear, "toYear");
  if (fromYear !== null && toYear !== null && fromYear > toYear) {
    throw new InvalidInputError({ key: "error.sources.yearsOrder" });
  }
  if (input.openAccessOnly !== undefined && typeof input.openAccessOnly !== "boolean") {
    throw new InvalidInputError("openAccessOnly must be true or false.");
  }
  const providers = input.providers;
  if (
    providers !== undefined &&
    (!Array.isArray(providers) || !providers.every((id) => typeof id === "string"))
  ) {
    throw new InvalidInputError("providers must be a list of provider ids.");
  }
  return {
    query,
    fromYear,
    toYear,
    openAccessOnly: input.openAccessOnly === true,
    providers: providers === undefined ? null : [...new Set(providers as string[])],
  };
}

/**
 * A DOI, an arXiv ID, a PubMed ID, an NCT number, a label's set id or a US
 * citation (a CFR section or part, a US Code section) the User typed, which
 * is looked up rather than searched for.
 */
export function identifierOf(query: string): WorkIdentifier | null {
  const cfr = parseCfr(query);
  if (cfr) return { kind: "cfr", id: cfrId(cfr) };
  const usc = parseUsc(query);
  if (usc) return { kind: "usc", id: uscId(usc) };
  const doi = normalizeDoi(query);
  if (doi) return { kind: "doi", id: doi.toLowerCase() };
  const arxiv =
    arxivIdOf(query) ?? /^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(query)?.[1] ?? null;
  if (arxiv) return { kind: "arxiv", id: arxiv };
  const pmid = /^(?:pmid:?\s*(\d{1,9})|(\d{7,9}))$/i.exec(query);
  const id = pmid?.[1] ?? pmid?.[2];
  if (id) return { kind: "pmid", id };
  const nct = /^NCT\d{8}$/i.exec(query);
  if (nct) return { kind: "nct", id: nct[0].toUpperCase() };
  const setId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(query);
  return setId ? { kind: "setid", id: setId[0].toLowerCase() } : null;
}

const FAILURES: Record<SourceError["reason"], SourceFailureReason> = {
  unreachable: "unreachable",
  "rate-limited": "rate-limited",
  "service-error": "service-error",
  "not-found": "service-error",
  "not-open": "service-error",
  "needs-key": "needs-key",
  "key-rejected": "key-rejected",
};

/** Why adding failed, when a provider's answer, not the copy, is the reason: the next copy won't fare better. */
const ADD_FAILURES: Partial<
  Record<SourceError["reason"], "rate-limited" | "needs-key" | "key-rejected">
> = {
  "rate-limited": "rate-limited",
  "needs-key": "needs-key",
  "key-rejected": "key-rejected",
};

/** How a found work's full text can be had: as its first open copy, the one adding tries first. */
function accessOf(work: MergedWork): SourceAccess {
  const first = work.fullText[0];
  if (!first) return { kind: "closed" };
  return {
    kind: "open",
    format: first.format === "pdf" ? "pdf" : first.format === "html" ? "web-page" : "text",
    version: first.version,
    licence: licenceOf(first.licence),
  };
}

export function createSources(options: SourcesOptions) {
  const { db, now, consent, providers, http } = options;
  const gate = createSendGate(consent, options.localOnly);
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  /** Each work seen this session, by key: what `add` adds. */
  const works = new Map<string, MergedWork>();
  /** Recent searches, by their input: answered again without asking. */
  const searches = new Map<
    string,
    { at: number; works: string[]; providers: SourceProviderOutcome[] }
  >();
  /** Adding the same work twice at once adds it once. */
  const adding = new Map<string, Promise<AddFoundSourceResult>>();

  const keep = <V>(map: Map<string, V>, key: string, value: V, max: number) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  const foundSource = (work: MergedWork): FoundSource => ({
    key: work.key,
    fields: work.fields,
    foundBy: work.foundBy.map((id) => ({ id, name: nameOf(id) })),
    citedBy: work.citedBy,
    versionDate: work.versionDate,
    access: accessOf(work),
    landingUrl: work.landingUrl,
    notice: work.notice,
    unofficial: work.unofficial,
    inLibrary: inLibrary(db, work.ids),
  });

  /** A provider that works only with the User's own key, which isn't set: it is off, and nothing is sent to it. */
  const missingKey = async (provider: SourceProvider): Promise<boolean> =>
    provider.needsKey !== undefined &&
    (await options.secrets.tryGet(sourceKeySecret(provider.id))) === null;

  const context = (signal: AbortSignal, service: ExternalService) => ({
    http: gatedHttp(http, () => gate.check("find-sources", service)),
    signal: AbortSignal.any([signal, options.signal]),
  });

  /** Asks the User once per provider; false if they declined. */
  const allowed = async (service: ExternalService): Promise<boolean> => {
    try {
      await consent.ensure("find-sources", service);
      return true;
    } catch (error) {
      if (error instanceof ConsentDeclinedError) return false;
      // Its prompt closed as Local mode came on: the check after it says so.
      if (error instanceof LocalModeError) return true;
      throw error;
    }
  };

  async function ask(
    provider: SourceProvider,
    input: ParsedInput,
    identifier: WorkIdentifier | null,
    signal: AbortSignal,
  ): Promise<{ works: ProviderWork[]; outcome: SourceProviderOutcome }> {
    const outcome = (
      count: number,
      failure: SourceProviderOutcome["failure"] = null,
    ): SourceProviderOutcome => ({ id: provider.id, name: provider.name, count, failure });
    // Before consent: there is nothing to ask about until the User has a key.
    if (await missingKey(provider)) {
      return {
        works: [],
        outcome: outcome(0, { reason: "needs-key", message: `${provider.name} needs a key.` }),
      };
    }
    if (!(await allowed(provider.service))) {
      return {
        works: [],
        outcome: outcome(0, {
          reason: "declined",
          message: `Searching ${provider.name} isn't allowed.`,
        }),
      };
    }
    // Local mode may have come on while the User was being asked.
    if (options.localOnly()) return { works: [], outcome: outcome(0) };
    try {
      const found = identifier
        ? [await provider.resolve?.(identifier, context(signal, provider.service))].filter(
            (work): work is ProviderWork => !!work,
          )
        : ((await provider.search?.(
            {
              text: input.query,
              fromYear: input.fromYear,
              toYear: input.toYear,
              openAccessOnly: input.openAccessOnly,
              limit: RESULTS_PER_PROVIDER,
            },
            context(signal, provider.service),
          )) ?? []);
      return { works: found, outcome: outcome(found.length) };
    } catch (error) {
      if (error instanceof LocalModeError) return { works: [], outcome: outcome(0) };
      if (error instanceof ConsentRevokedError) {
        return {
          works: [],
          outcome: outcome(0, { reason: "declined", message: error.message }),
        };
      }
      if (!(error instanceof SourceError)) throw error;
      return {
        works: [],
        outcome: outcome(0, { reason: FAILURES[error.reason], message: error.message }),
      };
    }
  }

  /**
   * The providers a search goes to: an identifier to those that look it up,
   * words to those that search. Words go to the providers named, else to the
   * ones searched by default (not drug labels or trials); an NCT number or a
   * set id names its provider, so it is looked up there whatever is chosen.
   */
  function targets(input: ParsedInput, identifier: WorkIdentifier | null): SourceProvider[] {
    const named = (provider: SourceProvider) =>
      input.providers === null
        ? provider.searchedByDefault !== false
        : input.providers.includes(provider.id);
    if (!identifier) return providers.filter((each) => each.search && named(each));
    return providers.filter(
      (each) =>
        each.resolve &&
        each.resolves?.includes(identifier.kind) &&
        // Crossref looks DOIs up, whichever providers are searched.
        (named(each) || each.search === undefined || each.searchedByDefault === false),
    );
  }

  async function search(input: unknown, signal: AbortSignal): Promise<FindSourcesResult> {
    const parsed = parseFindInput(input);
    if (options.localOnly()) return { outcome: "local-mode" };
    const identifier = identifierOf(parsed.query);
    const asked = targets(parsed, identifier);
    // The same search from the Library or an Answer, however its providers were named, while
    // the User's decision on each stays as it was.
    const cacheKey = () =>
      JSON.stringify([
        parsed.query,
        parsed.fromYear,
        parsed.toYear,
        parsed.openAccessOnly,
        asked.map((each) => `${each.id}:${consent.status("find-sources", each.service)}`),
      ]);
    const cached = searches.get(cacheKey());
    if (cached && options.clock() - cached.at < SEARCH_TTL_MS) {
      const kept = cached.works.flatMap((key) => {
        const work = works.get(key);
        return work ? [work] : [];
      });
      if (kept.length === cached.works.length) {
        return { outcome: "found", works: kept.map(foundSource), providers: cached.providers };
      }
    }
    const answers = await Promise.all(
      asked.map((provider) => ask(provider, parsed, identifier, signal)),
    );
    if (options.localOnly()) return { outcome: "local-mode" };
    const merged = mergeWorks(
      answers.map((answer, index) => ({ provider: asked[index]?.id ?? "", works: answer.works })),
    ).filter((work) => !parsed.openAccessOnly || work.fullText.length > 0);
    for (const work of merged) keep(works, work.key, work, MAX_WORKS);
    const outcomes = answers.map((answer) => answer.outcome);
    // A search a provider failed is asked again next time; one the User declined stays declined.
    if (outcomes.every((outcome) => !outcome.failure || outcome.failure.reason === "declined")) {
      // Keyed by the decisions made while it was asked.
      keep(
        searches,
        cacheKey(),
        { at: options.clock(), works: merged.map((work) => work.key), providers: outcomes },
        MAX_SEARCHES,
      );
    }
    return { outcome: "found", works: merged.map(foundSource), providers: outcomes };
  }

  /** Writes a fetched copy into the Sources folder, under the work's title; returns its path. */
  async function keepCopy(text: FullText, work: MergedWork): Promise<string> {
    const { data, extension } = fileOf(text);
    await mkdir(options.folder, { recursive: true });
    const name = await writeNewFile(
      options.folder,
      `${safeFileName(work.fields.title, "Untitled")}${extension}`,
      data,
    );
    return join(options.folder, name);
  }

  async function addWork(work: MergedWork, folderId: string | null): Promise<AddFoundSourceResult> {
    const existing = inLibrary(db, work.ids);
    if (existing?.documentId) {
      return {
        outcome: "document",
        document: options.document(existing.documentId),
        existing: true,
      };
    }
    /**
     * Hears a Document stored for the work, before it is read: what its
     * reading gives fills only what the providers left empty.
     */
    const stored =
      (copy: FullTextLocation, provider: SourceProvider | null, text: FullText | null) =>
      (documentId: string) => {
        const sections = text?.format === "sections" ? text : null;
        db.transaction(() => {
          const at = now();
          const linked =
            existing && linkReference(db, existing.recordId, documentId, at)
              ? existing.recordId
              : null;
          fillReference(db, documentId, work.fields, at);
          recordFoundSource(
            db,
            {
              documentId,
              recordId: linked,
              provider: provider ?? byId.get(work.foundBy[0] ?? "") ?? UNKNOWN,
              workKey: work.key,
              address: text?.url ?? copy.url,
              licence: sections?.licence ?? copy.licence,
              version: copy.version,
              versionDate: sections?.versionDate ?? copy.versionDate ?? work.versionDate,
              fetchedAt: at,
            },
            at,
          );
        });
      };
    let declined: string | null = null;
    /** What a provider answered that the User can act on (wait, add a key), when no copy could be had. */
    let refused: { reason: "rate-limited" | "needs-key" | "key-rejected"; message: string } | null =
      null;
    for (const copy of work.fullText) {
      if (copy.format === "html") {
        // Open as a web page at its publisher's: saved as Add a web page saves one.
        if (options.localOnly()) return LOCAL_MODE;
        const saved = await options.savePage(copy.url, folderId, stored(copy, null, null));
        if (saved) return { outcome: "document", ...saved };
        continue;
      }
      const provider = copy.provider === null ? null : byId.get(copy.provider);
      // A copy only its provider can fetch, from a provider not here (or one that fetches none).
      if (provider === undefined || (provider && !provider.fetchFullText)) continue;
      if (provider && (await missingKey(provider))) {
        refused = { reason: "needs-key", message: `${provider.name} needs a key.` };
        continue;
      }
      if (provider && !(await allowed(provider.service))) {
        declined = provider.name;
        continue;
      }
      if (options.localOnly()) return LOCAL_MODE;
      let path: string;
      let text: FullText;
      try {
        text = provider?.fetchFullText
          ? await provider.fetchFullText(copy, context(options.signal, provider.service))
          : await downloadOpenPdf(http, copy.url, options.signal);
        path = await keepCopy(text, work);
      } catch (error) {
        if (error instanceof LocalModeError) return LOCAL_MODE;
        if (error instanceof ConsentRevokedError) {
          declined = provider?.name ?? declined;
          continue;
        }
        if (!(error instanceof SourceError)) throw error;
        const reason = ADD_FAILURES[error.reason];
        if (reason) refused = { reason, message: error.message };
        // That copy can't be had: the next one may be.
        continue;
      }
      const document = await options.addFile(path, folderId, stored(copy, provider, text));
      if (document) return { outcome: "document", document, existing: false };
      await rm(path, { force: true });
    }
    if (declined && !existing) {
      return {
        outcome: "failed",
        reason: "declined",
        message: `Downloading from ${declined} isn't allowed.`,
      };
    }
    // Asked to wait, or for a key: nothing is kept, so trying again later adds the text.
    if (refused && !existing) return { outcome: "failed", ...refused };
    const reason = work.fullText.length > 0 ? "download-failed" : "closed";
    // An open copy that couldn't be had here, the User's browser may: else its page at its publisher.
    const landingUrl =
      (reason === "download-failed" ? work.fullText[0]?.url : null) ?? work.landingUrl;
    if (existing) {
      return {
        outcome: "reference",
        recordId: existing.recordId,
        reason,
        landingUrl,
        existing: true,
      };
    }
    const recordId = db.transaction(() => {
      const at = now();
      const id = writeUnlinkedReference(db, work.fields, at);
      recordFoundSource(
        db,
        {
          documentId: null,
          recordId: id,
          provider: byId.get(work.foundBy[0] ?? "") ?? UNKNOWN,
          workKey: work.key,
          address: work.landingUrl,
          licence: null,
          version: null,
          versionDate: work.versionDate,
          fetchedAt: null,
        },
        at,
      );
      return id;
    });
    return { outcome: "reference", recordId, reason, landingUrl, existing: false };
  }

  return {
    /** What the "find-sources" flow sends to one service besides: the User's key, to a provider that works only with it. */
    sendsTo(serviceId: string): DataKind[] {
      return providers.some((each) => each.needsKey && each.service.id === serviceId)
        ? ["provider-key"]
        : [];
    },

    async list(): Promise<SourceProviderInfo[]> {
      return Promise.all(
        providers.map(async (provider) => ({
          id: provider.id,
          name: provider.name,
          service: provider.service,
          searches: provider.search !== undefined,
          consent: consent.status("find-sources", provider.service),
          termsUrl: provider.terms.url,
          searchedByDefault: provider.searchedByDefault !== false,
          key: provider.takesKey
            ? (await options.secrets.tryGet(sourceKeySecret(provider.id))) === null
              ? ("unset" as const)
              : ("set" as const)
            : ("none" as const),
          keyNeeded: provider.needsKey !== undefined,
          keySignUp: provider.needsKey?.signUp ?? null,
        })),
      );
    },

    /** See `CoreApi.setSourceProviderKey`. */
    async setKey(providerId: unknown, key: unknown): Promise<void> {
      const provider = byId.get(typeof providerId === "string" ? providerId : "");
      if (!provider?.takesKey) throw new InvalidInputError("That provider takes no key.");
      if (key !== null && typeof key !== "string") {
        throw new InvalidInputError("A key must be text, or null to remove it.");
      }
      const name = sourceKeySecret(provider.id);
      const trimmed = cleanApiKey(key ?? "");
      if (trimmed === "") return options.secrets.delete(name);
      // A key is one token: anything else is a paste gone wrong, and it isn't echoed back.
      if (trimmed.length > 200 || /\s/.test(trimmed)) {
        throw new InvalidInputError({ key: "error.sources.keyLooksWrong" });
      }
      await options.secrets.set(name, readApiKey(trimmed));
    },

    /** See `CoreApi.findSources`. */
    search: (input: unknown, signal: AbortSignal = options.signal) => search(input, signal),

    /**
     * The Tool an Answer can call: none in local mode, or when the User
     * declined every provider that searches.
     */
    tools(): Tool[] {
      if (options.localOnly()) return [];
      const searching = providers.filter(
        (each) => each.search && consent.status("find-sources", each.service) !== "declined",
      );
      return searching.length > 0 ? [sourcesTool(search, searching)] : [];
    },

    /** See `CoreApi.addFoundSource`. */
    async add(input: unknown): Promise<AddFoundSourceResult> {
      if (!isRecord(input) || typeof input.key !== "string" || input.key === "") {
        throw new InvalidInputError("addFoundSource expects a found work's key.");
      }
      const folderId = input.folderId ?? null;
      if (folderId !== null && typeof folderId !== "string") {
        throw new InvalidInputError("A Folder id must be text, or null.");
      }
      if (options.localOnly()) return LOCAL_MODE;
      const work = works.get(input.key);
      if (!work) {
        return {
          outcome: "failed",
          reason: "not-found",
          message: "That work isn't in this session's results: search again to add it.",
        };
      }
      options.checkFolder(folderId);
      const running = adding.get(work.key);
      if (running) return running;
      const started = addWork(work, folderId).finally(() => adding.delete(work.key));
      adding.set(work.key, started);
      return started;
    },

    /** Removes the copies of Documents deleted permanently: their text goes with them. */
    async dropPurged(): Promise<void> {
      const files = purgedFoundFiles(db);
      if (files.length === 0) return;
      // Documents keep the path with links resolved (on macOS, /private/var for /var).
      const folders = [options.folder, await realpath(options.folder).catch(() => options.folder)];
      await Promise.all(
        files.map(async (file) => {
          try {
            // A web page's snapshot is removed with the other web pages'.
            if (folders.some((folder) => isInside(folder, file.path))) {
              await rm(file.path, { force: true });
            }
            // The core may have closed meanwhile: the row is forgotten at the next start.
            if (!options.signal.aborted) forgetFoundFile(db, file.id, now());
          } catch (error) {
            // Tried again at the next start.
            options.reportError(error);
          }
        }),
      );
    },
  };
}

export type Sources = ReturnType<typeof createSources>;
