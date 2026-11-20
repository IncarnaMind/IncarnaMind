/**
 * Canvases (#3406): pages an outside agent writes, kept with every version. A version is its HTML,
 * the files the agent named for it, each kept once in the data folder under the SHA-256 of its
 * bytes through the host's `CanvasFiles`, and the Citations its text cites. A window draws a version
 * through an address minted for that showing alone (`show`): only that version's files answer on it,
 * and its HTML comes with each Citation's marker written in. The User restores a version as a new
 * one, so none is lost; a deleted Canvas waits in Recently deleted, and once it is deleted for good
 * the files no other version uses go too.
 */
import { CANVAS_LIMITS, canvasFrameUrl } from "../../shared/canvases";
import type { CanvasFiles } from "../adapters";
import type { AgentCitation } from "../agents/citations";
import type { Canvas, CanvasFrame, CanvasVersionInfo } from "../api";
import { hashBytes } from "../documents/files";
import { isRecord, NotFoundError } from "../errors";
import type { Database } from "../storage";
import { canvasFileType } from "./fileTypes";
import { type MarkerWords, withMarkers } from "./markers";

export { canvasFileType } from "./fileTypes";

/** A file of a version, as the HTML refers to it by `name`. */
export interface CanvasFileRecord {
  name: string;
  hash: string;
  type: string;
  size: number;
}

/** A Citation a version's text cites, as IncarnaMind minted it for the agent. */
export type CanvasCitation = Omit<AgentCitation, "pairingId">;

/** A Canvas with the pairing that published it, by which a Canvas in no Folder is reached. */
export interface StoredCanvas extends Canvas {
  pairingId: string;
}

export interface CanvasVersion {
  number: number;
  title: string;
  html: string;
  files: CanvasFileRecord[];
  citations: CanvasCitation[];
}

/** Why a file an agent named was left out of a version. */
export type FileRefusal =
  | "unreadable"
  | "too-large"
  | "type"
  | "name"
  | "same-name"
  | "too-many"
  | "total";

export interface RefusedFile {
  path: string;
  why: FileRefusal;
}

export interface CanvasesOptions {
  db: Database;
  /** Absent: this host keeps no Canvases, and publishing one is refused. */
  files?: CanvasFiles;
  now(): string;
  newId(): string;
  changed(canvases: Canvas[]): void;
  /** How a version's markers read, from its Citations as they are now. */
  markerWords(citations: readonly CanvasCitation[]): MarkerWords;
}

interface CanvasRow {
  id: string;
  title: string;
  folder_id: string | null;
  pairing_id: string;
  agent: string;
  version: number | bigint;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  number: number | bigint;
  title: string;
  html_hash: string;
  files: string;
  citations: string;
}

interface VersionInfoRow {
  number: number | bigint;
  title: string;
  agent: string | null;
  restored_from: number | bigint | null;
  created_at: string;
}

/** The showings kept at once; the oldest goes past it, and its window asks again. */
const FRAMES_KEPT = 500;

const LIVE = `c.id, c.title, c.folder_id, c.pairing_id, c.agent, c.created_at, c.updated_at,
  (SELECT max(v.number) FROM canvas_versions v WHERE v.canvas_id = c.id AND v.deleted_at IS NULL)
    AS version
  FROM canvases c WHERE c.deleted_at IS NULL`;

const toCanvas = (row: CanvasRow): StoredCanvas => ({
  id: row.id,
  title: row.title,
  folderId: row.folder_id,
  agent: row.agent,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  pairingId: row.pairing_id,
});

const listOf = <T>(json: string, keep: (value: unknown) => value is T): T[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(keep) : [];
  } catch {
    return [];
  }
};

const isFile = (each: unknown): each is CanvasFileRecord =>
  isRecord(each) &&
  typeof each.name === "string" &&
  typeof each.hash === "string" &&
  typeof each.type === "string" &&
  typeof each.size === "number";

const isCitation = (each: unknown): each is CanvasCitation =>
  isRecord(each) &&
  typeof each.token === "string" &&
  typeof each.documentId === "string" &&
  typeof each.quote === "string";

/** The name a file is served by: the last part of its path, which the HTML refers to. */
export function fileNameOf(path: string): string | null {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (name === "" || name === "." || name === "..") return null;
  const control = [...name].some((each) => each.charCodeAt(0) < 0x20 || each === "\u007f");
  return name.length > CANVAS_LIMITS.nameCharacters || control ? null : name;
}

const utf8 = new TextEncoder();
const utf8Text = new TextDecoder();

const frameHost = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function createCanvases(options: CanvasesOptions) {
  const { db } = options;
  const frames = new Map<string, { canvasId: string; number: number }>();

  const list = (): StoredCanvas[] =>
    db.all<CanvasRow>(`SELECT ${LIVE} ORDER BY c.updated_at DESC, c.rowid DESC`).map(toCanvas);

  const get = (canvasId: string): StoredCanvas | null => {
    const row = db.get<CanvasRow>(`SELECT ${LIVE} AND c.id = ?`, [canvasId]);
    return row ? toCanvas(row) : null;
  };

  const requireCanvas = (canvasId: string): StoredCanvas => {
    const canvas = get(canvasId);
    if (!canvas) throw new NotFoundError({ key: "error.canvas.notFound" });
    return canvas;
  };

  /** The live Canvases as a window knows them, without the pairing that published each. */
  const forWindows = (): Canvas[] => list().map(({ pairingId: _, ...canvas }) => canvas);

  const versionRow = (canvasId: string, number: number) =>
    db.get<VersionRow>(
      `SELECT number, title, html_hash, files, citations FROM canvas_versions
       WHERE canvas_id = ? AND number = ? AND deleted_at IS NULL`,
      [canvasId, number],
    );

  const keeper = (): CanvasFiles => {
    if (!options.files) throw new CanvasesUnavailableError();
    return options.files;
  };

  const told = () => options.changed(forWindows());

  /**
   * Hashes publishes under way keep, by how many: `dropPurged` leaves them until their version is
   * in, as a version published meanwhile may keep the same bytes.
   */
  const held = new Map<string, number>();
  /** Removals under way, by hash: bytes kept again meanwhile are written once the removal is done. */
  const removing = new Map<string, Promise<void>>();

  /** Keeps bytes once, under their hash, held in `holds` until the publish `release`s them. */
  const keep = async (bytes: Uint8Array, holds: string[]): Promise<string> => {
    const files = keeper();
    const hash = hashBytes(bytes);
    holds.push(hash);
    held.set(hash, (held.get(hash) ?? 0) + 1);
    // Its failure is `dropPurged`'s to report; here it need only be over.
    await removing.get(hash)?.catch(() => undefined);
    await files.write(hash, bytes);
    return hash;
  };

  const release = (holds: readonly string[]) => {
    for (const hash of holds) {
      const left = (held.get(hash) ?? 1) - 1;
      if (left > 0) held.set(hash, left);
      else held.delete(hash);
    }
  };

  /**
   * The files of a new version: `kept` as the version before had them, each named here added or
   * put in place of the one of its name. Only the paths named are read, each on its own.
   */
  const gather = async (
    paths: readonly string[],
    kept: readonly CanvasFileRecord[],
    htmlBytes: number,
    holds: string[],
  ): Promise<{ files: CanvasFileRecord[]; refused: RefusedFile[] }> => {
    const files = new Map(kept.map((file) => [file.name, file]));
    const named = new Set<string>();
    const refused: RefusedFile[] = [];
    const total = () => htmlBytes + [...files.values()].reduce((sum, file) => sum + file.size, 0);
    for (const path of paths) {
      const name = fileNameOf(path);
      if (name === null) {
        refused.push({ path, why: "name" });
        continue;
      }
      if (named.has(name)) {
        refused.push({ path, why: "same-name" });
        continue;
      }
      named.add(name);
      if (!files.has(name) && files.size >= CANVAS_LIMITS.files) {
        refused.push({ path, why: "too-many" });
        continue;
      }
      const read = await keeper().readNamed(path, CANVAS_LIMITS.fileBytes);
      if (read.kind !== "read") {
        refused.push({ path, why: read.kind });
        continue;
      }
      const type = canvasFileType(name, read.bytes);
      if (type === null) {
        refused.push({ path, why: "type" });
        continue;
      }
      const before = files.get(name);
      if (total() - (before?.size ?? 0) + read.bytes.byteLength > CANVAS_LIMITS.totalBytes) {
        refused.push({ path, why: "total" });
        continue;
      }
      const hash = await keep(read.bytes, holds);
      files.set(name, { name, hash, type, size: read.bytes.byteLength });
    }
    return { files: [...files.values()], refused };
  };

  const insertVersion = (
    canvasId: string,
    number: number,
    version: {
      title: string;
      htmlHash: string;
      files: readonly CanvasFileRecord[];
      citations: readonly CanvasCitation[];
      /** null: the User restored it. */
      by: { pairingId: string; agent: string } | null;
      restoredFrom?: number;
    },
    at: string,
  ) =>
    db.run(
      `INSERT INTO canvas_versions (id, canvas_id, number, title, html_hash, files, citations,
         pairing_id, agent, restored_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        options.newId(),
        canvasId,
        number,
        version.title,
        version.htmlHash,
        JSON.stringify(version.files),
        JSON.stringify(version.citations),
        version.by?.pairingId ?? null,
        version.by?.agent ?? null,
        version.restoredFrom ?? null,
        at,
        at,
      ],
    );

  /** Adds `number` after `basedOn` in one step; false when another took that place meanwhile. */
  const addVersion = (
    canvasId: string,
    basedOn: number,
    version: Parameters<typeof insertVersion>[2],
  ): boolean => {
    const at = options.now();
    return db.transaction(() => {
      if ((get(canvasId)?.version ?? 0) !== basedOn) return false;
      insertVersion(canvasId, basedOn + 1, version, at);
      db.run("UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?", [
        version.title,
        at,
        canvasId,
      ]);
      return true;
    });
  };

  const readVersion = async (canvasId: string, number: number): Promise<CanvasVersion> => {
    const row = versionRow(canvasId, number);
    const html = row ? await keeper().read(row.html_hash) : null;
    if (!row || !html) throw new NotFoundError({ key: "error.canvas.notFound" });
    return {
      number: Number(row.number),
      title: row.title,
      html: utf8Text.decode(html),
      files: listOf(row.files, isFile),
      citations: listOf(row.citations, isCitation),
    };
  };

  /** The hashes of what versions keep: their HTML and files. */
  const hashesOf = (rows: readonly { html_hash: string; files: string }[]) =>
    new Set(
      rows.flatMap((row) => [row.html_hash, ...listOf(row.files, isFile).map((f) => f.hash)]),
    );

  /** Whether a version of a Canvas not deleted permanently keeps `hash`, as its HTML or a file. */
  const stillKept = (hash: string) =>
    db.get(
      `SELECT 1 FROM canvas_versions v JOIN canvases c ON c.id = v.canvas_id
       WHERE c.purged_at IS NULL AND (v.html_hash = ? OR EXISTS (
         SELECT 1 FROM json_each(v.files) f WHERE json_extract(f.value, '$.hash') = ?))
       LIMIT 1`,
      [hash, hash],
    ) !== undefined;

  return {
    list,
    forWindows,
    get,

    /** A live Canvas, or NotFoundError. */
    require: requireCanvas,

    /** A version's HTML, files and Citations: its newest without `number`. */
    version(canvasId: string, number?: number): Promise<CanvasVersion> {
      return readVersion(canvasId, number ?? requireCanvas(canvasId).version);
    },

    /** A live Canvas's versions, newest first. */
    versions(canvasId: string): CanvasVersionInfo[] {
      requireCanvas(canvasId);
      return db
        .all<VersionInfoRow>(
          `SELECT number, title, agent, restored_from, created_at FROM canvas_versions
           WHERE canvas_id = ? AND deleted_at IS NULL ORDER BY number DESC`,
          [canvasId],
        )
        .map((row) => ({
          number: Number(row.number),
          title: row.title,
          agent: row.agent,
          restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
          createdAt: row.created_at,
        }));
    },

    /**
     * Publishes a new Canvas as its version 1. `allowed` throws unless the publisher may still
     * write there, read once its files are read and before anything is written: what the User
     * grants may change while they are.
     */
    async publish(input: {
      title: string;
      html: string;
      paths: readonly string[];
      citations: readonly CanvasCitation[];
      folderId: string | null;
      pairingId: string;
      agent: string;
      allowed?(): void;
    }): Promise<{ canvas: StoredCanvas; files: CanvasFileRecord[]; refused: RefusedFile[] }> {
      const html = utf8.encode(input.html);
      const holds: string[] = [];
      const htmlHash = await keep(html, holds);
      const { files, refused } = await gather(input.paths, [], html.byteLength, holds);
      try {
        input.allowed?.();
      } catch (error) {
        release(holds);
        throw error;
      }
      const id = options.newId();
      const at = options.now();
      db.transaction(() => {
        db.run(
          `INSERT INTO canvases (id, title, folder_id, pairing_id, agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, input.title, input.folderId, input.pairingId, input.agent, at, at],
        );
        insertVersion(
          id,
          1,
          {
            title: input.title,
            htmlHash,
            files,
            citations: input.citations,
            by: { pairingId: input.pairingId, agent: input.agent },
          },
          at,
        );
      });
      release(holds);
      told();
      return { canvas: requireCanvas(id), files, refused };
    },

    /**
     * Publishes a Canvas's next version, built on version `basedOn`: what it doesn't give stays as
     * that version has it, its Citations with its HTML. `stale` when there is a newer version since.
     * `allowed` as for `publish`.
     */
    async update(
      canvasId: string,
      basedOn: number,
      input: {
        title?: string;
        html?: { text: string; citations: readonly CanvasCitation[] };
        paths: readonly string[];
        pairingId: string;
        agent: string;
        allowed?(): void;
      },
    ): Promise<
      | { kind: "updated"; canvas: StoredCanvas; files: CanvasFileRecord[]; refused: RefusedFile[] }
      | { kind: "stale"; canvas: StoredCanvas }
    > {
      const canvas = requireCanvas(canvasId);
      if (basedOn !== canvas.version) return { kind: "stale", canvas };
      const before = versionRow(canvasId, canvas.version);
      if (!before) throw new NotFoundError({ key: "error.canvas.notFound" });
      const html = input.html === undefined ? null : utf8.encode(input.html.text);
      const holds: string[] = [];
      const htmlHash = html ? await keep(html, holds) : before.html_hash;
      const htmlBytes = html?.byteLength ?? (await keeper().read(htmlHash))?.byteLength ?? 0;
      const { files, refused } = await gather(
        input.paths,
        listOf(before.files, isFile),
        htmlBytes,
        holds,
      );
      try {
        input.allowed?.();
      } catch (error) {
        release(holds);
        throw error;
      }
      const added = addVersion(canvasId, basedOn, {
        title: input.title ?? canvas.title,
        htmlHash,
        files,
        citations: input.html?.citations ?? listOf(before.citations, isCitation),
        by: { pairingId: input.pairingId, agent: input.agent },
      });
      release(holds);
      if (!added) return { kind: "stale", canvas: requireCanvas(canvasId) };
      told();
      return { kind: "updated", canvas: requireCanvas(canvasId), files, refused };
    },

    /** The User brings an earlier version back as the newest, a version of its own: none is lost. */
    restoreVersion(canvasId: string, number: number): StoredCanvas {
      const canvas = requireCanvas(canvasId);
      const row = versionRow(canvasId, number);
      if (!row) throw new NotFoundError({ key: "error.canvas.versionNotFound" });
      addVersion(canvasId, canvas.version, {
        title: row.title,
        htmlHash: row.html_hash,
        files: listOf(row.files, isFile),
        citations: listOf(row.citations, isCitation),
        by: null,
        restoredFrom: number,
      });
      told();
      return requireCanvas(canvasId);
    },

    /** Mints the address a window draws a live Canvas's version at: its newest without `number`. */
    show(canvasId: string, number?: number): CanvasFrame {
      const canvas = requireCanvas(canvasId);
      const shown = number ?? canvas.version;
      if (!versionRow(canvasId, shown))
        throw new NotFoundError({ key: "error.canvas.versionNotFound" });
      const host = frameHost();
      frames.set(host, { canvasId, number: shown });
      for (const old of frames.keys()) {
        if (frames.size <= FRAMES_KEPT) break;
        frames.delete(old);
      }
      return { url: canvasFrameUrl(host), version: shown };
    },

    /** The Canvas a showing draws, while it is live; null for an address minted for none. */
    showing(host: string): string | null {
      const frame = frames.get(host);
      return frame && get(frame.canvasId) ? frame.canvasId : null;
    },

    /**
     * What a showing's address answers for `path`: its version's HTML at "/", with its Citations'
     * markers written in, and each of its files at "/" and its name; null for anything else, and
     * for a Canvas deleted since.
     */
    async served(host: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
      const frame = frames.get(host);
      if (!frame || !get(frame.canvasId)) return null;
      const row = versionRow(frame.canvasId, frame.number);
      if (!row) return null;
      if (path === "/") {
        const bytes = await keeper().read(row.html_hash);
        if (!bytes) return null;
        const citations = listOf(row.citations, isCitation);
        const marked = withMarkers(
          utf8Text.decode(bytes),
          new Set(citations.map((citation) => citation.token)),
          options.markerWords(citations),
        );
        return { bytes: utf8.encode(marked), type: "text/html; charset=utf-8" };
      }
      let name: string;
      try {
        name = decodeURIComponent(path.slice(1));
      } catch {
        return null;
      }
      const file = listOf(row.files, isFile).find((each) => each.name === name);
      const bytes = file ? await keeper().read(file.hash) : null;
      return file && bytes ? { bytes, type: file.type } : null;
    },

    /**
     * A Citation of the version a showing draws, by its token, with its number as its marker shows
     * it; null for one it doesn't cite.
     */
    citation(
      host: string,
      token: string,
    ): { canvasId: string; citation: CanvasCitation; number: number } | null {
      const frame = frames.get(host);
      if (!frame || !get(frame.canvasId)) return null;
      const row = versionRow(frame.canvasId, frame.number);
      const citations = row ? listOf(row.citations, isCitation) : [];
      const at = citations.findIndex((each) => each.token === token);
      const citation = citations[at];
      return citation ? { canvasId: frame.canvasId, citation, number: at + 1 } : null;
    },

    /** Moves a live Canvas to Recently deleted at `at`, or NotFoundError. */
    remove(canvasId: string, at: string): void {
      requireCanvas(canvasId);
      db.run("UPDATE canvases SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, canvasId]);
      told();
    },

    /** Brings back a deleted Canvas where it was (the caller checks it may); then `announce`. */
    restore(canvasId: string): void {
      db.run("UPDATE canvases SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
        options.now(),
        canvasId,
      ]);
    },

    /** Its Folder is deleted: its Canvases, deleted ones too, go to no Folder. Then `announce`. */
    leaveFolder(folderId: string): { id: string; live: boolean }[] {
      return db
        .all<{ id: string; live: number }>(
          `UPDATE canvases SET folder_id = NULL, updated_at = ? WHERE folder_id = ?
           RETURNING id, deleted_at IS NULL AS live`,
          [options.now(), folderId],
        )
        .map((row) => ({ id: row.id, live: row.live === 1 }));
    },

    /**
     * A deleted Folder was restored: these Canvases go back into it, those still in none. Returns
     * whether a live one did.
     */
    returnToFolder(canvasIds: readonly string[], folderId: string): boolean {
      return db
        .all<{ live: number }>(
          `UPDATE canvases SET folder_id = ?, updated_at = ?
           WHERE folder_id IS NULL AND id IN (SELECT value FROM json_each(?))
           RETURNING deleted_at IS NULL AS live`,
          [folderId, options.now(), JSON.stringify(canvasIds)],
        )
        .some((row) => row.live === 1);
    },

    /** Says the live Canvases again, after a change made in a transaction. */
    announce: told,

    /**
     * Removes the files of the Canvases deleted permanently that no other Canvas keeps, then their
     * versions: after a purge, and at start-up for any one a failure left.
     */
    async dropPurged(): Promise<void> {
      const { files } = options;
      if (!files) return;
      const gone = db.all<{ id: string; html_hash: string; files: string }>(
        `SELECT v.id, v.html_hash, v.files FROM canvas_versions v
         JOIN canvases c ON c.id = v.canvas_id WHERE c.purged_at IS NOT NULL`,
      );
      if (gone.length === 0) return;
      for (const hash of hashesOf(gone)) {
        // Asked again for each, after the removals before it: a version published meanwhile counts.
        if (held.has(hash) || stillKept(hash)) continue;
        const removal = files.remove(hash);
        removing.set(hash, removal);
        try {
          await removal;
        } finally {
          removing.delete(hash);
        }
      }
      db.run("DELETE FROM canvas_versions WHERE id IN (SELECT value FROM json_each(?))", [
        JSON.stringify(gone.map((row) => row.id)),
      ]);
    },
  };
}

export type Canvases = ReturnType<typeof createCanvases>;

/** This host keeps no Canvases: it gave the core no `CanvasFiles`. */
export class CanvasesUnavailableError extends Error {
  constructor() {
    super("This host keeps no Canvases.");
    this.name = "CanvasesUnavailableError";
  }
}
