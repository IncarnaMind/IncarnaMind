/**
 * The CPython `run_code` runs Python with (ADR-0025, amended 2026-11-01):
 * IncarnaMind's own, pinned, with a fixed set of packages, downloaded the
 * first time code needs it. The host says which archive this build goes
 * with (`PythonRuntimeManifest`, written into the app when it was built);
 * it downloads to runtimes/ in the data folder, resumably, and is kept only
 * when its size and SHA-256 are the manifest's (../embedding/download). It
 * is unpacked there and imports every package once in the OS sandbox, which
 * also takes the time macOS spends on a native library it loads for the
 * first time, before the first run waits on it. Skill scripts run on it too,
 * once it is here, but never download it.
 *
 * Network traffic that carries no User content (the Privacy page lists it):
 * one GET for the archive, from the host its manifest names.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Executor, Logger } from "../../core/adapters";
import type { EmbeddingModelError, EmbeddingModelStatus } from "../../core/api";
import { downloadModel, ModelDownloadError, progressReporter } from "../../core/embedding/download";
import { STALL_MS } from "../../core/embedding/modelSources";
import { WORKING_FOLDER } from "../../core/execution";
import type { InstalledPython, PythonRuntimeManifest } from "../../core/runCode";
import { canonicalPath } from "../sandbox";
import { unpackTarZst } from "./tar";

export type { PythonRuntimeManifest };

export interface ReadyPython extends InstalledPython {
  /** matplotlib's font cache, built by the first import, which each run starts from. */
  fontCache: string;
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

/**
 * What `run_code` imports before its first run: every package the runtime has, and plotting, which
 * builds matplotlib's font cache where each run copies it from. In the OS sandbox getcwd() can't
 * read the folders above its own, so Python is told it (TMPDIR is the working folder), as
 * runner.py does.
 */
const FIRST_IMPORT = [
  "import os",
  "here = os.environ.get('TMPDIR') or os.getcwd()",
  "os.getcwd = lambda: here",
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
  const archive = join(folder, "download", manifest.file);
  const prefix = join(files, "python");
  const command = join(prefix, "bin", "python3");
  const fontCache = join(folder, "matplotlib");
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
  /** The preparation under way, and how many calls wait on it: it stops when the last one does. */
  let preparing: { done: Promise<PythonReady>; stop: AbortController; waiting: number } | null =
    null;

  const update = (patch: Partial<EmbeddingModelStatus>) => {
    status = { ...status, ...patch };
    if (!lifetime.signal.aborted) options.emitStatus(status);
  };

  async function firstImport(signal: AbortSignal): Promise<void> {
    const started = performance.now();
    await rm(fontCache, { recursive: true, force: true });
    await mkdir(fontCache, { recursive: true });
    const cache = await canonicalPath(fontCache, { mustExist: true });
    const ran = await options.executor.run({
      command,
      args: ["-I", "-B", "-c", FIRST_IMPORT],
      env: { MPLBACKEND: "Agg", MPLCONFIGDIR: cache, PYTHONIOENCODING: "utf-8" },
      // Only this import, IncarnaMind's own code, writes the font cache: a run gets a copy of it.
      allow: { read: [cache, prefix], write: [WORKING_FOLDER, cache], network: "none" },
      timeoutMs: FIRST_IMPORT_MS,
      maxOutputBytes: 16 * 1024,
      environment: "minimal",
      signal,
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

  async function prepare(signal: AbortSignal): Promise<void> {
    const download = join(folder, "download");
    const report = progressReporter(() => update({}));
    await downloadModel({
      directory: download,
      source: {
        baseUrl: new URL(".", manifest.url).href,
        files: [
          { path: manifest.file, url: manifest.url, size: manifest.size, sha256: manifest.sha256 },
        ],
      },
      sources: releaseSources(options.fetch),
      signal,
      onProgress: (bytes) => {
        status = { ...status, downloadedBytes: bytes };
        report();
      },
    });
    update({ downloadedBytes: manifest.size });
    const partial = `${files}.partial`;
    try {
      // A mark left from before would count these files ready once they are in place, before
      // their first import, and after one that fails.
      await rm(join(folder, READY_FILE), { force: true });
      await rm(partial, { recursive: true, force: true });
      await rm(files, { recursive: true, force: true });
      await mkdir(partial, { recursive: true });
      await unpackTarZst(join(download, manifest.file), partial, UNPACK_LIMITS);
      await rename(partial, files);
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch((cleanup: unknown) =>
        options.log?.warn("pythonRuntime.cleanupFailed", { reason: messageOf(cleanup) }),
      );
      // The archive matched its SHA-256, so a failure here is the disk's, or an archive the build got wrong.
      throw new ModelDownloadError("storage", `Couldn't unpack Python: ${messageOf(error)}`);
    }
    signal.throwIfAborted();
    await firstImport(signal);
    await writeFile(join(folder, READY_FILE), JSON.stringify({ sha256: manifest.sha256 }));
    await rm(download, { recursive: true, force: true });
    await removeOthers();
  }

  /** A preparation, once the one before it (stopped) has let go of the folder. */
  function startPreparing(after: Promise<unknown>) {
    const stop = new AbortController();
    const close = () => stop.abort(lifetime.signal.reason);
    if (lifetime.signal.aborted) close();
    else lifetime.signal.addEventListener("abort", close, { once: true });
    // The one before was stopped; it may still have finished what it was doing when it was.
    const done = after.then(settled, settled);
    async function settled(): Promise<PythonReady> {
      if (ready()) {
        lifetime.signal.removeEventListener("abort", close);
        if (preparing?.stop === stop) preparing = null;
        update({ state: "ready", downloadedBytes: manifest.size, error: null });
        return { ok: true, python: { command, prefix, fontCache, manifest } };
      }
      // An archive a download finished is only checked again: nothing is shown downloading. Should
      // it fail its check, the download starts again and shows so.
      const kept = (await stat(archive).catch(() => null))?.size === manifest.size;
      update({ state: "downloading", error: null, downloadedBytes: kept ? manifest.size : 0 });
      try {
        stop.signal.throwIfAborted();
        await prepare(stop.signal);
        update({ state: "ready", downloadedBytes: manifest.size, error: null });
        return { ok: true, python: { command, prefix, fontCache, manifest } };
      } catch (error) {
        if (stop.signal.aborted) {
          update({ state: "not-downloaded", error: null, downloadedBytes: 0 });
          return { ok: false, error: { kind: "network", message: "Stopped." } };
        }
        const failure: EmbeddingModelError =
          error instanceof ModelDownloadError
            ? { kind: error.kind, message: error.message }
            : {
                kind: error instanceof FirstImportError ? "load" : "storage",
                message: messageOf(error),
              };
        options.log?.warn("pythonRuntime.failed", { kind: failure.kind, reason: failure.message });
        update({ state: "failed", error: failure });
        return { ok: false, error: failure };
      } finally {
        lifetime.signal.removeEventListener("abort", close);
        if (preparing?.stop === stop) preparing = null;
      }
    }
    return { done, stop, waiting: 0 };
  }

  return {
    manifest,
    status: (): EmbeddingModelStatus => status,
    installed: (): InstalledPython | null => (ready() ? { command, prefix } : null),
    /**
     * The runtime, downloaded, unpacked and imported first if it isn't yet. Every call waits on the
     * same preparation, which stops when every call waiting on it was stopped: what was downloaded
     * is kept, and the next call resumes it. A failure is kept in the status, and the next call
     * tries again. Rejects with the signal's reason once `signal` stops.
     */
    ensure(signal: AbortSignal): Promise<PythonReady> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (ready()) {
        if (status.state !== "ready")
          update({ state: "ready", downloadedBytes: manifest.size, error: null });
        return Promise.resolve({ ok: true, python: { command, prefix, fontCache, manifest } });
      }
      if (!preparing || preparing.stop.signal.aborted) {
        preparing = startPreparing(preparing?.done ?? Promise.resolve(null));
      }
      const current = preparing;
      current.waiting++;
      return new Promise<PythonReady>((resolve, reject) => {
        const leave = () => {
          current.waiting--;
          if (current.waiting === 0) current.stop.abort(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener("abort", leave, { once: true });
        const settle = () => {
          signal.removeEventListener("abort", leave);
          current.waiting--;
        };
        current.done.then(
          (result) => {
            if (signal.aborted) return;
            settle();
            resolve(result);
          },
          (error: unknown) => {
            if (signal.aborted) return;
            settle();
            reject(error);
          },
        );
      });
    },
    close(): void {
      lifetime.abort();
    },
  };
}

export type PythonRuntime = ReturnType<typeof createPythonRuntime>;
