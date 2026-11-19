/**
 * Canvases (#3406): pages an outside agent writes, kept with every version it published. A version
 * is its HTML and the files the agent named for it, each kept once in the data folder under the
 * SHA-256 of its bytes, through the host's `CanvasFiles`. A window draws a version through an
 * address minted for that showing alone (`show`), and only that version's files answer on it.
 */
import { CANVAS_LIMITS, canvasFrameUrl } from "../../shared/canvases";
import type { CanvasFiles } from "../adapters";
import type { Canvas, CanvasFrame } from "../api";
import { hashBytes } from "../documents/files";
import { isRecord, NotFoundError } from "../errors";
import type { Database } from "../storage";
import { canvasFileType } from "./fileTypes";

export { canvasFileType } from "./fileTypes";

/** A file of a version, as the HTML refers to it by `name`. */
export interface CanvasFileRecord {
  name: string;
  hash: string;
  type: string;
  size: number;
}

/** A Canvas with the pairing that published it, by which a Canvas in no Folder is reached. */
export interface StoredCanvas extends Canvas {
  pairingId: string;
}

export interface CanvasVersion {
  number: number;
  title: string;
  html: string;
  files: CanvasFileRecord[];
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
}

/** The showings kept at once; the oldest goes past it, and its window asks again. */
const FRAMES_KEPT = 500;

const CANVAS_COLUMNS = `c.id, c.title, c.folder_id, c.pairing_id, c.agent, c.created_at, c.updated_at,
  (SELECT max(v.number) FROM canvas_versions v WHERE v.canvas_id = c.id AND v.deleted_at IS NULL)
    AS version`;

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

function filesOf(json: string): CanvasFileRecord[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (each): each is CanvasFileRecord =>
        isRecord(each) &&
        typeof each.name === "string" &&
        typeof each.hash === "string" &&
        typeof each.type === "string" &&
        typeof each.size === "number",
    );
  } catch {
    return [];
  }
}

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
    db
      .all<CanvasRow>(
        `SELECT ${CANVAS_COLUMNS} FROM canvases c WHERE c.deleted_at IS NULL
         ORDER BY c.updated_at DESC, c.rowid DESC`,
      )
      .map(toCanvas);

  const get = (canvasId: string): StoredCanvas | null => {
    const row = db.get<CanvasRow>(
      `SELECT ${CANVAS_COLUMNS} FROM canvases c WHERE c.id = ? AND c.deleted_at IS NULL`,
      [canvasId],
    );
    return row ? toCanvas(row) : null;
  };

  const requireCanvas = (canvasId: string): StoredCanvas => {
    const canvas = get(canvasId);
    if (!canvas) throw new NotFoundError({ key: "error.canvas.notFound" });
    return canvas;
  };

  const versionRow = (canvasId: string, number: number) =>
    db.get<VersionRow>(
      `SELECT number, title, html_hash, files FROM canvas_versions
       WHERE canvas_id = ? AND number = ? AND deleted_at IS NULL`,
      [canvasId, number],
    );

  const keeper = (): CanvasFiles => {
    if (!options.files) throw new CanvasesUnavailableError();
    return options.files;
  };

  /** The live Canvases as a window knows them, without the pairing that published each. */
  const forWindows = (): Canvas[] => list().map(({ pairingId: _, ...canvas }) => canvas);

  const told = () => options.changed(forWindows());

  /** Keeps bytes once, under their hash. */
  const keep = async (bytes: Uint8Array): Promise<string> => {
    const hash = hashBytes(bytes);
    await keeper().write(hash, bytes);
    return hash;
  };

  /**
   * The files of a new version: `kept` as the version before had them, each named here added or
   * put in place of the one of its name. Only the paths named are read, each on its own.
   */
  const gather = async (
    paths: readonly string[],
    kept: readonly CanvasFileRecord[],
    htmlBytes: number,
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
      files.set(name, { name, hash: await keep(read.bytes), type, size: read.bytes.byteLength });
    }
    return { files: [...files.values()], refused };
  };

  const insertVersion = (
    canvasId: string,
    number: number,
    version: { title: string; htmlHash: string; files: CanvasFileRecord[]; pairingId: string },
    at: string,
  ) =>
    db.run(
      `INSERT INTO canvas_versions (id, canvas_id, number, title, html_hash, files, pairing_id,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        options.newId(),
        canvasId,
        number,
        version.title,
        version.htmlHash,
        JSON.stringify(version.files),
        version.pairingId,
        at,
        at,
      ],
    );

  return {
    list,
    forWindows,
    get,

    /** A live Canvas, or NotFoundError. */
    require: requireCanvas,

    /** A version's HTML and files: its newest without `number`. */
    async version(canvasId: string, number?: number): Promise<CanvasVersion> {
      const canvas = requireCanvas(canvasId);
      const row = versionRow(canvasId, number ?? canvas.version);
      if (!row) throw new NotFoundError({ key: "error.canvas.notFound" });
      const html = await keeper().read(row.html_hash);
      if (!html) throw new NotFoundError({ key: "error.canvas.notFound" });
      return {
        number: Number(row.number),
        title: row.title,
        html: utf8Text.decode(html),
        files: filesOf(row.files),
      };
    },

    /** Publishes a new Canvas as its version 1. */
    async publish(input: {
      title: string;
      html: string;
      paths: readonly string[];
      folderId: string | null;
      pairingId: string;
      agent: string;
    }): Promise<{ canvas: StoredCanvas; files: CanvasFileRecord[]; refused: RefusedFile[] }> {
      const html = utf8.encode(input.html);
      const htmlHash = await keep(html);
      const { files, refused } = await gather(input.paths, [], html.byteLength);
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
          { title: input.title, htmlHash, files, pairingId: input.pairingId },
          at,
        );
      });
      told();
      return { canvas: requireCanvas(id), files, refused };
    },

    /**
     * Publishes a Canvas's next version, built on version `basedOn`: what it doesn't give stays as
     * that version has it. `stale` when the Canvas has a newer version since.
     */
    async update(
      canvasId: string,
      basedOn: number,
      input: { title?: string; html?: string; paths: readonly string[]; pairingId: string },
    ): Promise<
      | { kind: "updated"; canvas: StoredCanvas; files: CanvasFileRecord[]; refused: RefusedFile[] }
      | { kind: "stale"; canvas: StoredCanvas }
    > {
      const canvas = requireCanvas(canvasId);
      if (basedOn !== canvas.version) return { kind: "stale", canvas };
      const before = versionRow(canvasId, canvas.version);
      if (!before) throw new NotFoundError({ key: "error.canvas.notFound" });
      const html = input.html === undefined ? null : utf8.encode(input.html);
      const htmlHash = html ? await keep(html) : before.html_hash;
      const htmlBytes = html?.byteLength ?? (await keeper().read(htmlHash))?.byteLength ?? 0;
      const { files, refused } = await gather(input.paths, filesOf(before.files), htmlBytes);
      const title = input.title ?? canvas.title;
      const at = options.now();
      const stale = db.transaction(() => {
        // Two calls built on the same version: the second finds it taken while it read its files.
        if ((get(canvasId)?.version ?? 0) !== basedOn) return true;
        insertVersion(
          canvasId,
          basedOn + 1,
          { title, htmlHash, files, pairingId: input.pairingId },
          at,
        );
        db.run("UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?", [title, at, canvasId]);
        return false;
      });
      if (stale) return { kind: "stale", canvas: requireCanvas(canvasId) };
      told();
      return { kind: "updated", canvas: requireCanvas(canvasId), files, refused };
    },

    /** Mints the address a window draws a live Canvas's newest version at. */
    show(canvasId: string): CanvasFrame {
      const canvas = requireCanvas(canvasId);
      const host = frameHost();
      frames.set(host, { canvasId, number: canvas.version });
      for (const old of frames.keys()) {
        if (frames.size <= FRAMES_KEPT) break;
        frames.delete(old);
      }
      return { url: canvasFrameUrl(host), version: canvas.version };
    },

    /** The Canvas a showing draws, while it is live; null for an address minted for none. */
    showing(host: string): string | null {
      const frame = frames.get(host);
      return frame && get(frame.canvasId) ? frame.canvasId : null;
    },

    /**
     * What a showing's address answers for `path`: its version's HTML at "/", and each of its
     * files at "/" and its name; null for anything else, and for a Canvas deleted since.
     */
    async served(host: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
      const frame = frames.get(host);
      if (!frame || !get(frame.canvasId)) return null;
      const row = versionRow(frame.canvasId, frame.number);
      if (!row) return null;
      if (path === "/") {
        const bytes = await keeper().read(row.html_hash);
        return bytes ? { bytes, type: "text/html; charset=utf-8" } : null;
      }
      let name: string;
      try {
        name = decodeURIComponent(path.slice(1));
      } catch {
        return null;
      }
      const file = filesOf(row.files).find((each) => each.name === name);
      const bytes = file ? await keeper().read(file.hash) : null;
      return file && bytes ? { bytes, type: file.type } : null;
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
