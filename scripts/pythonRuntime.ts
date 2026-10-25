/**
 * Puts the files Analyses run with (ADR-0023) in resources/python, which
 * electron-builder ships beside app.asar: Pyodide's own files, unmodified,
 * from the pyodide package, and the wheels of numpy, pandas and what they
 * depend on, from Pyodide's CDN, each checked against the SHA-256 its lock
 * file records. Files already there and matching are kept; anything else in
 * the folder goes. The build runs it (electron.vite.config.ts), so the app
 * never fetches a package itself.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** What Analyses import; the wheels they depend on come with them. */
export const PYTHON_PACKAGES = ["numpy", "pandas"] as const;

/** Pyodide's files, as its package has them. */
export const PYODIDE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
] as const;

interface LockedPackage {
  file_name: string;
  sha256: string;
  version: string;
  depends: string[];
}

interface Lock {
  info: { python: string };
  packages: Record<string, LockedPackage>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function hashOf(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

async function download(url: string): Promise<Uint8Array> {
  let failure: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(
    `Couldn't download ${url}: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
}

/** The packages Analyses import and every one they depend on, by name, in order. */
export function packagesFor(lock: Lock): (LockedPackage & { name: string })[] {
  const wanted = new Map<string, LockedPackage>();
  const add = (name: string) => {
    if (wanted.has(name)) return;
    const found = lock.packages[name];
    if (!found) throw new Error(`Pyodide's lock file has no package ${name}.`);
    wanted.set(name, found);
    for (const dependency of found.depends) add(dependency);
  };
  for (const name of PYTHON_PACKAGES) add(name);
  return [...wanted]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, found]) => ({ ...found, name }));
}

/** Fills `folder` (resources/python) for this checkout's Pyodide; says what it had to fetch. */
export async function preparePythonRuntime(folder: string): Promise<{ fetched: string[] }> {
  const require = createRequire(import.meta.url);
  const pyodide = dirname(require.resolve("pyodide/package.json"));
  const { version } = JSON.parse(await readFile(join(pyodide, "package.json"), "utf8")) as {
    version: string;
  };
  const lock = JSON.parse(await readFile(join(pyodide, "pyodide-lock.json"), "utf8")) as Lock;
  await mkdir(folder, { recursive: true });
  const fetched: string[] = [];
  const kept = new Set<string>(["packages.json"]);

  for (const name of PYODIDE_FILES) {
    kept.add(name);
    const bytes = await readFile(join(pyodide, name));
    if ((await hashOf(join(folder, name))) !== sha256(bytes)) {
      await writeFile(join(folder, name), bytes);
    }
  }

  const packages = packagesFor(lock).map((each) => ({
    name: each.name,
    version: each.version,
    file: each.file_name,
    expected: each.sha256,
  }));
  for (const { file, expected } of packages) {
    kept.add(file);
    if ((await hashOf(join(folder, file))) === expected) continue;
    const bytes = await download(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${file}`);
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new Error(`${file} has SHA-256 ${actual}, but Pyodide's lock file says ${expected}.`);
    }
    await writeFile(join(folder, file), bytes);
    fetched.push(file);
  }

  for (const name of await readdir(folder)) {
    if (!kept.has(name)) await rm(join(folder, name), { recursive: true, force: true });
  }
  const listed = `${JSON.stringify(
    {
      pyodide: version,
      python: lock.info.python,
      packages: packages.map(({ name, version: packageVersion, file }) => ({
        name,
        version: packageVersion,
        file,
      })),
    },
    null,
    2,
  )}\n`;
  const listing = join(folder, "packages.json");
  if ((await readFile(listing, "utf8").catch(() => null)) !== listed) {
    await writeFile(listing, listed);
  }
  return { fetched };
}
