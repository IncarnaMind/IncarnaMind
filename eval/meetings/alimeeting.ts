/**
 * AliMeeting (CC BY-SA 4.0), the Eval set: real Mandarin meetings of two to four people, each
 * recorded by an eight-channel array in the room and by every participant's own headset, with
 * the speech of each speaker written down in a TextGrid.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";
import { type Fetch, isPinned } from "../lib/download";
import { tarEntries } from "../lib/tar";
import { encodeWav, wavHeader } from "../lib/wav";
import { sha256 } from "./cache";
import type { Reference } from "./types";

export interface GridTier {
  /** "N_SPK8001": the headset of speaker 8001. */
  name: string;
  intervals: { start: number; end: number; text: string }[];
}

const INTERVAL = /xmin = (\S+)\s+xmax = (\S+)\s+text = "((?:[^"]|"")*)"/g;

export function parseTextGrid(grid: string): GridTier[] {
  return grid
    .split(/\n\s*item \[\d+\]:/)
    .slice(1)
    .map((tier) => ({
      name: /name = "([^"]*)"/.exec(tier)?.[1] ?? "",
      intervals: [...tier.matchAll(INTERVAL)]
        .map((match) => ({
          start: Number(match[1]),
          end: Number(match[2]),
          text: (match[3] as string).replaceAll('""', '"').trim(),
        }))
        .filter((interval) => interval.text !== ""),
    }));
}

export const speakerOf = (tier: GridTier) => tier.name.replace(/^N_/, "");

export function alimeetingReference(
  tiers: readonly GridTier[],
  track: "room" | ((speaker: string) => "mic" | "system"),
): Reference {
  const segments = tiers.flatMap((tier) =>
    tier.intervals.map((interval) => ({
      ...interval,
      speaker: speakerOf(tier),
      track: typeof track === "string" ? track : track(speakerOf(tier)),
    })),
  );
  segments.sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
  return { format: 1, segments };
}

/** What one archive entry becomes in the cache. */
export interface ArchiveEntry {
  name: string;
  /** The cache file the entry is kept as, in the archive's folder. */
  file: string;
  /** `first-channel` keeps the first channel of a multi-channel WAV as mono 16-bit. */
  keep: "as-is" | "first-channel";
  /** The entry as the archive holds it, and the file kept: absent only while pinning them. */
  sha256?: string;
  bytes?: number;
  keptSha256?: string;
  keptBytes?: number;
}

const HEADER_BYTES = 4096;

async function firstChannel(
  content: AsyncIterable<Uint8Array>,
  hash: ReturnType<typeof createHash>,
): Promise<Int16Array> {
  const head: Buffer[] = [];
  let headLength = 0;
  let stride = 0;
  let out = new Int16Array(0);
  let frames = 0;
  let carry: Buffer = Buffer.alloc(0);
  const feed = (bytes: Buffer) => {
    const all = carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
    const whole = Math.floor(all.length / stride);
    for (let i = 0; i < whole && frames < out.length; i++) {
      out[frames++] = all.readInt16LE(i * stride);
    }
    carry = all.subarray(whole * stride);
  };
  const begin = () => {
    const bytes = Buffer.concat(head);
    const header = wavHeader(bytes, "the array recording");
    if (header.bits !== 16 || header.float || header.rate !== MEETING_SAMPLE_RATE) {
      throw new Error("The array recording isn't 16-bit 16 kHz audio.");
    }
    stride = header.channels * 2;
    out = new Int16Array(Math.floor(header.dataBytes / stride));
    feed(bytes.subarray(header.dataOffset));
  };
  for await (const chunk of content) {
    hash.update(chunk);
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (stride > 0) {
      feed(bytes);
      continue;
    }
    head.push(bytes);
    headLength += bytes.length;
    if (headLength >= HEADER_BYTES) begin();
  }
  if (stride === 0) begin();
  return out.subarray(0, frames);
}

/**
 * Reads the archive from its start, keeping the wanted entries in `folder`, and stops once the
 * last of them is out: later entries are not downloaded. An entry that doesn't match its pinned
 * SHA-256 is not kept, and fails the run.
 */
export async function extractEntries(
  fetchFn: Fetch,
  url: string,
  wanted: readonly ArchiveEntry[],
  folder: string,
  log: (message: string) => void,
): Promise<ArchiveEntry[]> {
  const measured = new Map<string, ArchiveEntry>();
  const missing = new Map<string, ArchiveEntry>();
  for (const entry of wanted) {
    const kept = entry.keptSha256 !== undefined && entry.keptBytes !== undefined;
    if (
      kept &&
      (await isPinned(join(folder, entry.file), {
        sha256: entry.keptSha256 as string,
        bytes: entry.keptBytes as number,
      }))
    ) {
      measured.set(entry.name, entry);
    } else missing.set(entry.name, entry);
  }
  if (missing.size === 0) return wanted.map((entry) => measured.get(entry.name) as ArchiveEntry);
  log(`Reading ${url} until it has ${missing.size} more files (the array recordings come first).`);
  const abort = new AbortController();
  const response = await fetchFn(url, { signal: abort.signal, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const archive = Readable.fromWeb(response.body as never).pipe(createGunzip());
  try {
    for await (const tarEntry of tarEntries(archive)) {
      const entry = tarEntry.isFile ? missing.get(tarEntry.name) : undefined;
      if (!entry) continue;
      const hash = createHash("sha256");
      let kept: Uint8Array;
      let bytes = 0;
      if (entry.keep === "first-channel") {
        kept = encodeWav(await firstChannel(tarEntry.content, hash));
        bytes = tarEntry.size;
      } else {
        const parts: Uint8Array[] = [];
        for await (const part of tarEntry.content) {
          hash.update(part);
          parts.push(part);
        }
        kept = Buffer.concat(parts);
        bytes = kept.length;
      }
      const result = {
        ...entry,
        sha256: hash.digest("hex"),
        bytes,
        keptSha256: sha256(kept),
        keptBytes: kept.length,
      };
      const pinned = entry.sha256 !== undefined;
      if (pinned && (result.sha256 !== entry.sha256 || result.bytes !== entry.bytes)) {
        throw new Error(`${entry.name} doesn't match its pinned SHA-256, so it was not kept.`);
      }
      if (
        pinned &&
        (result.keptSha256 !== entry.keptSha256 || result.keptBytes !== entry.keptBytes)
      ) {
        throw new Error(
          `${entry.file} isn't what the pinned conversion makes, so it was not kept.`,
        );
      }
      const path = join(folder, entry.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.partial`, kept);
      await rename(`${path}.partial`, path);
      missing.delete(entry.name);
      measured.set(entry.name, result);
      log(`Kept ${entry.file}`);
      if (missing.size === 0) break;
    }
  } finally {
    abort.abort();
    archive.destroy();
  }
  if (missing.size > 0) {
    throw new Error(`${url} lacks ${[...missing.keys()].join(", ")}`);
  }
  return wanted.map((entry) => measured.get(entry.name) as ArchiveEntry);
}

export async function readGrid(path: string): Promise<GridTier[]> {
  return parseTextGrid(await readFile(path, "utf8"));
}
