/**
 * The archive `run_code`'s Python comes in (ADR-0025): a tar of files, folders
 * and symbolic links, compressed with zstd, with `node:zlib` alone. Paths past
 * ustar's 100 characters, and link targets, go in pax records. The build
 * (scripts/pythonNative.ts) writes it in a fixed order with fixed owners, so
 * the same files make the same bytes; the app unpacks it only after its
 * SHA-256 matched the one built into the app, and still refuses an entry that
 * would land outside the folder it unpacks into.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, symlink, utimes } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";

export type TarEntry =
  | { kind: "file"; path: string; mode: number; mtime: number; size: number }
  | { kind: "directory"; path: string; mode: number; mtime: number }
  | { kind: "symlink"; path: string; mode: number; mtime: number; target: string };

const BLOCK = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, entry: TarEntry, type: string, size: number, link = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(entry.mode & 0o7777, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(Math.max(0, Math.floor(entry.mtime)), 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write(link, 157, 100, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7), 148, "ascii");
  block.write(" ", 155, "ascii");
  return block;
}

function padding(size: number): Buffer {
  const left = size % BLOCK;
  return Buffer.alloc(left === 0 ? 0 : BLOCK - left);
}

// A pax record's length counts its own digits.
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length++;
  return `${length}${body}`;
}

const fits = (text: string) => Buffer.byteLength(text) <= 100 && /^[\x20-\x7e]*$/.test(text);

/** An entry's header blocks: a pax header first when its path or target doesn't fit ustar's fields. */
export function entryHeader(entry: TarEntry): Buffer {
  const name = entry.kind === "directory" ? `${entry.path}/` : entry.path;
  const target = entry.kind === "symlink" ? entry.target : "";
  const records = [
    ...(fits(name) ? [] : [paxRecord("path", name)]),
    ...(fits(target) ? [] : [paxRecord("linkpath", target)]),
  ].join("");
  const type = entry.kind === "file" ? "0" : entry.kind === "directory" ? "5" : "2";
  const size = entry.kind === "file" ? entry.size : 0;
  const own = header(
    fits(name) ? name : "././@PaxHeader",
    entry,
    type,
    size,
    fits(target) ? target : "",
  );
  if (!records) return own;
  const pax = encoder.encode(records);
  return Buffer.concat([
    header("././@PaxHeader", { ...entry, mode: 0o644 }, "x", pax.byteLength),
    Buffer.from(pax),
    padding(pax.byteLength),
    own,
  ]);
}

/**
 * Writes `entries` as a zstd-compressed tar at `target`, in the order given;
 * each file's bytes come from `read`. Two blocks of zeros end it, as tar does.
 */
export async function writeTarZst(
  target: string,
  entries: readonly TarEntry[],
  read: (entry: Extract<TarEntry, { kind: "file" }>) => Readable,
  level = 19,
): Promise<void> {
  async function* blocks(): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      yield entryHeader(entry);
      if (entry.kind !== "file") continue;
      let written = 0;
      for await (const chunk of read(entry)) {
        written += (chunk as Buffer).byteLength;
        yield chunk as Buffer;
      }
      if (written !== entry.size) {
        throw new Error(
          `${entry.path} changed while it was archived: ${written} of ${entry.size} bytes.`,
        );
      }
      yield padding(entry.size);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  await pipeline(
    Readable.from(blocks()),
    createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } }),
    createWriteStream(target),
  );
}

const field = (block: Buffer, from: number, length: number) => {
  const raw = block.subarray(from, from + length);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
};

const number = (block: Buffer, from: number, length: number) => {
  const text = field(block, from, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
};

function paxFields(data: Buffer): Map<string, string> {
  const found = new Map<string, string>();
  let at = 0;
  while (at < data.byteLength) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(decoder.decode(data.subarray(at, space)));
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) found.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return found;
}

export class TarError extends Error {
  override name = "TarError";
}

/** A path the archive gives, checked: relative, "/" between parts, with no part that climbs out. */
function safePath(given: string): string {
  const path = given.replace(/\/+$/, "");
  const parts = path.split("/");
  if (
    path === "" ||
    isAbsolute(path) ||
    path.includes("\\") ||
    parts.some((part) => part === ".." || part === "" || part === ".")
  ) {
    throw new TarError(`The archive has an entry with an unsafe path: ${given}`);
  }
  return path;
}

/** Whether a link at `path` pointing to `target` stays inside the folder the archive unpacks into. */
function staysInside(path: string, target: string): boolean {
  if (isAbsolute(target) || target.includes("\\")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== ".." && !resolved.startsWith("../") && !posix.isAbsolute(resolved);
}

export interface UnpackLimits {
  /** Bytes of all files together. */
  maxBytes: number;
  /** Entries of every kind. */
  maxEntries: number;
}

/**
 * Unpacks the zstd-compressed tar at `archive` into `folder`, which must be
 * empty or new: files with their modes and times (Python's compiled files
 * check their sources' times), folders and symbolic links. Refuses, before
 * writing it, an entry that would land outside `folder` or under one of its
 * links, a link that points outside it, and any other kind of entry.
 */
export async function unpackTarZst(
  archive: string,
  folder: string,
  limits: UnpackLimits,
): Promise<{ entries: number; bytes: number }> {
  const links = new Set<string>();
  const times: { path: string; mtime: number }[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let pax = new Map<string, string>();
  let file: {
    path: string;
    left: number;
    pad: number;
    out: Writable;
    mtime: number;
    mode: number;
  } | null = null;
  let skip = 0;
  let entries = 0;
  let bytes = 0;
  let ended = false;

  const underLink = (path: string) => {
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
      if (links.has(path.slice(0, at))) return true;
    }
    return false;
  };
  const place = (given: string) => {
    const path = safePath(given);
    if (underLink(path) || links.has(path)) {
      throw new TarError(`The archive has an entry inside one of its own links: ${given}`);
    }
    return { path, target: join(folder, ...path.split("/")) };
  };
  const closeFile = async () => {
    if (!file) return;
    const done = file;
    file = null;
    skip = done.pad;
    await new Promise<void>((resolve, reject) =>
      done.out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    await chmod(done.path, done.mode);
    times.push({ path: done.path, mtime: done.mtime });
  };

  const entry = async (block: Buffer, size: number, stored: number) => {
    entries++;
    if (entries > limits.maxEntries)
      throw new TarError("The archive has more entries than allowed.");
    const type = field(block, 156, 1) || "0";
    const prefix = field(block, 345, 155);
    const name =
      pax.get("path") ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    const linkTarget = pax.get("linkpath") ?? field(block, 157, 100);
    pax = new Map();
    const mode = number(block, 100, 8) & 0o777;
    const mtime = number(block, 136, 12);
    const { path, target } = place(name);
    if (type === "5") {
      await mkdir(target, { recursive: true, mode: 0o755 });
      times.push({ path: target, mtime });
    } else if (type === "2") {
      if (!staysInside(path, linkTarget)) {
        throw new TarError(
          `The archive has a link that points outside it: ${name} → ${linkTarget}`,
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await symlink(linkTarget, target);
      links.add(path);
    } else if (type === "0") {
      bytes += size;
      if (bytes > limits.maxBytes) throw new TarError("The archive holds more than allowed.");
      await mkdir(dirname(target), { recursive: true });
      file = {
        path: target,
        left: size,
        pad: stored - size,
        out: createWriteStream(target, { flags: "wx", mode: 0o600 }),
        mtime,
        mode,
      };
      if (size === 0) await closeFile();
    } else {
      throw new TarError(`The archive has an entry of a kind it can't hold (${type}): ${name}`);
    }
  };

  const take = async (chunk: Buffer) => {
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (!ended) {
      if (file) {
        const part = pending.subarray(0, Math.min(file.left, pending.byteLength));
        if (part.byteLength === 0) return;
        pending = pending.subarray(part.byteLength);
        file.left -= part.byteLength;
        const out = file.out;
        if (!out.write(part)) await new Promise((resolve) => out.once("drain", resolve));
        if (file.left === 0) await closeFile();
        continue;
      }
      if (skip > 0) {
        const part = Math.min(skip, pending.byteLength);
        if (part === 0) return;
        pending = pending.subarray(part);
        skip -= part;
        continue;
      }
      if (pending.byteLength < BLOCK) return;
      const block = pending.subarray(0, BLOCK);
      if (block.every((byte) => byte === 0)) {
        ended = true;
        return;
      }
      const size = number(block, 124, 12);
      const stored = Math.ceil(size / BLOCK) * BLOCK;
      if (field(block, 156, 1) === "x") {
        if (pending.byteLength < BLOCK + stored) return;
        pax = paxFields(pending.subarray(BLOCK, BLOCK + size));
        pending = pending.subarray(BLOCK + stored);
        continue;
      }
      pending = pending.subarray(BLOCK);
      await entry(block, size, stored);
    }
  };

  await pipeline(
    createReadStream(archive),
    createZstdDecompress(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        take(chunk).then(() => callback(), callback);
      },
    }),
  );
  if (!ended || file) throw new TarError("The archive ended before its last entry.");
  // Deepest first, so a folder's time is set after everything written into it.
  for (const each of times.reverse()) await utimes(each.path, each.mtime, each.mtime);
  return { entries, bytes };
}
