/**
 * The CPython `run_code` runs Python with (ADR-0025, amended 2026-11-01):
 * IncarnaMind's own, pinned, with a fixed set of packages, downloaded the
 * first time code needs it. The host says which archive this build goes
 * with (`PythonRuntimeManifest`, written into the app when it was built);
 * it downloads to runtimes/ in the data folder, resumably, and is kept only
 * when its size and SHA-256 are the manifest's (../embedding/download). It
 * is unpacked there and imports every package once in the OS sandbox, which
 * also takes the time macOS spends on a native library it loads for the
 * first time, before the first run waits on it.
 *
 * Network traffic that carries no User content (the Privacy page lists it):
 * one GET for the archive, from the host its manifest names.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Executor, Logger } from "../adapters";
import type { EmbeddingModelError, EmbeddingModelStatus } from "../api";
import { downloadModel, ModelDownloadError } from "../embedding/download";
import { STALL_MS } from "../embedding/modelSources";
import { WORKING_FOLDER } from "../execution";
import { unpackTarZst } from "./tar";

/** The archive this build of the app goes with, as the build wrote it. */
export interface PythonRuntimeManifest {
  /** Its file name: "python-runtime-darwin-arm64.tar.zst". */
  file: string;
  /** Where it is downloaded from. */
  url: string;
  size: number;
  /** In hex. */
  sha256: string;
  /** "darwin-arm64", "linux-x64". */
  platform: string;
  /** CPython's version: "3.14.10". */
  python: string;
  /** Each distribution it has, by name: `{ numpy: "2.5.4" }`. */
  packages: Readonly<Record<string, string>>;
}

export interface ReadyPython {
  /** The interpreter: …/python/bin/python3. */
  command: string;
  manifest: PythonRuntimeManifest;
}

export type PythonReady =
  | { ok: true; python: ReadyPython }
  | { ok: false; error: EmbeddingModelError };

export interface PythonRuntimeOptions {
  dataDir: string;
  manifest: PythonRuntimeManifest;
  /** The OS sandbox's: the first import runs in it, as every run does. */
  executor: Executor;
  fetch: typeof fetch;
  emitStatus(status: EmbeddingModelStatus): void;
  log?: Logger;
}

/** What `run_code` imports before its first run: every package the runtime has, and plotting. */
const FIRST_IMPORT = [
  "import numpy, pandas, scipy.stats, statsmodels.api, sklearn.linear_model, sklearn.cluster",
  "import openpyxl, PIL.Image, matplotlib",
  "matplotlib.use('Agg')",
  "import matplotlib.pyplot",
].join("\n");

/** Far longer than the first import takes on a slow Mac, which checks each native library once. */
const FIRST_IMPORT_MS = 10 * 60_000;

/** The archive unpacks to about 350 MB in some 11,000 entries; well past that is not this archive. */
const UNPACK_LIMITS = { maxBytes: 2_000_000_000, maxEntries: 100_000 };

const READY_FILE = "ready.json";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The runtime is in place, but Python couldn't import its packages on this computer. */
class FirstImportError extends Error {
  override name = "FirstImportError";
}

/** Where a runtime lives: one folder per archive, by its SHA-256, so a new one never overwrites a working one. */
export const pythonRuntimeFolder = (dataDir: string, sha256: string) =>
  join(dataDir, "runtimes", `python-${sha256.slice(0, 16)}`);

/** GitHub's release downloads, which redirect to its asset hosts and nowhere else. */
const RELEASE_HOSTS = ["github.com", "githubusercontent.com"];

function releaseSources(fetcher: typeof fetch) {
  return {
    async urlsFor(_folder: string, file: { path: string; url?: string }, baseUrl: string) {
      return [{ source: "github" as const, url: new URL(file.url ?? file.path, baseUrl) }];
    },
    failed() {},
    redirectAllowed(_source: string, asked: URL, from: URL, to: URL): boolean {
      if (from.protocol === "https:" && to.protocol !== "https:") return false;
      return (
        to.host === asked.host ||
        RELEASE_HOSTS.some((host) => to.hostname === host || to.hostname.endsWith(`.${host}`))
      );
    },
    stallMs: STALL_MS,
    fetch: fetcher,
  };
}

export function createPythonRuntime(options: PythonRuntimeOptions) {
  const { manifest } = options;
  const folder = pythonRuntimeFolder(options.dataDir, manifest.sha256);
  const files = join(folder, "files");
  const command = join(files, "python", "bin", "python3");
  const lifetime = new AbortController();
  const ready = (): boolean => {
    try {
      const marked = JSON.parse(readFileSync(join(folder, READY_FILE), "utf8")) as unknown;
      return (
        typeof marked === "object" &&
        marked !== null &&
        (marked as { sha256?: unknown }).sha256 === manifest.sha256 &&
        existsSync(command)
      );
    } catch {
      return false;
    }
  };

  let status: EmbeddingModelStatus = {
    name: `Python ${manifest.python}`,
    host: new URL(manifest.url).host,
    state: ready() ? "ready" : "not-downloaded",
    downloadedBytes: 0,
    totalBytes: manifest.size,
    error: null,
  };
  if (status.state === "ready") status.downloadedBytes = manifest.size;
  let preparing: Promise<PythonReady> | null = null;
  let lastProgress = 0;

  const update = (patch: Partial<EmbeddingModelStatus>) => {
    status = { ...status, ...patch };
    if (!lifetime.signal.aborted) options.emitStatus(status);
  };

  async function firstImport(): Promise<void> {
    const started = performance.now();
    const ran = await options.executor.run({
      command,
      args: ["-I", "-B", "-c", FIRST_IMPORT],
      env: { MPLBACKEND: "Agg", MPLCONFIGDIR: ".matplotlib", PYTHONIOENCODING: "utf-8" },
      allow: { read: [], write: [WORKING_FOLDER], network: "none" },
      timeoutMs: FIRST_IMPORT_MS,
      maxOutputBytes: 16 * 1024,
      signal: lifetime.signal,
    });
    if (ran.exitCode !== 0) {
      const said = ran.stderr.trim().split("\n").slice(-3).join(" ");
      throw new FirstImportError(
        ran.timedOut
          ? `Python's packages took longer than ${FIRST_IMPORT_MS / 60_000} minutes to import.`
          : `Python couldn't import its packages: ${said || `exit ${ran.exitCode}`}`,
      );
    }
    options.log?.info("pythonRuntime.firstImport", {
      ms: Math.round(performance.now() - started),
      platform: manifest.platform,
    });
  }

  async function removeOthers(): Promise<void> {
    const runtimes = join(options.dataDir, "runtimes");
    const own = `python-${manifest.sha256.slice(0, 16)}`;
    for (const entry of await readdir(runtimes).catch(() => [])) {
      if (entry.startsWith("python-") && entry !== own) {
        await rm(join(runtimes, entry), { recursive: true, force: true }).catch((error: unknown) =>
          options.log?.warn("pythonRuntime.removeFailed", {
            folder: entry,
            reason: messageOf(error),
          }),
        );
      }
    }
  }

  async function prepare(): Promise<void> {
    const download = join(folder, "download");
    await downloadModel({
      directory: download,
      source: {
        baseUrl: new URL(".", manifest.url).href,
        files: [
          { path: manifest.file, url: manifest.url, size: manifest.size, sha256: manifest.sha256 },
        ],
      },
      sources: releaseSources(options.fetch),
      signal: lifetime.signal,
      onProgress: (bytes) => {
        status = { ...status, downloadedBytes: bytes };
        if (Date.now() - lastProgress < 250) return;
        lastProgress = Date.now();
        update({});
      },
    });
    update({ downloadedBytes: manifest.size });
    const partial = `${files}.partial`;
    try {
      await rm(partial, { recursive: true, force: true });
      await rm(files, { recursive: true, force: true });
      await mkdir(partial, { recursive: true });
      await unpackTarZst(join(download, manifest.file), partial, UNPACK_LIMITS);
      await rename(partial, files);
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      // The archive matched its SHA-256, so a failure here is the disk's, or an archive the build got wrong.
      throw new ModelDownloadError("storage", `Couldn't unpack Python: ${messageOf(error)}`);
    }
    await firstImport();
    await writeFile(join(folder, READY_FILE), JSON.stringify({ sha256: manifest.sha256 }));
    await rm(download, { recursive: true, force: true });
    await removeOthers();
  }

  return {
    manifest,
    status: (): EmbeddingModelStatus => status,
    /**
     * The runtime, downloaded, unpacked and imported first if it isn't yet; every caller waits on
     * the same preparation, which only `close` stops. A failure is kept in the status, and the
     * next call tries again: the download resumes.
     */
    ensure(): Promise<PythonReady> {
      if (ready()) {
        if (status.state !== "ready")
          update({ state: "ready", downloadedBytes: manifest.size, error: null });
        return Promise.resolve({ ok: true, python: { command, manifest } });
      }
      preparing ??= (async (): Promise<PythonReady> => {
        update({ state: "downloading", error: null, downloadedBytes: 0 });
        try {
          await prepare();
          update({ state: "ready", downloadedBytes: manifest.size, error: null });
          return { ok: true, python: { command, manifest } };
        } catch (error) {
          const failure: EmbeddingModelError =
            error instanceof ModelDownloadError
              ? { kind: error.kind, message: error.message }
              : {
                  kind: error instanceof FirstImportError ? "load" : "storage",
                  message: messageOf(error),
                };
          if (!lifetime.signal.aborted) {
            options.log?.warn("pythonRuntime.failed", {
              kind: failure.kind,
              reason: failure.message,
            });
          }
          update({ state: "failed", error: failure });
          return { ok: false, error: failure };
        } finally {
          preparing = null;
        }
      })();
      return preparing;
    },
    close(): void {
      lifetime.abort();
    },
  };
}

export type PythonRuntime = ReturnType<typeof createPythonRuntime>;
