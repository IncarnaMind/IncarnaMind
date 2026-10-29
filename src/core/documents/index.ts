/**
 * Documents (ADR-0010): files indexed where the User keeps them, processed
 * into Passages off the main thread (extracting on a worker thread,
 * embedding through the embedder), renamed, removed from the index, and
 * searched by keyword, vector and hybrid search. Linked folders and the
 * files on disk are kept in step by ./library.
 *
 * Each Document has a current version, its `content_hash`: the SHA-256 of
 * its file as read for processing. Passages and page text belong to a
 * version. When the file changes, the new version is processed and its
 * Passages replace the old ones in search; the old version's page text stays
 * for as long as a Citation quotes it, or a feature retains it
 * (./retention), so the Citation is still checked against the text it
 * quoted (`collectOldVersions`). A new version that can't be processed
 * replaces nothing: the last good one stays (`record`).
 *
 * A Document removed from the index is deleted with its Passages and text,
 * except when its Linked folder is unlinked: then the Units the Citations in
 * Minds point to, and those retained, stay, the only text a deleted Document
 * keeps (`keptCitationTexts`), so those Citations can still be checked.
 */

import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { LiveDocument } from "../../shared/citations";
import { joinUnits, quoteInUnits } from "../../shared/locations";
import { readableQuote } from "../../shared/readableQuote";
import {
  type Anchor,
  anchorsOf,
  cellNumber,
  type TextUnit,
  type UnitKind,
  type UnitLabel,
  type UnitText,
} from "../../shared/units";
import { parseUnreadParts } from "../../shared/unreadFiles";
import { silentLogger } from "../activityLog";
import type { Logger } from "../adapters";
import { cleanQuote } from "../answers/citations";
import type { CitedUnits } from "../answers/citedVersions";
import type {
  AddDocumentsResult,
  Document,
  DocumentFailureReason,
  DocumentFileStatus,
  DocumentKind,
  DocumentScanProgress,
  DocumentStatus,
  DocumentText,
  DocumentTextMatch,
  KeptCitationText,
  OwnFile,
  PassageSearchResult,
  ProviderErrorKind,
  ScannedQuote,
  ScannedQuoteInput,
  ScannedText,
  SearchMode,
  SkippedFile,
  TaggingState,
} from "../api";
import { ownFileKinds } from "../api";
import { EmbeddingUnavailableError, type SearchEmbedder } from "../embedding/active";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Folders } from "../folders";
import { referenceOf, writeFileReference } from "../referenceRecords/store";
import { foundSourceOf } from "../sources/store";
import type { Database, SqlValue } from "../storage";
import { tagsOfDocument } from "../tags";
import type { StoredTaggingState } from "../tags/tagger";
import { isPlaceholderDate } from "./creationDate";
import { createEmbeddingQueue } from "./embedding";
import {
  DOCUMENT_EXTENSIONS,
  isLegacyCopy,
  openFile,
  openImageBeside,
  pathIn,
  relativePath,
  type StatIdentity,
} from "./files";
import { isPackageKind, packageSizeError } from "./formats/zip";
import { keywordText } from "./keywords";
import { createLibrary, type LibraryHooks } from "./library";
import { joinCjkLineWraps, onlyCjkLineWrapChange } from "./lineWrap";
import { laidOut, type PageText } from "./passages";
import {
  CURRENT_SINCE,
  HAN_CURRENT_SINCE,
  type KeywordsJob,
  METADATA_VERSION,
  NAME_INDEX_CURRENT_SINCE,
  PICTURES_CURRENT_SINCE,
  PROCESSING_VERSION,
  type ProcessedPassage,
  type ProcessingJob,
  type ProcessingResult,
  SCAN_CURRENT_SINCE,
  type ScanJob,
  type WorkerResult,
} from "./processing";
import { createProcessor } from "./processor";
import { createReadingMeter, type ReadingMeterOptions } from "./readingSpeed";
import { type TextRecognitionModel, TextRecognitionUnavailableError } from "./scan";
import { MIN_PAGE_TEXT } from "./scan/pages";
import {
  distinctPassages,
  fuseRankingScores,
  fuseRankings,
  HYBRID_CANDIDATES,
  keywordOnlyPassages,
  keywordSearch,
  livePassage,
  passagesBetween,
  passagesBySeq,
  passagesInWindow,
  textSearch,
  type WindowedPassage,
  windowedPassagesBySeq,
} from "./search";
import {
  type SearchCandidate,
  type SearchToolOptions,
  searchDocumentsTool,
  topsOfEach,
} from "./searchTool";
import { detectLanguage, languageList, type TextLanguage } from "./textLanguage";
import { unreadMessage } from "./unreadMessage";
import { createVectorIndex } from "./vectors";
import type { WatchFolder } from "./watcher";
import type { SnapshotFile } from "./web";
import { currentLookHash, lookName, showsPicture, webPageInfo } from "./web/store";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 200;

/** A Document's language is told from the start of its first few Passages: a few thousand characters. */
const LANGUAGE_SAMPLE_PASSAGES = 4;
const LANGUAGE_SAMPLE_CHARACTERS = 1000;
const MAX_NAME_LENGTH = 500;
const SEARCH_MODES: readonly SearchMode[] = ["hybrid", "keyword", "vector"];

/**
 * A GLOB for text with a Han character in it: CJK Unified Ideographs and
 * Extension A, where every traditional character the keyword index folds is,
 * and the radicals and compatibility ideographs normalisation turns into them.
 */
const HAS_HAN = "*[\u2e80-\u2fdf\u3400-\u9fff\uf900-\ufaff]*";

interface DocumentRow {
  id: string;
  content_hash: string;
  name: string;
  kind: string;
  size: number;
  page_count: number | null;
  status: string;
  failure_reason: string | null;
  failure_message: string | null;
  unread_parts: string | null;
  folder_id: string | null;
  tagging_status: string;
  tagging_error_kind: string | null;
  tagging_error_message: string | null;
  tagging_error_resets_at: string | null;
  embedding_model: string | null;
  path: string;
  linked_folder_id: string | null;
  file_status: string;
  source_kind: string;
  creation_date: string | null;
  title: string | null;
  own_file: string | null;
  counted_as_evidence: number;
  not_cited: number;
  processing_version: number;
  keywords_version: number;
  file_mtime_ms: number | null;
  created_at: string;
  updated_at: string;
}

/** A stored Unit (a `document_pages` row), as read for the check and the viewer. */
interface UnitRow {
  page: number | null;
  text: string;
  kind: string;
  label: string | null;
  anchors: string | null;
}

/** JSON stored by this app; null if it doesn't parse. */
function parseJson<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

const toUnitText = (row: UnitRow): PageText => ({
  page: row.page,
  text: row.text,
  kind: row.kind as UnitKind,
  label: parseJson<UnitLabel>(row.label),
  anchors: parseJson<Anchor[]>(row.anchors),
});

const COLUMNS = `id, content_hash, name, kind, size, page_count, status,
  failure_reason, failure_message, unread_parts, folder_id, tagging_status, tagging_error_kind,
  tagging_error_message, tagging_error_resets_at, embedding_model, path, linked_folder_id, file_status,
  source_kind, creation_date, title, own_file, counted_as_evidence, not_cited, processing_version,
  keywords_version, file_mtime_ms, created_at, updated_at`;

/** What IncarnaMind wrote the file as (#80), from its stored kind; a kind a newer version wrote counts as an export. */
const ownFileOf = (row: Pick<DocumentRow, "own_file" | "counted_as_evidence">): OwnFile | null =>
  row.own_file === null
    ? null
    : {
        kind: ownFileKinds.find((kind) => kind === row.own_file) ?? "export",
        counted: row.counted_as_evidence === 1,
      };

function parsePaths(input: unknown): string[] {
  if (!Array.isArray(input)) throw new InvalidInputError("addDocuments expects a list of paths.");
  for (const path of input) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new InvalidInputError("Each Document must be given as an absolute file path.");
    }
  }
  return input;
}

function parseId(id: unknown): string {
  if (typeof id !== "string" || id === "")
    throw new InvalidInputError("A Document id is required.");
  return id;
}

function parseName(name: unknown): string {
  if (typeof name !== "string") throw new InvalidInputError("A Document's name must be text.");
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidInputError({ key: "error.document.nameEmpty" });
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new InvalidInputError({
      key: "error.document.nameTooLong",
      values: { max: MAX_NAME_LENGTH },
    });
  }
  return trimmed;
}

/** `listDocuments` options, checked. Undefined means any. */
export function parseListOptions(options: unknown): {
  folderId: string | undefined;
  includeSubfolders: boolean;
  tagId: string | undefined;
  linkedFolderId: string | null | undefined;
} {
  if (options === undefined) {
    return {
      folderId: undefined,
      includeSubfolders: false,
      tagId: undefined,
      linkedFolderId: undefined,
    };
  }
  if (!isRecord(options)) throw new InvalidInputError("listDocuments expects an object.");
  const { folderId, includeSubfolders = false, tagId, linkedFolderId } = options;
  if (folderId !== undefined && (typeof folderId !== "string" || folderId === "")) {
    throw new InvalidInputError("A Folder id must be a non-empty string.");
  }
  if (typeof includeSubfolders !== "boolean") {
    throw new InvalidInputError("includeSubfolders must be true or false.");
  }
  if (tagId !== undefined && (typeof tagId !== "string" || tagId === "")) {
    throw new InvalidInputError("A Tag id must be a non-empty string.");
  }
  if (
    linkedFolderId !== undefined &&
    linkedFolderId !== null &&
    (typeof linkedFolderId !== "string" || linkedFolderId === "")
  ) {
    throw new InvalidInputError("A Linked folder id must be a non-empty string, or null.");
  }
  return { folderId, includeSubfolders, tagId, linkedFolderId };
}

/** Where automatic tagging is, from what is stored and the Document's processing status. */
function taggingOf(status: string, stored: string): TaggingState {
  if (stored === "tagged") return "tagged"; // kept while the Document is processed again
  if (status === "ready") return stored as StoredTaggingState;
  if (status === "failed" || status === "no-text") return "skipped";
  return "pending";
}

/**
 * A stored failure shows only once processing has settled. While a Document is
 * read again, its status and scan progress belong to the new job, not the old failure.
 */
const failedNow = (row: Pick<DocumentRow, "status" | "failure_reason">) =>
  row.status === "failed" ||
  (row.failure_reason !== null &&
    (row.status === "ready" || row.status === "embedding" || row.status === "waiting-for-model"));

/** `searchPassages` options, checked and with their defaults. */
function parseSearchOptions(options: unknown): {
  mode: SearchMode;
  limit: number;
  documentIds: string[] | undefined;
} {
  if (options === undefined) {
    return { mode: "hybrid", limit: DEFAULT_SEARCH_LIMIT, documentIds: undefined };
  }
  if (!isRecord(options)) throw new InvalidInputError("searchPassages expects an object.");
  const { mode = "hybrid", limit = DEFAULT_SEARCH_LIMIT, documentIds } = options;
  if (!SEARCH_MODES.includes(mode as SearchMode)) {
    throw new InvalidInputError(`The search mode must be one of ${SEARCH_MODES.join(", ")}.`);
  }
  const checked = searchLimit(limit);
  if (
    documentIds !== undefined &&
    (!Array.isArray(documentIds) || !documentIds.every((id) => typeof id === "string" && id !== ""))
  ) {
    throw new InvalidInputError("documentIds must be a list of Document ids.");
  }
  return {
    mode: mode as SearchMode,
    limit: checked,
    documentIds: documentIds as string[] | undefined,
  };
}

/** A search's `limit`, checked: a whole number from 1 to 200, 20 when not given. */
/** Documents a text search leaves out, as the core asks (the examples', see #1942). */
function excludedIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id !== "")) {
    throw new InvalidInputError({ key: "error.search.options" });
  }
  return value as string[];
}

function searchLimit(limit: unknown = DEFAULT_SEARCH_LIMIT): number {
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SEARCH_LIMIT
  ) {
    throw new InvalidInputError({ key: "error.search.limit", values: { max: MAX_SEARCH_LIMIT } });
  }
  return limit;
}

/** A Passage a Citation names, with its Document: what the Citation check needs. */
export interface CitationSource {
  passageId: string;
  /** The Passage's text, as search returned it. */
  text: string;
  /** The pages the Passage covers; null for a Document without pages. */
  pageFrom: number | null;
  pageTo: number | null;
  documentId: string;
  documentName: string;
  documentKind: DocumentKind;
  /** The version of the Document the Passage was built from: what a Citation of it quotes. */
  contentHash: string;
  /** The Document has been deleted since. */
  documentDeleted: boolean;
  /** The User keeps the Document as their own workings: its Passages are read, never cited. */
  notCited: boolean;
}

/**
 * A Document's date as Answers see it beside its Passages, and where it comes from:
 * the Document ("document"), or its file's information ("file-created", "file-modified"),
 * which says when the file was made or changed, never what the Document is dated (#1173).
 */
export interface DocumentDate {
  /** ISO 8601 at the precision known: "2025-05-14", "2024-03" or "2019". */
  date: string;
  of: "document" | "file-created" | "file-modified";
}

/** A live Document's file, opened for reading. */
export interface DocumentFile {
  document: Document;
  /** The file's bytes. Cancel the stream if it isn't read to the end, so the file is closed. */
  stream: ReadableStream<Uint8Array>;
  /** The file's size now, in bytes. */
  size: number;
}

/** A picture a Markdown Document shows from beside it. */
export interface DocumentImage {
  /** Its bytes. Cancel the stream if it isn't read to the end, so the file is closed. */
  stream: ReadableStream<Uint8Array>;
  size: number;
  /** Its media type, e.g. "image/png". */
  type: string;
}

export interface DocumentsOptions {
  db: Database;
  dataDir: string;
  now: () => string;
  /**
   * The embedding model in use (the built-in one unless the User chose
   * another), which embeds Passages and search queries.
   */
  model: SearchEmbedder;
  /** The Folders of Linked folders, which follow the disk. */
  folders: Folders;
  /**
   * Pushes the "document.status" event; `unchanged` when the Document is as it was (back from
   * Recently deleted, or embedded again), so Organize doesn't file it anew.
   */
  emitStatus(document: Document, unchanged?: boolean): void;
  /** Pushes the "documents.moved" event. */
  emitMoved(documents: Document[]): void;
  /** Pushes the "documents.removed" event. */
  emitRemoved(documentIds: string[]): void;
  /** Pushes the "keptCitationTexts.changed" event: a Linked folder was unlinked. */
  emitKept?: (kept: KeptCitationText[]) => void;
  /** Folders changed: push "folders.changed". */
  foldersChanged(): void;
  /** Pushes "linkedFolders.changed". */
  linkedFoldersChanged: LibraryHooks["linkedFoldersChanged"];
  /** A Document just became ready, i.e. searchable: called before its status is pushed. */
  onReady?: (documentId: string) => void;
  /** A scan found a new Document, announced but not yet queued for processing. */
  onFound?: (documentId: string) => void;
  /** Asks iCloud Drive to download a file an ".icloud" stub stands for. */
  downloadStub?: (path: string) => Promise<void>;
  /**
   * The Units the Citations in Minds point to in these Documents, and those
   * features retain: kept when the Documents leave the index with their
   * Linked folder. None if not given.
   */
  citedUnits?: (documentIds: readonly string[]) => CitedUnits[];
  /**
   * Reads scanned pages (#397). Absent (tests that don't need it): a PDF's
   * scanned pages are left with the little text they have, as before.
   */
  textRecognition?: TextRecognitionModel;
  /** How many scans are read at once (./processor, `scansAtOnce`). */
  scansAtOnce?: number;
  /** The password kept for a locked PDF (./pdfPasswords, #763); undefined when none is. */
  pdfPassword?(documentId: string): Promise<string | undefined>;
  readingSpeed: Pick<ReadingMeterOptions, "read" | "write">;
  linkedFolders: {
    watch: WatchFolder;
    stat: StatIdentity;
    retryMs: number;
    detectDataless: boolean;
  };
  reportError?: (error: unknown) => void;
  log?: Logger;
}

/** Which Documents `list` returns. Every condition given must match. */
export interface DocumentFilter {
  /** Only Documents in one of these Folders. */
  folderIds?: readonly string[];
  /** Only Documents carrying this Tag, if it isn't deleted. */
  tagId?: string;
  /** Only these Documents. */
  ids?: readonly string[];
  /** Only this Linked folder's Documents, or with null, files added on their own. */
  linkedFolderId?: string | null;
  /** Leave out missing Documents: new searches don't look at them. */
  searchable?: boolean;
}

// A file named "2306.10683v1" says nothing of what is in it: the model gets its title too. A
// title taken from a first line that is a sentence, as a text file's is, says no more than a search.
const withTitle = (name: string, title: string | null) => {
  const shown = title?.replace(/\s+/g, " ").trim() ?? "";
  const same = (a: string) => a.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const heading = shown.length <= 160 && !/[.!?。！？]$/.test(shown);
  return heading && shown && !same(name).includes(same(shown)) ? `${name} (“${shown}”)` : name;
};

export function createDocuments(options: DocumentsOptions) {
  const { db, dataDir, now, model, emitStatus } = options;
  const reportError = options.reportError ?? ((error: unknown) => console.error(error));
  const log = options.log ?? silentLogger;
  const vectors = createVectorIndex(db, model);
  const legacyFolder = join(dataDir, "documents");
  const { textRecognition } = options;
  /** Where reading each Document's scanned pages is, while its job reads them (#397). */
  const scanProgress = new Map<string, DocumentScanProgress>();

  /** The scanned pages of a Document's current version that couldn't be read (see "pages-unread"). */
  const unreadPages = (row: Pick<DocumentRow, "id" | "content_hash">): number[] =>
    db
      .all<{ page: number }>(
        `SELECT page FROM document_pages
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL
           AND json_extract(label, '$.scan.unread') = 1
         ORDER BY page`,
        [row.id, row.content_hash],
      )
      .map((each) => each.page);

  /**
   * The share of a Document's Passages embedded so far with the current model:
   * none while it waits its turn after a switch, holding another model's vectors.
   */
  const progressOf = (row: DocumentRow): number => {
    if (row.embedding_model !== model.id) return 0;
    const counts = db.get<{ total: number; embedded: number }>(
      `SELECT count(*) AS total, count(embedding) AS embedded FROM passages
       WHERE document_id = ? AND deleted_at IS NULL`,
      [row.id],
    );
    return counts && counts.total > 0 ? counts.embedded / counts.total : 0;
  };

  /**
   * The status shown: stored "embedding" is the Document being embedded, or
   * one waiting its turn, which is queued (see `EmbeddingQueue.isEmbedding`);
   * a failure kept with a good version is "failed" (see `failedNow`).
   */
  const statusOf = (row: DocumentRow): DocumentStatus => {
    if (failedNow(row)) return "failed";
    if (row.status === "embedding" && !embedding.isEmbedding(row.id)) return "queued";
    return row.status as DocumentStatus;
  };

  /** The Mind a file was last imported as, still there (#720). */
  const importedMindOf = (documentId: string): string | null =>
    db.get<{ mind_id: string }>(
      `SELECT p.mind_id FROM word_packages p JOIN minds m ON m.id = p.mind_id
       WHERE p.document_id = ? AND p.deleted_at IS NULL AND m.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`,
      [documentId],
    )?.mind_id ?? null;

  // A damaged `unread_parts` is said once for each Document: a list reads every Document again
  // and again, and the log would fill with the same line.
  const loggedUnreadParts = new Set<string>();
  const toDocument = (row: DocumentRow): Document => {
    const unreadParts = parseUnreadParts(row.unread_parts);
    const unreadPartsUnknown = row.unread_parts !== null && unreadParts === null;
    if (unreadPartsUnknown && !loggedUnreadParts.has(row.id)) {
      loggedUnreadParts.add(row.id);
      log.warn("documents.unreadPartsUnreadable", { documentId: row.id });
    }
    const tagging = taggingOf(row.status, row.tagging_status);
    const status = statusOf(row);
    const failed = status === "failed";
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as DocumentKind,
      contentHash: row.content_hash,
      path: row.path,
      fileStatus: row.file_status as DocumentFileStatus,
      keptByApp: row.source_kind === "data-folder",
      linkedFolderId: row.linked_folder_id,
      size: row.size,
      pageCount: row.page_count,
      status,
      progress: status === "embedding" ? progressOf(row) : null,
      scan:
        status === "extracting" || status === "queued" ? (scanProgress.get(row.id) ?? null) : null,
      failure: failed
        ? {
            reason: (row.failure_reason ?? "processing-error") as DocumentFailureReason,
            message: row.failure_message ?? "",
            ...(row.failure_reason === "pages-unread" && { pages: unreadPages(row) }),
          }
        : null,
      unreadParts,
      unreadPartsUnknown,
      folderId: row.folder_id,
      tags: tagsOfDocument(db, row.id),
      tagging,
      // Why it failed, or why it waits when that is worth saying (a plan's or a rate limit).
      taggingError:
        tagging === "failed" || (tagging === "waiting-for-provider" && row.tagging_error_kind)
          ? {
              kind: (row.tagging_error_kind ?? "unknown") as ProviderErrorKind,
              message: row.tagging_error_message ?? "",
              ...(row.tagging_error_resets_at !== null && {
                resetsAt: row.tagging_error_resets_at,
              }),
            }
          : null,
      creationDate:
        row.creation_date && !isPlaceholderDate(row.creation_date) ? row.creation_date : null,
      modifiedAt: row.file_mtime_ms === null ? null : new Date(row.file_mtime_ms).toISOString(),
      title: row.title,
      web: row.kind === "web" ? webPageInfo(db, row.id) : null,
      reference: referenceOf(db, row.id),
      ownFile: ownFileOf(row),
      notCited: row.not_cited === 1,
      found: foundSourceOf(db, row.id),
      importedAs: importedMindOf(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const find = (id: string) =>
    db.get<DocumentRow>(`SELECT ${COLUMNS} FROM documents WHERE id = ? AND deleted_at IS NULL`, [
      id,
    ]);

  // Set below, once the library exists: Linked folders' progress follows their Documents.
  let progressed = (_linkedFolderId: string | null) => {};

  /**
   * Documents whose embeddings are being made again, their Passages as they
   * were: reporting them is no change Organize should file (#2023).
   */
  const reembedding = new Set<string>();

  const announce = (id: string, unchanged = false) => {
    const row = find(id);
    if (!row) return;
    const reembedded = reembedding.has(id);
    // Its re-embed ended, ready or failed: a Retry from here is a new run, filed as on main (#2023).
    if (reembedded && (row.status === "ready" || row.status === "failed")) reembedding.delete(id);
    emitStatus(toDocument(row), unchanged || reembedded);
    progressed(row.linked_folder_id);
  };

  /**
   * At startup, what Citations point to in the PDFs whose pages an older
   * reader read, found in one walk over the Minds for all of them (see `keptScans`).
   */
  let citedAtStart: ReadonlyMap<string, CitedUnits[]> | null = null;

  /**
   * The scanned pages a job keeps as they were read (see `ScanJob.keep`):
   * those of the version indexed read by today's reader, those a Citation
   * quotes or a feature retains, and those a job read before it was stopped.
   */
  function keptScans(row: Pick<DocumentRow, "id" | "content_hash">): ScanJob["keep"] {
    const reader = textRecognition?.reader;
    const stored = db
      .all<UnitRow>(
        `SELECT page, text, kind, label, anchors FROM document_pages
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL
           AND json_extract(label, '$.scan.reader') IS NOT NULL
           AND json_extract(label, '$.scan.unread') IS NOT 1
         ORDER BY page`,
        [row.id, row.content_hash],
      )
      .map(toUnitText);
    // Only when a page was read by an older reader do Citations need looking for.
    const older = stored.some((unit) => unit.label?.scan?.reader !== reader);
    const cited = new Set<number>();
    if (older) {
      for (const units of citedAtStart?.get(row.id) ?? options.citedUnits?.([row.id]) ?? []) {
        if (units.contentHash !== null && units.contentHash !== row.content_hash) continue;
        for (const unit of stored) {
          const page = unit.page ?? 0;
          if (units.pageFrom === null || units.pageTo === null) cited.add(page);
          else if (page >= units.pageFrom && page <= units.pageTo) cited.add(page);
        }
      }
    }
    const keep = new Map<number, TextUnit>();
    for (const unit of stored) {
      const page = unit.page ?? 0;
      if (unit.label?.scan?.reader === reader || cited.has(page)) {
        keep.set(page, {
          page,
          kind: unit.kind ?? "page",
          label: unit.label ?? null,
          text: unit.text,
          anchors: unit.anchors ?? null,
        });
      }
    }
    const unfinished = unfinishedScan(row);
    if (unfinished) return unfinished;
    return keep.size > 0 ? { contentHash: row.content_hash, units: [...keep.values()] } : null;
  }

  // A read that a quit, a crash or a stop ended leaves the pages of a version not yet indexed
  // (#1504); the job uses them only if the file is still that version.
  function unfinishedScan(row: Pick<DocumentRow, "id" | "content_hash">): ScanJob["keep"] {
    const latest = db.get<{ content_hash: string }>(
      `SELECT content_hash FROM document_pages
       WHERE document_id = ? AND deleted_at IS NULL
         AND json_extract(label, '$.scan.reader') IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [row.id],
    );
    if (!latest || latest.content_hash === row.content_hash) return null;
    const units = db
      .all<UnitRow>(
        `SELECT page, text, kind, label, anchors FROM document_pages
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL
           AND json_extract(label, '$.scan.reader') = ?
           AND json_extract(label, '$.scan.unread') IS NOT 1
         ORDER BY page`,
        [row.id, latest.content_hash, textRecognition?.reader ?? ""],
      )
      .map(toUnitText)
      .map(
        (unit): TextUnit => ({
          page: unit.page ?? 0,
          kind: unit.kind ?? "page",
          label: unit.label ?? null,
          text: unit.text,
          anchors: unit.anchors ?? null,
        }),
      );
    return units.length > 0 ? { contentHash: latest.content_hash, units } : null;
  }

  // Written as soon as it is read, so a quit or a crash keeps it (#1504); the finished read
  // writes them all again.
  function keepScannedPage(documentId: string, contentHash: string, unit: TextUnit): void {
    db.transaction(() => {
      // A job stopped meanwhile read it all the same: the next one keeps it.
      if (!find(documentId)) return;
      const at = now();
      db.run(
        `UPDATE document_pages SET deleted_at = ?, updated_at = ?
         WHERE document_id = ? AND content_hash = ? AND page = ? AND deleted_at IS NULL`,
        [at, at, documentId, contentHash, BigInt(unit.page)],
      );
      insertPages(documentId, contentHash, [unit]);
    });
  }

  const jobFor = (
    row: Pick<DocumentRow, "id" | "kind" | "path" | "content_hash">,
  ): ProcessingJob => ({
    task: "process",
    documentId: row.id,
    kind: row.kind as DocumentKind,
    file: row.path,
    scan:
      textRecognition && row.kind === "pdf"
        ? { reader: textRecognition.reader, keep: keptScans(row) }
        : textRecognition && row.kind === "web"
          ? { reader: textRecognition.reader, keep: null }
          : null,
  });

  const setStatus = (id: string, status: DocumentStatus) =>
    db.run("UPDATE documents SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);

  // Set below, once the library exists.
  let isPaused = (_documentId: string) => false;

  const reading = createReadingMeter({
    ...options.readingSpeed,
    clock: () => performance.now(),
    embedding: () => (model.enabled() ? model.id : ""),
    reportError,
  });

  const embedding = createEmbeddingQueue({
    db,
    now,
    model,
    vectors,
    announce,
    onReady: options.onReady,
    onEmbedded: (id, ms) => reading.embedded(id, ms),
    isPaused: (id) => isPaused(id),
  });

  /** Adds a Passage to the keyword index, under the `seq` it was stored with. */
  const index = (seq: number, text: string) =>
    db.run("INSERT INTO passages_fts (rowid, text) VALUES (?, ?)", [BigInt(seq), text]);

  /**
   * Indexes a Document's name, once for all its Passages, in the name's own
   * index, whose document frequency counts Documents (#2042). Run in a
   * transaction.
   */
  function indexName(id: string, name: string): void {
    db.run("DELETE FROM document_names_fts WHERE document_id = ?", [id]);
    const keywords = keywordText(name);
    if (keywords !== "") {
      db.run("INSERT INTO document_names_fts (document_id, text) VALUES (?, ?)", [id, keywords]);
    }
  }

  /**
   * Rewrites a Document's live Passages' index rows: from the words its
   * processing gave each of them, keyed by position, or else from its stored
   * text. Run in a transaction.
   */
  function reindexPassages(id: string, keywords?: ReadonlyMap<number, string>): void {
    const passages = db.all<{ seq: number; position: number; text: string }>(
      "SELECT seq, position, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [id],
    );
    for (const { seq, position, text } of passages) {
      db.run("DELETE FROM passages_fts WHERE rowid = ?", [BigInt(seq)]);
      index(seq, keywords?.get(position) ?? keywordText(text));
    }
  }

  /**
   * Stores the text of a version's Units (pages, slides, sections, rows,
   * lines), with their labels and anchors, for the Citation check and the
   * viewer. Run in a transaction.
   */
  function insertPages(documentId: string, contentHash: string, pages: readonly PageText[]): void {
    const at = now();
    for (const { page, text, kind, label, anchors } of pages) {
      db.run(
        `INSERT INTO document_pages (id, document_id, content_hash, page, kind, label, anchors,
           text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          documentId,
          contentHash,
          page === null ? null : BigInt(page),
          kind ?? "page",
          label ? JSON.stringify(label) : null,
          anchors && anchors.length > 0 ? JSON.stringify(anchors) : null,
          text,
          at,
          at,
        ],
      );
    }
  }

  /** Stores a version's Passages and indexes them. Run in a transaction. */
  function insertPassages(
    documentId: string,
    contentHash: string,
    passages: ProcessedPassage[],
  ): void {
    const at = now();
    for (const passage of passages) {
      const stored = db.get<{ seq: number }>(
        `INSERT INTO passages (id, document_id, content_hash, position, page_from, page_to,
           window_from, window_to, text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING seq`,
        [
          randomUUID(),
          documentId,
          contentHash,
          BigInt(passage.position),
          passage.pageFrom === null ? null : BigInt(passage.pageFrom),
          passage.pageTo === null ? null : BigInt(passage.pageTo),
          BigInt(passage.windowFrom),
          BigInt(passage.windowTo),
          passage.text,
          at,
          at,
        ],
      );
      if (!stored) throw new Error("The Passage wasn't saved.");
      index(stored.seq, passage.keywords);
    }
  }

  /** Whether a Document's live Passages are exactly these, in order. */
  function samePassages(documentId: string, passages: readonly ProcessedPassage[]): boolean {
    const live = db.all<{
      position: number;
      page_from: number | null;
      page_to: number | null;
      window_from: number;
      window_to: number;
      text: string;
    }>(
      `SELECT position, page_from, page_to, window_from, window_to, text FROM passages
       WHERE document_id = ? AND deleted_at IS NULL ORDER BY position`,
      [documentId],
    );
    return (
      live.length === passages.length &&
      live.every((stored, index) => {
        const passage = passages[index] as ProcessedPassage;
        return (
          stored.position === passage.position &&
          stored.page_from === passage.pageFrom &&
          stored.page_to === passage.pageTo &&
          stored.window_from === passage.windowFrom &&
          stored.window_to === passage.windowTo &&
          stored.text === passage.text
        );
      })
    );
  }

  /**
   * How re-reading a PDF changed the text of its pages: not at all, only by
   * joining wrapped lines, or otherwise.
   */
  function pageTextChange(
    documentId: string,
    contentHash: string,
    pages: readonly PageText[],
  ): "same" | "wraps" | "changed" {
    const stored = db.all<{ page: number | null; text: string }>(
      `SELECT page, text FROM document_pages
       WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page`,
      [documentId, contentHash],
    );
    if (stored.length !== pages.length) return "changed";
    let changed = false;
    for (const [index, unit] of pages.entries()) {
      const earlier = stored[index] as { page: number | null; text: string };
      if (earlier.page !== unit.page) return "changed";
      if (earlier.text === unit.text) continue;
      if (!onlyCjkLineWrapChange(earlier.text, unit.text)) return "changed";
      changed = true;
    }
    return changed ? "wraps" : "same";
  }

  /**
   * Joins the stored Passages' wrapped lines in place, so their ids, vectors
   * and windows stay, and refreshes their keyword rows. Run in a transaction.
   */
  function joinStoredPassages(documentId: string, at: string): void {
    const rows = db.all<{ seq: number; text: string }>(
      "SELECT seq, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [documentId],
    );
    let changed = false;
    for (const { seq, text } of rows) {
      const joined = joinCjkLineWraps(text);
      if (joined === text) continue;
      db.run("UPDATE passages SET text = ?, updated_at = ? WHERE seq = ?", [
        joined,
        at,
        BigInt(seq),
      ]);
      changed = true;
    }
    if (changed) reindexPassages(documentId);
  }

  /**
   * Whether the stored Passages still run through the pages' text from start
   * to end, as a join keeps them: a Passage read from an older, shorter scan
   * leaves the rest uncovered.
   */
  function passagesFitPages(documentId: string, pages: readonly PageText[]): boolean {
    const text = laidOut(pages);
    if (text === "") return false;
    const rows = db.all<{ text: string }>(
      "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [documentId],
    );
    if (rows.length === 0) return false;
    let from = 0;
    let end = 0;
    for (const [index, row] of rows.entries()) {
      const joined = joinCjkLineWraps(row.text);
      const at = text.indexOf(joined, from);
      if (at === -1 || (index === 0 && at !== 0)) return false;
      from = at;
      end = at + joined.length;
    }
    return end === text.length;
  }

  /**
   * The status of a Document whose new version couldn't be indexed (its file
   * couldn't be read, or what was read couldn't be processed): the version
   * indexed before stays, so it is ready again if all of it is embedded with
   * the current model, or embeddings are off, otherwise it goes back to
   * embedding. Null if no version has Passages indexed.
   */
  function indexedStatus(row: DocumentRow): DocumentStatus | null {
    const counts = db.get<{ total: number; embedded: number }>(
      `SELECT count(*) AS total, count(embedding) AS embedded FROM passages
       WHERE document_id = ? AND deleted_at IS NULL`,
      [row.id],
    );
    if (!counts || counts.total === 0) return null;
    if (!model.enabled()) return "ready";
    if (counts.embedded === counts.total && row.embedding_model === model.id) return "ready";
    return model.isReady() ? "embedding" : "waiting-for-model";
  }

  /** What `record` wrote: the Document's status, and whether its Passages were replaced. */
  interface Recorded {
    status: DocumentStatus;
    replaced: boolean;
  }

  /**
   * Writes a job's result: the version read replaces the Passages of an
   * earlier processing, and its pages replace those of the same version;
   * other versions' pages stay for their Citations, and its creation date
   * replaces the Document's. A version that can't be processed (a file a
   * sync client has only half written, a corrupt one) replaces nothing,
   * creation date included: the last good version stays indexed and
   * searched, and the failure is recorded with it (see `failedNow`), until
   * a later version or a retry is read. Only a Document with no version
   * indexed fails outright. Nothing is written if the Document was deleted
   * or queued again meanwhile. Returns what it wrote, if it did.
   */
  function record(job: ProcessingJob, result: ProcessingResult): Recorded | undefined {
    if (result.outcome === "stopped") return undefined;
    return db.transaction(() => {
      const row = find(job.documentId);
      if (row?.status !== "extracting") return undefined;
      indexName(row.id, row.name);
      // A version that can't be read keeps the rows of its last good one, which still hold the
      // name from an older pipeline; its name match would then count twice (#2042).
      if (result.outcome !== "ready" && row.processing_version < NAME_INDEX_CURRENT_SINCE) {
        reindexPassages(row.id);
        // The rows are this version's now; the Passages they were built from, and so the
        // version the next start reads the file for, are not (#2185).
        db.run("UPDATE documents SET keywords_version = ? WHERE id = ?", [
          BigInt(PROCESSING_VERSION),
          row.id,
        ]);
      }
      const at = now();
      if (result.outcome === "file-unreadable") {
        const status = indexedStatus(row) ?? "queued";
        // Gone, or not readable now: the library works out which, and tells.
        // The modified time is forgotten, so the file is read again once it
        // can be, and a version still to process isn't taken as indexed.
        db.run(
          `UPDATE documents SET status = ?, file_status = ?, file_mtime_ms = NULL, updated_at = ?
           WHERE id = ?`,
          [status, result.gone ? row.file_status : "unavailable", at, row.id],
        );
        return { status, replaced: false };
      }
      if (result.outcome === "crashed" || result.outcome === "failed") {
        const kept = indexedStatus(row);
        if (kept !== null) {
          // Its content hash, Passages, pages and vectors are the last good version's still.
          db.run(
            `UPDATE documents SET status = ?, failure_reason = ?, failure_message = ?, updated_at = ?
             WHERE id = ?`,
            [
              kept,
              result.outcome === "failed" ? result.reason : "processing-error",
              result.message,
              at,
              row.id,
            ],
          );
          return { status: kept, replaced: false };
        }
      }
      // The same version processed again into the same Passages (a PDF whose short pages
      // turned out not to be scans, #397) keeps them, their vectors and their keywords,
      // which were built as they would be now since version 6: nothing to embed again.
      const reread = result.outcome === "ready" && result.contentHash === row.content_hash;
      const pageChange =
        reread && row.kind === "pdf"
          ? pageTextChange(row.id, result.contentHash, result.pages)
          : "changed";
      // A re-read that only joins wrapped lines keeps the Passages it had, their ids, windows
      // and vectors: the text is the same words, so nothing is embedded again (#2110). A scan
      // page kept while it was read can leave a Passage set that no longer covers the text.
      const coversText =
        reread &&
        row.kind === "pdf" &&
        pageChange !== "changed" &&
        passagesFitPages(row.id, result.pages);
      // Only a Document with no scanned page: a Passage of a scan would take a joined line
      // its page never took.
      const joinable =
        coversText && result.outcome === "ready" && result.pages.every((unit) => !unit.label?.scan);
      if (
        reread &&
        row.processing_version >= HAN_CURRENT_SINCE &&
        pageChange === "wraps" &&
        joinable
      ) {
        joinStoredPassages(row.id, at);
      }
      // A Document kept that way has Passages whose windows an older build chose; a later
      // pipeline (a version past its kind's) starts the Passages afresh.
      const keptWindows =
        coversText &&
        pageChange === "same" &&
        row.processing_version >=
          ((CURRENT_SINCE as Readonly<Record<string, number>>)[row.kind] ?? PROCESSING_VERSION);
      const passagesSame = reread && samePassages(row.id, result.passages);
      const unchanged =
        reread &&
        row.processing_version >= HAN_CURRENT_SINCE &&
        (passagesSame || keptWindows || (pageChange === "wraps" && joinable));
      // Its Passages are the ones it had, and so are their vectors; its index, built before
      // NAME_INDEX_CURRENT_SINCE, still holds its name in every Passage's row (#2042). Kept
      // windows and joined in place Passages aren't the rebuilt ones, so the words come from
      // the stored text, never from a rebuilt Passage at the same position.
      if (unchanged && row.processing_version < NAME_INDEX_CURRENT_SINCE) {
        if (passagesSame) {
          reindexPassages(
            row.id,
            new Map(result.passages.map((passage) => [passage.position, passage.keywords])),
          );
        } else {
          reindexPassages(row.id);
        }
      }
      if (!unchanged) {
        // Its content is new: Organize sees the Document anew (#2023).
        reembedding.delete(job.documentId);
        db.run(
          `UPDATE passages SET deleted_at = ?, updated_at = ?, embedding = NULL
           WHERE document_id = ? AND deleted_at IS NULL`,
          [at, at, job.documentId],
        );
      }
      if (result.outcome === "crashed") {
        db.run(
          `UPDATE documents SET status = 'failed', failure_reason = 'processing-error',
             failure_message = ?, unread_parts = NULL, updated_at = ? WHERE id = ?`,
          [result.message, at, job.documentId],
        );
        return { status: "failed", replaced: true };
      }
      db.run(
        `UPDATE document_pages SET deleted_at = ?, updated_at = ?
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL`,
        [at, at, job.documentId, result.contentHash],
      );
      let status: DocumentStatus;
      if (result.outcome === "ready") {
        if (!unchanged) {
          insertPassages(job.documentId, result.contentHash, result.passages);
        }
        insertPages(job.documentId, result.contentHash, result.pages);
        // Searchable now, by its words: while embeddings are off, that is all there is to do.
        status = unchanged
          ? (indexedStatus(row) ?? "ready")
          : !model.enabled()
            ? "ready"
            : model.isReady()
              ? "embedding"
              : "waiting-for-model";
      } else {
        status = result.outcome;
      }
      // A partial read keeps the readable text searchable (#397, #1818).
      const failure =
        result.outcome === "failed"
          ? { reason: result.reason, message: result.message }
          : result.outcome === "ready" && result.unread
            ? {
                reason: result.unread.forms ? "forms-unread" : "pages-unread",
                message: unreadMessage(result.unread),
              }
            : null;
      const parts =
        result.outcome === "failed" || result.parts == null ? null : JSON.stringify(result.parts);
      db.run(
        `UPDATE documents SET status = ?, page_count = ?, failure_reason = ?, failure_message = ?,
           unread_parts = ?, processing_version = ?, keywords_version = ?, embedding_model = ?,
           embedding_dimensions = CASE WHEN ? THEN embedding_dimensions END,
           content_hash = ?, size = ?, file_status = 'available', creation_date = ?,
           title = ?, metadata_version = ?, updated_at = ?
         WHERE id = ?`,
        [
          status,
          result.outcome === "failed" || result.pageCount === null
            ? null
            : BigInt(result.pageCount),
          failure?.reason ?? null,
          failure?.message ?? null,
          parts,
          BigInt(PROCESSING_VERSION),
          BigInt(PROCESSING_VERSION),
          unchanged ? row.embedding_model : status === "embedding" ? model.id : null,
          unchanged ? 1 : 0,
          result.contentHash,
          result.size,
          result.creationDate,
          result.title,
          BigInt(METADATA_VERSION),
          at,
          job.documentId,
        ],
      );
      // What the User edited, or Look up filled, stays; the rest is this version's.
      writeFileReference(db, job.documentId, result.reference, at);
      return { status, replaced: !unchanged };
    });
  }

  // Set below, once the library exists: works out whether an unreadable file is gone.
  let checkFile = (_path: string) => {};

  /**
   * Sends the next stale Document's keyword job; called after each one answers.
   * Null while none is under way (#2042).
   */
  let keywordUpgradeNext: (() => void) | null = null;

  /**
   * Rewrites the keyword rows of the Documents an older version indexed, one
   * Document per job and per transaction, after the first window: the worker
   * segments each Passage's stored text off the core's thread, and the name row,
   * the rows and the keyword version are written together, so no word of a name
   * is ever counted twice (#2042). Its Passages, and the version that says which
   * pipeline read them, are left as the last read left them (#2185).
   */
  function upgradeKeywordIndex(): void {
    if (closed || keywordUpgradeNext) return;
    const stale = db.all<{ id: string }>(
      `SELECT id FROM documents d
       WHERE d.deleted_at IS NULL AND d.keywords_version < ?
         AND d.status IN ('ready', 'embedding', 'waiting-for-model')
         AND EXISTS (SELECT 1 FROM passages p
                     WHERE p.document_id = d.id AND p.deleted_at IS NULL)
       ORDER BY d.created_at, d.rowid`,
      [BigInt(NAME_INDEX_CURRENT_SINCE)],
    );
    const queue = stale.map((row) => row.id);
    const next = () => {
      for (;;) {
        if (closed) {
          keywordUpgradeNext = null;
          return;
        }
        const id = queue.shift();
        if (id === undefined) {
          keywordUpgradeNext = null;
          return;
        }
        const row = find(id);
        if (!row || row.keywords_version >= NAME_INDEX_CURRENT_SINCE) continue;
        const passages = db.all<{ seq: number; text: string }>(
          `SELECT seq, text FROM passages
           WHERE document_id = ? AND deleted_at IS NULL ORDER BY position`,
          [id],
        );
        if (passages.length === 0) continue;
        processor.enqueue({
          task: "keywords",
          documentId: id,
          contentHash: row.content_hash ?? "",
          passages,
        });
        return;
      }
    };
    keywordUpgradeNext = next;
    next();
  }

  /** Writes one Document's upgraded keyword rows, or drops a result it is too late for. */
  function writeKeywordUpgrade(job: KeywordsJob, result: WorkerResult): void {
    if (result.outcome !== "keywords" || result.documentId !== job.documentId) return;
    const row = find(job.documentId);
    if (!row || row.keywords_version >= NAME_INDEX_CURRENT_SINCE) return;
    if ((row.content_hash ?? "") !== job.contentHash) return;
    const live = new Set(
      db
        .all<{ seq: number }>(
          "SELECT seq FROM passages WHERE document_id = ? AND deleted_at IS NULL",
          [job.documentId],
        )
        .map((each) => each.seq),
    );
    db.transaction(() => {
      const found = find(job.documentId);
      if (!found) return;
      indexName(found.id, found.name);
      for (const { seq, keywords } of result.passages) {
        if (!live.has(seq)) continue;
        db.run("DELETE FROM passages_fts WHERE rowid = ?", [BigInt(seq)]);
        db.run("INSERT INTO passages_fts (rowid, text) VALUES (?, ?)", [BigInt(seq), keywords]);
      }
      // The rows are this version's; the Passages they were built from are not, and only a
      // read can say they are (#2185).
      db.run("UPDATE documents SET keywords_version = ? WHERE id = ?", [
        BigInt(PROCESSING_VERSION),
        found.id,
      ]);
    });
  }

  const processor = createProcessor({
    scansAtOnce: options.scansAtOnce,
    onStart(job, warm) {
      reading.started(job.documentId, warm);
      const row = find(job.documentId);
      if (row?.status !== "queued") return undefined;
      setStatus(job.documentId, "extracting");
      announce(job.documentId);
      // A job queued again while one before it ran keeps the pages that one read meanwhile.
      return job.scan ? { ...job, scan: { ...job.scan, keep: keptScans(row) } } : undefined;
    },
    onWaiting(job) {
      // Queued, a quit doesn't count it as what stopped the app; its scan progress, kept, says
      // it is a scan waiting its turn.
      if (find(job.documentId)?.status !== "extracting") return;
      setStatus(job.documentId, "queued");
      announce(job.documentId);
    },
    onProgress(job, { contentHash, read, of, unit }) {
      scanProgress.set(job.documentId, {
        pages: of,
        read,
        of: job.kind === "web" ? "pictures" : "scanned-pages",
      });
      // A page that couldn't be read is read again by the next job; a web page's pictures are few.
      if (unit && job.kind === "pdf" && !unit.label?.scan?.unread) {
        keepScannedPage(job.documentId, contentHash, unit);
      }
      announce(job.documentId);
    },
    read(_job, page, picture) {
      if (!textRecognition) {
        return Promise.reject(new TextRecognitionUnavailableError("Scanned pages can't be read."));
      }
      return textRecognition.read(picture, page);
    },
    onLog(job, { event, fields }) {
      log.warn(event, { documentId: job.documentId, ...fields });
    },
    readFile(_job, page, file) {
      if (!textRecognition) {
        return Promise.reject(new TextRecognitionUnavailableError("Pictures can't be read."));
      }
      return textRecognition.readFile(file, page);
    },
    isUnavailable: (error) => error instanceof TextRecognitionUnavailableError,
    password: async (job) => options.pdfPassword?.(job.documentId),
    onKeywords(job, result) {
      try {
        writeKeywordUpgrade(job, result);
      } finally {
        keywordUpgradeNext?.();
      }
    },
    onResult(job, result) {
      const scanned = scanProgress.delete(job.documentId);
      const recorded = record(job, result);
      if (recorded === undefined) return; // deleted, or queued again, while processing
      const { status, replaced } = recorded;
      if (result.outcome === "ready" && !scanned) {
        reading.processed(job.documentId, job.kind, result.size, status === "ready");
      }
      // Any vectors from an earlier processing went with the old Passages.
      if (replaced) vectors.removeDocument(job.documentId);
      if (result.outcome === "file-unreadable") {
        if (find(job.documentId)?.path !== job.file) {
          // The file moved while it was being read: read it where it is now.
          announce(job.documentId);
          process(job.documentId);
          return;
        }
        checkFile(job.file);
      }
      if (status === "ready") {
        // The version indexed before, ready again: tagged, if it still needs to be.
        try {
          options.onReady?.(job.documentId);
        } catch (error) {
          reportError(error);
        }
      }
      // Its turn to be embedded may come at once: then the queue has announced it.
      if (!(status === "embedding" && embedding.enqueue(job.documentId))) {
        announce(job.documentId);
      }
      if (status === "waiting-for-model") model.ensure();
    },
    onMetadata(job, result) {
      metadataQueued = false;
      if (result.outcome === "read") {
        // Only for the version read, and unless processing it again read it meanwhile.
        const written = db.transaction(() => {
          const at = now();
          const updated = db.get<{ id: string }>(
            `UPDATE documents SET creation_date = ?, title = ?, metadata_version = ?, updated_at = ?
             WHERE id = ? AND content_hash = ? AND metadata_version < ? AND deleted_at IS NULL
             RETURNING id`,
            [
              result.creationDate,
              result.title,
              BigInt(METADATA_VERSION),
              at,
              job.documentId,
              job.contentHash,
              BigInt(METADATA_VERSION),
            ],
          );
          if (updated) writeFileReference(db, job.documentId, result.reference, at);
          return updated !== undefined;
        });
        // Its reference record is new, whatever else was found.
        const row = written ? find(job.documentId) : undefined;
        if (row) emitStatus(toDocument(row));
      } else {
        // The file changed (processing the new version reads its date), can't
        // be read now, or stopped the worker: tried again at the next start.
        metadataSkipped.add(job.documentId);
      }
      readNextMetadata();
    },
  });

  /** Documents whose metadata job didn't read their metadata this session (see `readNextMetadata`). */
  const metadataSkipped = new Set<string>();
  /** Whether a metadata job is queued or under way: there is at most one. */
  let metadataQueued = false;
  let closed = false;

  /**
   * The one-time fill of creation dates (#53): queues a metadata job for the
   * next Document whose metadata this version hasn't read (see
   * `METADATA_VERSION`; every Document from before migration 24), most
   * recently added first. Its text isn't extracted again and nothing is
   * embedded: the job reads the creation date in the file's metadata, and
   * the year written in the stored first Unit. One job at a time, each
   * queued when the last is done, so processing jobs queued meanwhile go
   * first. Documents being processed (which reads their date), in a paused
   * Linked folder, whose file isn't there, or skipped this session wait for
   * a later turn: at the next start, or when their folder is resumed.
   */
  function readNextMetadata(): void {
    if (closed || metadataQueued) return;
    const row = db.get<Pick<DocumentRow, "id" | "kind" | "path" | "content_hash">>(
      `SELECT d.id, d.kind, d.path, d.content_hash FROM documents d
       WHERE d.deleted_at IS NULL AND d.metadata_version < ?
         AND d.status NOT IN ('queued', 'extracting') AND d.file_status = 'available'
         AND d.id NOT IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM linked_folders l
                         WHERE l.id = d.linked_folder_id AND l.paused = 1 AND l.deleted_at IS NULL)
       ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
      [BigInt(METADATA_VERSION), JSON.stringify([...metadataSkipped])],
    );
    if (!row) return;
    const firstUnit = db.get<{ text: string }>(
      `SELECT text FROM document_pages
       WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL
       ORDER BY page LIMIT 1`,
      [row.id, row.content_hash],
    );
    metadataQueued = true;
    processor.enqueue({
      task: "metadata",
      documentId: row.id,
      kind: row.kind as DocumentKind,
      file: row.path,
      contentHash: row.content_hash,
      firstUnit: firstUnit?.text ?? null,
    });
  }

  /**
   * Queues a Document for processing, replacing a job not yet started. A
   * paused Linked folder's Documents wait, queued, until it is resumed. A
   * failure recorded with it is forgotten: the result decides again.
   */
  function process(id: string): void {
    const row = find(id);
    if (!row) return;
    processor.cancel(id);
    if (row.status !== "queued" || row.failure_reason !== null) {
      db.run(
        `UPDATE documents SET status = 'queued', failure_reason = NULL, failure_message = NULL,
           updated_at = ? WHERE id = ?`,
        [now(), id],
      );
      announce(id);
    }
    if (!isPaused(id)) processor.enqueue(jobFor(row));
  }

  /**
   * The stored Units (`document_pages` ids) Citations' checks read, as
   * `pageTexts` does: of the version each quotes (or every version, if it
   * doesn't say), its Units (or all of them, for a whole file).
   */
  function unitsToKeep(cited: readonly CitedUnits[], deletedWith?: string): string[] {
    const ids = new Set<string>();
    const seen = new Set<string>();
    for (const units of cited) {
      const key = JSON.stringify(units);
      if (seen.has(key)) continue;
      seen.add(key);
      const conditions = ["document_id = ?"];
      const params: SqlValue[] = [units.documentId];
      if (deletedWith === undefined) conditions.push("deleted_at IS NULL");
      else {
        conditions.push("(deleted_at IS NULL OR deleted_at = ?)");
        params.push(deletedWith);
      }
      if (units.contentHash !== null) {
        conditions.push("content_hash = ?");
        params.push(units.contentHash);
      }
      if (units.pageFrom !== null && units.pageTo !== null) {
        conditions.push("page BETWEEN ? AND ?");
        params.push(BigInt(units.pageFrom), BigInt(units.pageTo));
      }
      const rows = db.all<{ id: string }>(
        `SELECT id FROM document_pages WHERE ${conditions.join(" AND ")}`,
        params,
      );
      for (const row of rows) ids.add(row.id);
    }
    return [...ids];
  }

  /**
   * The stored text of one version of a live Document, Units (pages,
   * slides, sections, rows, lines) `from` to `to`, in order, as its
   * Passages were built from it, with their kinds, labels and anchors. With
   * both null, every Unit. Empty if the Document was deleted, or that
   * version's text is gone.
   */
  function pageTexts(
    documentId: string,
    contentHash: string,
    from: number | null,
    to: number | null,
  ): PageText[] {
    const range = from === null || to === null ? "" : "AND dp.page BETWEEN ? AND ?";
    const params = from === null || to === null ? [] : [BigInt(from), BigInt(to)];
    return db
      .all<UnitRow>(
        `SELECT dp.page, dp.text, dp.kind, dp.label, dp.anchors FROM document_pages dp
         JOIN documents d ON d.id = dp.document_id
         WHERE dp.document_id = ? AND dp.content_hash = ? AND dp.deleted_at IS NULL
           AND d.deleted_at IS NULL ${range}
         ORDER BY dp.page`,
        [documentId, contentHash, ...params],
      )
      .map(toUnitText);
  }

  /**
   * The text kept of Documents unlinked with their Linked folder (see
   * `CoreApi.listKeptCitationTexts`): by Document and version, in that order.
   */
  function keptCitationTexts(): KeptCitationText[] {
    // From the Documents (CROSS JOIN keeps that order): every live one's text isn't scanned.
    const rows = db.all<{ document_id: string; content_hash: string; page: number }>(
      `SELECT dp.document_id, dp.content_hash, dp.page FROM documents d
       CROSS JOIN document_pages dp ON dp.document_id = d.id
       WHERE d.deleted_at IS NOT NULL AND dp.deleted_at IS NULL
         AND dp.content_hash IS NOT NULL AND dp.page IS NOT NULL
       ORDER BY dp.document_id, dp.content_hash, dp.page`,
    );
    const kept: KeptCitationText[] = [];
    for (const row of rows) {
      const last = kept.at(-1);
      if (last?.documentId === row.document_id && last.contentHash === row.content_hash) {
        last.units.push(row.page);
      } else {
        kept.push({
          documentId: row.document_id,
          contentHash: row.content_hash,
          units: [row.page],
        });
      }
    }
    return kept;
  }

  /**
   * Soft-deletes Documents, their Passages, Tags and page text, at `at`.
   * Unlinking with their Linked folder, the Units Citations point to are
   * given in `keep`: they stay, and the text kept is pushed. Otherwise the
   * User deleted them: their vectors stay too, for `restore`.
   */
  function removeFromIndex(ids: readonly string[], at: string, keep?: readonly CitedUnits[]) {
    if (ids.length === 0) return;
    const list = JSON.stringify(ids);
    db.transaction(() => {
      db.run(
        `UPDATE documents SET deleted_at = ?, updated_at = ?
         WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
        [at, at, list],
      );
      db.run(
        `UPDATE passages SET deleted_at = ?, updated_at = ?${keep ? ", embedding = NULL" : ""}
         WHERE document_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
        [at, at, list],
      );
      db.run(
        `UPDATE document_tags SET deleted_at = ?, updated_at = ?
         WHERE document_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
        [at, at, list],
      );
      db.run(
        `UPDATE web_pages SET deleted_at = ?, updated_at = ?
         WHERE document_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
        [at, at, list],
      );
      db.run(
        `UPDATE web_page_pictures SET deleted_at = ?, updated_at = ?
         WHERE document_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
        [at, at, list],
      );
      db.run(
        `UPDATE document_pages SET deleted_at = ?, updated_at = ?
         WHERE document_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
           AND id NOT IN (SELECT value FROM json_each(?))`,
        [at, at, list, JSON.stringify(unitsToKeep(keep ?? []))],
      );
    });
    for (const id of ids) {
      vectors.removeDocument(id);
      processor.cancel(id);
      reading.forget(id);
    }
    // Pushed first, so a Citation quoting what is kept never shows "can't check" meanwhile.
    if (keep) options.emitKept?.(keptCitationTexts());
    options.emitRemoved([...ids]);
  }

  // Startup: Documents copied into the data folder by the old layout (before
  // ADR-0010) are files kept there, until the User links their originals.
  // Each copy gets its kind's extension, so another app can open it. One
  // deleted then can still be restored, so it gets its path too, after the live
  // ones and without renaming: its copy went with the delete, unless a live one
  // with the same content, maybe of another kind, still has it.
  for (const row of db.all<{ id: string; content_hash: string; kind: string; deleted: number }>(
    `SELECT id, content_hash, kind, deleted_at IS NOT NULL AS deleted FROM documents
     WHERE path IS NULL AND purged_at IS NULL ORDER BY deleted`,
  )) {
    const bare = join(legacyFolder, row.content_hash);
    const extension = DOCUMENT_EXTENSIONS[row.kind as DocumentKind]?.[0];
    const named = extension ? `${bare}.${extension}` : bare;
    try {
      if (!row.deleted && named !== bare && !existsSync(named) && existsSync(bare)) {
        renameSync(bare, named);
      }
    } catch (error) {
      reportError(error);
    }
    db.run("UPDATE documents SET path = ? WHERE id = ?", [
      existsSync(named) ? named : bare,
      row.id,
    ]);
  }

  const library = createLibrary({
    db,
    now,
    dataDir,
    folders: options.folders,
    watch: options.linkedFolders.watch,
    stat: options.linkedFolders.stat,
    retryMs: options.linkedFolders.retryMs,
    detectDataless: options.linkedFolders.detectDataless,
    readingSeconds: (files) => reading.seconds(files),
    hooks: {
      process,
      stillQueued: (id) => {
        if (find(id)?.status === "queued" && !processor.has(id)) process(id);
      },
      announce,
      added: (id) => options.onFound?.(id),
      moved: (ids) => {
        const moved = ids.flatMap((id) => {
          const row = find(id);
          return row ? [toDocument(row)] : [];
        });
        if (moved.length > 0) options.emitMoved(moved);
      },
      renamed: (id) => {
        const row = find(id);
        if (row) db.transaction(() => indexName(id, row.name));
      },
      // Unlinked: the Units Citations point to stay, so those Citations can still be checked.
      remove: (ids, at) => removeFromIndex(ids, at, options.citedUnits?.(ids) ?? []),
      paused: (linkedFolderId, paused) => {
        const rows = db.all<DocumentRow>(
          `SELECT ${COLUMNS} FROM documents
           WHERE linked_folder_id = ? AND deleted_at IS NULL
             AND status IN ('queued', 'extracting', 'embedding')
           ORDER BY created_at, rowid`,
          [linkedFolderId],
        );
        for (const row of rows) {
          if (paused) {
            processor.cancel(row.id);
            if (row.status === "extracting") {
              setStatus(row.id, "queued"); // its result is dropped
              announce(row.id);
            }
          } else if (row.status === "embedding") {
            embedding.enqueue(row.id);
          } else {
            processor.enqueue(jobFor(row));
          }
        }
        // Its Documents' metadata, if any is still to read, can be read again.
        if (!paused) readNextMetadata();
      },
      foldersChanged: options.foldersChanged,
      linkedFoldersChanged: options.linkedFoldersChanged,
      downloadStub: options.downloadStub,
      reportError,
    },
  });
  isPaused = (id) => library.isPaused(find(id)?.linked_folder_id ?? null);
  progressed = (linkedFolderId) => library.progressed(linkedFolderId);
  checkFile = (path) => {
    library.check([path]).catch(reportError);
  };

  // Documents processed by an older pipeline are processed again, through the usual
  // statuses: those whose kind it changed for (see `CURRENT_SINCE`), and those with Han
  // characters in their text or name, whose keyword index now folds them (see
  // `HAN_CURRENT_SINCE`). The others are already what this pipeline builds, so their text
  // isn't looked through again at the next start; the one thing left is their Document's
  // name, which this version moved out of each Passage's keyword row (see
  // `NAME_INDEX_CURRENT_SINCE`), and that is rewritten in place below.
  db.transaction(() => {
    db.run(
      `UPDATE documents SET status = 'queued', updated_at = ?
       WHERE deleted_at IS NULL
         AND processing_version < coalesce(json_extract(?, '$.' || kind), ?)
         AND status IN ('ready', 'embedding', 'waiting-for-model')`,
      [now(), JSON.stringify(CURRENT_SINCE), BigInt(PROCESSING_VERSION)],
    );
    db.run(
      `UPDATE documents SET status = 'queued', updated_at = ?
       WHERE deleted_at IS NULL AND processing_version < ?
         AND status IN ('ready', 'embedding', 'waiting-for-model')
         AND (name GLOB ? OR EXISTS (SELECT 1 FROM passages p
                                     WHERE p.document_id = documents.id
                                       AND p.deleted_at IS NULL AND p.text GLOB ?))`,
      [now(), BigInt(HAN_CURRENT_SINCE), HAS_HAN, HAS_HAN],
    );
    // A workbook with no text to search can still have left sheets unread (#740): one read
    // before that was recorded is read again, once, unlike a ready workbook above.
    db.run(
      `UPDATE documents SET status = 'queued', updated_at = ?
       WHERE deleted_at IS NULL AND kind = 'xlsx' AND status = 'no-text'
         AND processing_version < ?`,
      [now(), BigInt(CURRENT_SINCE.xlsx)],
    );
    // PDFs with a page of little or no text, or one read from its picture by an older
    // reader, are processed again, so their scanned pages are read (#397): only when there is
    // a model to read them. A page of text comes out as it was (see `samePassages`).
    if (textRecognition) {
      db.run(
        `UPDATE documents SET status = 'queued', updated_at = ?
         WHERE deleted_at IS NULL AND kind = 'pdf' AND processing_version < ?
           AND status IN ('ready', 'embedding', 'waiting-for-model', 'no-text')
           AND (status = 'no-text' OR EXISTS (
             SELECT 1 FROM document_pages dp
             WHERE dp.document_id = documents.id AND dp.content_hash = documents.content_hash
               AND dp.deleted_at IS NULL
               AND (length(trim(dp.text)) < ? OR json_extract(dp.label, '$.scan') IS NOT NULL)))`,
        [now(), BigInt(SCAN_CURRENT_SINCE), BigInt(MIN_PAGE_TEXT * 2)],
      );
      db.run(
        `UPDATE documents SET status = 'queued', updated_at = ?
         WHERE deleted_at IS NULL AND kind = 'web' AND processing_version < ?
           AND status IN ('ready', 'embedding', 'waiting-for-model')
           AND EXISTS (
             SELECT 1 FROM web_page_pictures wp
             WHERE wp.document_id = documents.id AND wp.content_hash = documents.content_hash
               AND wp.deleted_at IS NULL)`,
        [now(), BigInt(PICTURES_CURRENT_SINCE)],
      );
    }
    // A Document with a Passage stays as of the version before this one until its keyword
    // rows are rewritten: that runs in the background once the first window is up, one
    // Document per transaction, so the start never waits for it (#2042).
    db.run(
      `UPDATE documents SET processing_version = ?
       WHERE deleted_at IS NULL AND processing_version < ?
         AND status IN ('ready', 'embedding', 'waiting-for-model')
         AND NOT EXISTS (SELECT 1 FROM passages p
                         WHERE p.document_id = documents.id AND p.deleted_at IS NULL)`,
      [BigInt(PROCESSING_VERSION), BigInt(PROCESSING_VERSION)],
    );
  });
  // Once the text recognition model is downloaded, the scanned pages that couldn't be read
  // for want of it are read (#397).
  textRecognition?.onReady(() => {
    if (closed) return;
    for (const { id } of db.all<{ id: string }>(
      `SELECT id FROM documents
       WHERE deleted_at IS NULL AND file_status = 'available'
         AND status NOT IN ('queued', 'extracting')
         AND (failure_reason IN ('pages-unread', 'forms-unread') OR (kind = 'web' AND EXISTS (
           SELECT 1 FROM document_pages dp, json_each(dp.label, '$.figures') figure
           WHERE dp.document_id = documents.id AND dp.content_hash = documents.content_hash
             AND dp.deleted_at IS NULL AND json_extract(figure.value, '$.unread') = 1)))
       ORDER BY created_at DESC, rowid DESC`,
    )) {
      process(id);
    }
  });
  // Pick up work a quit interrupted, in the order it was queued (newest files first).
  const unfinished = db.all<DocumentRow>(
    `SELECT ${COLUMNS} FROM documents
     WHERE deleted_at IS NULL AND status IN ('queued', 'extracting')
     ORDER BY created_at, rowid`,
  );
  // After a better reader came, many scanned PDFs are read again: their Citations are found at once.
  const upgraded = textRecognition
    ? db
        .all<{ document_id: string }>(
          `SELECT DISTINCT dp.document_id FROM documents d
           JOIN document_pages dp ON dp.document_id = d.id AND dp.content_hash = d.content_hash
           WHERE d.deleted_at IS NULL AND d.kind = 'pdf' AND d.status IN ('queued', 'extracting')
             AND dp.deleted_at IS NULL AND json_extract(dp.label, '$.scan.reader') != ?`,
          [textRecognition.reader],
        )
        .map((each) => each.document_id)
    : [];
  if (upgraded.length > 0 && options.citedUnits) {
    const byDocument = new Map<string, CitedUnits[]>(upgraded.map((id) => [id, []]));
    for (const units of options.citedUnits(upgraded)) byDocument.get(units.documentId)?.push(units);
    citedAtStart = byDocument;
  }
  // A Document read well before, being read again for a newer pipeline, isn't what stopped the app.
  const rereadForNewerPipeline = (row: DocumentRow) =>
    row.processing_version <
      (Object.entries(CURRENT_SINCE).find(([kind]) => kind === row.kind)?.[1] ??
        PROCESSING_VERSION) && indexedStatus(row) !== null;
  for (const row of unfinished) {
    if (row.status === "extracting") {
      if (!rereadForNewerPipeline(row)) {
        // Read again by itself, what stopped the app could stop it again, at every start.
        db.run(
          `UPDATE documents SET status = ?, failure_reason = 'app-stopped',
             failure_message = ?, updated_at = ? WHERE id = ?`,
          [
            indexedStatus(row) ?? "failed",
            "The app stopped while it was being read.",
            now(),
            row.id,
          ],
        );
        continue;
      }
      db.run("UPDATE documents SET status = 'queued', updated_at = ? WHERE id = ?", [
        now(),
        row.id,
      ]);
    }
    if (!isPaused(row.id)) processor.enqueue(jobFor(row));
  }
  citedAtStart = null;

  /**
   * Puts every Document with Passages to search whose vectors aren't all from
   * the current model through embedding (again), or has it wait for the model.
   * Documents already embedded with it stay ready. `thorough` also finds ready
   * Documents with a Passage that has no vector yet, as one can after a time
   * with embeddings off: their vectors from the model are kept, and only the
   * missing ones made. `only` leaves the other Documents as they are.
   *
   * While embeddings are off, the other way round: a Document being embedded,
   * or waiting for the model, is ready, since its keyword index is; any
   * vectors it has stay stored, unused.
   *
   * Returns the Documents whose status changed.
   */
  function embedWithCurrentModel(thorough = false, only?: readonly string[]): string[] {
    const filter = only === undefined ? "" : " AND id IN (SELECT value FROM json_each(?))";
    const ids = only === undefined ? [] : [JSON.stringify(only)];
    if (!model.enabled()) {
      const readied = db.transaction(() => {
        const rows = db.all<{ id: string }>(
          `SELECT id FROM documents
           WHERE deleted_at IS NULL AND status IN ('embedding', 'waiting-for-model')${filter}
           ORDER BY created_at, rowid`,
          ids,
        );
        for (const { id } of rows) setStatus(id, "ready");
        return rows.map((row) => row.id);
      });
      for (const id of readied) {
        try {
          options.onReady?.(id);
        } catch (error) {
          reportError(error); // the Document is ready all the same
        }
      }
      return readied;
    }
    const ready = model.isReady();
    const changed = db.transaction(() => {
      const rows = db.all<{ id: string; status: string }>(
        `SELECT d.id, d.status FROM documents d
         WHERE d.deleted_at IS NULL AND d.status IN ('ready', 'embedding', 'waiting-for-model')
           AND (d.status <> 'ready' OR d.embedding_model IS NOT ?${
             thorough
               ? ` OR EXISTS (SELECT 1 FROM passages p WHERE p.document_id = d.id
                     AND p.deleted_at IS NULL AND p.embedding IS NULL)`
               : ""
           })
           ${only === undefined ? "" : "AND d.id IN (SELECT value FROM json_each(?))"}
         ORDER BY d.created_at, d.rowid`,
        [model.id, ...ids],
      );
      for (const row of rows) reembedding.add(row.id);
      const target = ready ? "embedding" : "waiting-for-model";
      return rows.filter((row) => {
        if (row.status === target) return false;
        setStatus(row.id, target);
        return true;
      });
    });
    if (ready) {
      const embeddingRows = db.all<{ id: string }>(
        `SELECT id FROM documents WHERE deleted_at IS NULL AND status = 'embedding'
         ORDER BY created_at, rowid`,
      );
      for (const { id } of embeddingRows) embedding.enqueue(id);
    } else if (
      db.get("SELECT 1 FROM documents WHERE deleted_at IS NULL AND status = 'waiting-for-model'")
    ) {
      model.ensure();
    }
    return changed.map((row) => row.id);
  }

  // Embedding carries on where it stopped, or waits for the model; Documents
  // embedded with a model other than the current one are embedded again.
  // With embeddings off, what was waiting is ready (an install that had the
  // built-in model on by default, say).
  embedWithCurrentModel();
  model.onReady(() => embedding.resumeWaiting());
  // The User switched model, or turned embeddings on or off: what is under way
  // stops, and every Document without the model's vectors is embedded, or,
  // turned off, is ready.
  model.onSwitch(() => {
    embedding.restart();
    vectors.reset();
    // Queued, but for one whose turn came at once, which the queue announced.
    for (const id of embedWithCurrentModel(true)) if (!embedding.isEmbedding(id)) announce(id);
  });

  /** The live Documents a filter keeps, as SQL conditions on `documents`, with their parameters. */
  const filterWhere = ({ folderIds, tagId, ids, linkedFolderId, searchable }: DocumentFilter) => {
    const conditions = ["deleted_at IS NULL"];
    const params: string[] = [];
    if (folderIds !== undefined) {
      conditions.push("folder_id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(folderIds));
    }
    if (tagId !== undefined) {
      conditions.push(
        `id IN (SELECT l.document_id FROM document_tags l JOIN tags t ON t.id = l.tag_id
                WHERE l.tag_id = ? AND l.deleted_at IS NULL AND t.deleted_at IS NULL)`,
      );
      params.push(tagId);
    }
    if (ids !== undefined) {
      conditions.push("id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(ids));
    }
    if (linkedFolderId === null) conditions.push("linked_folder_id IS NULL");
    else if (linkedFolderId !== undefined) {
      conditions.push("linked_folder_id = ?");
      params.push(linkedFolderId);
    }
    if (searchable) conditions.push("file_status <> 'missing'");
    return { where: conditions.join(" AND "), params };
  };

  /** Most recently added first, only those the filter keeps. */
  const list = (filter: DocumentFilter = {}): Document[] => {
    const { where, params } = filterWhere(filter);
    return db
      .all<DocumentRow>(
        `SELECT ${COLUMNS} FROM documents WHERE ${where} ORDER BY created_at DESC, rowid DESC`,
        params,
      )
      .map(toDocument);
  };

  /** Every live Document's id, version and names, in `list`'s order: what a Citation needs to show its Document's current name. */
  const names = (): LiveDocument[] =>
    db
      .all<{ id: string; content_hash: string; name: string; title: string | null }>(
        `SELECT id, content_hash, name, title FROM documents
         WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC`,
      )
      .map((row) => ({
        id: row.id,
        contentHash: row.content_hash,
        name: row.name,
        title: row.title,
      }));

  /**
   * Whether any live Document is outside these: whether the Library holds more
   * than the example's own copies (#1942). A search asks this on every call, so
   * it reads no more than the first Document it finds.
   */
  const hasDocumentOutside = (outside: readonly string[]): boolean =>
    Boolean(
      db.get(
        `SELECT 1 FROM documents WHERE deleted_at IS NULL
         AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,
        [JSON.stringify(outside)],
      ),
    );

  /** The ids of the live Documents the filter keeps, in `list`'s order. */
  const ids = (filter: DocumentFilter = {}): string[] => {
    const { where, params } = filterWhere(filter);
    return db
      .all<{ id: string }>(
        `SELECT id FROM documents WHERE ${where} ORDER BY created_at DESC, rowid DESC`,
        params,
      )
      .map((row) => row.id);
  };

  /**
   * The Documents a search looks at: those given that aren't missing, or,
   * with none given, undefined (every Document) unless some are missing:
   * then every Document that isn't.
   */
  function searchScope(documentIds: readonly string[] | undefined): string[] | undefined {
    if (documentIds) return ids({ ids: documentIds, searchable: true });
    const anyMissing = db.get(
      "SELECT 1 FROM documents WHERE deleted_at IS NULL AND file_status = 'missing'",
    );
    return anyMissing ? ids({ searchable: true }) : undefined;
  }

  /**
   * The query's vector, or null when a hybrid search has to do without:
   * embeddings are off (nothing is loaded), or the model isn't ready, or
   * fails. A vector search throws instead.
   */
  async function queryVector(query: string, mode: SearchMode): Promise<Float32Array | null> {
    const unavailable = () => {
      if (mode === "vector") throw model.notReadyError();
      return null;
    };
    if (!model.enabled()) {
      if (mode === "vector") {
        throw new InvalidInputError({ key: "error.provider.embeddingsOff" });
      }
      return null;
    }
    if (!(await model.load())) return unavailable();
    try {
      return await model.embedQuery(query);
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) return unavailable();
      if (mode === "vector") throw error;
      console.error(error);
      return null;
    }
  }

  /** SQL for the live, not missing Documents `d` with Passages to search: of all of them, or only of these. */
  function searchable(documentIds: readonly string[] | undefined) {
    return {
      where: `d.deleted_at IS NULL AND d.file_status <> 'missing'
        AND EXISTS (SELECT 1 FROM passages p WHERE p.document_id = d.id AND p.deleted_at IS NULL)
        ${documentIds ? "AND d.id IN (SELECT value FROM json_each(?))" : ""}`,
      params: documentIds ? [JSON.stringify(documentIds)] : [],
    };
  }

  /** Each Document's language, by its version: told once from its first Passages (see ./textLanguage). */
  const languages = new Map<string, { contentHash: string; language: TextLanguage | null }>();

  function documentLanguage(id: string, contentHash: string): TextLanguage | null {
    const known = languages.get(id);
    if (known?.contentHash === contentHash) return known.language;
    const sample = db
      .all<{ text: string }>(
        `SELECT substr(text, 1, ?) AS text FROM passages
         WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?`,
        [BigInt(LANGUAGE_SAMPLE_CHARACTERS), id, BigInt(LANGUAGE_SAMPLE_PASSAGES)],
      )
      .map((row) => row.text)
      .join("\n");
    const language = detectLanguage(sample);
    languages.set(id, { contentHash, language });
    return language;
  }

  function searchableCount(documentIds?: readonly string[]): number {
    const { where, params } = searchable(documentIds);
    return (
      db.get<{ count: number }>(`SELECT count(*) AS count FROM documents d WHERE ${where}`, params)
        ?.count ?? 0
    );
  }

  /**
   * Keyword search's and vector search's rankings of the live Passages, each
   * `listed` long, copies of one file merged (see `distinctPassages`), and
   * the Passages in keyword search's that have no vector, for fusion (see
   * `fuseRankingScores`). Vector search's is empty while embeddings are off,
   * while the embedding model can't embed the query, and until any Passage
   * in the Search scope has a vector. Keyword search's is `keywordListed`
   * long, when given.
   */
  async function rankings(
    query: string,
    listed: number,
    documentIds: readonly string[] | undefined,
    keywordListed = listed,
  ): Promise<{ lists: number[][]; keywordOnly: Set<number> }> {
    const scope = searchScope(documentIds);
    const vector = await queryVector(query, "hybrid");
    const keyword = keywordSearch(db, query, keywordListed, scope);
    const similar = vector ? vectors.search(vector, listed, scope).map((hit) => hit.seq) : [];
    const lists = distinctPassages(db, [keyword, similar]);
    const keywordOnly =
      similar.length > 0 ? keywordOnlyPassages(db, lists[0] ?? [], model.id) : new Set<number>();
    return { lists, keywordOnly };
  }

  /** The Passages of these fused hits, in their order, each with its fused score. */
  function scored(hits: readonly { seq: number; score: number }[]): SearchCandidate[] {
    const scores = new Map(hits.map((hit) => [hit.seq, hit.score]));
    return windowedPassagesBySeq(
      db,
      hits.map((hit) => hit.seq),
    ).map((passage) => ({ ...passage, score: scores.get(passage.seq) ?? 0 }));
  }

  /** Hybrid search for the document-search Tool: the best `limit` live Passages, with fused scores. */
  async function candidates(
    query: string,
    limit: number,
    documentIds: readonly string[] | undefined,
  ): Promise<SearchCandidate[]> {
    if (query.trim() === "") return [];
    const { lists, keywordOnly } = await rankings(
      query,
      Math.max(limit, HYBRID_CANDIDATES),
      documentIds,
    );
    return scored(fuseRankingScores(lists, limit, keywordOnly));
  }

  /**
   * For the search Tool's reranker: keyword search's best `perList` and
   * vector search's, each Passage once, in fused order with fused scores, so
   * a reranker that fails leaves search's own order. Without vector search's
   * (embeddings off, the default, or no vectors yet), keyword search's best
   * `keywordAlone`, in its order.
   */
  async function rerankCandidates(
    query: string,
    counts: { perList: number; keywordAlone: number },
    documentIds: readonly string[] | undefined,
  ): Promise<SearchCandidate[]> {
    if (query.trim() === "") return [];
    const listed = Math.max(2 * counts.perList, HYBRID_CANDIDATES);
    const { lists, keywordOnly } = await rankings(
      query,
      listed,
      documentIds,
      Math.max(listed, counts.keywordAlone),
    );
    const [keyword = [], similar = []] = lists;
    if (similar.length === 0) {
      return scored(fuseRankingScores([keyword], counts.keywordAlone));
    }
    // With vector search, keyword search's list is fused as long as vector search's.
    const fused = [keyword.slice(0, listed), similar];
    const chosen = new Set(topsOfEach(fused, counts.perList));
    return scored(
      fuseRankingScores(fused, Number.POSITIVE_INFINITY, keywordOnly).filter((hit) =>
        chosen.has(hit.seq),
      ),
    );
  }

  /** The live Document whose file is to be opened, checked against the disk first. */
  async function openablePath(idInput: unknown): Promise<DocumentRow> {
    const id = parseId(idInput);
    const before = find(id);
    if (!before) throw new NotFoundError({ key: "error.document.notFound" });
    // A file is looked at again when it is opened: it may have changed, moved or gone.
    await library.check([before.path]);
    const row = find(id);
    if (!row) throw new NotFoundError({ key: "error.document.notFound" });
    if (row.file_status === "missing")
      throw new NotFoundError({ key: "error.document.fileMissing" });
    if (row.file_status === "unavailable") {
      throw new NotFoundError({ key: "error.document.fileUnavailable" });
    }
    return row;
  }

  return {
    /**
     * Starts watching Linked folders, and reconciles the index with the disk.
     * The creation dates of Documents from before they were read are read
     * in the background (see `readNextMetadata`).
     */
    start(): void {
      library.start();
      readNextMetadata();
    },

    /**
     * The document-search Tool (see ./searchTool): hybrid search, grouped by
     * Document and clustered by sliding window.
     */
    searchTool(query: string, toolOptions?: SearchToolOptions): Promise<WindowedPassage[]> {
      return searchDocumentsTool(
        {
          candidates,
          rerankCandidates,
          window: (documentId, window) => passagesInWindow(db, documentId, window),
        },
        query,
        toolOptions,
      );
    },

    /** A live Passage of a live Document, as search returns it; null for any other. */
    passage: (passageId: string): WindowedPassage | null => livePassage(db, passageId),

    /** The live Passages of a live Document at positions `from` to `to`, in reading order. */
    passagesBetween: (documentId: string, from: number, to: number): WindowedPassage[] =>
      passagesBetween(db, documentId, from, to),

    /**
     * How far embedding with the current model has got: the live Documents
     * with Passages to search, and of those, the ones whose Passages are all
     * embedded with it.
     */
    embeddingProgress(): { total: number; done: number } {
      const counts = db.get<{ total: number; done: number | null }>(
        `SELECT count(*) AS total,
           sum(status = 'ready' AND embedding_model IS ?) AS done
         FROM documents
         WHERE deleted_at IS NULL AND status IN ('ready', 'embedding', 'waiting-for-model')`,
        [model.id],
      );
      return { total: counts?.total ?? 0, done: counts?.done ?? 0 };
    },

    /** How many live Documents have Passages to search: of all of them, or only of these. */
    searchableCount,

    /**
     * The live Documents with Passages to search (of all of them, or only of these) that
     * joined after `since` (ISO 8601, UTC): added then, or, with `folderId`, filed into that
     * Folder then. `joinedAt` says when.
     */
    searchableJoinedAfter(
      documentIds: readonly string[] | undefined,
      since: string,
      folderId: string | null,
    ): { id: string; joinedAt: string }[] {
      const { where, params } = searchable(documentIds);
      return db
        .all<{ id: string; joined_at: string }>(
          `SELECT id, joined_at FROM (
             SELECT d.id, MAX(d.created_at, COALESCE((
               SELECT COALESCE(a.filed_at, a.created_at) FROM document_groups a
               WHERE a.document_id = d.id AND a.group_id = ? AND a.deleted_at IS NULL
             ), d.created_at)) AS joined_at
             FROM documents d WHERE ${where}
           ) WHERE joined_at > ?`,
          [folderId, ...params, since],
        )
        .map((row) => ({ id: row.id, joinedAt: row.joined_at }));
    },

    /**
     * How many live Documents have Passages to search (of all of them, or only
     * of these), and the names of the `limit` most recently added, newest
     * first, each with its title when its name doesn't hold it; `webPage`: one
     * of them is a saved web page, named by its own title.
     */
    searchableNames(
      documentIds: readonly string[] | undefined,
      limit: number,
    ): { total: number; names: string[]; webPage: boolean } {
      const { where, params } = searchable(documentIds);
      const rows = db.all<{ name: string; title: string | null; kind: string }>(
        `SELECT d.name, d.title, d.kind FROM documents d WHERE ${where}
         ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
        [...params, BigInt(limit)],
      );
      return {
        total: searchableCount(documentIds),
        names: rows.map((row) => withTitle(row.name, row.title)),
        webPage: rows.some((row) => row.kind === "web"),
      };
    },

    /** The live Documents with Passages to search (of all of them, or only of these), the most text first: `size` characters. */
    searchableBySize(
      documentIds: readonly string[] | undefined,
    ): { id: string; name: string; size: number }[] {
      const { where, params } = searchable(documentIds);
      return db
        .all<{ id: string; name: string; size: bigint | number }>(
          `SELECT d.id, d.name,
             (SELECT coalesce(sum(length(p.text)), 0) FROM passages p
               WHERE p.document_id = d.id AND p.deleted_at IS NULL) AS size
           FROM documents d WHERE ${where}
           ORDER BY size DESC, d.created_at DESC, d.rowid DESC`,
          params,
        )
        .map((row) => ({ id: row.id, name: row.name, size: Number(row.size) }));
    },

    /** Whether any live Document to search (of all of them, or only of these) is a workbook or a CSV file. */
    searchableHasSheets(documentIds: readonly string[] | undefined): boolean {
      const { where, params } = searchable(documentIds);
      return (
        db.get<{ found: number }>(
          `SELECT 1 AS found FROM documents d WHERE ${where} AND d.kind IN ('xlsx', 'csv') LIMIT 1`,
          params,
        ) !== undefined
      );
    },

    /**
     * The languages the live Documents with Passages to search are in (of all
     * of them, or only of these), the most common first, with how many
     * Documents are in each. A Document whose language can't be told isn't counted.
     */
    searchableLanguages(
      documentIds: readonly string[] | undefined,
    ): { language: TextLanguage; documents: number }[] {
      const { where, params } = searchable(documentIds);
      const rows = db.all<{ id: string; content_hash: string }>(
        `SELECT d.id, d.content_hash FROM documents d WHERE ${where}`,
        params,
      );
      if (!documentIds) {
        // Every searchable Document is here: forget the others.
        const live = new Set(rows.map((row) => row.id));
        for (const id of languages.keys()) if (!live.has(id)) languages.delete(id);
      }
      return languageList(rows.map((row) => documentLanguage(row.id, row.content_hash)));
    },

    /**
     * A Passage and its Document, for a Citation. Deleted Passages are found
     * too (a new version of the Document replaces its Passages), with the
     * version they were built from, and a deleted Document is reported as
     * such. Null for an unknown Passage.
     */
    citationSource(passageId: string): CitationSource | null {
      const row = db.get<{
        id: string;
        text: string;
        page_from: number | null;
        page_to: number | null;
        document_id: string;
        name: string;
        kind: string;
        content_hash: string;
        deleted_at: string | null;
        not_cited: number;
      }>(
        `SELECT p.id, p.text, p.page_from, p.page_to, p.document_id, d.name, d.kind,
           coalesce(p.content_hash, d.content_hash) AS content_hash, d.deleted_at, d.not_cited
         FROM passages p JOIN documents d ON d.id = p.document_id
         WHERE p.id = ?`,
        [passageId],
      );
      if (!row) return null;
      return {
        passageId: row.id,
        text: row.text,
        pageFrom: row.page_from,
        pageTo: row.page_to,
        documentId: row.document_id,
        documentName: row.name,
        documentKind: row.kind as DocumentKind,
        contentHash: row.content_hash,
        documentDeleted: row.deleted_at !== null,
        notCited: row.not_cited === 1,
      };
    },

    pageTexts,

    keptCitationTexts,

    /** The current version of a live Document, or null if it was deleted. */
    currentVersion(documentId: string): string | null {
      return find(documentId)?.content_hash ?? null;
    },

    /**
     * A live Document's date, as Answers see it beside its Passages (#548):
     * the date it states (its reference record's, else its creation date),
     * else the day its file was last modified, in UTC. Null when nothing
     * gives one, or the Document was deleted.
     */
    documentDate(documentId: string): DocumentDate | null {
      const row = find(documentId);
      if (!row) return null;
      const issued = referenceOf(db, documentId)?.fields.issued;
      if (issued) return { date: issued, of: "document" };
      // A date stored before it was known to be a placeholder (2000-01-01) isn't shown either.
      if (row.creation_date && !isPlaceholderDate(row.creation_date)) {
        // A year alone is the one written in the first Unit (see ./creationDate): file metadata
        // gives a day. A web page's date is the one it says it was published on.
        const stated = row.creation_date.length === 4 || row.kind === "web";
        return {
          date: row.creation_date.slice(0, 10),
          of: stated ? "document" : "file-created",
        };
      }
      if (row.file_mtime_ms === null) return null;
      const modified = new Date(row.file_mtime_ms).toISOString().slice(0, 10);
      return isPlaceholderDate(modified) ? null : { date: modified, of: "file-modified" };
    },

    /**
     * The live Passages of a Document's current version that cover pages
     * `from` to `to` (any, for a Document without pages), in reading order.
     */
    passagesCovering(
      documentId: string,
      from: number | null,
      to: number | null,
    ): { id: string; text: string }[] {
      const range = from === null || to === null ? "" : "AND p.page_from <= ? AND p.page_to >= ?";
      const params = from === null || to === null ? [] : [BigInt(from), BigInt(to)];
      return db.all<{ id: string; text: string }>(
        `SELECT p.id, p.text FROM passages p JOIN documents d ON d.id = p.document_id
         WHERE p.document_id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
           AND p.content_hash = d.content_hash ${range}
         ORDER BY p.position`,
        [documentId, ...params],
      );
    },

    /**
     * The number a workbook's cell stores (0.04213 for a cell showing "4.2%"),
     * for the Tools that calculate over cells. Null when the cell shows its
     * number plainly, isn't a number, or isn't there; always null for a CSV.
     * `sheet` is the sheet's name, null for a CSV. From the Document's current
     * version. Throws NotFoundError for an unknown or deleted Document.
     */
    cellNumber(idInput: unknown, sheet: string | null, ref: string): number | null {
      const row = find(parseId(idInput));
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      const units = db.all<UnitRow>(
        `SELECT page, text, kind, label, anchors FROM document_pages
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL AND kind = 'rows'
         ORDER BY page`,
        [row.id, row.content_hash],
      );
      for (const unit of units.map(toUnitText)) {
        if ((unit.label?.sheet ?? null) !== sheet) continue;
        const number = cellNumber(unit.label, ref);
        if (number !== null) return number;
      }
      return null;
    },

    /** The text kept of a live Document's current version (see `CoreApi.readDocumentText`). */
    readText(idInput: unknown): DocumentText {
      const row = find(parseId(idInput));
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      const pages = db.all<UnitRow>(
        `SELECT page, text, kind, label, anchors FROM document_pages
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page`,
        [row.id, row.content_hash],
      );
      return {
        documentId: row.id,
        contentHash: row.content_hash,
        fileStatus: row.file_status as DocumentFileStatus,
        pages: pages.map(toUnitText).map((unit) => ({
          page: unit.page ?? 1,
          text: unit.text,
          kind: unit.kind ?? "page",
          label: unit.label ?? null,
        })),
      };
    },

    /** The scanned pages of a live Document's current version (see `CoreApi.readScannedText`). */
    readScannedText(idInput: unknown): ScannedText {
      const row = find(parseId(idInput));
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      const units = db
        .all<UnitRow>(
          `SELECT page, text, kind, label, anchors FROM document_pages
           WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL
             AND json_extract(label, '$.scan.reader') IS NOT NULL
           ORDER BY page`,
          [row.id, row.content_hash],
        )
        .map(toUnitText);
      return {
        documentId: row.id,
        contentHash: row.content_hash,
        pages: units.map((unit) => ({
          page: unit.page ?? 1,
          text: unit.text,
          label: unit.label ?? null,
          anchors: unit.anchors ?? [],
        })),
      };
    },

    /** A Citation's quote as the Document's text reads it (see `CoreApi.readableQuote`). */
    readableQuote(input: ScannedQuoteInput): string | null {
      const row = find(parseId(input.documentId));
      if (!row) return null;
      const units = pageTexts(
        row.id,
        input.contentHash ?? row.content_hash,
        input.pageFrom,
        input.pageTo ?? input.pageFrom,
      );
      const ranges = quoteInUnits(units, cleanQuote(input.quote));
      return ranges && ranges.length > 0 ? readableQuote(joinUnits(units).text, ranges) : null;
    },

    /** A Citation's quote read from a scan (see `CoreApi.readScannedQuote`). */
    readScannedQuote(input: ScannedQuoteInput): ScannedQuote | null {
      const row = find(parseId(input.documentId));
      if (!row) return null;
      const units = pageTexts(
        row.id,
        input.contentHash ?? row.content_hash,
        input.pageFrom,
        input.pageTo ?? input.pageFrom,
      );
      const read = (unit: UnitText) =>
        (unit.label?.scan && !unit.label.scan.unread) ||
        unit.label?.figures?.some((figure) => !figure.unread);
      if (!units.some(read)) return null;
      const ranges = quoteInUnits(units, cleanQuote(input.quote));
      if (!ranges || ranges.length === 0) return null;
      const unsure: string[] = [];
      const covers = (from: number, to: number) =>
        ranges.some((range) => range.start < to && range.end > from);
      // A quote of a page of text beside a scanned one wasn't read from a scan.
      let scanned = false;
      let pictured = false;
      let start = 0;
      for (const unit of units) {
        const end = start + unit.text.length;
        if (unit.label?.scan && !unit.label.scan.unread && covers(start, end)) scanned = true;
        for (const [from, to] of unit.label?.scan?.unsure ?? []) {
          if (covers(start + from, start + to)) unsure.push(unit.text.slice(from, to));
        }
        for (const figure of unit.label?.figures ?? []) {
          const anchor = anchorsOf(unit).find((each) => each.target === `figure${figure.number}`);
          if (figure.unread || !anchor || !covers(start + anchor.start, start + anchor.end)) {
            continue;
          }
          pictured = true;
          for (const [from, to] of figure.unsure ?? []) {
            if (covers(start + from, start + to)) unsure.push(unit.text.slice(from, to));
          }
        }
        // `joinUnits` puts one line break between Units.
        start = end + 1;
      }
      return scanned ? { unsure, from: "scan" } : pictured ? { unsure, from: "picture" } : null;
    },

    /** `added` hears of each new Document as it is stored, before it is processed. */
    async add(
      input: unknown,
      added?: (documentId: string) => void,
    ): Promise<Omit<AddDocumentsResult, "batchId">> {
      const paths = parsePaths(input);
      const brought: string[] = [];
      const results = await library.addFiles(paths, (documentId) => {
        brought.push(documentId);
        added?.(documentId);
      });
      const documents: Document[] = [];
      const skipped: SkippedFile[] = [];
      results.forEach((result, at) => {
        const row =
          result === "unreadable" || result === "unsupported-type" ? undefined : find(result);
        if (row) documents.push(toDocument(row));
        else {
          skipped.push({
            path: paths[at] as string,
            reason: result === "unsupported-type" ? "unsupported-type" : "unreadable",
          });
        }
      });
      return { documents, skipped, added: brought };
    },

    /** See the library's `newVersionFrom`: a newer draft of a Word file imported before (#720). */
    newVersionFrom: (documentId: string, path: string) => library.newVersionFrom(documentId, path),

    /**
     * Adds a file IncarnaMind saved in the data folder, a web page's snapshot
     * or a Meeting's Transcript while it records, as a new Document named
     * `name`, and queues it; `record` runs in the same transaction.
     */
    addSnapshot(
      id: string,
      name: string,
      file: SnapshotFile,
      record: () => void,
      kind: "web" | "transcript" = "web",
    ): Document {
      const at = now();
      db.transaction(() => {
        db.run(
          `INSERT INTO documents (id, content_hash, name, kind, size, status, path,
             linked_folder_id, folder_id, source_kind, relative_path, file_status, file_mtime_ms,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 'data-folder', ?, 'available', ?, ?, ?)`,
          [
            id,
            file.contentHash,
            parseName(name.slice(0, MAX_NAME_LENGTH)),
            kind,
            file.size,
            file.path,
            relativePath(dataDir, file.path),
            file.mtimeMs,
            at,
            at,
          ],
        );
        record();
      });
      announce(id);
      process(id);
      const row = find(id);
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      return toDocument(row);
    },

    /** Looks at a file again now, as when it is opened: a new version is processed. */
    check: (path: string) => library.check([path]),

    /** As `check`, and resolves only once the file has been read: for a file just written. */
    checkNow: (path: string) => library.check([path], true),

    /** Tells the windows a Document changed besides its processing, such as a web page's look. */
    announce,

    list,
    names,
    ids,
    hasDocumentOutside,
    upgradeKeywordIndex,

    /** The live Documents (of these, or all of them) that failed, have no text or were read in part: the few `findUnreadDocuments` looks at. */
    unread(documentIds?: readonly string[]): Document[] {
      const { where, params } = filterWhere(documentIds ? { ids: documentIds } : {});
      return db
        .all<DocumentRow>(
          `SELECT ${COLUMNS} FROM documents
           WHERE ${where} AND (status IN ('failed', 'no-text') OR failure_reason IS NOT NULL
             OR unread_parts IS NOT NULL)
           ORDER BY created_at DESC, rowid DESC`,
          params,
        )
        .map(toDocument);
    },

    /** The live Documents (of these, or all of them) whose text is still being read: queued or extracting, newest first. */
    reading(documentIds?: readonly string[]): Document[] {
      const { where, params } = filterWhere(documentIds ? { ids: documentIds } : {});
      return db
        .all<DocumentRow>(
          `SELECT ${COLUMNS} FROM documents
           WHERE ${where} AND status IN ('queued', 'extracting')
           ORDER BY created_at DESC, rowid DESC`,
          params,
        )
        .map(toDocument);
    },

    /** A live Document. Throws NotFoundError for an unknown or deleted one. */
    get(idInput: unknown): Document {
      const row = find(parseId(idInput));
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      return toDocument(row);
    },

    /** The live Documents among `ids`, in that order. */
    getMany(documentIds: readonly string[]): Document[] {
      return documentIds.flatMap((id) => {
        const row = find(id);
        return row ? [toDocument(row)] : [];
      });
    },

    /**
     * Renames a Document, and indexes its new name: the name's own index, not
     * its Passages, which don't hold it. Its vectors keep the name they were
     * embedded with. The file isn't touched.
     */
    rename(idInput: unknown, nameInput: unknown): Document {
      const id = parseId(idInput);
      const name = parseName(nameInput);
      if (!find(id)) throw new NotFoundError({ key: "error.document.notFound" });
      db.transaction(() => {
        db.run("UPDATE documents SET name = ?, updated_at = ? WHERE id = ?", [name, now(), id]);
        indexName(id, name);
      });
      const row = find(id);
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      return toDocument(row);
    },

    /**
     * Counts a Document IncarnaMind wrote as evidence, or leaves it out again
     * (#80, see `OwnFile`), and says so. InvalidInputError for any other.
     */
    setCountedAsEvidence(idInput: unknown, countedInput: unknown): Document {
      const id = parseId(idInput);
      if (typeof countedInput !== "boolean") {
        throw new InvalidInputError("counted must be true or false.");
      }
      const row = find(id);
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      if (row.own_file === null) {
        throw new InvalidInputError("Only a file IncarnaMind wrote is left out of evidence.");
      }
      if ((row.counted_as_evidence === 1) !== countedInput) {
        db.run("UPDATE documents SET counted_as_evidence = ?, updated_at = ? WHERE id = ?", [
          countedInput ? 1 : 0,
          now(),
          id,
        ]);
        announce(id);
      }
      const updated = find(id);
      if (!updated) throw new NotFoundError({ key: "error.document.notFound" });
      return toDocument(updated);
    },

    /**
     * Keeps a Document as the User's own workings, or cites it as any again
     * (see `Document.notCited`), and says so.
     */
    setNotCited(idInput: unknown, notCitedInput: unknown): Document {
      const id = parseId(idInput);
      if (typeof notCitedInput !== "boolean") {
        throw new InvalidInputError({ key: "error.document.notCitedChoice" });
      }
      const row = find(id);
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      if ((row.not_cited === 1) !== notCitedInput) {
        db.run("UPDATE documents SET not_cited = ?, updated_at = ? WHERE id = ?", [
          notCitedInput ? 1 : 0,
          now(),
          id,
        ]);
        announce(id);
      }
      const updated = find(id);
      if (!updated) throw new NotFoundError({ key: "error.document.notFound" });
      return toDocument(updated);
    },

    /**
     * Removes Documents from the index, all in one step, or none when one isn't found. No file
     * is touched: a copy the old layout made in the data folder goes once its Document is
     * deleted permanently (`dropPurged`).
     */
    delete(idsInput: unknown): string[] {
      const ids = [...new Set((Array.isArray(idsInput) ? idsInput : [idsInput]).map(parseId))];
      const rows = ids.map((id) => {
        const row = find(id);
        if (!row) throw new NotFoundError({ key: "error.document.notFound" });
        return row;
      });
      removeFromIndex(ids, now());
      // Once a Linked folder, not once a Document: 1,700 Documents took 90 s one by one (#1349).
      for (const linkedFolderId of new Set(rows.map((row) => row.linked_folder_id))) {
        library.documentsChanged(linkedFolderId);
      }
      return ids;
    },

    /**
     * Brings back Documents the User deleted (the caller checks they may), with the
     * Passages, text, Tags and web page versions deleted with them, without reading their files. Run in the
     * caller's transaction, then `restored`.
     */
    restore(ids: readonly string[]): void {
      const at = now();
      const rows = db.all<DocumentRow & { deleted_at: string }>(
        `SELECT ${COLUMNS}, deleted_at FROM documents
         WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL`,
        [JSON.stringify(ids)],
      );
      if (rows.length === 0) return;
      const list = JSON.stringify(rows.map((row) => row.id));
      // What went with each Document, by its own delete time: read from its row, so its parts go
      // back before it does. One statement a table, however many there are (#1349).
      const deletedWith = (table: string) =>
        `(SELECT d.deleted_at FROM documents d WHERE d.id = ${table}.document_id)`;
      db.run(
        `UPDATE passages SET deleted_at = NULL, updated_at = ?
         WHERE document_id IN (SELECT value FROM json_each(?))
           AND deleted_at = ${deletedWith("passages")}
           AND content_hash IS (SELECT d.content_hash FROM documents d WHERE d.id = passages.document_id)`,
        [at, list],
      );
      for (const table of ["document_pages", "web_pages", "web_page_pictures"]) {
        db.run(
          `UPDATE ${table} SET deleted_at = NULL, updated_at = ?
           WHERE document_id IN (SELECT value FROM json_each(?)) AND deleted_at = ${deletedWith(table)}`,
          [at, list],
        );
      }
      db.run(
        `UPDATE document_tags SET deleted_at = NULL, updated_at = ?
         WHERE document_id IN (SELECT value FROM json_each(?))
           AND deleted_at = ${deletedWith("document_tags")}
           AND NOT EXISTS (SELECT 1 FROM document_tags live
                           WHERE live.document_id = document_tags.document_id
                             AND live.tag_id = document_tags.tag_id AND live.deleted_at IS NULL)`,
        [at, list],
      );
      db.run(
        `UPDATE documents SET deleted_at = NULL, updated_at = ?
         WHERE id IN (SELECT value FROM json_each(?))`,
        [at, list],
      );
      for (const row of rows) {
        reindexPassages(row.id);
        if (row.status === "extracting") setStatus(row.id, "queued");
        else if (["ready", "embedding", "waiting-for-model"].includes(row.status)) {
          const status = indexedStatus(row);
          if (status !== null && status !== row.status) setStatus(row.id, status);
        }
      }
    },

    /** Picks up Documents `restore` brought back where they were, and announces them. */
    restored(ids: readonly string[]): void {
      const linkedFolders = new Set<string | null>();
      for (const id of ids) {
        const row = find(id);
        if (!row) continue;
        linkedFolders.add(row.linked_folder_id);
        vectors.restoreDocument(id);
        // Its processing was cut short by the delete: it carries on, from its file.
        if (row.status === "queued") process(id);
        else if (row.status === "ready") {
          try {
            options.onReady?.(id);
          } catch (error) {
            reportError(error);
          }
        }
        // Embedded again from here, before `embedWithCurrentModel` marks it below (#1433).
        if (row.status === "embedding") reembedding.add(id);
        if (!(row.status === "embedding" && embedding.enqueue(id))) announce(id, true);
        if (row.status === "waiting-for-model") model.ensure();
      }
      // A Document back from an unlinked Linked folder lost its vectors with it: they are embedded again (#1292).
      for (const id of embedWithCurrentModel(true, ids))
        if (!embedding.isEmbedding(id)) announce(id, true);
      for (const linkedFolderId of linkedFolders) library.documentsChanged(linkedFolderId);
      const copies = db
        .all<{ path: string; relative_path: string }>(
          `SELECT path, relative_path FROM documents
           WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
             AND source_kind = 'data-folder' AND relative_path IS NOT NULL`,
          [JSON.stringify(ids)],
        )
        .filter((row) => isLegacyCopy(dataDir, pathIn(dataDir, row.relative_path)))
        .map((row) => row.path);
      // Builds before #1432 removed the copy at delete: one gone shows missing now, not when opened.
      if (copies.length > 0) library.check(copies).catch(reportError);
    },

    /**
     * Removes the old layout's copies of Documents deleted permanently, each once no Document
     * that can still come back is at its place. Again at each start, for a quit that cut it short.
     */
    async dropPurged(): Promise<void> {
      // By place, not by path: a Document added from a data folder reached through a link has
      // the path with links resolved, an old one the path as the app was given it.
      const copies = db
        .all<{ relative_path: string }>(
          `SELECT DISTINCT d.relative_path FROM documents d
           WHERE d.purged_at IS NOT NULL AND d.source_kind = 'data-folder'
             AND d.linked_folder_id IS NULL AND d.relative_path IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM documents o WHERE o.purged_at IS NULL
               AND (o.path = d.path
                    OR (o.source_kind = 'data-folder' AND o.relative_path = d.relative_path)))`,
        )
        .map((row) => pathIn(dataDir, row.relative_path))
        .filter((path) => isLegacyCopy(dataDir, path));
      await Promise.all(copies.map((path) => rm(path, { force: true }).catch(reportError)));
    },

    /**
     * Processes a Document that failed again, from its file as it is now (see
     * `CoreApi.retryDocument`). Only a failed one whose file is there; one
     * that kept its last good version keeps it until the file is read.
     */
    retry(idInput: unknown): Document {
      const id = parseId(idInput);
      const row = find(id);
      if (!row) throw new NotFoundError({ key: "error.document.notFound" });
      // A scan with no text is read again too (#763): its text recognition may now be ready.
      if (!failedNow(row) && row.status !== "no-text") {
        throw new InvalidInputError({ key: "error.document.notFailed" });
      }
      if (row.file_status !== "available") {
        throw new NotFoundError({ key: "error.document.fileGone" });
      }
      process(id);
      return toDocument(find(id) ?? row);
    },

    /**
     * Opens a live Document's file where it is. Missing and unreachable files
     * are refused (NotFoundError), and an Office file over the size limit
     * (ExtractionError "too-large") before any byte is read.
     */
    async openFile(idInput: unknown): Promise<DocumentFile> {
      const row = await openablePath(idInput);
      if (isPackageKind(row.kind as DocumentKind)) {
        const size = await stat(row.path).then(
          (stats) => stats.size,
          () => null,
        );
        const refused = size === null ? null : packageSizeError(size);
        if (refused) throw refused;
      }
      try {
        const { stream, size } = await openFile(row.path);
        return { document: toDocument(row), stream, size };
      } catch (error) {
        await library.check([row.path]);
        throw new NotFoundError({ key: "error.document.fileCantOpen" }, { cause: error });
      }
    },

    /** The path of a live Document's file, checked to be there, to open in another app. */
    async filePath(idInput: unknown): Promise<string> {
      return (await openablePath(idInput)).path;
    },

    /**
     * Opens a picture a live Markdown Document shows from beside it, by the
     * path written in the file (see `openImageBeside`), or one a saved web
     * page's versions show, by its path in the snapshot, or the PDF of how
     * its last version looked (`WebPageLook.path`). Anything else is refused
     * (NotFoundError).
     */
    async openImage(idInput: unknown, path: unknown): Promise<DocumentImage> {
      if (typeof path !== "string" || path.length > 2048) {
        throw new InvalidInputError("An image's path must be text.");
      }
      const row = await openablePath(idInput);
      const look = row.kind === "web" ? currentLookHash(db, row.id) : null;
      if (look && path === `looks/${lookName(look)}`) {
        try {
          return { ...(await openFile(join(dirname(row.path), path))), type: "application/pdf" };
        } catch (error) {
          throw new NotFoundError({ key: "error.webPage.lookGone" }, { cause: error });
        }
      }
      if (row.kind === "web") {
        // A saved web page's picture: one of the files its versions show, and nothing else (#756).
        const hash = /^pictures\/([0-9a-f]{64})\.(?:png|jpg|gif|webp|avif)$/.exec(path)?.[1];
        if (!hash || !showsPicture(db, row.id, hash)) {
          throw new NotFoundError({ key: "error.document.noSuchPicture" });
        }
      } else if (row.kind !== "markdown") {
        throw new NotFoundError("Only a Markdown Document shows pictures from beside it.");
      }
      try {
        return await openImageBeside(row.path, path);
      } catch (error) {
        throw new NotFoundError("There is no such picture beside the Document.", { cause: error });
      }
    },

    async search(query: unknown, searchOptions: unknown): Promise<PassageSearchResult[]> {
      if (typeof query !== "string") throw new InvalidInputError("The search query must be text.");
      const { mode, limit, documentIds } = parseSearchOptions(searchOptions);
      if (query.trim() === "") return [];
      const scope = searchScope(documentIds);
      // Copies of one file share Passages: ask for more, so the limit holds after they are merged.
      const asked = Math.min(MAX_SEARCH_LIMIT, limit * 2);
      if (mode === "keyword") {
        const [keyword = []] = distinctPassages(db, [keywordSearch(db, query, asked, scope)]);
        return passagesBySeq(db, keyword.slice(0, limit));
      }
      const vector = await queryVector(query, mode);
      if (mode === "vector") {
        const hits = vector ? vectors.search(vector, asked, scope) : [];
        const [similar = []] = distinctPassages(db, [hits.map((hit) => hit.seq)]);
        return passagesBySeq(db, similar.slice(0, limit));
      }
      const keyword = keywordSearch(db, query, HYBRID_CANDIDATES, scope);
      const similar = vector
        ? vectors.search(vector, HYBRID_CANDIDATES, scope).map((hit) => hit.seq)
        : [];
      const lists = distinctPassages(db, [keyword, similar]);
      const keywordOnly =
        similar.length > 0 ? keywordOnlyPassages(db, lists[0] ?? [], model.id) : undefined;
      return passagesBySeq(db, fuseRankings(lists, limit, keywordOnly));
    },

    /** See `CoreApi.searchDocumentText`. */
    searchText(query: unknown, options?: unknown): DocumentTextMatch[] {
      if (typeof query !== "string") throw new InvalidInputError("The search query must be text.");
      if (options !== undefined && !isRecord(options)) {
        throw new InvalidInputError({ key: "error.search.options" });
      }
      return textSearch(
        db,
        query,
        searchLimit(options?.limit),
        excludedIds(options?.excludeDocumentIds),
      );
    },

    /** Linked folders (see ./library). */
    linkedFolders: library,

    /**
     * Garbage-collects old versions' text: the pages (and replaced Passages)
     * of each version that isn't a live Document's current one, unless
     * `isCited` says a Citation quotes it or a feature retains it. Returns
     * how many versions went.
     */
    collectOldVersions(isCited: (documentId: string, contentHash: string) => boolean): number {
      const versions = db.all<{ document_id: string; content_hash: string | null }>(
        `SELECT DISTINCT dp.document_id, dp.content_hash FROM document_pages dp
         JOIN documents d ON d.id = dp.document_id
         WHERE d.deleted_at IS NULL AND dp.content_hash IS NOT d.content_hash
         UNION
         SELECT DISTINCT p.document_id, p.content_hash FROM passages p
         JOIN documents d ON d.id = p.document_id
         WHERE d.deleted_at IS NULL AND p.deleted_at IS NOT NULL
           AND p.content_hash IS NOT d.content_hash`,
      );
      let collected = 0;
      db.transaction(() => {
        for (const { document_id: documentId, content_hash: contentHash } of versions) {
          if (contentHash !== null && isCited(documentId, contentHash)) continue;
          db.run("DELETE FROM document_pages WHERE document_id = ? AND content_hash IS ?", [
            documentId,
            contentHash,
          ]);
          db.run(
            `DELETE FROM passages
             WHERE document_id = ? AND content_hash IS ? AND deleted_at IS NOT NULL`,
            [documentId, contentHash],
          );
          collected++;
        }
      });
      return collected;
    },

    /**
     * Drops the text of deleted Documents being deleted permanently, except the Units
     * `keep` says Citations still point to: they stay as the text kept of an unlinked
     * Document does (`keptCitationTexts`), and go once nothing quotes them.
     */
    purgeText(ids: readonly string[], keep: readonly CitedUnits[]): void {
      const at = now();
      db.transaction(() => {
        for (const id of ids) {
          const row = db.get<{ deleted_at: string | null }>(
            "SELECT deleted_at FROM documents WHERE id = ?",
            [id],
          );
          if (!row?.deleted_at) continue;
          const kept = unitsToKeep(
            keep.filter((units) => units.documentId === id),
            row.deleted_at,
          );
          db.run(
            `UPDATE document_pages SET deleted_at = NULL, updated_at = ?
             WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL`,
            [at, JSON.stringify(kept)],
          );
          db.run("DELETE FROM document_pages WHERE document_id = ? AND deleted_at IS NOT NULL", [
            id,
          ]);
        }
      });
      options.emitKept?.(keptCitationTexts());
    },

    /**
     * Lets go of the text kept of unlinked Documents (`keptCitationTexts`):
     * each version's, unless `isCited` says a Citation still quotes it or a
     * feature retains it. It is deleted as their other text was. Returns how
     * many versions went.
     */
    releaseKeptText(isCited: (documentId: string, contentHash: string) => boolean): number {
      const at = now();
      let released = 0;
      db.transaction(() => {
        for (const { documentId, contentHash } of keptCitationTexts()) {
          if (isCited(documentId, contentHash)) continue;
          db.run(
            `UPDATE document_pages SET deleted_at = ?, updated_at = ?
             WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL`,
            [at, at, documentId, contentHash],
          );
          released++;
        }
      });
      return released;
    },

    /** Whether any live Document has text of a version other than its current one. */
    hasOldVersions(): boolean {
      return (
        db.get(
          `SELECT 1 FROM document_pages dp JOIN documents d ON d.id = dp.document_id
           WHERE d.deleted_at IS NULL AND dp.content_hash IS NOT d.content_hash
           UNION ALL
           SELECT 1 FROM passages p JOIN documents d ON d.id = p.document_id
           WHERE d.deleted_at IS NULL AND p.deleted_at IS NOT NULL
             AND p.content_hash IS NOT d.content_hash
           LIMIT 1`,
        ) !== undefined
      );
    },

    /**
     * While a Meeting is recorded (#135), Documents wait to be read and
     * embedded: the one being read finishes, the rest go on afterwards.
     */
    hold(held: boolean): void {
      processor.hold(held);
      embedding.hold(held);
    },

    close(): void {
      closed = true;
      library.close();
      embedding.close();
      processor.close();
      reading.close();
      // Closed in good order, a Document being read is read again at the next start; one
      // still "extracting" then is one whose reading stopped the app (see `unfinished`).
      db.run(
        `UPDATE documents SET status = 'queued', updated_at = ?
         WHERE deleted_at IS NULL AND status = 'extracting'`,
        [now()],
      );
    },
  };
}
