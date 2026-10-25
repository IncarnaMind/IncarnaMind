/**
 * Downloads the built-in embedding model's files into the data folder.
 *
 * Network traffic that carries no User content (for the privacy page, #44):
 * plain GET requests for the model's files to each source's host (./modelSources:
 * Hugging Face first by default). Nothing about the User or their Documents is
 * sent, so the download needs no consent.
 *
 * Safe to interrupt at any point. Each file is written to "<file>.partial" and
 * renamed only once its size and SHA-256 match the recorded ones; the next
 * download resumes a partial file with an HTTP Range request, from whichever
 * source it tries next. `verified.json` is written last, listing the files
 * that were checked, so startup only compares it and the file sizes instead of
 * hashing 135 MB again.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EmbeddingModelSource, ModelFile } from "../adapters";
import type { EmbeddingModelError, ModelSourceId } from "../api";
import { type ModelSources, redirectAllowedByDefault } from "./modelSources";

const VERIFIED_FILE = "verified.json";

/** Why a download failed; "load" failures come from the runner, not from here. */
export class ModelDownloadError extends Error {
  override name = "ModelDownloadError";
  constructor(
    readonly kind: Exclude<EmbeddingModelError["kind"], "load">,
    message: string,
    /** Every source failed: what each said. */
    readonly sources?: { source: ModelSourceId; message: string }[],
  ) {
    super(message);
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A file-system error (it names a system call), as opposed to a network one. */
const isFileSystemError = (error: unknown) =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === "string";

const sizeOf = async (path: string): Promise<number | null> => {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
};

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Whether every file was downloaded and checked: `verified.json` lists exactly
 * these files, and each has its recorded size. A model with no files is always downloaded.
 */
export function isModelDownloaded(directory: string, files: readonly ModelFile[]): boolean {
  if (files.length === 0) return true;
  try {
    const verified = JSON.parse(readFileSync(join(directory, VERIFIED_FILE), "utf8")) as unknown;
    if (JSON.stringify(verified) !== JSON.stringify({ files })) return false;
    return files.every((file) => statSync(join(directory, file.path)).size === file.size);
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  /** The model's folder in the data folder. */
  directory: string;
  source: EmbeddingModelSource;
  /** Aborting leaves partial files to resume from. */
  signal: AbortSignal;
  /** Bytes downloaded and checked so far, out of the files' total size. */
  onProgress(downloadedBytes: number): void;
  /** Where else each file may come from, in turn (#1578). Absent: `source` alone. */
  sources?: ModelSources;
}

/**
 * Downloads and checks every file not yet in place. A file already in place
 * with the right size (from an interrupted download, or copied in by hand) is
 * checked instead of downloaded again. Throws ModelDownloadError, or the
 * signal's reason when aborted.
 */
export async function downloadModel(options: DownloadOptions): Promise<void> {
  const { directory, source, signal, onProgress } = options;
  let done = 0;
  for (const file of source.files) {
    signal.throwIfAborted();
    const target = join(directory, file.path);
    try {
      await mkdir(dirname(target), { recursive: true });
      if ((await sizeOf(target)) === file.size && (await sha256Of(target)) === file.sha256) {
        done += file.size;
        onProgress(done);
        continue;
      }
      await rm(target, { force: true });
    } catch (error) {
      throw new ModelDownloadError("storage", `Couldn't prepare ${file.path}: ${messageOf(error)}`);
    }
    const base = done;
    await downloadFromSources(file, target, options, (bytes) => onProgress(base + bytes));
    done += file.size;
    onProgress(done);
  }
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, VERIFIED_FILE), JSON.stringify({ files: source.files }));
  } catch (error) {
    throw new ModelDownloadError("storage", `Couldn't record the download: ${messageOf(error)}`);
  }
}

// A storage failure or the signal's abort stops at once: no other source would fare better.
async function downloadFromSources(
  file: ModelFile,
  target: string,
  options: DownloadOptions,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const { source, signal, sources } = options;
  const urls = sources
    ? await sources.urlsFor(basename(options.directory), file, source.baseUrl)
    : [{ source: "huggingface" as const, url: new URL(file.url ?? file.path, source.baseUrl) }];
  const failures: { source: ModelSourceId; message: string; kind: string }[] = [];
  for (const each of urls) {
    try {
      await downloadFile(
        file,
        target,
        each.url,
        { signal, sources, source: each.source },
        onProgress,
      );
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ModelDownloadError) || error.kind === "storage") throw error;
      failures.push({ source: each.source, message: error.message, kind: error.kind });
      sources?.failed(each.source);
    }
  }
  throw new ModelDownloadError(
    failures.length > 0 && failures.every((each) => each.kind === "integrity")
      ? "integrity"
      : "network",
    failures.length === 1
      ? (failures[0]?.message ?? "")
      : `No source gave ${file.path}: ${failures.map((each) => `${each.source}: ${each.message}`).join("; ")}`,
    failures.map(({ source, message }) => ({ source, message })),
  );
}

// A resumed file that fails its check is downloaded again from the start once, as the bytes
// before may have come from another source.
async function downloadFile(
  file: ModelFile,
  target: string,
  url: URL,
  context: DownloadContext,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const partial = `${target}.partial`;
  for (let fresh = false; ; fresh = true) {
    let offset = (await sizeOf(partial)) ?? 0;
    if (offset > file.size) {
      await rm(partial, { force: true });
      offset = 0;
    }
    const resumed = offset > 0;
    if (offset < file.size)
      offset = await fetchInto(file, partial, offset, url, context, onProgress);
    if (offset < file.size) {
      throw new ModelDownloadError("network", `The download of ${file.path} ended early.`);
    }
    let hash: string;
    try {
      hash = await sha256Of(partial);
    } catch (error) {
      throw new ModelDownloadError("storage", `Couldn't read ${file.path}: ${messageOf(error)}`);
    }
    if (hash === file.sha256) break;
    await rm(partial, { force: true });
    if (!resumed || fresh) {
      throw new ModelDownloadError(
        "integrity",
        `${file.path} from ${url.host} doesn't match its recorded SHA-256 (got ${hash}), so it was discarded.`,
      );
    }
  }
  try {
    await rename(partial, target);
  } catch (error) {
    throw new ModelDownloadError("storage", `Couldn't save ${file.path}: ${messageOf(error)}`);
  }
}

async function fetchInto(
  file: ModelFile,
  partial: string,
  offset: number,
  url: URL,
  context: DownloadContext,
  onProgress: (bytes: number) => void,
): Promise<number> {
  const { sources } = context;
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const awake = () => {
    if (!sources) return;
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), sources.stallMs);
  };
  const signal = AbortSignal.any([context.signal, stall.signal]);
  const fetcher = sources?.fetch ?? fetch;
  const allowed = (from: URL, to: URL) =>
    sources
      ? sources.redirectAllowed(context.source, url, from, to)
      : redirectAllowedByDefault(url, from, to);
  const stopped = (error: unknown, what: string) => {
    context.signal.throwIfAborted();
    if (stall.signal.aborted) {
      return new ModelDownloadError(
        "network",
        `${url.host} sent nothing for ${(sources?.stallMs ?? 0) / 1000} s.`,
      );
    }
    return new ModelDownloadError("network", `${what}: ${messageOf(error)}`);
  };
  awake();
  try {
    const request = (at: URL) =>
      fetcher(at, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        redirect: "manual",
        credentials: "omit",
        signal,
      });
    return await fetchAwake(
      file,
      partial,
      offset,
      url,
      request,
      allowed,
      signal,
      stopped,
      (bytes) => {
        awake();
        onProgress(bytes);
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

interface DownloadContext {
  signal: AbortSignal;
  sources: ModelSources | undefined;
  source: ModelSourceId;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// Followed here rather than by `fetch`, so a source can't send a download to a host it doesn't own.
async function followed(
  file: ModelFile,
  url: URL,
  request: (at: URL) => Promise<Response>,
  allowed: (from: URL, to: URL) => boolean,
  stopped: (error: unknown, what: string) => ModelDownloadError,
): Promise<{ response: Response; at: URL }> {
  let at = url;
  for (let hops = 0; ; hops++) {
    let response: Response;
    try {
      response = await request(at);
    } catch (error) {
      throw stopped(error, `Couldn't reach ${at.host}`);
    }
    const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return { response, at };
    await response.body?.cancel();
    const next = new URL(location, at);
    if (hops === MAX_REDIRECTS || !allowed(at, next)) {
      throw new ModelDownloadError(
        "network",
        `${at.host} sent ${file.path} on to ${next.protocol}//${next.host}, which isn't one of its own hosts.`,
      );
    }
    at = next;
  }
}

async function fetchAwake(
  file: ModelFile,
  partial: string,
  offset: number,
  url: URL,
  request: (at: URL) => Promise<Response>,
  allowed: (from: URL, to: URL) => boolean,
  signal: AbortSignal,
  stopped: (error: unknown, what: string) => ModelDownloadError,
  onProgress: (bytes: number) => void,
): Promise<number> {
  const { response, at } = await followed(file, url, request, allowed, stopped);
  // A server that ignores the Range header sends the whole file again.
  const resumed =
    response.status === 206 &&
    response.headers.get("content-range")?.match(/^bytes (\d+)-/)?.[1] === String(offset);
  if (response.status !== 200 && !resumed) {
    await response.body?.cancel();
    if (response.status === 206 || response.status === 416) await rm(partial, { force: true });
    throw new ModelDownloadError(
      "network",
      `${at.host} answered HTTP ${response.status} for ${file.path}.`,
    );
  }
  // A short error page with a 200 isn't kept as the file's start, for the next source to resume.
  const expected = resumed ? file.size - offset : file.size;
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  const encoded = (response.headers.get("content-encoding") ?? "identity") !== "identity";
  if (!encoded && Number.isFinite(length) && length !== expected) {
    await response.body?.cancel();
    throw new ModelDownloadError(
      "network",
      `${at.host} sent ${length} bytes for ${file.path}, not the ${expected} recorded.`,
    );
  }
  if (!response.body) throw new ModelDownloadError("network", `${at.host} sent no data.`);

  let received = resumed ? offset : 0;
  onProgress(received);
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > file.size) {
        callback(
          new ModelDownloadError(
            "integrity",
            `${url.host} sent more than the ${file.size} bytes recorded for ${file.path}.`,
          ),
        );
        return;
      }
      onProgress(received);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(partial, { flags: resumed ? "a" : "w" }),
      { signal },
    );
  } catch (error) {
    if (error instanceof ModelDownloadError) {
      await rm(partial, { force: true });
      throw error;
    }
    if (isFileSystemError(error)) {
      throw new ModelDownloadError("storage", `Couldn't write ${file.path}: ${messageOf(error)}`);
    }
    throw stopped(error, `The download of ${file.path} from ${url.host} stopped`);
  }
  return received;
}
