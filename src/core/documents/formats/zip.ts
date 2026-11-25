/**
 * Office packages (.docx, .pptx, .xlsx) as ZIP archives, read and written by
 * one module, so a package can be written with the entries it doesn't change
 * copied from another as they are, compressed bytes and all (#77).
 *
 * Reading: the central directory, and stored or deflated entries. No
 * encryption, no multi-disk, no ZIP64. It inflates with
 * `DecompressionStream("deflate-raw")`, so it runs in the processing worker
 * and in the renderer alike, with no dependency. Ported from the
 * office-formats spike (ADR-0011).
 *
 * Untrusted input: a file over 500 MB isn't opened at all, an entry is
 * inflated against a size limit, and a package stops being read once its
 * parts have inflated past 1 GB together, so a ZIP bomb fails instead of
 * filling memory; large parts (a sheet) can be read as a stream of text and
 * dropped part-way.
 *
 * Password-protected Office files and the legacy binary formats (.doc, .xls,
 * .ppt) aren't ZIP files but OLE compound files: `openPackage` tells which,
 * so processing can say "needs a password" rather than "not a ZIP file".
 *
 * Writing (`writeZip`): new entries deflated, copied ones as they were, no
 * ZIP64 (an export is far below 4 GB), and a fixed timestamp, so the same
 * content always gives the same bytes. The module has no Node imports, so
 * the caller passes the deflate: the core's is Node's zlib.
 */
import type { DocumentKind } from "../../api";
import { ExtractionError } from "./errors";

/** An entry as the central directory lists it. */
interface DirectoryEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** An entry as a package stores it: what `writeZip` needs to copy it unchanged. */
export interface RawEntry {
  /** 0 (stored) or 8 (deflated). */
  method: number;
  /** Of its content. */
  crc32: number;
  /** Its content's size. */
  size: number;
  /** Its bytes as stored: compressed, if it is deflated. */
  data: Uint8Array;
}

const MB = 1024 * 1024;

/** The most entries a package may have. */
const MAX_ENTRIES = 20_000;
/** The largest a part read whole may inflate to: an XML part parsed into a tree. */
export const MAX_PART_BYTES = 64 * MB;
/** The largest Office file opened: a larger one is refused before it is read (#77; see `packageSizeError`). */
export const MAX_PACKAGE_BYTES = 500 * MB;
/** The most all the parts read from a package may inflate to, together (#77). */
export const MAX_INFLATED_BYTES = 1024 * MB;

/** Why a file over one of the limits isn't opened, with the limit. */
const tooLargeToOpen = (limit: string) =>
  new ExtractionError("too-large", `Too large to open (limit ${limit}).`);

/**
 * Why an Office file of `size` bytes isn't opened at all, or null if it can
 * be: processing asks before it reads a file, and `openPackage` before it
 * reads a package.
 */
export function packageSizeError(size: number): ExtractionError | null {
  return size > MAX_PACKAGE_BYTES ? tooLargeToOpen("500 MB") : null;
}

export const isPackageKind = (kind: DocumentKind) =>
  kind === "docx" || kind === "pptx" || kind === "xlsx";

const EOCD = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** The signature of an OLE compound file. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** "EncryptedPackage" in UTF-16LE: the stream an encrypted Office file keeps its package in. */
const ENCRYPTED_PACKAGE = (() => {
  const name = "EncryptedPackage";
  const bytes = new Uint8Array(name.length * 2);
  for (let index = 0; index < name.length; index++) bytes[index * 2] = name.charCodeAt(index);
  return bytes;
})();

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** Whether the bytes are an OLE compound file: a legacy binary Office file, or an encrypted one. */
export const isCompoundFile = (bytes: Uint8Array): boolean => startsWith(bytes, CFB_SIGNATURE);

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0] as number;
  for (let at = bytes.indexOf(first); at >= 0 && at <= bytes.length - needle.length; ) {
    let index = 1;
    while (index < needle.length && bytes[at + index] === needle[index]) index++;
    if (index === needle.length) return true;
    at = bytes.indexOf(first, at + 1);
  }
  return false;
}

export class ZipArchive {
  private readonly entries = new Map<string, DirectoryEntry>();
  /**
   * False when two entries share a name, or a name that isn't ASCII isn't marked UTF-8: it reads,
   * but written back, a part would be lost or renamed.
   */
  rewritable = true;
  private readonly view: DataView;
  /** How much the parts read so far have inflated to, together. */
  private inflated = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.readCentralDirectory();
  }

  private readCentralDirectory(): void {
    const { view, bytes } = this;
    // The end record is in the last 22 + 65,535 (its comment) bytes.
    let eocd = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
      if (view.getUint32(at, true) === EOCD) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw new ExtractionError("unreadable", "Not a ZIP package: no end record.");
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_EOCD_LOCATOR) {
      throw new ExtractionError("unreadable", "ZIP64 packages aren't supported.");
    }
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count > MAX_ENTRIES) {
      throw new ExtractionError("unreadable", `The package has too many parts (${count}).`);
    }
    const decoder = new TextDecoder();
    for (let index = 0; index < count; index++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL) {
        throw new ExtractionError("unreadable", "The package's directory is corrupt.");
      }
      const nameLength = view.getUint16(offset + 28, true);
      const raw = bytes.subarray(offset + 46, offset + 46 + nameLength);
      const name = decoder.decode(raw);
      const utf8 = (view.getUint16(offset + 8, true) & 0x0800) !== 0;
      if (this.entries.has(name) || (!utf8 && raw.some((byte) => byte >= 0x80))) {
        this.rewritable = false;
      }
      this.entries.set(name, {
        name,
        method: view.getUint16(offset + 10, true),
        crc32: view.getUint32(offset + 16, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localHeaderOffset: view.getUint32(offset + 42, true),
      });
      offset +=
        46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The names of the parts, in the directory's order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * An entry as it is stored, to copy into another package with `writeZip`;
   * undefined if there's no such entry.
   */
  raw(name: string): RawEntry | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const { view, bytes } = this;
    const at = entry.localHeaderOffset;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL) {
      throw new ExtractionError("unreadable", `A part of the package is corrupt: ${name}`);
    }
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    if (start + entry.compressedSize > bytes.length) {
      throw new ExtractionError("unreadable", `A part of the package is cut short: ${name}`);
    }
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      throw new ExtractionError("unreadable", `Unsupported compression in ${name}.`);
    }
    return {
      method: entry.method,
      crc32: entry.crc32,
      size: entry.size,
      data: bytes.subarray(start, start + entry.compressedSize),
    };
  }

  /**
   * Counts bytes inflated (or read stored) towards the package's limit,
   * `MAX_INFLATED_BYTES`: past it, reading stops.
   */
  private spend(bytes: number): void {
    this.inflated += bytes;
    if (this.inflated > MAX_INFLATED_BYTES) throw tooLargeToOpen("1 GB");
  }

  /** An entry's bytes, inflated, up to `limit` bytes; undefined if there's no such entry. */
  async read(name: string, limit = MAX_PART_BYTES): Promise<Uint8Array | undefined> {
    const raw = this.raw(name);
    if (!raw) return undefined;
    if (raw.method === STORED) {
      if (raw.data.length > limit) throw tooLarge(name);
      this.spend(raw.data.length);
      return raw.data;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of inflate(raw.data)) {
      total += chunk.length;
      if (total > limit) throw tooLarge(name);
      this.spend(chunk.length);
      chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async readText(name: string, limit = MAX_PART_BYTES): Promise<string | undefined> {
    const data = await this.read(name, limit);
    return data && new TextDecoder().decode(data);
  }

  /**
   * An entry's text, a chunk at a time, as it inflates, up to `limit` bytes:
   * for parts too large to hold whole. Stopping early (a `break`) stops inflating.
   */
  async *textChunks(name: string, limit: number): AsyncGenerator<string> {
    const raw = this.raw(name);
    if (!raw) return;
    const decoder = new TextDecoder();
    if (raw.method === STORED) {
      if (raw.data.length > limit) throw tooLarge(name);
      this.spend(raw.data.length);
      yield decoder.decode(raw.data);
      return;
    }
    let total = 0;
    for await (const chunk of inflate(raw.data)) {
      total += chunk.length;
      if (total > limit) throw tooLarge(name);
      this.spend(chunk.length);
      yield decoder.decode(chunk, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  }
}

/**
 * A part that inflates past what may be read of it. A Document with one fails
 * as unreadable, as before; a Word import says it is too large (#104).
 */
export class PartTooLargeError extends ExtractionError {
  override name = "PartTooLargeError";
}

const tooLarge = (name: string) =>
  new PartTooLargeError("unreadable", `A part of the package is too large to read: ${name}`);

async function* inflate(data: Uint8Array): AsyncGenerator<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throw new ExtractionError(
          "unreadable",
          `A part of the package couldn't be inflated: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Opens an Office package. A file over `MAX_PACKAGE_BYTES` is refused before
 * anything in it is read. An OLE compound file instead of a ZIP is either
 * encrypted (it holds an "EncryptedPackage" stream: the file needs a
 * password) or a legacy binary file renamed; both are refused with a reason.
 */
export function openPackage(bytes: Uint8Array): ZipArchive {
  const refused = packageSizeError(bytes.byteLength);
  if (refused) throw refused;
  if (startsWith(bytes, CFB_SIGNATURE)) {
    if (contains(bytes, ENCRYPTED_PACKAGE)) {
      throw new ExtractionError("password-protected", "The file is encrypted with a password.");
    }
    throw new ExtractionError(
      "unreadable",
      "The file is an older binary Office file (97–2003), not an Office Open XML package.",
    );
  }
  return new ZipArchive(bytes);
}

/** Resolves a relationship target against the part that owns it: ("ppt/slides/slide1.xml", "../media/a.png"). */
export function resolvePart(owner: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = owner.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// Writing

/** An entry to write: new content, which is deflated, or one of another package, copied as it is. */
export type ZipWriteEntry =
  | {
      /** The path inside the archive, with "/" separators. */
      name: string;
      /** Text is stored as UTF-8. */
      data: string | Uint8Array;
    }
  | {
      name: string;
      /** As `ZipArchive.raw` gives it. */
      raw: RawEntry;
    };

/** Raw DEFLATE at the default level, as Node's `zlib.deflateRawSync` does it. */
export type Deflate = (data: Uint8Array) => Uint8Array;

/** 1980-01-01 00:00, the earliest MS-DOS date ZIP can hold. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** Version 2.0: deflate. */
const VERSION = 20;
/** File names are UTF-8. */
const UTF8_NAMES = 1 << 11;

/**
 * A ZIP archive of the entries, in their order: each new one deflated with
 * `deflate`, each copied one with its bytes as they were.
 */
export function writeZip(entries: readonly ZipWriteEntry[], deflate: Deflate): Uint8Array {
  if (entries.length > 0xffff) throw new Error("Too many entries for a ZIP without ZIP64.");
  const encoder = new TextEncoder();
  const records = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    if ("raw" in entry) return { name, ...entry.raw };
    const content = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    return {
      name,
      method: DEFLATED,
      crc32: crc32(content),
      size: content.length,
      data: deflate(content),
    };
  });

  let length = 22;
  for (const { name, data } of records) length += 30 + name.length + data.length + 46 + name.length;
  if (length > 0xffffffff) throw new Error("Too large for a ZIP without ZIP64.");
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  // From the version needed to the name's length, a local header and a central record agree.
  const common = (at: number, record: (typeof records)[number]) => {
    view.setUint16(at, VERSION, true);
    view.setUint16(at + 2, UTF8_NAMES, true);
    view.setUint16(at + 4, record.method, true);
    view.setUint16(at + 6, DOS_TIME, true);
    view.setUint16(at + 8, DOS_DATE, true);
    view.setUint32(at + 10, record.crc32, true);
    view.setUint32(at + 14, record.data.length, true);
    view.setUint32(at + 18, record.size, true);
    view.setUint16(at + 22, record.name.length, true);
    // The extra field's length: none.
  };

  let at = 0;
  const offsets: number[] = [];
  for (const record of records) {
    offsets.push(at);
    view.setUint32(at, LOCAL, true);
    common(at + 4, record);
    out.set(record.name, at + 30);
    out.set(record.data, at + 30 + record.name.length);
    at += 30 + record.name.length + record.data.length;
  }
  const directory = at;
  records.forEach((record, index) => {
    view.setUint32(at, CENTRAL, true);
    // Made by: version 2.0, MS-DOS.
    view.setUint16(at + 4, VERSION, true);
    common(at + 6, record);
    // Extra field, comment, disk number, internal and external attributes: none.
    view.setUint32(at + 42, offsets[index] as number, true);
    out.set(record.name, at + 46);
    at += 46 + record.name.length;
  });
  view.setUint32(at, EOCD, true);
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

/** The CRC-32 table (polynomial 0xEDB88320), one entry per byte value. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[byte] = value;
  }
  return table;
})();

/** ZIP's checksum of an entry's content. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  // By index: an iterator over a large picture is several times slower.
  for (let index = 0; index < data.length; index++) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
