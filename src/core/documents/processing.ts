/**
 * What the processing worker does with each job. A processing job turns a
 * Document's file into Passages, and reads its creation date and title. A metadata job
 * reads only those: no text is extracted and nothing is
 * embedded. Each reads the file where the User keeps it, once, and hashes
 * what it read, so what it gives is always of the version recorded with it,
 * even if the file changes meanwhile. It never touches the database; the
 * core writes the result.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TextUnit } from "../../shared/units";
import type { LogFields, PagePicture, PictureRead, RecognizedLine } from "../adapters";
import type { DocumentFailureReason, DocumentKind } from "../api";
import {
  type FileMetadata,
  type FileReference,
  readReference,
  webPageReference,
} from "../referenceRecords/read";
import { stripBoilerplate } from "./boilerplate";
import { creationDate, pdfDate, w3cDate } from "./creationDate";
import { ExtractionError, extractText, type PageReading, pdfMetadata } from "./extract";
import { officeProperties } from "./formats/coreProperties";
import { readWebPage, SAVED_PICTURE } from "./formats/web";
import { isPackageKind, packageSizeError } from "./formats/zip";
import { keywordText } from "./keywords";
import { type BuiltPassage, buildPassages } from "./passages";
import { documentTitle } from "./title";

/**
 * The version of this pipeline: text extraction, Passage building, text
 * normalisation and keyword indexing. Bump it whenever any of them changes the
 * Passages or the index: Documents processed by an older version are
 * processed again at startup, going through the usual statuses.
 * 1: #25 (400/200 Passages, trigram index). 2: ADR-0009 (500/200 Passages,
 * normalised text, segmented keyword index, embeddings). 3: #30 (running
 * headers, footers and page numbers removed; page text stored for the
 * Citation check). 4: #31 (Passages built from whole lines, as the retrieval
 * prototype built them). 5: ADR-0011 (text stored as Units: Markdown by
 * section, plain text by blocks of lines; Word, PowerPoint, Excel and CSV
 * read). 6: ADR-0009's amendment (the keyword index reads traditional
 * Chinese characters as simplified ones; see `HAN_CURRENT_SINCE`). 7: #76
 * (a Word file's comments are read into the section their mark is in). 8:
 * #435 (a workbook's rows Units keep the number of each cell whose shown
 * text isn't that number written plainly). 9: #397 (a PDF's scanned pages
 * are read from their pictures; see `SCAN_CURRENT_SINCE`). 10: #756 (a saved
 * web page's pictures are read, their text in its section; see
 * `PICTURES_CURRENT_SINCE`). 11: #901 (a PDF's pages keep the name they
 * print, from its page labels or its headers and footers). 12: #1818
 * (PDF form fields are included in the pages' text).
 */
export const PROCESSING_VERSION = 12;

/**
 * Per kind, the oldest version whose Passages and Units are still what this
 * version would build: a Document processed by an older one is processed
 * again at startup. Version 5 changed nothing for PDFs, whose Passages
 * (and embeddings) stay as they are; version 6 changed no Passage or Unit;
 * version 7 changed only Word files', which gain their comments; version 8
 * only Excel workbooks', whose rows Units gain their cells' numbers; version 9
 * only PDFs' scanned pages, which `SCAN_CURRENT_SINCE` reads again; version
 * 10 only web pages with saved pictures, which `PICTURES_CURRENT_SINCE` reads;
 * version 11 only PDFs', whose pages gain their printed names and whose
 * Passages come out as they were; version 12 includes their form fields.
 */
export const CURRENT_SINCE: Readonly<Record<DocumentKind, number>> = {
  pdf: 12,
  text: 5,
  markdown: 5,
  docx: 7,
  pptx: 5,
  xlsx: 8,
  csv: 5,
  web: 7,
  transcript: 7,
};

/**
 * For a Document with Han characters in its text or name (Chinese, or
 * Japanese kanji), the oldest version whose keyword index is still what this
 * version would build: since version 6, the index reads traditional
 * characters as simplified ones (see ./keywords). Such a Document processed
 * by an older version, and current for its kind, is processed again at
 * startup. One without Han characters has nothing to fold: its version is
 * set to this one without its file being read, so its text is looked
 * through only once.
 */
export const HAN_CURRENT_SINCE = 6;

/**
 * For a PDF with a page that has little or no text (a scan, maybe), or a
 * page read from its picture, the oldest version that reads such pages as
 * this one would: since version 9 they are read from their pictures (#397).
 * Such a PDF processed by an older version is processed again at startup;
 * its pages of text come out as they were. When how pages are read changes
 * (`TextRecognitionModelDefinition.reader`), bump this with the processing
 * version: the pages read before are read again, except those a Citation
 * quotes, which are kept as they were read (see `ScanJob.keep`).
 */
export const SCAN_CURRENT_SINCE = 9;

/**
 * For a web page saved with its pictures, the oldest version that reads
 * them: one processed by an older version is processed again at startup,
 * when there is a model to read them.
 */
export const PICTURES_CURRENT_SINCE = 10;

/**
 * The version of the metadata read: what a Document's creation date is
 * worked out from (see ./creationDate). A Document whose metadata was read
 * by an older version, or not at all (`metadata_version` 0, as every
 * Document from before migration 24 is), has it read again by a metadata
 * job, in the background, without being processed or embedded again. When
 * only the metadata read changes, bump this, not `PROCESSING_VERSION`.
 * 1: #53 (creation dates). 2: #213 (titles). 3: #286 (reference records).
 * 4: #706 (reference records from a PDF's first page).
 */
export const METADATA_VERSION = 4;

/** How many of a PDF's first pages a DOI or an arXiv id is looked for in (#286). */
const REFERENCE_PAGES = 2;

/** Extracts a Document's text into Passages and Units, and reads its creation date. */
export interface ProcessingJob {
  task: "process";
  documentId: string;
  kind: DocumentKind;
  /** The Document's file, where the User keeps it. */
  file: string;
  /** How a PDF's scanned pages are read; none when they can't be (no model to read them with). */
  scan?: ScanJob | null;
}

/** Reading a PDF's scanned pages from their pictures (#397). */
export interface ScanJob {
  /** What reads them now (`UnitScan.reader`). */
  reader: string;
  /**
   * Scanned pages of a version read already, used as they are when the file
   * is still that version: those read by this reader (a retry reads only the
   * pages that couldn't be read), those a Citation quotes (so it stays
   * found), and those read before the job was stopped.
   */
  keep: { contentHash: string; units: TextUnit[] } | null;
}

/** Reads only a Document's metadata (its creation date): nothing is extracted or embedded. */
export interface MetadataJob {
  task: "metadata";
  documentId: string;
  kind: DocumentKind;
  /** The Document's file, where the User keeps it. */
  file: string;
  /** The version indexed: the metadata is read only if the file still is that version. */
  contentHash: string;
  /** That version's first Unit, as stored: where a year is looked for if the metadata has no date. */
  firstUnit: string | null;
}

export type WorkerJob = ProcessingJob | MetadataJob;

/** A Passage as the worker hands it over. */
export interface ProcessedPassage extends BuiltPassage {
  /**
   * The Passage's words for the keyword index (see ./keywords), worked out here
   * so the core's thread doesn't have to. The Document's name isn't included:
   * the core adds it, so a rename only redoes that part.
   */
  keywords: string;
}

/** What became of the file's text. */
type Processed =
  | {
      outcome: "ready";
      pageCount: number | null;
      passages: ProcessedPassage[];
      /**
       * The text of each Unit (page, slide, section, block of rows or lines),
       * as the Passages were built from it (see ./boilerplate), with its label and anchors.
       */
      pages: TextUnit[];
      /** PDF pages with unread content, and why; null when all could be read. */
      unread: { pages: number[]; message: string; forms?: true } | null;
    }
  | { outcome: "no-text"; pageCount: number | null }
  | { outcome: "failed"; reason: DocumentFailureReason; message: string };

/** The file couldn't be read: it is gone (`gone`), or can't be read now. */
interface FileUnreadable {
  outcome: "file-unreadable";
  gone: boolean;
  message: string;
}

/** The worker stopped mid-job (a crash, or out of memory). */
interface Crashed {
  outcome: "crashed";
  message: string;
}

/** The core stopped the job (its Linked folder was paused): nothing was processed. */
interface Stopped {
  outcome: "stopped";
}

/** What a version's metadata says of it. */
export interface VersionMetadata {
  /** The version's creation date (see ./creationDate), or null if nothing gives one. */
  creationDate: string | null;
  /** The version's title (see ./title), or null. */
  title: string | null;
  /** The version's reference record, as far as the file gives it (see ../referenceRecords/read). */
  reference: FileReference;
}

export type ProcessingResult =
  | (Processed &
      VersionMetadata & {
        /** The version processed: the SHA-256 of the bytes read, hex. */
        contentHash: string;
        /** How many bytes were read. */
        size: number;
      })
  /** Nothing was processed. */
  | FileUnreadable
  | Crashed
  | Stopped;

export type MetadataResult =
  | ({ outcome: "read" } & VersionMetadata)
  /** The file is no longer the version indexed: nothing was read. */
  | { outcome: "changed" }
  | FileUnreadable
  | Crashed;

export type WorkerResult = ProcessingResult | MetadataResult;

/**
 * How a job reads scanned pages: the text recognition model, which the core
 * runs, asked page by page; where the job is; and its stop signal.
 */
export interface ReadingChannel {
  /** The lines on a page's picture. Rejects with `ReadingUnavailable` when no page can be read now. */
  read(page: number, picture: PagePicture): Promise<RecognizedLine[]>;
  /** The lines on a picture file, read where the model runs (`TextRecognizer.readFile`). */
  readFile(page: number, file: Uint8Array): Promise<PictureRead>;
  log(event: string, fields: LogFields): void;
  /** `read` of `of` scanned pages of version `contentHash` are read; `unit` is the one just read. */
  progress(contentHash: string, read: number, of: number, unit: TextUnit | null): void;
  signal: AbortSignal;
}

/**
 * Messages from the core to the worker. `id` pairs everything with its job:
 * a job; the order to stop it; the lines read for a page it asked about
 * (`request` pairs them with the asking), or why they couldn't be.
 */
export type WorkerRequest =
  | { id: number; job: WorkerJob; password?: string }
  | { id: number; stop: true }
  | {
      id: number;
      request: number;
      lines?: RecognizedLine[];
      read?: PictureRead;
      error?: { message: string; unavailable: boolean };
    };

/**
 * Messages from the worker to the core: a job's result; how far it is in
 * reading scanned pages, with the page just read; and a page's picture to read.
 */
export type WorkerResponse =
  | { id: number; result: WorkerResult }
  | {
      id: number;
      progress: { contentHash: string; read: number; of: number; unit: TextUnit | null };
    }
  | { id: number; request: number; page: number; picture: PagePicture }
  | { id: number; request: number; page: number; file: Uint8Array }
  | { id: number; log: { event: string; fields: LogFields } };

/** Runs a job of either kind. Never throws. */
/** `password`: what opens the job's PDF when it is locked (#763), never kept with the job. */
export function runJob(
  job: WorkerJob,
  channel: ReadingChannel | null = null,
  password?: string,
): Promise<WorkerResult> {
  return job.task === "process" ? processFile(job, channel, password) : readMetadata(job, password);
}

/** Why the file couldn't be read: it is gone, or can't be read now. */
function unreadable(error: unknown): FileUnreadable {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    outcome: "file-unreadable",
    gone: code === "ENOENT" || code === "ENOTDIR",
    message: messageOf(error),
  };
}

/** The file's bytes, or why they couldn't be read. */
async function readBytes(file: string): Promise<Uint8Array | FileUnreadable> {
  try {
    return await readFile(file);
  } catch (error) {
    return unreadable(error);
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * A Word, PowerPoint or Excel file too large to open (see
 * `packageSizeError`), refused before it is read: its bytes are only hashed
 * as they stream past, for the version it is. Null for a file that isn't.
 */
async function refuseTooLarge(file: string, kind: DocumentKind): Promise<ProcessingResult | null> {
  try {
    const { size } = await stat(file);
    const refused = packageSizeError(size);
    if (!refused) return null;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return {
      outcome: "failed",
      reason: refused.reason,
      message: refused.message,
      contentHash: hash.digest("hex"),
      size,
      creationDate: null,
      title: null,
      reference: readReference({ kind, firstPages: [] }),
    };
  } catch (error) {
    return unreadable(error);
  }
}

/** Never throws: every problem becomes a "failed" result. */
export async function processFile(
  job: ProcessingJob,
  channel: ReadingChannel | null = null,
  password?: string,
): Promise<ProcessingResult> {
  const refused = isPackageKind(job.kind) ? await refuseTooLarge(job.file, job.kind) : null;
  if (refused) return refused;
  const bytes = await readBytes(job.file);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const version = { contentHash: sha256(bytes), size: bytes.byteLength };
  const reading: PageReading | null =
    job.scan && channel
      ? {
          read: channel.read,
          readFile: channel.readFile,
          log: channel.log,
          signal: channel.signal,
          progress: (read, of, unit) => channel.progress(version.contentHash, read, of, unit),
          reader: job.scan.reader,
          keep: new Map(
            job.scan.keep?.contentHash === version.contentHash
              ? job.scan.keep.units.map((unit) => [unit.page, unit])
              : [],
          ),
        }
      : null;
  const readPicture =
    job.kind === "web"
      ? async (src: string) => {
          if (!SAVED_PICTURE.test(src)) throw new Error("Not a picture saved with the page.");
          return readFile(join(dirname(job.file), src));
        }
      : null;
  const { processed, firstPages } = await processBytes(
    job.kind,
    bytes,
    reading,
    password,
    readPicture,
  );
  if (reading?.signal.aborted) return { outcome: "stopped" };
  const firstUnit = processed.outcome === "ready" ? (processed.pages[0]?.text ?? null) : null;
  return {
    ...processed,
    ...version,
    ...(await readMetadataOf(job.kind, bytes, firstUnit, firstPages, password)),
  };
}

/** A metadata job: the creation date of the version indexed, read from the file. Never throws. */
export async function readMetadata(job: MetadataJob, password?: string): Promise<MetadataResult> {
  // Text, Markdown and CSV files have no metadata: only the stored first Unit is read.
  if (!hasMetadata(job.kind)) {
    const firstPages = job.firstUnit === null ? [] : [job.firstUnit];
    return {
      outcome: "read",
      creationDate: creationDate([], job.firstUnit, thisYear()),
      title: documentTitle(null, job.firstUnit),
      reference: readReference({ kind: job.kind, firstPages }),
    };
  }
  const bytes = await readBytes(job.file);
  if (!(bytes instanceof Uint8Array)) return bytes;
  if (sha256(bytes) !== job.contentHash) return { outcome: "changed" };
  // A PDF's first pages are read again as extracted: the stored first Unit has lost its running
  // headers and footers, where a DOI often is.
  const firstPages = job.kind === "pdf" ? null : job.firstUnit === null ? [] : [job.firstUnit];
  return {
    outcome: "read",
    ...(await readMetadataOf(job.kind, bytes, job.firstUnit, firstPages, password)),
  };
}

const hasMetadata = (kind: DocumentKind) =>
  kind === "pdf" || kind === "docx" || kind === "pptx" || kind === "xlsx" || kind === "web";

/** The local calendar year now: no later creation date is plausible. */
const thisYear = () => new Date().getFullYear();

/**
 * A version's creation date (see ./creationDate): the metadata's (a PDF's
 * Info dictionary, then its XMP; an Office file's core properties), or else
 * the latest year written in its first Unit. Its title, and its reference
 * record (see ../referenceRecords/read), from the same metadata and from
 * `firstPages`, its first pages' text as extracted (null: a PDF's are read
 * here). Never throws: metadata that can't be read is no metadata, and
 * never fails the Document.
 */
async function readMetadataOf(
  kind: DocumentKind,
  bytes: Uint8Array,
  firstUnit: string | null,
  firstPages: string[] | null,
  password: string | undefined,
): Promise<VersionMetadata> {
  let fromMetadata: (string | null)[] = [];
  let property: string | null = null;
  const parts: FileMetadata = { kind, firstPages: firstPages ?? [] };
  try {
    if (kind === "web") {
      // When it was published, if it says; a year in its text is no date of the page's.
      const { meta } = readWebPage(new TextDecoder().decode(bytes));
      const title = documentTitle(meta.title, firstUnit);
      return {
        creationDate: creationDate(
          [meta.published === null ? null : w3cDate(meta.published)],
          null,
          thisYear(),
        ),
        title,
        reference: webPageReference(
          {
            address: meta.address ?? "",
            siteName: meta.siteName ?? "",
            author: meta.author,
            published: meta.published,
          },
          title,
        ),
      };
    }
    if (kind === "pdf") {
      const pdf = await pdfMetadata(bytes, firstPages === null ? REFERENCE_PAGES : 0, password);
      fromMetadata = [
        pdf.info === null ? null : pdfDate(pdf.info),
        pdf.xmp === null ? null : w3cDate(pdf.xmp),
      ];
      property = pdf.title;
      parts.info = { title: pdf.title, author: pdf.author };
      parts.xmp = pdf.xmpPacket;
      parts.firstPageLines = pdf.firstPageLines;
      if (firstPages === null) parts.firstPages = pdf.firstPages;
    } else if (hasMetadata(kind)) {
      const office = await officeProperties(bytes);
      fromMetadata = [office.created === null ? null : w3cDate(office.created)];
      property = office.title;
      parts.office = office;
    }
  } catch {
    // Unusual or malformed: the year comes from the first Unit.
  }
  return {
    creationDate: creationDate(fromMetadata, firstUnit, thisYear()),
    title: documentTitle(property, firstUnit),
    reference: readReference(parts),
  };
}

/** The file's text, processed, and its first pages as extracted (see `readMetadataOf`). */
async function processBytes(
  kind: DocumentKind,
  bytes: Uint8Array,
  reading: PageReading | null,
  password: string | undefined,
  readPicture: ((src: string) => Promise<Uint8Array>) | null,
): Promise<{ processed: Processed; firstPages: string[] }> {
  try {
    const extracted = await extractText(kind, bytes, reading, password, readPicture);
    const firstPages = extracted.units.slice(0, REFERENCE_PAGES).map((unit) => unit.text);
    const pages = kind === "pdf" ? stripBoilerplate(extracted.units) : extracted.units;
    const { pageCount, unread } = extracted;
    const passages = buildPassages(pages).map((passage) => ({
      ...passage,
      keywords: keywordText(passage.text),
    }));
    if (passages.length === 0) {
      // A scan none of whose pages could be read: it has text to find, once they can be.
      const processed: Processed = unread
        ? {
            outcome: "failed",
            reason: unread.forms ? "forms-unread" : "pages-unread",
            message: unreadMessage(unread),
          }
        : { outcome: "no-text", pageCount };
      return { processed, firstPages };
    }
    return { processed: { outcome: "ready", pageCount, passages, pages, unread }, firstPages };
  } catch (error) {
    const processed: Processed =
      error instanceof ExtractionError
        ? { outcome: "failed", reason: error.reason, message: error.message }
        : { outcome: "failed", reason: "processing-error", message: messageOf(error) };
    return { processed, firstPages: [] };
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The technical detail of scanned pages that couldn't be read, in English, for logs and tooltips. */
export const unreadMessage = (unread: { pages: number[]; message: string; forms?: true }) =>
  unread.forms
    ? unread.message
    : `Scanned ${unread.pages.length === 1 ? "page" : "pages"} ${unread.pages.join(", ")} couldn't be read${unread.message ? `: ${unread.message}` : "."}`;
