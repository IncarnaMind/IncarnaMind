/**
 * One `web_pages` row per version of a web page (migration 47), with its
 * look when it was asked for (migration 91), and one `web_page_pictures` row
 * per picture each version shows (migration 89).
 */
import { randomUUID } from "node:crypto";
import type { WebPageInfo, WebPageLook, WebPageLookFailure, WebPageOrigin } from "../../api";
import type { Database } from "../../storage";

interface WebPageRow {
  content_hash: string;
  address: string;
  site_name: string;
  author: string | null;
  published: string | null;
  fetched_at: string;
  pictures_left_out: number;
  origin: WebPageOrigin;
  look_status: "saving" | "saved" | "failed" | null;
  look_hash: string | null;
  look_saved_at: string | null;
  look_failure: string | null;
}

export interface WebPageVersion {
  documentId: string;
  contentHash: string;
  address: string;
  siteName: string;
  author: string | null;
  published: string | null;
  fetchedAt: string;
  picturesLeftOut: number;
  origin: WebPageOrigin;
}

/** A picture a version shows, numbered from 1 as the page shows them; its file is named by `pictureHash`. */
export interface WebPagePicture {
  number: number;
  pictureHash: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  address: string;
}

export const lookName = (lookHash: string) => `${lookHash}.pdf`;

const LOOK_FAILURES = new Set<string>([
  "timed-out",
  "unreachable",
  "too-large",
  "stopped",
  "local-mode",
  "failed",
]);
const isLookFailure = (value: string | null): value is WebPageLookFailure =>
  value !== null && LOOK_FAILURES.has(value);

/** A look's file is named by the SHA-256 of its content, and nothing else is read as one. */
const isLookHash = (value: string | null): value is string =>
  value !== null && /^[0-9a-f]{64}$/.test(value);

function lookOf(row: WebPageRow): WebPageLook | null {
  switch (row.look_status) {
    case "saving":
      return { status: "saving" };
    case "saved":
      return isLookHash(row.look_hash) && row.look_saved_at
        ? { status: "saved", savedAt: row.look_saved_at, path: `looks/${lookName(row.look_hash)}` }
        : null;
    case "failed":
      return {
        status: "failed",
        failure: isLookFailure(row.look_failure) ? row.look_failure : "failed",
      };
    default:
      return null;
  }
}

/** As last fetched; null for a Document that isn't a web page. */
export function webPageInfo(db: Database, documentId: string): WebPageInfo | null {
  const rows = db.all<WebPageRow>(
    `SELECT content_hash, address, site_name, author, published, fetched_at, pictures_left_out,
       origin, look_status, look_hash, look_saved_at, look_failure
     FROM web_pages
     WHERE document_id = ? AND deleted_at IS NULL ORDER BY fetched_at DESC, rowid DESC`,
    [documentId],
  );
  const latest = rows[0];
  if (!latest) return null;
  return {
    address: latest.address,
    origin: latest.origin,
    siteName: latest.site_name,
    author: latest.author,
    published: latest.published,
    fetchedAt: latest.fetched_at,
    versions: rows.map((row) => ({ contentHash: row.content_hash, fetchedAt: row.fetched_at })),
    picturesLeftOut: latest.pictures_left_out,
    look: lookOf(latest),
  };
}

export function recordLook(
  db: Database,
  documentId: string,
  contentHash: string,
  look:
    | { status: "saving"; resumed?: true }
    | { status: "saved"; lookHash: string; savedAt: string }
    | { status: "failed"; failure: WebPageLookFailure },
  at: string,
): boolean {
  // In Recently deleted too: restored, the page says how its look went.
  return (
    db.all<{ id: string }>(
      `UPDATE web_pages SET look_status = ?, look_hash = ?, look_saved_at = ?, look_failure = ?,
         updated_at = ?
       WHERE document_id = ? AND content_hash = ? RETURNING id`,
      [
        look.status,
        look.status === "saved" ? look.lookHash : null,
        look.status === "saved" ? look.savedAt : null,
        look.status === "failed"
          ? look.failure
          : look.status === "saving" && look.resumed
            ? RESUMED
            : null,
        at,
        documentId,
        contentHash,
      ],
    ).length > 0
  );
}

/** On a look being made: it was made again once already, after the app quit while making it. */
const RESUMED = "resumed";

export function looksUnderWay(
  db: Database,
): { documentId: string; contentHash: string; address: string; resumed: boolean }[] {
  return db
    .all<{
      document_id: string;
      content_hash: string;
      address: string;
      look_failure: string | null;
    }>(
      `SELECT w.document_id, w.content_hash, w.address, w.look_failure FROM web_pages w
       JOIN documents d ON d.id = w.document_id
       WHERE w.look_status = 'saving' AND w.deleted_at IS NULL AND d.deleted_at IS NULL`,
    )
    .map((row) => ({
      documentId: row.document_id,
      contentHash: row.content_hash,
      address: row.address,
      resumed: row.look_failure === RESUMED,
    }));
}

/** The looks some version of a web page has, live or in Recently deleted: their files stay. */
export function keptLookHashes(db: Database): Set<string> {
  return new Set(
    db
      .all<{ look_hash: string }>(
        "SELECT DISTINCT look_hash FROM web_pages WHERE look_hash IS NOT NULL",
      )
      .map((row) => row.look_hash),
  );
}

export function currentLookHash(db: Database, documentId: string): string | null {
  const latest = db.get<{ look_status: string | null; look_hash: string | null }>(
    `SELECT look_status, look_hash FROM web_pages
     WHERE document_id = ? AND deleted_at IS NULL
     ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
    [documentId],
  );
  return latest?.look_status === "saved" && isLookHash(latest.look_hash) ? latest.look_hash : null;
}

export function claimForUser(db: Database, documentId: string, at: string): void {
  db.run(
    `UPDATE web_pages SET origin = 'user', updated_at = ?
     WHERE document_id = ? AND origin <> 'user' AND deleted_at IS NULL`,
    [at, documentId],
  );
}

export function originOf(db: Database, documentId: string): WebPageOrigin | null {
  return (
    db.get<{ origin: WebPageOrigin }>(
      `SELECT origin FROM web_pages WHERE document_id = ? AND deleted_at IS NULL
       ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
      [documentId],
    )?.origin ?? null
  );
}

/** The live page saved at `address` most recently, of those `reusable` takes. */
export function documentAtAddress(
  db: Database,
  address: string,
  reusable: (documentId: string) => boolean = () => true,
): string | null {
  return (
    db
      .all<{ document_id: string }>(
        `SELECT w.document_id FROM web_pages w JOIN documents d ON d.id = w.document_id
         WHERE w.address = ? AND w.deleted_at IS NULL AND d.deleted_at IS NULL
         ORDER BY w.fetched_at DESC`,
        [address],
      )
      .find((row) => reusable(row.document_id))?.document_id ?? null
  );
}

/** A new row for a new version; the same version fetched again updates its row. */
export function recordVersion(db: Database, version: WebPageVersion, at: string): void {
  const updated = db.get<{ id: string }>(
    `UPDATE web_pages SET address = ?, site_name = ?, author = ?, published = ?, fetched_at = ?,
       pictures_left_out = ?, updated_at = ?
     WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL RETURNING id`,
    [
      version.address,
      version.siteName,
      version.author,
      version.published,
      version.fetchedAt,
      version.picturesLeftOut,
      at,
      version.documentId,
      version.contentHash,
    ],
  );
  if (updated) return;
  db.run(
    `INSERT INTO web_pages (id, document_id, content_hash, address, site_name, author, published,
       fetched_at, pictures_left_out, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      version.documentId,
      version.contentHash,
      version.address,
      version.siteName,
      version.author,
      version.published,
      version.fetchedAt,
      version.picturesLeftOut,
      version.origin,
      at,
      at,
    ],
  );
}

/** Records the pictures a version shows; a version fetched again shows the same ones. */
export function recordPictures(
  db: Database,
  documentId: string,
  contentHash: string,
  pictures: readonly WebPagePicture[],
  at: string,
): void {
  const known = new Set(
    db
      .all<{ number: number }>(
        `SELECT number FROM web_page_pictures
         WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL`,
        [documentId, contentHash],
      )
      .map((row) => row.number),
  );
  for (const picture of pictures) {
    if (known.has(picture.number)) continue;
    db.run(
      `INSERT INTO web_page_pictures (id, document_id, content_hash, number, picture_hash,
         media_type, width, height, bytes, address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        documentId,
        contentHash,
        picture.number,
        picture.pictureHash,
        picture.mediaType,
        picture.width,
        picture.height,
        picture.bytes,
        picture.address,
        at,
        at,
      ],
    );
  }
}

/** Whether any version of the Document shows the picture named by this hash. */
export function showsPicture(db: Database, documentId: string, pictureHash: string): boolean {
  return (
    db.get<{ found: number }>(
      `SELECT 1 AS found FROM web_page_pictures
       WHERE document_id = ? AND picture_hash = ? AND deleted_at IS NULL LIMIT 1`,
      [documentId, pictureHash],
    ) !== undefined
  );
}

/** The pictures some version of a web page shows, live or in Recently deleted: their files stay. */
export function keptPictureHashes(db: Database): Set<string> {
  return new Set(
    db
      .all<{ picture_hash: string }>("SELECT DISTINCT picture_hash FROM web_page_pictures")
      .map((row) => row.picture_hash),
  );
}
