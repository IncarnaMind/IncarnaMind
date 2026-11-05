/**
 * IncarnaMind's own Python for `run_code` (ADR-0025), downloaded the first time code needs it:
 * from a stand-in release on this computer, checked against the SHA-256 built into the app,
 * unpacked into the data folder, imported once, and kept. The archive here holds a stand-in
 * interpreter, a shell script, so no real Python is downloaded; tests/main/runCodeRuntime.test.ts
 * loads the real one.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, onTestFinished, test } from "vitest";
import type { EmbeddingModelStatus } from "../../src/core/api";
import { createLocalExecutor } from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import {
  createPythonRuntime,
  type PythonRuntimeManifest,
  pythonRuntimeFolder,
} from "../../src/main/runCode/python";
import { type TarEntry, writeTarZst } from "../../src/main/runCode/tar";
import { createTempDataFolder, LOCAL_FETCH } from "../helpers/core";

/**
 * Notes each first import in the font cache's folder, the one place a first import writes, and
 * ends with `exit`. It gets only the minimal environment code gets, so nothing else reaches it.
 */
const interpreterExiting = (exit: number) =>
  `#!/bin/sh\necho imported >> "$MPLCONFIGDIR/imported"\nexit ${exit}\n`;
const INTERPRETER = interpreterExiting(0);

/**
 * A stand-in runtime archive, served from a stand-in release; `served` counts its downloads.
 * `stallAfter` sends that many bytes and then nothing more until `resume`; `dropped` counts the
 * downloads the app gave up before the end.
 */
async function release(
  options: { interpreter?: string; stallAfter?: number; extra?: TarEntry[] } = {},
) {
  const root = await createTempDataFolder();
  const interpreter = options.interpreter ?? INTERPRETER;
  const entries: TarEntry[] = [
    { kind: "directory", path: "python", mode: 0o755, mtime: 1_700_000_000 },
    {
      kind: "file",
      path: "python/bin/python3.14",
      mode: 0o755,
      mtime: 1_700_000_000,
      size: Buffer.byteLength(interpreter),
    },
    {
      kind: "symlink",
      path: "python/bin/python3",
      mode: 0o777,
      mtime: 1_700_000_000,
      target: "python3.14",
    },
    { kind: "file", path: "LICENSES/cpython.txt", mode: 0o644, mtime: 1_700_000_000, size: 3 },
    ...(options.extra ?? []),
  ];
  const archive = join(root, "python-runtime-test.tar.zst");
  await writeTarZst(
    archive,
    entries,
    (entry) => Readable.from([Buffer.from(entry.path.endsWith("txt") ? "PSF" : interpreter)]),
    3,
  );
  const bytes = await readFile(archive);
  let served = 0;
  let dropped = 0;
  let offline = false;
  const stalled: (() => void)[] = [];
  const server = createServer((request, response) => {
    if (offline) {
      request.socket.destroy();
      return;
    }
    served++;
    response.on("close", () => {
      if (!response.writableFinished) dropped++;
    });
    response.writeHead(200, { "content-length": bytes.byteLength });
    const { stallAfter } = options;
    if (stallAfter === undefined) {
      response.end(bytes);
      return;
    }
    response.write(bytes.subarray(0, stallAfter));
    stalled.push(() => response.end(bytes.subarray(stallAfter)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  const manifest: PythonRuntimeManifest = {
    file: "python-runtime-test.tar.zst",
    url: `http://127.0.0.1:${port}/python-runtime-test.tar.zst`,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    platform: "test",
    python: "3.14.10",
    packages: { numpy: "2.5.4" },
  };
  return {
    manifest,
    served: () => served,
    dropped: () => dropped,
    resume: () => {
      for (const send of stalled.splice(0)) send();
    },
    goOffline: () => {
      offline = true;
    },
  };
}

async function runtimeFor(manifest: PythonRuntimeManifest) {
  const dataDir = await createTempDataFolder();
  const imports = join(pythonRuntimeFolder(dataDir, manifest.sha256), "matplotlib", "imported");
  const executor = createLocalExecutor({
    processes: createProcessLauncher(async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" })),
    tempDir: dataDir,
    reportError: (error) => {
      throw error;
    },
  });
  const statuses: EmbeddingModelStatus[] = [];
  const make = () =>
    createPythonRuntime({
      dataDir,
      manifest,
      executor,
      fetch: LOCAL_FETCH,
      emitStatus: (status) => statuses.push(status),
    });
  return {
    dataDir,
    statuses,
    make,
    imports: () => readFile(imports, "utf8").catch(() => ""),
  };
}

describe.skipIf(process.platform === "win32")("run_code's own Python", () => {
  test("downloads once, checks it, unpacks it into the data folder and imports its packages first", async () => {
    const { manifest, served } = await release();
    const { dataDir, statuses, make, imports } = await runtimeFor(manifest);
    const runtime = make();
    expect(runtime.status().state).toBe("not-downloaded");
    const [first, second] = await Promise.all([
      runtime.ensure(new AbortController().signal),
      runtime.ensure(new AbortController().signal),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(served()).toBe(1);
    const folder = pythonRuntimeFolder(dataDir, manifest.sha256);
    expect(first.ok && first.python.command).toBe(
      join(folder, "files", "python", "bin", "python3"),
    );
    expect(await readFile(join(folder, "files", "LICENSES", "cpython.txt"), "utf8")).toBe("PSF");
    expect(await imports()).toBe("imported\n");
    expect(statuses.at(0)?.state).toBe("downloading");
    expect(statuses.at(-1)).toMatchObject({ state: "ready", downloadedBytes: manifest.size });
    // The archive itself is gone once it is unpacked.
    expect((await readdir(folder)).sort()).toEqual(["files", "matplotlib", "ready.json"]);

    const again = make();
    expect(again.status().state).toBe("ready");
    expect((await again.ensure(new AbortController().signal)).ok).toBe(true);
    expect(served()).toBe(1);
    expect(await imports()).toBe("imported\n");
  });

  test("says it is installed only once it is ready, and asking downloads nothing", async () => {
    const { manifest, served } = await release();
    const { dataDir, make } = await runtimeFor(manifest);
    const runtime = make();
    expect(runtime.installed()).toBeNull();
    expect(served()).toBe(0);
    expect(runtime.status().state).toBe("not-downloaded");

    expect((await runtime.ensure(new AbortController().signal)).ok).toBe(true);
    const prefix = join(pythonRuntimeFolder(dataDir, manifest.sha256), "files", "python");
    expect(runtime.installed()).toEqual({ command: join(prefix, "bin", "python3"), prefix });
    expect(make().installed()).toEqual({ command: join(prefix, "bin", "python3"), prefix });

    const failing = await release({ interpreter: interpreterExiting(3) });
    const unready = (await runtimeFor(failing.manifest)).make();
    expect((await unready.ensure(new AbortController().signal)).ok).toBe(false);
    expect(unready.installed()).toBeNull();
  });

  test("a ready mark left from before, its files gone, counts for nothing once they are back and fail to import", async () => {
    const { manifest } = await release({ interpreter: interpreterExiting(3) });
    const { dataDir, make } = await runtimeFor(manifest);
    const folder = pythonRuntimeFolder(dataDir, manifest.sha256);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "ready.json"), JSON.stringify({ sha256: manifest.sha256 }));
    const runtime = make();
    expect(runtime.installed()).toBeNull();

    expect(await runtime.ensure(new AbortController().signal)).toMatchObject({
      ok: false,
      error: { kind: "load" },
    });
    expect(runtime.installed()).toBeNull();
    expect(make().installed()).toBeNull();
  });

  test("keeps nothing that doesn't match the SHA-256 built into the app", async () => {
    const { manifest } = await release();
    const { dataDir, make } = await runtimeFor({ ...manifest, sha256: "0".repeat(64) });
    const done = await make().ensure(new AbortController().signal);
    expect(done).toMatchObject({ ok: false, error: { kind: "integrity" } });
    const folder = pythonRuntimeFolder(dataDir, "0".repeat(64));
    expect(await readdir(join(folder, "download")).catch(() => [])).toEqual([]);
    const right = await runtimeFor(manifest);
    expect((await right.make().ensure(new AbortController().signal)).ok).toBe(true);
  });

  test("an archive with a link out of its folder fails as one that can't be kept, and nothing of it is", async () => {
    const { manifest } = await release({
      extra: [
        {
          kind: "symlink",
          path: "python/lib",
          mode: 0o777,
          mtime: 1_700_000_000,
          target: "../../..",
        },
      ],
    });
    const { dataDir, statuses, make } = await runtimeFor(manifest);
    const done = await make().ensure(new AbortController().signal);
    expect(done).toMatchObject({
      ok: false,
      error: {
        kind: "storage",
        message:
          "Couldn't unpack Python: The archive has a link that points outside it: python/lib → ../../..",
      },
    });
    expect(statuses.at(-1)).toMatchObject({ state: "failed" });
    const folder = pythonRuntimeFolder(dataDir, manifest.sha256);
    expect((await readdir(folder)).filter((name) => name !== "download")).toEqual([]);
  });

  test("shows how far the download came when the release stalls after a burst", async () => {
    const { manifest, resume } = await release({ stallAfter: 100 });
    const { statuses, make } = await runtimeFor(manifest);
    const runtime = make();
    const ensured = runtime.ensure(new AbortController().signal);
    await expect
      .poll(() => statuses.at(-1))
      .toMatchObject({ state: "downloading", downloadedBytes: 100 });
    expect(statuses.at(0)).toMatchObject({ state: "downloading", downloadedBytes: 0 });
    resume();
    expect((await ensured).ok).toBe(true);
  });

  test("a call that stops leaves the download to the calls still waiting on it", async () => {
    const { manifest, dropped, served, resume } = await release({ stallAfter: 100 });
    const { statuses, make } = await runtimeFor(manifest);
    const runtime = make();
    const first = new AbortController();
    const stopping = runtime.ensure(first.signal);
    const staying = runtime.ensure(new AbortController().signal);
    await expect.poll(() => statuses.at(-1)?.downloadedBytes).toBe(100);

    first.abort(new Error("stopped one"));
    await expect(stopping).rejects.toThrow("stopped one");
    resume();
    expect((await staying).ok).toBe(true);
    expect(served()).toBe(1);
    expect(dropped()).toBe(0);
  });

  test("stops downloading once every call waiting on it is stopped, and the next call starts again", async () => {
    const { manifest, dropped, served, resume } = await release({ stallAfter: 100 });
    const { statuses, make } = await runtimeFor(manifest);
    const runtime = make();
    const only = new AbortController();
    const waiting = runtime.ensure(only.signal);
    await expect.poll(() => statuses.at(-1)?.downloadedBytes).toBe(100);

    only.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    await expect.poll(() => dropped()).toBe(1);
    await expect.poll(() => runtime.status().state).toBe("not-downloaded");

    const again = runtime.ensure(new AbortController().signal);
    await expect.poll(() => served()).toBe(2);
    resume();
    expect((await again).ok).toBe(true);
    expect(runtime.status().state).toBe("ready");
  });

  test("a closed runtime downloads nothing", async () => {
    const { manifest, served } = await release();
    const { make } = await runtimeFor(manifest);
    const runtime = make();
    runtime.close();
    const result = await runtime.ensure(new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(served()).toBe(0);
    expect((await make().ensure(new AbortController().signal)).ok).toBe(true);
    expect(served()).toBe(1);
  });

  test("says it couldn't be downloaded when offline, and tries again on the next call", async () => {
    const { manifest, goOffline, served } = await release();
    goOffline();
    const { make } = await runtimeFor(manifest);
    const runtime = make();
    const failed = await runtime.ensure(new AbortController().signal);
    expect(failed).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(runtime.status().state).toBe("failed");
    expect(served()).toBe(0);
  });

  test("a runtime whose packages don't import fails as one that can't start here", async () => {
    const { manifest } = await release({ interpreter: interpreterExiting(3) });
    const { make, imports } = await runtimeFor(manifest);
    const runtime = make();
    const failed = await runtime.ensure(new AbortController().signal);
    expect(failed).toMatchObject({ ok: false, error: { kind: "load" } });
    expect(await imports()).toBe("imported\n");
    expect(runtime.status().state).toBe("failed");
  });

  test("an archive already downloaded and checked is never shown downloading again", async () => {
    // Its packages import from the second try on, as after a first import that was stopped.
    const { manifest, served } = await release({
      interpreter: [
        "#!/bin/sh",
        'tried="$MPLCONFIGDIR/../tried"',
        '[ -f "$tried" ] || { touch "$tried"; exit 3; }',
        "",
      ].join("\n"),
    });
    const { statuses, make } = await runtimeFor(manifest);
    const runtime = make();
    expect(await runtime.ensure(new AbortController().signal)).toMatchObject({
      ok: false,
      error: { kind: "load" },
    });
    statuses.length = 0;

    expect((await runtime.ensure(new AbortController().signal)).ok).toBe(true);
    expect(served()).toBe(1);
    const preparing = statuses.filter((status) => status.state === "downloading");
    expect(preparing.length).toBeGreaterThan(0);
    expect(manifest.size).toBe(261);
    expect(preparing.map((status) => status.downloadedBytes)).toEqual(preparing.map(() => 261));
    expect(statuses.at(-1)).toMatchObject({ state: "ready" });
  });

  test("an archive of the right size but other bytes is downloaded again, and shown downloading from 0", async () => {
    const { manifest, served } = await release();
    const { dataDir, statuses, make } = await runtimeFor(manifest);
    const download = join(pythonRuntimeFolder(dataDir, manifest.sha256), "download");
    await mkdir(download, { recursive: true });
    await writeFile(join(download, manifest.file), Buffer.alloc(manifest.size));

    expect((await make().ensure(new AbortController().signal)).ok).toBe(true);
    expect(served()).toBe(1);
    const shown = statuses
      .filter((status) => status.state === "downloading")
      .map((status) => status.downloadedBytes);
    expect(manifest.size).toBe(241);
    expect(shown[0]).toBe(241);
    expect(shown.indexOf(0)).toBeGreaterThan(0);
    expect(statuses.at(-1)).toMatchObject({ state: "ready" });
  });

  test("a new runtime removes the one it replaces once it is ready", async () => {
    const { manifest } = await release();
    const { dataDir, make } = await runtimeFor(manifest);
    const older = join(dataDir, "runtimes", "python-0123456789abcdef");
    await mkdir(join(older, "files"), { recursive: true });
    await writeFile(join(older, "ready.json"), "{}");
    const other = join(dataDir, "runtimes", "speech");
    await mkdir(other, { recursive: true });
    expect((await make().ensure(new AbortController().signal)).ok).toBe(true);
    expect((await readdir(join(dataDir, "runtimes"))).sort()).toEqual([
      `python-${manifest.sha256.slice(0, 16)}`,
      "speech",
    ]);
  });
});
