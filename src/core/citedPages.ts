/**
 * The cited page (#133): when a Citation is made, how its Location looked in
 * the version it quotes (a PDF's pages, a slide, a sheet's rows, a section or
 * lines of text) is saved as a picture in the data folder's "Cited pages",
 * with the text drawn on it, so a quote can be shown where it stood after its
 * file changes or goes (the source pack, #134).
 *
 * - One picture per Location and version: Citations of the same rows, slide
 *   or section share it (see `areaOf`).
 * - Drawing takes turns in the background queue: never while an Answer is
 *   being written, and a drawing under way gives way when one starts. What
 *   waits is kept in the database, so a drawing a quit cut short is made at
 *   the next start, if the file still has that version.
 * - A PDF's pages are drawn by the page-image worker; every other kind by its
 *   viewer, off screen (`CoreAdapters.capturePage`).
 * - A picture is kept while a Citation or a Checkpoint points at it, and
 *   retains its version's text meanwhile (./documents/retention). At the
 *   first start after the last one goes, it goes. Nothing here is searched.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DrawnPage, PageArea, PageText } from "../shared/citedPage";
import { parseLocation } from "../shared/locations";
import type { CapturePage, Logger } from "./adapters";
import type { CitationFields, CitedUnits } from "./answers/citedVersions";
import {
  type CitationAttributes,
  type CitationLocation,
  type Document,
  RECENTLY_DELETED_DAYS,
} from "./api";
import type { BackgroundCall, BackgroundJob, BackgroundQueue } from "./backgroundQueue";
import { hashFile, isGone } from "./documents/files";
import type { createVersionRetention } from "./documents/retention";
import { InvalidInputError, isRecord } from "./errors";
import type { Database } from "./storage";

/** The data folder's folder of cited pages' pictures, each `<id>.png` or `<id>.jpg`. */
export const CITED_PAGES_FOLDER = "Cited pages";

/** The largest picture kept, in bytes. */
const MAX_BYTES = 32 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<DrawnPage["type"], string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** What a Citation's saved page is found by: its Document, the version it quotes, its Units and Location. */
export type CitedPlace = Pick<
  CitationAttributes,
  "documentId" | "contentHash" | "pageFrom" | "pageTo" | "location"
>;

/** What a Location's picture shows: a sheet's cited rows, or else all of its Units. */
function areaOf(location: CitationLocation): PageArea {
  return location.kind === "rows"
    ? { kind: "rows", sheet: location.sheet, from: location.from, to: location.to }
    : { kind: location.kind };
}

/** A Citation's place, as saved pages are kept by. */
interface Place {
  documentId: string;
  /** Null for a Citation that doesn't say which version it quotes: every version. */
  contentHash: string | null;
  pageFrom: number;
  pageTo: number;
  /** `areaOf` its Location, as stored; null for a Citation made before Locations. */
  area: string | null;
}

const isUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

function placeOf(citation: CitationFields): Place | null {
  const { documentId, contentHash, pageFrom, pageTo } = citation;
  if (typeof documentId !== "string" || documentId === "" || !isUnit(pageFrom)) return null;
  const to = isUnit(pageTo) ? pageTo : pageFrom;
  const location = parseLocation(citation.location);
  return {
    documentId,
    contentHash: typeof contentHash === "string" && contentHash !== "" ? contentHash : null,
    pageFrom: Math.min(pageFrom, to),
    pageTo: Math.max(pageFrom, to),
    area: location ? JSON.stringify(areaOf(location)) : null,
  };
}

/** What one saved page is for: Citations with the same key share it. Null if a Citation can't have one. */
export function citedPageKey(citation: CitationFields): string | null {
  const place = placeOf(citation);
  return place?.contentHash && place.area !== null ? JSON.stringify(place) : null;
}

function parseArea(stored: string): PageArea {
  const value: unknown = JSON.parse(stored);
  if (isRecord(value)) {
    const { kind, sheet, from, to } = value;
    if (
      kind === "rows" &&
      isUnit(from) &&
      isUnit(to) &&
      (sheet === null || typeof sheet === "string")
    ) {
      return { kind, sheet, from, to };
    }
    if (
      kind === "page" ||
      kind === "slide" ||
      kind === "section" ||
      kind === "lines" ||
      kind === "time"
    ) {
      return { kind };
    }
  }
  throw new Error("A cited page's area couldn't be read.");
}

const isBox = (value: unknown): boolean =>
  isRecord(value) &&
  ["x", "y", "width", "height"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );

/** The text drawn on a picture, as stored: runs that aren't whole are left out. */
function parseText(stored: string | null): PageText[] {
  if (stored === null) return [];
  const value: unknown = JSON.parse(stored);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (run): run is PageText =>
      isRecord(run) &&
      typeof run.text === "string" &&
      (run.breakAfter === undefined || typeof run.breakAfter === "boolean") &&
      isBox(run.box),
  );
}

/** A drawing as it may be saved; throws otherwise. */
function checked(page: DrawnPage): DrawnPage {
  const size = (value: number) => Number.isInteger(value) && value > 0;
  if (
    !(page.type in EXTENSIONS) ||
    !size(page.width) ||
    !size(page.height) ||
    page.data.byteLength === 0 ||
    page.data.byteLength > MAX_BYTES ||
    !Array.isArray(page.text)
  ) {
    throw new Error("The cited page wasn't drawn as a picture that can be saved.");
  }
  return page;
}

interface Row {
  id: string;
  document_id: string;
  content_hash: string;
  page_from: number;
  page_to: number;
  area: string;
  image_type: string | null;
  width: number | null;
  height: number | null;
  text: string | null;
}

const COLUMNS =
  "id, document_id, content_hash, page_from, page_to, area, image_type, width, height, text";

const imageType = (stored: string | null): DrawnPage["type"] | null =>
  stored === "image/jpeg" || stored === "image/png" ? stored : null;

const fileName = (id: string, type: DrawnPage["type"]) => `${id}.${EXTENSIONS[type]}`;

/**
 * Why something failed, for the log: a file system error's code, as its message names the
 * User's file; else the message, which is ours (the Document changed, the page couldn't be drawn).
 */
function reasonOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : "unknown";
}

export interface CitedPagesOptions {
  db: Database;
  dataDir: string;
  now: () => string;
  retention: ReturnType<typeof createVersionRetention>;
  background: BackgroundQueue;
  /** A live Document; null for one deleted, or not known here. */
  document(documentId: string): Document | null;
  /** The path of a live Document's file, checked to be there. */
  filePath(documentId: string): Promise<string>;
  /** Draws a PDF's pages from its file, which must be this version; `documentId` is whose. */
  drawPdf(
    documentId: string,
    file: string,
    contentHash: string,
    pages: readonly number[],
    signal: AbortSignal,
  ): Promise<DrawnPage>;
  capturePage: CapturePage | undefined;
  log: Logger;
}

export function createCitedPages(options: CitedPagesOptions) {
  const { db, now, retention, log } = options;
  const folder = join(options.dataDir, CITED_PAGES_FOLDER);
  const lifetime = new AbortController();
  /** The turn in the background queue, while one is queued or running. */
  let turn: BackgroundJob | null = null;

  const drawable = (document: Document) =>
    document.kind === "pdf" || options.capturePage !== undefined;

  const waiting = () =>
    db.get<Row>(
      `SELECT ${COLUMNS} FROM cited_pages WHERE deleted_at IS NULL AND image_type IS NULL
       ORDER BY created_at, rowid LIMIT 1`,
    );

  async function draw(row: Row, signal: AbortSignal): Promise<DrawnPage> {
    const document = options.document(row.document_id);
    if (!document) throw new Error("The Document was deleted.");
    if (document.contentHash !== row.content_hash) {
      throw new Error("The Document changed since it was cited.");
    }
    const path = await options.filePath(row.document_id);
    if (document.kind === "pdf") {
      const pages = Array.from(
        { length: row.page_to - row.page_from + 1 },
        (_, index) => row.page_from + index,
      );
      return options.drawPdf(row.document_id, path, row.content_hash, pages, signal);
    }
    const capture = options.capturePage;
    if (!capture) throw new Error("This copy of IncarnaMind can't draw cited pages.");
    // The viewer reads the file as it is on disk, so it must be the version cited throughout.
    const before = await stat(path);
    if ((await hashFile(path)).contentHash !== row.content_hash) {
      throw new Error("The Document changed since it was cited.");
    }
    const area = parseArea(row.area);
    const page = await capture(
      { document, pageFrom: row.page_from, pageTo: row.page_to, area },
      signal,
    );
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("The Document changed while its page was drawn.");
    }
    return page;
  }

  /** Writes the picture whole under a name of its own, then records it. */
  async function save(row: Row, page: DrawnPage): Promise<void> {
    await mkdir(folder, { recursive: true });
    const name = fileName(row.id, page.type);
    const writing = join(folder, `${name}.${randomUUID()}.writing`);
    try {
      await writeFile(writing, page.data, { flush: true });
      await rename(writing, join(folder, name));
    } catch (error) {
      await rm(writing, { force: true });
      throw error;
    }
    // Closed meanwhile: the picture goes at the next start, which draws it again.
    if (lifetime.signal.aborted) return;
    const at = now();
    db.transaction(() => {
      if (!db.get("SELECT 1 FROM cited_pages WHERE id = ? AND deleted_at IS NULL", [row.id])) {
        return;
      }
      db.run(
        `UPDATE cited_pages SET image_type = ?, width = ?, height = ?, text = ?, saved_at = ?,
           updated_at = ?
         WHERE id = ?`,
        [page.type, page.width, page.height, JSON.stringify(page.text), at, at, row.id],
      );
      retention.retain("saved-page", row.id, [
        {
          documentId: row.document_id,
          contentHash: row.content_hash,
          pageFrom: row.page_from,
          pageTo: row.page_to,
        },
      ]);
    });
  }

  /** A page that can't be drawn isn't: a later Citation of its Location tries again. */
  function notSaved(row: Row, error: unknown): void {
    log.warn("citedPage.notSaved", { documentId: row.document_id, reason: reasonOf(error) });
    const at = now();
    db.run(
      "UPDATE cited_pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [at, at, row.id],
    );
  }

  /** Draws and saves the page that has waited longest: one turn in the background queue. */
  async function saveNext(call: BackgroundCall): Promise<void> {
    const row = waiting();
    if (!row) return;
    // It is drawn on this computer: an Answer that starts comes first, and this goes again after.
    call.runsLocally();
    try {
      const page = checked(await draw(row, call.signal));
      if (lifetime.signal.aborted) return;
      await save(row, page);
    } catch (error) {
      if (lifetime.signal.aborted || call.gaveWay) return;
      notSaved(row, error);
    }
  }

  function schedule(): void {
    if (turn || lifetime.signal.aborted || !waiting()) return;
    const job: BackgroundJob = {
      kind: "cited-page",
      run: async (call) => {
        try {
          await saveNext(call);
        } catch (error) {
          if (!lifetime.signal.aborted) log.error("citedPage.failed", { reason: reasonOf(error) });
        } finally {
          // A turn that gave way goes again, first; otherwise the next page takes a new turn.
          if (!call.gaveWay) {
            turn = null;
            schedule();
          }
        }
      },
    };
    turn = job;
    options.background.add(job);
  }

  return {
    /**
     * Citations were made: each one's page waits to be drawn, unless its
     * Location of that version is saved or waiting already. Only the version
     * a Document's file has now can be drawn.
     */
    citationsMade(citations: readonly CitedPlace[]): void {
      if (lifetime.signal.aborted) return;
      const at = now();
      let added = false;
      db.transaction(() => {
        for (const citation of citations) {
          const place = placeOf(citation);
          if (!place?.contentHash || place.area === null) continue;
          const document = options.document(place.documentId);
          if (
            !document ||
            document.contentHash !== place.contentHash ||
            document.fileStatus !== "available" ||
            !drawable(document)
          ) {
            continue;
          }
          const params = [
            place.documentId,
            place.contentHash,
            place.pageFrom,
            place.pageTo,
            place.area,
          ];
          const known = db.get(
            `SELECT 1 FROM cited_pages
             WHERE document_id = ? AND content_hash = ? AND page_from = ? AND page_to = ?
               AND area = ? AND deleted_at IS NULL`,
            params,
          );
          if (known) continue;
          db.run(
            `INSERT INTO cited_pages (id, document_id, content_hash, page_from, page_to, area,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), ...params, at, at],
          );
          added = true;
        }
      });
      if (added) schedule();
    },

    /** Starts drawing the pages that wait, as at a start after a quit cut a drawing short. */
    start(): void {
      schedule();
    },

    /** A Citation's saved page, read from its file; null if none is saved. */
    async image(citation: unknown): Promise<DrawnPage | null> {
      if (!isRecord(citation)) throw new InvalidInputError("A Citation must be an object.");
      const place = placeOf(citation);
      if (!place?.contentHash || place.area === null) return null;
      const row = db.get<Row>(
        `SELECT ${COLUMNS} FROM cited_pages
         WHERE document_id = ? AND content_hash = ? AND page_from = ? AND page_to = ?
           AND area = ? AND deleted_at IS NULL AND image_type IS NOT NULL`,
        [place.documentId, place.contentHash, place.pageFrom, place.pageTo, place.area],
      );
      const type = imageType(row?.image_type ?? null);
      if (!row || !type || !row.width || !row.height) return null;
      let data: Buffer;
      try {
        data = await readFile(join(folder, fileName(row.id, type)));
      } catch (error) {
        if (!isGone(error)) throw error;
        log.warn("citedPage.missing", { documentId: row.document_id });
        return null;
      }
      return {
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        type,
        width: row.width,
        height: row.height,
        text: parseText(row.text),
      };
    },

    /**
     * For the start-up clean-up: told every Citation, it keeps the pages they
     * point at, and those of the Units a Checkpoint retains; `collect` lets
     * the rest go. Null when no page is saved or waiting.
     */
    collector(): { cite(citation: CitationFields): void; collect(): void } | null {
      const rows = db.all<Row>(`SELECT ${COLUMNS} FROM cited_pages WHERE deleted_at IS NULL`);
      if (rows.length === 0) return null;
      const byDocument = new Map<string, Row[]>();
      for (const row of rows) {
        const list = byDocument.get(row.document_id);
        if (list) list.push(row);
        else byDocument.set(row.document_id, [row]);
      }
      const kept = new Set<string>();
      const keep = (place: Place, overlapping: boolean) => {
        for (const row of byDocument.get(place.documentId) ?? []) {
          if (place.contentHash !== null && row.content_hash !== place.contentHash) continue;
          if (place.area !== null && row.area !== place.area) continue;
          const same = overlapping
            ? row.page_from <= place.pageTo && row.page_to >= place.pageFrom
            : row.page_from === place.pageFrom && row.page_to === place.pageTo;
          if (same) kept.add(row.id);
        }
      };
      return {
        cite(citation) {
          const place = placeOf(citation);
          if (place) keep(place, false);
        },
        collect() {
          const units: CitedUnits[] = [];
          retention.addRetainedUnits(new Set(byDocument.keys()), units, [
            "checkpoint",
            "note-figure",
          ]);
          for (const unit of units) {
            const pageFrom = unit.pageFrom ?? 1;
            const pageTo = unit.pageTo ?? Number.MAX_SAFE_INTEGER;
            keep({ ...unit, pageFrom, pageTo, area: null }, true);
          }
          const gone = rows.filter((row) => !kept.has(row.id));
          if (gone.length === 0) return;
          const at = now();
          db.transaction(() => {
            for (const row of gone) {
              db.run("UPDATE cited_pages SET deleted_at = ?, updated_at = ? WHERE id = ?", [
                at,
                at,
                row.id,
              ]);
              retention.release("saved-page", row.id);
            }
          });
        },
      };
    },

    /**
     * Removes the files no saved page names: those of pages gone, and what a
     * quit left half written. At start-up, before any page is drawn.
     */
    sweep(): void {
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch (error) {
        if (!isGone(error)) log.warn("citedPage.sweep", { reason: reasonOf(error) });
        return;
      }
      const named = new Set<string>();
      for (const row of db.all<{ id: string; image_type: string | null }>(
        "SELECT id, image_type FROM cited_pages WHERE deleted_at IS NULL AND image_type IS NOT NULL",
      )) {
        const type = imageType(row.image_type);
        if (type) named.add(fileName(row.id, type));
      }
      for (const name of names) {
        if (named.has(name)) continue;
        try {
          rmSync(join(folder, name), { force: true });
        } catch (error) {
          log.warn("citedPage.sweep", { reason: reasonOf(error) });
        }
      }
    },

    /** Forgets pages gone longer than `RECENTLY_DELETED_DAYS`: a later sync has had that long. */
    forgetGone(): void {
      const before = new Date(
        Date.parse(now()) - RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      db.run("DELETE FROM cited_pages WHERE deleted_at IS NOT NULL AND deleted_at < ?", [before]);
    },

    /** Stops: a drawing under way is dropped, to be drawn again at the next start. */
    close(): void {
      lifetime.abort();
    },
  };
}

export type CitedPages = ReturnType<typeof createCitedPages>;
