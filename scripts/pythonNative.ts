/**
 * Builds the Python `run_code` runs (ADR-0025, #2351) on the platform it runs on, as each
 * platform's release runner does: python-build-standalone's CPython, unmodified but for Linux's
 * `_dbm`, with the wheels scripts/pythonNative/lock.txt pins, chosen for the oldest system the app
 * runs on and installed offline, their sources compiled, and the licence texts of all of it in
 * LICENSES/. Writes <out>/python-runtime-<platform>.tar.zst, and resources/python-native/runtime.json
 * with its URL, size and SHA-256, which the app is built with so that it takes only this file. The
 * same lock, pins and script make the same bytes.
 *
 * Usage: npm run python:native -- --out <folder> --url <base URL> [--cache <folder>]
 * Needs the uv that scripts/pythonNative/pins.ts names on PATH. Downloads are kept in the cache
 * folder (by default under the out folder) and checked against their pinned SHA-256 on every use.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createZstdDecompress } from "node:zlib";
import { type TarEntry, writeTarZst } from "../src/core/runCode/tar";
import { type NativePlatform, PINS } from "./pythonNative/pins";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const LOCK = join(REPOSITORY, "scripts", "pythonNative", "lock.txt");
const RESOURCE = join(REPOSITORY, "resources", "python-native", "runtime.json");
const PBS_RELEASES = "https://github.com/astral-sh/python-build-standalone/releases/download";

const [MAJOR, MINOR] = PINS.python.split(".");
const STDLIB = `python/lib/python${MAJOR}.${MINOR}`;
const SITE_PACKAGES = `${STDLIB}/site-packages`;

/** The time every file the build adds carries: the day python-build-standalone's release is dated. */
const ADDED_MTIME =
  Date.UTC(
    Number(PINS.pythonBuildStandalone.slice(0, 4)),
    Number(PINS.pythonBuildStandalone.slice(4, 6)) - 1,
    Number(PINS.pythonBuildStandalone.slice(6, 8)),
  ) / 1000;

/**
 * python-build-standalone's files left out. On Linux `_dbm` links Berkeley DB, whose Sleepycat
 * licence asks that the source of software using it be offered; `dbm` falls back to SQLite.
 */
const LEFT_OUT: Record<NativePlatform, { files: RegExp | null; licences: string[] }> = {
  "darwin-arm64": { files: null, licences: [] },
  "linux-x64": {
    files: new RegExp(`^${STDLIB.replaceAll(".", "\\.")}/lib-dynload/_dbm[^/]*\\.so$`),
    licences: ["LICENSE.bdb.txt"],
  },
};

/**
 * The copyleft libraries a wheel may bundle, each a library of its own that its package links to
 * as it runs, and the distributions allowed to bundle each. The project owner decides on these:
 * one bundled by a distribution not listed here fails the build.
 */
const COPYLEFT_ALLOWED: Record<string, { licence: string; in: readonly string[] }> = {
  libgfortran: {
    licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    in: ["numpy", "scipy", "scikit-learn"],
  },
  libgcc_s: {
    licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    in: ["numpy", "scipy", "scikit-learn"],
  },
  libgomp: {
    licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    in: ["numpy", "scipy", "scikit-learn"],
  },
  libquadmath: { licence: "LGPL-2.1-or-later", in: ["numpy", "scipy", "scikit-learn"] },
};

/** What a licence text calls a bundled library whose file is named otherwise. */
const LICENCE_NAMES: Record<string, string> = {
  libbrotlicommon: "brotli",
  libbrotlidec: "brotli",
  libgcc_s: "libgcc",
  libopenjp2: "openjpeg",
  libsharpyuv: "libwebp",
  libwebpdemux: "libwebp",
  libwebpmux: "libwebp",
  libz: "zlib",
};

const IMPORT_CHECK =
  "import numpy, pandas, scipy.stats, statsmodels.api, sklearn.linear_model, matplotlib.pyplot, PIL.Image, openpyxl";

// A child's behaviour must come from its arguments alone: UV_COMPILE_BYTECODE, say, would compile
// with another invalidation mode, and PIP_INDEX_URL would fetch from elsewhere.
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(UV_|PIP_|PYTHON)/.test(name)),
);

type Kind = TarEntry["kind"];
interface Found {
  path: string;
  kind: Kind;
  mode: number;
  mtime: number;
  size: number;
  target: string;
}
interface Original {
  kind: Kind;
  mode: number;
  mtime: number;
  /** A file's SHA-256, a link's target. */
  content: string;
}
interface Distribution {
  name: string;
  version: string;
  /** The dist-info folder, from the archive's root. */
  folder: string;
  /** Every file its RECORD lists, from the archive's root. */
  files: string[];
  /** Whether python-build-standalone installed it (pip). */
  original: boolean;
}
interface Extension {
  shared_lib?: string;
  license_paths?: string[];
}
interface PythonJson {
  license_path: string;
  python_implementation_cache_tag: string;
  build_info: { extensions: Record<string, Extension[]> };
}

const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fileHash(path: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

/** Runs a command with CHILD_ENV and `env`; resolves with its output, or rejects with it. */
async function run(
  command: string,
  args: readonly string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const child = spawn(command, args, {
    env: { ...CHILD_ENV, ...options.env },
    stdio: "pipe",
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stdin.end(options.input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`${basename(command)} ${args.slice(0, 4).join(" ")} … failed:\n${output}`);
  }
  return output;
}

/** The pinned file, from the cache when it has it with the pinned SHA-256, else downloaded into it. */
async function fetchPinned(cache: string, pinned: { file: string; sha256: string }) {
  const path = join(cache, pinned.file);
  const had = await fileHash(path);
  if (had === pinned.sha256) return path;
  if (had) console.log(`${pinned.file} in the cache has SHA-256 ${had}; downloading it again.`);
  await mkdir(cache, { recursive: true });
  const url = `${PBS_RELEASES}/${PINS.pythonBuildStandalone}/${encodeURIComponent(pinned.file)}`;
  const partial = `${path}.partial`;
  let failure: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        tap,
        createWriteStream(partial),
      );
      const got = hash.digest("hex");
      if (got !== pinned.sha256) {
        await rm(partial, { force: true });
        throw new Error(
          `${pinned.file} has SHA-256 ${got}, but scripts/pythonNative/pins.ts says ${pinned.sha256}.`,
        );
      }
      await rename(partial, path);
      return path;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(
    `Couldn't download ${url}: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
}

/** Unpacks python-build-standalone's archives: the prefix, and the full archive's licence texts. */
async function unpackPbs(
  runtimeArchive: string,
  licenceArchive: string,
  stage: string,
  full: string,
) {
  await mkdir(stage, { recursive: true });
  await mkdir(full, { recursive: true });
  // -p keeps the modes the archive gives; extraction keeps its times.
  await run("tar", ["-xpzf", runtimeArchive, "-C", stage]);
  const tar = spawn("tar", ["-x", "-f", "-", "-C", full, "python/licenses", "python/PYTHON.json"], {
    env: CHILD_ENV,
    stdio: ["pipe", "ignore", "inherit"],
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    tar.once("error", reject);
    tar.once("close", resolve);
  });
  await pipeline(createReadStream(licenceArchive), createZstdDecompress(), tar.stdin);
  if ((await closed) !== 0) throw new Error(`tar couldn't read ${basename(licenceArchive)}.`);
}

/** Everything under `root`, as paths from it with "/" between parts, a folder before what it holds. */
async function walk(root: string, from = ""): Promise<Found[]> {
  const found: Found[] = [];
  for (const entry of await readdir(join(root, from), { withFileTypes: true })) {
    const path = from ? `${from}/${entry.name}` : entry.name;
    const full = join(root, path);
    const info = await lstat(full);
    const kind: Kind = info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
        ? "directory"
        : "file";
    if (kind === "file" && !info.isFile())
      throw new Error(`${path} is neither a file, folder nor link.`);
    found.push({
      path,
      kind,
      mode: info.mode & 0o7777,
      mtime: Math.floor(info.mtimeMs / 1000),
      size: kind === "file" ? info.size : 0,
      target: kind === "symlink" ? await readlink(full) : "",
    });
    if (kind === "directory") found.push(...(await walk(root, path)));
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The standard library's own modules, without its tests and the GUI tools no analysis runs. */
function standardSources(originals: Map<string, Original>, cacheTag: string): string[] {
  return [...originals.keys()].filter(
    (path) =>
      path.startsWith(`${STDLIB}/`) &&
      !path.startsWith(`${SITE_PACKAGES}/`) &&
      path.endsWith(".py") &&
      !/\/(?:test|tests|idlelib|turtledemo|tkinter)\//.test(path) &&
      !originals.has(compiledOf(path, cacheTag)),
  );
}

const compiledOf = (path: string, cacheTag: string) =>
  `${posix.dirname(path)}/__pycache__/${posix.basename(path, ".py")}.${cacheTag}.pyc`;

async function originalsOf(stage: string): Promise<Map<string, Original>> {
  const originals = new Map<string, Original>();
  for (const each of await walk(stage)) {
    if (each.kind === "directory") continue;
    originals.set(each.path, {
      kind: each.kind,
      mode: each.mode,
      mtime: each.mtime,
      content:
        each.kind === "symlink" ? each.target : ((await fileHash(join(stage, each.path))) ?? ""),
    });
  }
  return originals;
}

/** The wheel platform tags that run on `oldest`: pip takes older macOS tags itself, not older manylinux ones. */
function wheelPlatforms(oldest: string): string[] {
  const linux = /^manylinux_2_(\d+)_(\w+)$/.exec(oldest);
  if (!linux) return [oldest];
  const [, glibc, arch] = linux;
  const tags: string[] = [];
  for (let minor = Number(glibc); minor >= 5; minor--) tags.push(`manylinux_2_${minor}_${arch}`);
  return [...tags, `manylinux2014_${arch}`, `manylinux2010_${arch}`, `manylinux1_${arch}`];
}

/** Each package lock.txt pins, by its normalized name, with its version and its wheels' hashes. */
function lockedPackages(lock: string): Map<string, { version: string; hashes: Set<string> }> {
  const locked = new Map<string, { version: string; hashes: Set<string> }>();
  let current: { version: string; hashes: Set<string> } | null = null;
  for (const line of lock.split("\n")) {
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)/.exec(line);
    if (pin) {
      current = { version: pin[2] ?? "", hashes: new Set() };
      locked.set(normalize(pin[1] ?? ""), current);
      continue;
    }
    for (const [, hash] of line.matchAll(/--hash=sha256:([0-9a-f]{64})/g)) {
      if (hash) current?.hashes.add(hash);
    }
  }
  return locked;
}

/** Fails unless the wheelhouse holds exactly one wheel, of a hash the lock gives, for each pin. */
async function checkWheelhouse(wheelhouse: string, lock: string) {
  const locked = lockedPackages(lock);
  const found = new Map<string, string>();
  const problems: string[] = [];
  for (const file of (await readdir(wheelhouse)).sort()) {
    const [name = "", version = ""] = file.split("-");
    const pin = locked.get(normalize(name));
    const hash = await fileHash(join(wheelhouse, file));
    const earlier = found.get(normalize(name));
    if (
      !file.endsWith(".whl") ||
      !pin ||
      pin.version !== version ||
      !hash ||
      !pin.hashes.has(hash)
    ) {
      problems.push(`${file} isn't a wheel lock.txt pins`);
    } else if (earlier) {
      problems.push(`two wheels of ${name}: ${earlier} and ${file}`);
    } else {
      found.set(normalize(name), file);
    }
  }
  for (const name of locked.keys()) {
    if (!found.has(name)) problems.push(`no wheel of ${name} for this platform`);
  }
  if (problems.length > 0) {
    throw new Error(`pip's wheels don't match lock.txt:\n- ${problems.join("\n- ")}`);
  }
}

/** A RECORD line's path field, as written: the last two fields, a hash and a size, hold no comma. */
const pathField = (line: string) => line.slice(0, line.lastIndexOf(",", line.lastIndexOf(",") - 1));

function recordPath(line: string): string {
  const field = pathField(line);
  return field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field;
}

/** A path RECORD gives (from site-packages), from the archive's root. */
const fromRoot = (path: string) => posix.normalize(posix.join(SITE_PACKAGES, path));

async function distributionsOf(stage: string, originals: Map<string, Original>) {
  const distributions: Distribution[] = [];
  for (const name of (await readdir(join(stage, SITE_PACKAGES))).sort()) {
    if (!name.endsWith(".dist-info")) continue;
    const folder = `${SITE_PACKAGES}/${name}`;
    const metadata = await readFile(join(stage, folder, "METADATA"), "utf8");
    const header = metadata.split(/\r?\n\r?\n/)[0] ?? "";
    const field = (key: string) => new RegExp(`^${key}: *(.+?)\\s*$`, "m").exec(header)?.[1] ?? "";
    const record = await readFile(join(stage, folder, "RECORD"), "utf8");
    distributions.push({
      name: normalize(field("Name")),
      version: field("Version"),
      folder,
      files: record
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => fromRoot(recordPath(line))),
      original: originals.has(`${folder}/RECORD`),
    });
  }
  return distributions;
}

/**
 * Makes what uv wrote the same wherever it ran: each dist-info's uv_cache.json (uv's own note,
 * with the time it installed) goes, and the scripts uv wrote into bin/, which run the interpreter
 * by the build folder's absolute path, run the one beside them. RECORD follows both.
 */
async function normalizeInstall(stage: string, distributions: Distribution[]) {
  const interpreter = join(stage, "python", "bin", "python3");
  // uv starts a script with the interpreter's path, or through sh when the path is longer than a
  // shebang may be. Not realpath, which macOS has only since 13.
  const starts = [`#!${interpreter}\n`, `#!/bin/sh\n'''exec' '${interpreter}' "$0" "$@"\n' '''\n`];
  const beside = `#!/bin/sh\n'''exec' "$(dirname -- "$0")/python3" "$0" "$@"\n' '''\n`;
  for (const distribution of distributions.filter((each) => !each.original)) {
    const recordFile = join(stage, distribution.folder, "RECORD");
    const kept: string[] = [];
    for (const line of (await readFile(recordFile, "utf8")).split("\n")) {
      const path = line.trim() ? fromRoot(recordPath(line)) : "";
      if (path === `${distribution.folder}/uv_cache.json`) {
        await rm(join(stage, path));
        continue;
      }
      if (path.startsWith("python/bin/")) {
        const script = await readFile(join(stage, path), "utf8");
        const start = starts.find((each) => script.startsWith(each));
        if (start) {
          const rewritten = Buffer.from(beside + script.slice(start.length));
          await writeFile(join(stage, path), rewritten);
          const digest = createHash("sha256").update(rewritten).digest("base64url");
          kept.push(`${pathField(line)},sha256=${digest},${rewritten.byteLength}`);
          continue;
        }
      }
      kept.push(line);
    }
    await writeFile(recordFile, kept.join("\n"));
    distribution.files = distribution.files.filter(
      (path) => path !== `${distribution.folder}/uv_cache.json`,
    );
  }
}

/**
 * Fails unless python-build-standalone's files are as its archive gave them, and every other file
 * is one an installed package's RECORD lists, or the compiled form of one, and doesn't hold the
 * build folder's path, which would make the bytes depend on where the build ran.
 */
async function checkTree(
  stage: string,
  originals: Map<string, Original>,
  distributions: Distribution[],
  cacheTag: string,
) {
  const expected = new Set<string>(
    standardSources(originals, cacheTag).map((path) => compiledOf(path, cacheTag)),
  );
  for (const distribution of distributions.filter((each) => !each.original)) {
    for (const path of distribution.files) {
      expected.add(path);
      if (path.endsWith(".py")) expected.add(compiledOf(path, cacheTag));
    }
  }
  const buildPaths = [...new Set([stage, await realpath(stage)])].map((path) => Buffer.from(path));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const each of await walk(stage)) {
    if (each.kind === "directory") continue;
    seen.add(each.path);
    const original = originals.get(each.path);
    if (original) {
      const content =
        each.kind === "symlink" ? each.target : await fileHash(join(stage, each.path));
      if (original.kind !== each.kind || original.content !== content) {
        problems.push(`${each.path} is python-build-standalone's, and changed`);
      }
      continue;
    }
    if (!expected.has(each.path)) {
      problems.push(`${each.path} isn't from any installed package`);
      continue;
    }
    if (each.kind === "file") {
      const bytes = await readFile(join(stage, each.path));
      if (buildPaths.some((path) => bytes.includes(path))) {
        problems.push(`${each.path} holds the build folder's path`);
      }
    }
  }
  for (const path of originals.keys()) {
    if (!seen.has(path)) problems.push(`${path} is python-build-standalone's, and went`);
  }
  if (problems.length > 0) {
    throw new Error(`The runtime isn't as built:\n- ${problems.join("\n- ")}`);
  }
}

const LICENCE_FILE = /(^|[._-])(licen[cs]es?|copying|notice)([._-]|$)/i;
const CODE_FILE = /\.(py|pyi|pyc|pyx|pxd|so|dylib|h|c)$/i;

/**
 * Where each licence text goes in LICENSES/, and where it comes from: python-build-standalone's
 * texts and CPython's in python/, each installed distribution's in a folder named after it: its
 * dist-info's licence files, and the notices its package carries for the code it bundles.
 */
async function gatherLicences(
  stage: string,
  full: string,
  distributions: Distribution[],
  leftOut: readonly string[],
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const problems: string[] = [];
  const add = async (target: string, source: string) => {
    const earlier = sources.get(target);
    if (earlier === undefined) sources.set(target, source);
    else if ((await fileHash(earlier)) !== (await fileHash(source))) {
      problems.push(`${target} would be both ${earlier} and ${source}`);
    }
  };
  for (const name of (await readdir(join(full, "python", "licenses"))).sort()) {
    if (!leftOut.includes(name))
      await add(`LICENSES/python/${name}`, join(full, "python", "licenses", name));
  }
  await add("LICENSES/python/LICENSE.txt", join(stage, STDLIB, "LICENSE.txt"));
  for (const distribution of distributions) {
    for (const path of distribution.files) {
      const name = posix.basename(path);
      let inside: string | null = null;
      if (path.startsWith(`${distribution.folder}/licenses/`)) {
        inside = path.slice(`${distribution.folder}/licenses/`.length);
      } else if (posix.dirname(path) === distribution.folder) {
        if (/^(licen[cs]e|copying|notice|authors)/i.test(name)) inside = name;
      } else if (
        path.startsWith(`${SITE_PACKAGES}/`) &&
        LICENCE_FILE.test(name) &&
        !CODE_FILE.test(name)
      ) {
        inside = path.slice(`${SITE_PACKAGES}/`.length);
      }
      if (inside !== null) {
        await add(`LICENSES/${distribution.name}/${inside}`, join(stage, path));
      }
    }
  }
  if (problems.length > 0) throw new Error(`Licence texts collide:\n- ${problems.join("\n- ")}`);
  return sources;
}

/** A bundled library's name: its file's name up to its version, without auditwheel's hashes. */
function libraryName(file: string): string {
  const stem = file.split(".")[0] ?? file;
  return stem.replace(/(-[0-9a-f]{8})+$/, "");
}

/**
 * The names a licence text may call a bundled library by: libscipy_openblas64_ is "libscipy_openblas",
 * libpng16 "libpng", libfreetype "FreeType"; LICENCE_NAMES gives the rest.
 */
function calledBy(name: string): string[] {
  const called = LICENCE_NAMES[name] ?? name;
  const forms = [called, called.replace(/[\d_]+$/, "")];
  const withoutLib = forms.filter((form) => /^lib.{3}/.test(form)).map((form) => form.slice(3));
  return [...new Set([...forms, ...withoutLib])];
}

/** Whether `text`, in lower case, has `name` as a word of its own. */
const hasWord = (text: string, name: string) =>
  new RegExp(
    `(^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`,
  ).test(text);

/**
 * Each shared library the runtime holds, with the licence texts that name it; fails the build
 * listing those none names, and copyleft libraries COPYLEFT_ALLOWED doesn't allow where they are.
 * A wheel's bundled library (in `<package>.libs/` or `<package>/.dylibs/`) must be named in its
 * distribution's own texts; a module of CPython's in lib-dynload must have each text
 * python-build-standalone's PYTHON.json gives it.
 */
async function checkLibraries(
  stage: string,
  distributions: Distribution[],
  licences: Map<string, string>,
  pythonJson: PythonJson,
): Promise<Map<string, string[]>> {
  const owners = new Map<string, Distribution>();
  for (const distribution of distributions) {
    for (const path of distribution.files) owners.set(path, distribution);
  }
  const textsOf = new Map<string, { path: string; text: string }[]>();
  for (const [target, source] of licences) {
    const owner = target.split("/")[1] ?? "";
    const text = (await readFile(source, "latin1")).toLowerCase();
    textsOf.set(owner, [...(textsOf.get(owner) ?? []), { path: target, text }]);
  }
  const modules = new Map<string, Extension>();
  for (const variants of Object.values(pythonJson.build_info.extensions)) {
    for (const variant of variants) {
      if (variant.shared_lib) modules.set(posix.basename(variant.shared_lib), variant);
    }
  }
  const named = new Map<string, string[]>();
  const problems: string[] = [];
  for (const each of await walk(stage)) {
    const file = posix.basename(each.path);
    const folder = posix.basename(posix.dirname(each.path));
    if (each.kind !== "file" || !/\.(so(\.\d+)*|dylib)$/.test(file)) continue;
    if (folder === "lib-dynload") {
      const module = modules.get(file);
      const wanted = (module?.license_paths ?? [pythonJson.license_path]).map(
        (path) => `LICENSES/python/${posix.basename(path)}`,
      );
      const missing = wanted.filter((path) => !licences.has(path));
      if (!module || missing.length > 0)
        problems.push(`${each.path} has no licence text that names it`);
      else named.set(each.path, wanted);
      continue;
    }
    if (folder !== ".dylibs" && !folder.endsWith(".libs")) continue;
    const owner = owners.get(each.path);
    const name = libraryName(file);
    const texts = (owner ? textsOf.get(owner.name) : undefined) ?? [];
    const naming = texts
      .filter(({ text }) => calledBy(name).some((call) => hasWord(text, call)))
      .map(({ path }) => path);
    if (naming.length === 0) problems.push(`${each.path} has no licence text that names it`);
    else named.set(each.path, naming);
    const copyleft = COPYLEFT_ALLOWED[name];
    if (copyleft && !copyleft.in.includes(owner?.name ?? "")) {
      problems.push(
        `${each.path} is ${name} (${copyleft.licence}), which COPYLEFT_ALLOWED doesn't allow in ${owner?.name ?? "a file no package lists"}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Shared libraries without their licence:\n- ${problems.join("\n- ")}`);
  }
  return named;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      url: { type: "string" },
      cache: { type: "string" },
    },
  });
  const platform = `${process.platform}-${process.arch}`;
  if (!(platform in PINS.platforms)) {
    const system = process.platform === "win32" ? "Windows" : platform;
    console.log(`There is no run_code Python for ${system} yet, so no runtime.json is written.`);
    return;
  }
  const pins = PINS.platforms[platform as NativePlatform];
  const leftOut = LEFT_OUT[platform as NativePlatform];
  const { out: outGiven, url } = values;
  if (!outGiven || !url) {
    throw new Error(
      "Usage: npm run python:native -- --out <folder> --url <base URL> [--cache <folder>]",
    );
  }
  if (!/^https?:\/\/[^/]+\/(.*\/)?$/.test(url)) {
    throw new Error(
      `--url must be an http(s) URL that ends in "/", to put the file's name after: ${url}`,
    );
  }
  const started = performance.now();
  const out = resolve(outGiven);
  const cache = values.cache ? resolve(values.cache) : join(out, "python-native-cache");
  const work = join(out, "python-native-build");
  const stage = join(work, "runtime");
  const full = join(work, "full");
  const wheelhouse = join(work, "wheelhouse");

  const uvVersion = await run("uv", ["--version"]).catch((error: unknown) => {
    throw new Error(
      `This build installs with uv ${PINS.uv} (scripts/pythonNative/pins.ts), which isn't on PATH: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!uvVersion.startsWith(`uv ${PINS.uv} `) && uvVersion.trim() !== `uv ${PINS.uv}`) {
    throw new Error(
      `This build installs with uv ${PINS.uv} (scripts/pythonNative/pins.ts), but PATH has ${uvVersion.trim()}.`,
    );
  }
  const lock = await readFile(LOCK);

  await rm(work, { recursive: true, force: true });
  await mkdir(wheelhouse, { recursive: true });
  const runtimeArchive = await fetchPinned(join(cache, "python-build-standalone"), pins.runtime);
  const licenceArchive = await fetchPinned(join(cache, "python-build-standalone"), pins.licences);
  await unpackPbs(runtimeArchive, licenceArchive, stage, full);
  if (leftOut.files) {
    for (const each of await walk(stage)) {
      if (leftOut.files.test(each.path)) await rm(join(stage, each.path));
    }
  }
  const originals = await originalsOf(stage);
  const pythonJson = JSON.parse(
    await readFile(join(full, "python", "PYTHON.json"), "utf8"),
  ) as PythonJson;
  console.log(
    `python-build-standalone ${PINS.pythonBuildStandalone} unpacked (${seconds(started)})`,
  );

  const python = join(stage, "python", "bin", "python3");
  // -B: python-build-standalone's own files must stay as they are, so nothing compiles into them.
  await run(python, [
    "-I",
    "-B",
    "-m",
    "pip",
    "--isolated",
    "--disable-pip-version-check",
    "--no-input",
    "download",
    "--quiet",
    "--require-hashes",
    "--only-binary=:all:",
    "--no-deps",
    ...wheelPlatforms(pins.wheels).flatMap((tag) => ["--platform", tag]),
    "--implementation",
    "cp",
    "--python-version",
    `${MAJOR}.${MINOR}`,
    "--abi",
    `cp${MAJOR}${MINOR}`,
    "--index-url",
    "https://pypi.org/simple",
    "--cache-dir",
    join(cache, "pip"),
    "--dest",
    wheelhouse,
    "--requirement",
    LOCK,
  ]);
  await checkWheelhouse(wheelhouse, lock.toString("utf8"));
  console.log(`Wheels for ${pins.wheels} fetched and checked (${seconds(started)})`);

  await run("uv", [
    "pip",
    "install",
    "--no-config",
    "--offline",
    "--no-index",
    "--no-cache",
    "--find-links",
    wheelhouse,
    "--require-hashes",
    "--link-mode",
    "copy",
    "--strict",
    "--quiet",
    "--python",
    python,
    "--requirement",
    LOCK,
  ]);
  const distributions = await distributionsOf(stage, originals);
  await normalizeInstall(stage, distributions);
  const sources = distributions
    .filter((each) => !each.original)
    .flatMap((each) => each.files)
    .filter((path) => path.startsWith(`${SITE_PACKAGES}/`) && path.endsWith(".py"))
    .map((path) => join(stage, path));
  // The stripped archives have no compiled standard library, and the runtime folder can't be
  // written when code runs: without these caches, every run compiles each standard module it
  // imports again (0.4–0.7 s a run, measured). The modules themselves stay as the archive has them.
  const standard = standardSources(originals, pythonJson.python_implementation_cache_tag);
  sources.push(...standard.map((path) => join(stage, path)));
  // unchecked-hash: the runtime folder can't be written when code runs, and its files' times are
  // the archive's. -s keeps the build folder's path out of the compiled files.
  await run(
    python,
    [
      "-I",
      "-B",
      "-m",
      "compileall",
      "-q",
      "--invalidation-mode",
      "unchecked-hash",
      "-s",
      stage,
      "-j",
      "0",
      "-i",
      "-",
    ],
    { input: sources.join("\n") },
  );
  console.log(`Installed and compiled ${sources.length} sources (${seconds(started)})`);

  await run(python, ["-I", "-B", "-c", IMPORT_CHECK], {
    env: { MPLBACKEND: "Agg", MPLCONFIGDIR: join(work, "matplotlib") },
  });
  await checkTree(stage, originals, distributions, pythonJson.python_implementation_cache_tag);

  const licences = await gatherLicences(stage, full, distributions, leftOut.licences);
  const named = await checkLibraries(stage, distributions, licences, pythonJson);
  for (const [target, source] of licences) {
    await mkdir(dirname(join(stage, target)), { recursive: true });
    await copyFile(source, join(stage, target));
  }
  const packages = Object.fromEntries(
    distributions
      .map(({ name, version }) => [name, version] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  await writeFile(
    join(stage, "runtime.json"),
    json({
      python: PINS.python,
      pythonBuildStandalone: PINS.pythonBuildStandalone,
      platform,
      packages,
      lock: sha256(lock),
    }),
  );

  const entries: TarEntry[] = (await walk(stage)).map((each) => {
    const original = originals.get(each.path);
    const mtime = original?.mtime ?? ADDED_MTIME;
    if (each.kind === "directory")
      return { kind: "directory", path: each.path, mode: 0o755, mtime };
    if (each.kind === "symlink") {
      return {
        kind: "symlink",
        path: each.path,
        mode: original?.mode ?? 0o777,
        mtime,
        target: each.target,
      };
    }
    const mode = original?.mode ?? (each.mode & 0o111 ? 0o755 : 0o644);
    return { kind: "file", path: each.path, mode, mtime, size: each.size };
  });
  const file = `python-runtime-${platform}.tar.zst`;
  const archive = join(out, file);
  await rm(archive, { force: true });
  await writeTarZst(`${archive}.partial`, entries, (entry) =>
    createReadStream(join(stage, ...entry.path.split("/"))),
  );
  await rename(`${archive}.partial`, archive);
  const size = (await stat(archive)).size;
  const hash = await fileHash(archive);
  await mkdir(dirname(RESOURCE), { recursive: true });
  await writeFile(
    RESOURCE,
    json({
      file,
      url: `${url}${file}`,
      size,
      sha256: hash,
      platform,
      python: PINS.python,
      packages,
    }),
  );
  await rm(work, { recursive: true, force: true });

  for (const [library, texts] of named) console.log(`${library}: ${texts.join(", ")}`);
  const bytes = entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0);
  console.log(
    `${archive}: ${(size / 1e6).toFixed(1)} MB (${(bytes / 1e6).toFixed(1)} MB in ${entries.length} entries), SHA-256 ${hash} (${seconds(started)})`,
  );
  console.log(`${relative(REPOSITORY, RESOURCE).split(sep).join("/")} written.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
