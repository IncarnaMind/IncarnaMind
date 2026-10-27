/**
 * The versions of Documents that features other than Citations still need
 * (#79, migration 48). An old version's text stays for as long as a Citation
 * quotes it (ADR-0010). A check result's evidence, a saved page, an
 * unfinished Task's sources and a Checkpoint's Citations need old text too,
 * and they are kept outside Minds. A Note's figure dependencies are projected
 * here so older readers also keep their source text (ADR-0021). Each owner retains the versions
 * it needs, and where in them. The start-up clean-up then reads them all with
 * one query, beside the Minds it already walks.
 *
 * - A retained version keeps its text when its file changes, as a quoted one
 *   does. When its Linked folder is unlinked, the Units retained stay.
 * - Once its last owner releases it, and no Citation quotes it, its text goes
 *   at the next start.
 * - A release marks rows deleted, so a later sync can pass it on. The rows
 *   are forgotten `RECENTLY_DELETED_DAYS` later, so the table stays bounded.
 */
import { randomUUID } from "node:crypto";
import { parseLocation } from "../../shared/locations";
import {
  addCitedUnit,
  addCitedVersion,
  type CitedUnits,
  type CitedVersions,
} from "../answers/citedVersions";
import { type CitationLocation, RECENTLY_DELETED_DAYS } from "../api";
import { InvalidInputError, isRecord } from "../errors";
import type { Database } from "../storage";

/**
 * What retains a version: a check result (its evidence, #96), a saved page
 * (#133), an unfinished Task (#126), a Checkpoint (#113) or a Note's figure inputs.
 */
export const RETENTION_KINDS = [
  "check-result",
  "saved-page",
  "task",
  "checkpoint",
  "note-figure",
] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

/** A version of a Document that an owner retains, and where in it. */
export interface RetainedVersion {
  documentId: string;
  /** The version: the SHA-256 of its file, as `Document.contentHash` gave it. */
  contentHash: string;
  /** The Units needed (pages, slides…), from 1, as a Citation names them; both null for all. */
  pageFrom: number | null;
  pageTo: number | null;
  /** Where in the Document, as a Citation's Location; null if it doesn't say. */
  location: CitationLocation | null;
}

/** A version to retain. Without Units, all of them; without a Location, none is said. */
export type RetainVersion = Pick<RetainedVersion, "documentId" | "contentHash"> &
  Partial<Pick<RetainedVersion, "pageFrom" | "pageTo" | "location">>;

/** What the core's features use (see `Core.retention`). */
export interface VersionRetention {
  /**
   * Sets the versions one owner retains, in place of those it retained
   * before: any it no longer lists are released. An empty list releases all.
   */
  retain(kind: RetentionKind, ownerId: string, versions: readonly RetainVersion[]): void;
  /** Releases every version one owner retains, as when the owner is deleted or done. */
  release(kind: RetentionKind, ownerId: string): void;
  /** The versions one owner retains, in the order they were first retained. */
  retainedBy(kind: RetentionKind, ownerId: string): RetainedVersion[];
  /** Whether any owner of this kind retains a version of one of these Documents. */
  isRetained(kind: RetentionKind, documentIds: readonly string[]): boolean;
}

interface Row {
  id: string;
  document_id: string;
  content_hash: string;
  page_from: number | null;
  page_to: number | null;
  location: string | null;
}

const isUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

function parseKind(kind: unknown): RetentionKind {
  const known = RETENTION_KINDS.find((each) => each === kind);
  if (!known) throw new InvalidInputError(`Nothing of the kind ${String(kind)} retains versions.`);
  return known;
}

function parseOwner(ownerId: unknown): string {
  if (typeof ownerId !== "string" || ownerId === "") {
    throw new InvalidInputError("The owner of retained versions must be a non-empty id.");
  }
  return ownerId;
}

function parseVersion(input: unknown): RetainedVersion {
  if (!isRecord(input)) throw new InvalidInputError("A retained version must be an object.");
  const { documentId, contentHash } = input;
  if (typeof documentId !== "string" || documentId === "") {
    throw new InvalidInputError("A retained version needs its Document's id.");
  }
  if (typeof contentHash !== "string" || contentHash === "") {
    throw new InvalidInputError("A retained version needs its content hash.");
  }
  const pageFrom = input.pageFrom ?? null;
  const pageTo = input.pageTo ?? null;
  const allUnits = pageFrom === null && pageTo === null;
  if (!allUnits && !(isUnit(pageFrom) && isUnit(pageTo) && pageFrom <= pageTo)) {
    throw new InvalidInputError(
      "Retained Units are a first and a last Unit number, from 1, or both null.",
    );
  }
  const stored = input.location ?? null;
  const location = stored === null ? null : parseLocation(stored);
  if (stored !== null && location === null) {
    throw new InvalidInputError("A retained version's Location must be a Citation's Location.");
  }
  return { documentId, contentHash, pageFrom, pageTo, location };
}

/**
 * A row as a version. A Location of a kind a newer version wrote reads as
 * none, so retaining the same version without a Location keeps that row, and
 * what it stored, as it is.
 */
const toVersion = (row: Row): RetainedVersion => ({
  documentId: row.document_id,
  contentHash: row.content_hash,
  pageFrom: row.page_from,
  pageTo: row.page_to,
  location: parseLocation(row.location),
});

/** One key per version and place, so retaining it again changes nothing. */
const keyOf = (version: RetainedVersion) =>
  JSON.stringify([
    version.documentId,
    version.contentHash,
    version.pageFrom,
    version.pageTo,
    version.location,
  ]);

export function createVersionRetention(db: Database, now: () => string) {
  const ownRows = (kind: RetentionKind, ownerId: string) =>
    db.all<Row>(
      `SELECT id, document_id, content_hash, page_from, page_to, location FROM retained_versions
       WHERE kind = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY rowid`,
      [kind, ownerId],
    );

  return {
    retain(kindInput: unknown, ownerInput: unknown, versionsInput: unknown): void {
      const kind = parseKind(kindInput);
      const ownerId = parseOwner(ownerInput);
      if (!Array.isArray(versionsInput)) {
        throw new InvalidInputError("Retaining takes a list of versions.");
      }
      const wanted = new Map<string, RetainedVersion>();
      for (const input of versionsInput) {
        const version = parseVersion(input);
        wanted.set(keyOf(version), version);
      }
      const at = now();
      db.transaction(() => {
        for (const row of ownRows(kind, ownerId)) {
          const key = keyOf(toVersion(row));
          // Retained already: left as it is. A second row for it, as a sync may bring, goes.
          if (wanted.delete(key)) continue;
          db.run("UPDATE retained_versions SET deleted_at = ?, updated_at = ? WHERE id = ?", [
            at,
            at,
            row.id,
          ]);
        }
        for (const version of wanted.values()) {
          db.run(
            `INSERT INTO retained_versions (id, kind, owner_id, document_id, content_hash,
               page_from, page_to, location, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              kind,
              ownerId,
              version.documentId,
              version.contentHash,
              version.pageFrom === null ? null : BigInt(version.pageFrom),
              version.pageTo === null ? null : BigInt(version.pageTo),
              version.location === null ? null : JSON.stringify(version.location),
              at,
              at,
            ],
          );
        }
      });
    },

    release(kindInput: unknown, ownerInput: unknown): void {
      const kind = parseKind(kindInput);
      const ownerId = parseOwner(ownerInput);
      const at = now();
      db.run(
        `UPDATE retained_versions SET deleted_at = ?, updated_at = ?
         WHERE kind = ? AND owner_id = ? AND deleted_at IS NULL`,
        [at, at, kind, ownerId],
      );
    },

    retainedBy(kindInput: unknown, ownerInput: unknown): RetainedVersion[] {
      return ownRows(parseKind(kindInput), parseOwner(ownerInput)).map(toVersion);
    },

    isRetained(kindInput: unknown, documentIds: readonly string[]): boolean {
      const kind = parseKind(kindInput);
      if (documentIds.length === 0) return false;
      const marks = documentIds.map(() => "?").join(", ");
      return (
        db.get<{ found: number }>(
          `SELECT 1 AS found FROM retained_versions
           WHERE kind = ? AND document_id IN (${marks}) AND deleted_at IS NULL LIMIT 1`,
          [kind, ...documentIds],
        ) !== undefined
      );
    },

    /**
     * Adds every retained version to `cited`, for the start-up clean-up: of
     * every kind, those a newer version of IncarnaMind wrote included.
     */
    addRetainedVersions(cited: CitedVersions): void {
      const rows = db.all<{ document_id: string; content_hash: string }>(
        `SELECT DISTINCT document_id, content_hash FROM retained_versions
         WHERE deleted_at IS NULL`,
      );
      for (const row of rows) {
        addCitedVersion({ documentId: row.document_id, contentHash: row.content_hash }, cited);
      }
    },

    /**
     * Adds the Units retained in these Documents to `cited`, for a Linked
     * folder being unlinked; with `kinds`, only those owners of these kinds retain.
     */
    addRetainedUnits(
      documentIds: ReadonlySet<string>,
      cited: CitedUnits[],
      kinds?: readonly RetentionKind[],
    ): void {
      const rows = db.all<Omit<Row, "id" | "location">>(
        `SELECT document_id, content_hash, page_from, page_to FROM retained_versions
         WHERE deleted_at IS NULL AND document_id IN (SELECT value FROM json_each(?1))
           AND (?2 IS NULL OR kind IN (SELECT value FROM json_each(?2)))`,
        [JSON.stringify([...documentIds]), kinds ? JSON.stringify(kinds) : null],
      );
      for (const row of rows) {
        const units = {
          documentId: row.document_id,
          contentHash: row.content_hash,
          pageFrom: row.page_from,
          pageTo: row.page_to,
        };
        addCitedUnit(units, documentIds, cited);
      }
    },

    /** Forgets releases older than `RECENTLY_DELETED_DAYS`: a later sync has had that long. */
    forgetReleased(): void {
      const before = new Date(
        Date.parse(now()) - RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      db.run("DELETE FROM retained_versions WHERE deleted_at IS NOT NULL AND deleted_at < ?", [
        before,
      ]);
    },
  };
}
