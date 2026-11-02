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
import {
  createPythonRuntime,
  type PythonRuntimeManifest,
  pythonRuntimeFolder,
} from "../../src/core/runCode/python";
import { type TarEntry, writeTarZst } from "../../src/core/runCode/tar";
import { createProcessLauncher } from "../../src/main/processes";
import { createTempDataFolder, LOCAL_FETCH } from "../helpers/core";

// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell script's own variable.
const INTERPRETER = '#!/bin/sh\necho imported >> "$IMPORTS"\nexit ${STAND_IN_EXIT:-0}\n';

/** A stand-in runtime archive, served from a stand-in release; `served` counts its downloads. */
async function release(options: { interpreter?: string } = {}) {
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
  let offline = false;
  const server = createServer((request, response) => {
    if (offline) {
      request.socket.destroy();
      return;
    }
    served++;
    response.writeHead(200, { "content-length": bytes.byteLength });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
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
    goOffline: () => {
      offline = true;
    },
  };
}

async function runtimeFor(manifest: PythonRuntimeManifest, env: Record<string, string> = {}) {
  const dataDir = await createTempDataFolder();
  const imports = join(dataDir, "imports.txt");
  const executor = createLocalExecutor({
    processes: createProcessLauncher(async () => ({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      IMPORTS: imports,
      ...env,
    })),
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
    const [first, second] = await Promise.all([runtime.ensure(), runtime.ensure()]);
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
    expect((await again.ensure()).ok).toBe(true);
    expect(served()).toBe(1);
    expect(await imports()).toBe("imported\n");
  });

  test("keeps nothing that doesn't match the SHA-256 built into the app", async () => {
    const { manifest } = await release();
    const { dataDir, make } = await runtimeFor({ ...manifest, sha256: "0".repeat(64) });
    const done = await make().ensure();
    expect(done).toMatchObject({ ok: false, error: { kind: "integrity" } });
    const folder = pythonRuntimeFolder(dataDir, "0".repeat(64));
    expect(await readdir(join(folder, "download")).catch(() => [])).toEqual([]);
    const right = await runtimeFor(manifest);
    expect((await right.make().ensure()).ok).toBe(true);
  });

  test("says it couldn't be downloaded when offline, and tries again on the next call", async () => {
    const { manifest, goOffline, served } = await release();
    goOffline();
    const { make } = await runtimeFor(manifest);
    const runtime = make();
    const failed = await runtime.ensure();
    expect(failed).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(runtime.status().state).toBe("failed");
    expect(served()).toBe(0);
  });

  test("a runtime whose packages don't import fails as one that can't start here", async () => {
    const { manifest } = await release();
    const { make, imports } = await runtimeFor(manifest, { STAND_IN_EXIT: "3" });
    const runtime = make();
    const failed = await runtime.ensure();
    expect(failed).toMatchObject({ ok: false, error: { kind: "load" } });
    expect(await imports()).toBe("imported\n");
    expect(runtime.status().state).toBe("failed");
  });

  test("a new runtime removes the one it replaces once it is ready", async () => {
    const { manifest } = await release();
    const { dataDir, make } = await runtimeFor(manifest);
    const older = join(dataDir, "runtimes", "python-0123456789abcdef");
    await mkdir(join(older, "files"), { recursive: true });
    await writeFile(join(older, "ready.json"), "{}");
    const other = join(dataDir, "runtimes", "speech");
    await mkdir(other, { recursive: true });
    expect((await make().ensure()).ok).toBe(true);
    expect((await readdir(join(dataDir, "runtimes"))).sort()).toEqual([
      `python-${manifest.sha256.slice(0, 16)}`,
      "speech",
    ]);
  });
});
