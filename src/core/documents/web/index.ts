/**
 * Web pages saved as Documents (#261): the snapshot, in the data folder's
 * "Web pages", is the Document's file and is indexed like any file. "Fetch
 * again" writes over it, so a changed page is a new version (ADR-0010).
 *
 * The article's pictures are saved with it (#756): fetched once through the
 * fetcher that reaches only the public internet, kept in "Web pages/pictures"
 * as files named by their content, so versions share them and none is
 * written over, and shown by the snapshot from there. A page kept as it
 * looks has a PDF of each version made in the background, one at a time, in
 * "Web pages/looks", named by its content too.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normaliseAddress } from "../../../shared/webAddresses";
import type { PageLook } from "../../adapters";
import type { Document, SaveWebPageInput, WebPageOrigin, WebPageResult } from "../../api";
import { InvalidInputError, isRecord, NotFoundError } from "../../errors";
import type { Database } from "../../storage";
import { hashBytes } from "../files";
import { WebPageError } from "./errors";
import { type FetchLimits, fetchPage, type PageFetch } from "./fetch";
import { type FetchedPicture, fetchPictures, type PictureLimits } from "./pictures";
import { type ShownPicture, type Snapshot, snapshotOf, withPictures } from "./snapshot";
import {
  claimForUser,
  documentAtAddress,
  keptLookHashes,
  keptPictureHashes,
  lookName,
  looksUnderWay,
  originOf,
  recordLook,
  recordPictures,
  recordVersion,
  type WebPagePicture,
  type WebPageVersion,
  webPageInfo,
} from "./store";

export { WebPageError } from "./errors";

export interface SnapshotFile {
  path: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

export interface WebPagesOptions {
  db: Database;
  dataDir: string;
  now: () => string;
  documents: {
    get(id: string): Document;
    addSnapshot(id: string, name: string, file: SnapshotFile, record: () => void): Document;
    check(path: string): Promise<void>;
    announce(id: string): void;
  };
  /** Most preferred first, as Accept-Language lists them. */
  languages(): readonly string[];
  fetch?: PageFetch;
  limits?: FetchLimits;
  /** Fetches the pictures: one that reaches only the public internet, whatever fetched the page. */
  pictureFetch: PageFetch;
  pictureLimits?: PictureLimits;
  /** Makes a page's look; none: no page is kept as it looks. */
  look?: PageLook;
  /** A save that doesn't say keeps the page as it looks: `UserSettings.keepWebPageLook`. */
  keepLookByDefault: () => boolean;
  /** "Keep everything on this computer" is on: a page the User names isn't fetched unless they let it. */
  localOnly?: () => boolean;
  /** Aborted when the core closes: no look is started, and none that finishes late is kept. */
  signal: AbortSignal;
  reportError?: (error: unknown) => void;
}

/** Where a picture's file is, as the snapshot names it beside itself. */
const pictureName = (picture: { pictureHash: string; mediaType: string }) =>
  `${picture.pictureHash}.${PICTURE_EXTENSIONS[picture.mediaType] ?? "bin"}`;

const PICTURE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** A page ready to write: its snapshot with its pictures in place, and the pictures it shows. */
interface PageToWrite {
  snapshot: Snapshot;
  xhtml: string;
  pictures: WebPagePicture[];
  leftOut: number;
}

async function writeOnce(path: string, bytes: Uint8Array): Promise<void> {
  const there = await access(path).then(
    () => true,
    () => false,
  );
  if (there) return;
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function parseSaveInput(input: unknown): SaveWebPageInput {
  if (!isRecord(input) || typeof input.address !== "string") {
    throw new InvalidInputError("saveWebPage expects an address.");
  }
  const { address, html, folderId, keepLook, localModeOnce } = input;
  if (keepLook !== undefined && typeof keepLook !== "boolean") {
    throw new InvalidInputError({ key: "error.webPage.keepLookNotBoolean" });
  }
  if (localModeOnce !== undefined && typeof localModeOnce !== "boolean") {
    throw new InvalidInputError({ key: "error.webPage.localModeOnceNotBoolean" });
  }
  if (html !== undefined && typeof html !== "string") {
    throw new InvalidInputError("A web page's HTML must be text.");
  }
  if (folderId !== undefined && folderId !== null && typeof folderId !== "string") {
    throw new InvalidInputError("A Folder id must be text, or null.");
  }
  return {
    address,
    ...(html === undefined ? {} : { html }),
    folderId: folderId ?? null,
    ...(keepLook === undefined ? {} : { keepLook }),
    ...(localModeOnce === undefined ? {} : { localModeOnce }),
  };
}

/**
 * Which page saved already a save may give back: only those `reusable` takes, any when it is left
 * out. A save under way is shared only with saves of the same `key`.
 */
export interface PageReuse {
  key: string;
  reusable?(documentId: string): boolean;
}

/**
 * The key of a save for one side of the Folder wall (`wallId`, null: outside every wall): a page
 * under way is shared only on that side, so whoever joins it never takes, or files, a page across
 * the wall (#2243).
 */
export const wallKey = (wallId: string | null): string => `wall:${wallId ?? "none"}`;

export function createWebPages(options: WebPagesOptions) {
  const { db, now, documents, signal } = options;
  const folder = join(options.dataDir, "Web pages");
  const pictureFolder = join(folder, "pictures");
  const lookFolder = join(folder, "looks");
  /**
   * Pictures a save has written and not recorded yet, with how many saves:
   * no clean-up takes them meanwhile.
   */
  const saving = new Map<string, number>();
  const hold = (hashes: readonly string[], by: number) => {
    for (const hash of hashes) {
      const count = (saving.get(hash) ?? 0) + by;
      if (count > 0) saving.set(hash, count);
      else saving.delete(hash);
    }
  };
  /** Asked twice at once, a save or a fetch is done once. */
  const underWay = new Map<string, Promise<WebPageResult>>();

  const once = (key: string, task: () => Promise<WebPageResult>): Promise<WebPageResult> => {
    const running = underWay.get(key);
    if (running) return running;
    const started = task().finally(() => underWay.delete(key));
    underWay.set(key, started);
    return started;
  };

  const heldInLocalMode = (address: string): WebPageResult => {
    const site = URL.parse(address)?.host ?? address;
    return failed(
      address,
      new WebPageError(
        "local-mode",
        `“Keep everything on this computer” is on, so ${site} isn't contacted.`,
      ),
    );
  };

  const failed = (address: string, error: unknown): WebPageResult => {
    if (error instanceof WebPageError)
      return { outcome: "failed", address, failure: error.failure };
    throw error;
  };

  async function keepPicture(picture: FetchedPicture): Promise<WebPagePicture> {
    const kept = {
      pictureHash: hashBytes(picture.bytes),
      mediaType: picture.type.mediaType,
    };
    await writeOnce(join(pictureFolder, pictureName(kept)), picture.bytes);
    return {
      number: 0,
      ...kept,
      width: picture.width,
      height: picture.height,
      bytes: picture.bytes.byteLength,
      address: picture.address,
    };
  }

  async function pageFor(
    address: string,
    html: string | undefined,
    fetch = options.fetch,
  ): Promise<PageToWrite> {
    const page =
      html === undefined
        ? await fetchPage(address, {
            fetch,
            limits: options.limits,
            languages: options.languages(),
          })
        : { html, url: address };
    const snapshot = snapshotOf(page.html, page.url, address);
    // HTML given is saved as it is: nothing is fetched, its pictures neither.
    const fetched =
      html === undefined
        ? await fetchPictures(snapshot.pictures, options.pictureFetch, {
            ...(options.pictureLimits ? { limits: options.pictureLimits } : {}),
            ...(options.reportError ? { reportError: options.reportError } : {}),
          })
        : { kept: [], leftOut: 0 };
    const shown = new Map<number, ShownPicture>();
    const pictures: WebPagePicture[] = [];
    const hashes = fetched.kept.map((picture) => hashBytes(picture.bytes));
    hold(hashes, 1);
    try {
      for (const picture of fetched.kept) {
        const kept = { ...(await keepPicture(picture)), number: pictures.length + 1 };
        pictures.push(kept);
        shown.set(picture.index, {
          src: `pictures/${pictureName(kept)}`,
          width: kept.width,
          height: kept.height,
        });
      }
    } catch (error) {
      hold(hashes, -1);
      throw error;
    }
    return {
      snapshot,
      xhtml: withPictures(snapshot.xhtml, shown),
      pictures,
      leftOut: fetched.leftOut,
    };
  }

  /** Writes a page, its pictures held from clean-up until it is recorded. */
  async function withPage<T>(
    page: PageToWrite,
    task: (page: PageToWrite) => Promise<T> | T,
  ): Promise<T> {
    try {
      return await task(page);
    } finally {
      hold(
        page.pictures.map((picture) => picture.pictureHash),
        -1,
      );
    }
  }

  /** Writes a snapshot over `path`, whole or not at all. */
  async function write(path: string, xhtml: string): Promise<SnapshotFile> {
    await mkdir(folder, { recursive: true });
    const bytes = Buffer.from(xhtml, "utf8");
    const partial = `${path}.${randomUUID()}.part`;
    try {
      await writeFile(partial, bytes);
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const { mtimeMs } = await stat(path);
    return { path, contentHash: hashBytes(bytes), size: bytes.byteLength, mtimeMs };
  }

  let looks: Promise<void> = Promise.resolve();

  // A look still waiting at close stays "saving": the next start makes it.
  const queueLook = (documentId: string, contentHash: string, address: string) => {
    const look = options.look;
    if (!look) return;
    looks = looks
      .then(async () => {
        if (signal.aborted) return;
        if (options.localOnly?.()) {
          recordLook(
            db,
            documentId,
            contentHash,
            { status: "failed", failure: "local-mode" },
            now(),
          );
          documents.announce(documentId);
          return;
        }
        const made = await look.render(address).catch((error: unknown) => ({
          failure: "failed" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
        if (signal.aborted) return;
        if ("pdf" in made) {
          const lookHash = hashBytes(made.pdf);
          const file = join(lookFolder, lookName(lookHash));
          hold([lookHash], 1);
          try {
            await writeOnce(file, made.pdf);
            if (signal.aborted) return;
            const at = now();
            const recorded = recordLook(
              db,
              documentId,
              contentHash,
              { status: "saved", lookHash, savedAt: at },
              at,
            );
            // Deleted permanently while it was made: nothing shows it, unless another page does.
            if (!recorded && !keptLookHashes(db).has(lookHash)) rmSync(file, { force: true });
          } finally {
            hold([lookHash], -1);
          }
        } else {
          options.reportError?.(`${address}: ${made.failure}, ${made.message}`);
          recordLook(
            db,
            documentId,
            contentHash,
            { status: "failed", failure: made.failure },
            now(),
          );
        }
        documents.announce(documentId);
      })
      .catch((error: unknown) => options.reportError?.(error));
  };

  const startLook = (documentId: string, contentHash: string, address: string) => {
    if (!options.look) return;
    const held = options.localOnly?.() === true;
    recordLook(
      db,
      documentId,
      contentHash,
      held ? { status: "failed", failure: "local-mode" } : { status: "saving" },
      now(),
    );
    documents.announce(documentId);
    if (!held) queueLook(documentId, contentHash, address);
  };

  // Looks being made when the app last quit were asked for: they are made now, once. One that
  // was made again already and didn't finish may be what stopped the app: it is given up.
  for (const each of looksUnderWay(db)) {
    if (each.resumed) {
      recordLook(
        db,
        each.documentId,
        each.contentHash,
        { status: "failed", failure: "stopped" },
        now(),
      );
      continue;
    }
    recordLook(db, each.documentId, each.contentHash, { status: "saving", resumed: true }, now());
    queueLook(each.documentId, each.contentHash, each.address);
  }

  /** Records a version written, and the pictures it shows. */
  const record = (
    documentId: string,
    file: SnapshotFile,
    address: string,
    page: PageToWrite,
    origin: WebPageOrigin,
  ) => {
    const at = now();
    const version: WebPageVersion = {
      documentId,
      contentHash: file.contentHash,
      address,
      siteName: page.snapshot.siteName,
      author: page.snapshot.author,
      published: page.snapshot.published,
      fetchedAt: at,
      picturesLeftOut: page.leftOut,
      origin,
    };
    recordVersion(db, version, at);
    recordPictures(db, documentId, file.contentHash, page.pictures, at);
  };

  return {
    /**
     * Removes the snapshots of web pages deleted permanently, their text going
     * with them, and the pictures no other page shows.
     */
    async dropPurged(): Promise<void> {
      const rows = db.all<{ path: string }>(
        "SELECT path FROM documents WHERE kind = 'web' AND purged_at IS NOT NULL",
      );
      await Promise.all(rows.map((row) => rm(row.path, { force: true })));
      const files = await readdir(pictureFolder).catch(() => [] as string[]);
      // Checked and removed in one turn, with nothing awaited between: a save that holds a
      // picture, or has recorded it, meanwhile keeps it; one that holds it after finds it gone
      // and writes it again.
      const lookFiles = await readdir(lookFolder).catch(() => [] as string[]);
      if (signal.aborted) return;
      const removeUnkept = (from: string, names: readonly string[], kept: Set<string>) => {
        for (const name of names) {
          const hash = name.split(".")[0] ?? "";
          if (kept.has(hash) || saving.has(hash)) continue;
          try {
            rmSync(join(from, name), { force: true });
          } catch (error) {
            options.reportError?.(error);
          }
        }
      };
      removeUnkept(pictureFolder, files, keptPictureHashes(db));
      removeUnkept(lookFolder, lookFiles, keptLookHashes(db));
    },

    /**
     * See `CoreApi.saveWebPage`; the caller files it in its Folder. `added`
     * hears a new Document's id as it is stored, before it is processed.
     * `fetch` fetches the page instead of the usual one: web search's (#128). `origin` says who
     * saves it; the User saving an address a search saved makes it theirs. `reuse` limits which
     * page saved already is given back; without it, any is.
     */
    save(
      input: unknown,
      added?: (documentId: string) => void,
      fetch?: PageFetch,
      origin: WebPageOrigin = "user",
      reuse?: PageReuse,
    ): Promise<WebPageResult> {
      const { address: typed, html, keepLook, localModeOnce } = parseSaveInput(input);
      const address = normaliseAddress(typed);
      if (!address) {
        return Promise.resolve(
          failed(typed, new WebPageError("invalid-address", "Not an http or https address.")),
        );
      }
      const saved = (id: string): WebPageResult => ({
        outcome: "saved",
        document: documents.get(id),
        existing: true,
      });
      // A save that joins one a web search has under way is the User's too.
      const claimed = (result: WebPageResult): WebPageResult => {
        if (origin !== "user" || result.outcome !== "saved") return result;
        claimForUser(db, result.document.id, now());
        return { ...result, document: documents.get(result.document.id) };
      };
      const known = documentAtAddress(db, address, reuse?.reusable);
      if (known) return Promise.resolve(claimed(saved(known)));
      if (options.localOnly?.() && html === undefined && !fetch && !localModeOnce) {
        return Promise.resolve(heldInLocalMode(address));
      }
      return once(reuse ? `${reuse.key}\n${address}` : address, async () => {
        try {
          return await withPage(await pageFor(address, html, fetch), async (page) => {
            const meanwhile = documentAtAddress(db, address, reuse?.reusable);
            if (meanwhile) return saved(meanwhile);
            const id = randomUUID();
            const file = await write(join(folder, `${id}.html`), page.xhtml);
            const document = documents.addSnapshot(id, page.snapshot.title, file, () => {
              record(id, file, address, page, origin);
              added?.(id);
            });
            if (html === undefined && (keepLook ?? options.keepLookByDefault())) {
              startLook(id, file.contentHash, address);
            }
            return { outcome: "saved", document, existing: false };
          });
        } catch (error) {
          return failed(address, error);
        }
      }).then(claimed);
    },

    /** See `CoreApi.fetchWebPageAgain`. */
    fetchAgain(documentId: unknown, fetchOptions?: unknown): Promise<WebPageResult> {
      if (typeof documentId !== "string" || documentId === "") {
        throw new InvalidInputError("A Document id is required.");
      }
      const document = documents.get(documentId);
      const info = webPageInfo(db, document.id);
      if (document.kind !== "web" || !info) {
        throw new InvalidInputError("Only a web page can be fetched again.");
      }
      const letThrough = isRecord(fetchOptions) && fetchOptions.localModeOnce === true;
      if (options.localOnly?.() && !letThrough)
        return Promise.resolve(heldInLocalMode(info.address));
      return once(`document:${document.id}`, async () => {
        try {
          return await withPage(await pageFor(info.address, undefined), async (page) => {
            const current = documents.get(document.id);
            const file = await write(current.path, page.xhtml);
            record(current.id, file, info.address, page, originOf(db, current.id) ?? info.origin);
            const look = webPageInfo(db, current.id)?.look ?? null;
            // The page's own choice at its save, whatever the setting says now.
            const wanted = info.look !== null;
            if (wanted && (look === null || look.status === "failed")) {
              startLook(current.id, file.contentHash, info.address);
            }
            await documents.check(current.path);
            return {
              outcome: "saved" as const,
              document: documents.get(current.id),
              existing: true,
            };
          });
        } catch (error) {
          if (error instanceof NotFoundError) throw error;
          return failed(info.address, error);
        }
      });
    },

    /** See `CoreApi.keepWebPageLook`. */
    keepLook(documentId: unknown): Document {
      if (typeof documentId !== "string" || documentId === "") {
        throw new InvalidInputError({ key: "error.document.idRequired" });
      }
      const document = documents.get(documentId);
      const info = webPageInfo(db, document.id);
      const latest = info?.versions[0];
      if (document.kind !== "web" || !info || !latest) {
        throw new InvalidInputError({ key: "error.webPage.lookNotWebPage" });
      }
      if (info.look?.status !== "saving" && info.look?.status !== "saved") {
        startLook(document.id, latest.contentHash, info.address);
      }
      return documents.get(document.id);
    },
  };
}
