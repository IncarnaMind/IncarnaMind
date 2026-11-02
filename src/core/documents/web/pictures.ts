/**
 * A saved web page's pictures (#756): the article's own, fetched once with
 * the page, from this computer, anonymously (no cookies, no Referer), within
 * the caps below. What a picture is comes from its bytes, never from what
 * the server says; anything else is left out.
 */
import { isHeifPicture } from "../formats/images";
import { WebPageError } from "./errors";
import { type PageFetch, type PageResponse, USER_AGENT } from "./fetch";

export interface PictureLimits {
  /** Smaller on either side is an icon or a pixel. */
  minSide: number;
  /** More pixels than this, as its header says, would take too much memory to draw or read. */
  maxPixels: number;
  maxBytes: number;
  maxTotalBytes: number;
  maxCount: number;
  /** For all of a page's pictures together. */
  timeoutMs: number;
  /** Fetched at once. */
  concurrency: number;
}

export const PICTURE_LIMITS: PictureLimits = {
  minSide: 64,
  maxPixels: 50_000_000,
  maxBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxCount: 60,
  timeoutMs: 20_000,
  concurrency: 4,
};

export interface PictureType {
  mediaType: string;
  extension: string;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** What a picture is, by its first bytes: PNG, JPEG, GIF, WebP or AVIF; null for anything else. */
export function pictureType(bytes: Uint8Array): PictureType | null {
  if (startsWith(bytes, PNG)) return { mediaType: "image/png", extension: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mediaType: "image/jpeg", extension: "jpg" };
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return { mediaType: "image/gif", extension: "gif" };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { mediaType: "image/webp", extension: "webp" };
  }
  if (ascii(bytes, 4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(bytes, 8, 4))) {
    return { mediaType: "image/avif", extension: "avif" };
  }
  return null;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const data = view(bytes);
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Start of frame: baseline, progressive and the rest, not DHT (C4), JPG (C8) or DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.getUint16(at + 5), width: data.getUint16(at + 7) };
    }
    at += 2 + data.getUint16(at + 2);
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const data = view(bytes);
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    const width = 1 + (data.getUint32(24, true) & 0xffffff);
    const height = 1 + (data.getUint32(27, true) & 0xffffff);
    return { width, height };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = data.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/**
 * AVIF: the largest of its `ispe` boxes, the spatial extents of each image
 * in it, so a small first one can't hide a large one the decoder draws.
 */
function avifSize(bytes: Uint8Array): { width: number; height: number } | null {
  const data = view(bytes);
  let largest: { width: number; height: number } | null = null;
  for (let at = 4; at < bytes.length - 16; at++) {
    if (bytes[at] !== 0x69 || ascii(bytes, at, 4) !== "ispe") continue;
    const width = data.getUint32(at + 8);
    const height = data.getUint32(at + 12);
    if (!largest || width * height > largest.width * largest.height) largest = { width, height };
  }
  return largest;
}

/**
 * GIF: its screen, or its first frame where that reaches further, as the
 * decoder draws the frame whole.
 */
function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 13) return null;
  const data = view(bytes);
  let width = data.getUint16(6, true);
  let height = data.getUint16(8, true);
  const packed = bytes[10] ?? 0;
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x2c) {
      if (at + 9 > bytes.length) return null;
      width = Math.max(width, data.getUint16(at + 1, true) + data.getUint16(at + 5, true));
      height = Math.max(height, data.getUint16(at + 3, true) + data.getUint16(at + 7, true));
      return { width, height };
    }
    if (block !== 0x21) return { width, height };
    at += 2;
    while (at < bytes.length && bytes[at] !== 0) at += (bytes[at] ?? 0) + 1;
    at += 1;
  }
  return { width, height };
}

/** Why a picture is refused before it is drawn or read (#762). */
export interface PictureProblem {
  kind: "too-large" | "size-unreadable" | "unreadable";
  /** The technical sentence a failure and the log keep. */
  message: string;
}

/**
 * Why a picture must not be drawn or read (#762): its header's size is over
 * the memory cap, its size can't be read, or its bytes are not a picture kind
 * IncarnaMind reads. Null when it is fine. A HEIF's size is checked after it
 * is decoded, so it passes here; any other bytes a decoder would take are
 * refused, so a picture named .png that is really another format can't reach
 * the decoder at all.
 */
export function pictureProblem(bytes: Uint8Array): PictureProblem | null {
  const type = pictureType(bytes);
  if (!type) {
    return isHeifPicture(bytes)
      ? null
      : {
          kind: "unreadable",
          message: "This isn’t a picture IncarnaMind reads (PNG, JPEG, GIF, WebP, AVIF or HEIC).",
        };
  }
  const size = pictureSize(bytes, type);
  if (!size) return { kind: "size-unreadable", message: "The picture’s size couldn’t be read." };
  return size.width * size.height > PICTURE_LIMITS.maxPixels
    ? {
        kind: "too-large",
        message: `The picture is too large to open (${size.width} × ${size.height} pixels).`,
      }
    : null;
}

/** A picture's size in pixels, from its header; null when it can't be read. */
export function pictureSize(
  bytes: Uint8Array,
  type: PictureType,
): { width: number; height: number } | null {
  const data = view(bytes);
  try {
    switch (type.extension) {
      case "png":
        return bytes.length >= 24
          ? { width: data.getUint32(16), height: data.getUint32(20) }
          : null;
      case "gif":
        return gifSize(bytes);
      case "jpg":
        return jpegSize(bytes);
      case "webp":
        return webpSize(bytes);
      case "avif":
        return avifSize(bytes);
      default:
        return null;
    }
  } catch {
    // A header shorter than it says: not a picture to keep.
    return null;
  }
}

/** A picture the article shows, to fetch: its address, in the order the page shows them. */
export interface PictureCandidate {
  /** Its index among the page's candidates, from 0, as the snapshot marks it. */
  index: number;
  address: string;
}

export interface FetchedPicture {
  index: number;
  address: string;
  bytes: Uint8Array;
  type: PictureType;
  width: number;
  height: number;
}

export interface FetchedPictures {
  kept: FetchedPicture[];
  /** Over the caps: too many, too large, or past the page's total. */
  leftOut: number;
}

type Fetched =
  | { kind: "kept"; picture: FetchedPicture }
  | { kind: "too-large" }
  | { kind: "not-kept" };

async function readCapped(response: PageResponse, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

const isWebAddress = (address: string) => /^https?:$/i.test(URL.parse(address)?.protocol ?? "");

async function fetchOne(
  candidate: PictureCandidate,
  fetch: PageFetch,
  limits: PictureLimits,
  signal: AbortSignal,
  reportError: (error: unknown) => void,
): Promise<Fetched> {
  if (!isWebAddress(candidate.address)) return { kind: "not-kept" };
  let response: PageResponse;
  try {
    response = await fetch(candidate.address, {
      redirect: "follow",
      credentials: "omit",
      signal,
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
        "User-Agent": USER_AGENT,
      },
    });
  } catch (error) {
    // Refused by the fetcher's guard, unreachable or out of time: the picture is only its description.
    if (!(error instanceof WebPageError) && !signal.aborted) reportError(error);
    return { kind: "not-kept" };
  }
  try {
    if (!response.ok || !isWebAddress(response.url || candidate.address)) {
      await response.body?.cancel();
      return { kind: "not-kept" };
    }
    if (Number(response.headers.get("content-length")) > limits.maxBytes) {
      await response.body?.cancel();
      return { kind: "too-large" };
    }
    const bytes = await readCapped(response, limits.maxBytes);
    if (!bytes) return { kind: "too-large" };
    const type = pictureType(bytes);
    const size = type && pictureSize(bytes, type);
    if (!type || !size || size.width < limits.minSide || size.height < limits.minSide) {
      return { kind: "not-kept" };
    }
    // A small file can declare a huge picture: one that would fill the memory once drawn.
    if (size.width * size.height > limits.maxPixels) return { kind: "too-large" };
    return {
      kind: "kept",
      picture: { index: candidate.index, address: candidate.address, bytes, type, ...size },
    };
  } catch (error) {
    if (!signal.aborted) reportError(error);
    return { kind: "not-kept" };
  }
}

/**
 * Fetches a page's pictures, in its order, a few at a time, within the time
 * limit for them all. The first ones within the caps are kept; those over
 * them are counted as left out. One that can't be fetched, or isn't a
 * picture, or is an icon, is simply not kept: the page shows its description.
 */
export async function fetchPictures(
  candidates: readonly PictureCandidate[],
  fetch: PageFetch,
  {
    limits = PICTURE_LIMITS,
    reportError = () => undefined,
  }: { limits?: PictureLimits; reportError?: (error: unknown) => void } = {},
): Promise<FetchedPictures> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const kept: FetchedPicture[] = [];
  let leftOut = 0;
  let total = 0;
  let next = 0;
  while (next < candidates.length) {
    if (kept.length >= limits.maxCount) {
      leftOut += candidates.length - next;
      break;
    }
    const batch = candidates.slice(next, next + limits.concurrency);
    next += batch.length;
    const results = await Promise.all(
      batch.map((candidate) => fetchOne(candidate, fetch, limits, signal, reportError)),
    );
    for (const result of results) {
      if (result.kind === "too-large") leftOut++;
      if (result.kind !== "kept") continue;
      const { picture } = result;
      if (
        kept.length >= limits.maxCount ||
        total + picture.bytes.byteLength > limits.maxTotalBytes
      ) {
        leftOut++;
        continue;
      }
      kept.push(picture);
      total += picture.bytes.byteLength;
    }
  }
  return { kept, leftOut };
}
