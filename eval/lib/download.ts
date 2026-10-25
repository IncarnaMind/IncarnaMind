import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Fetch = typeof fetch;

export interface Pinned {
  url: string;
  sha256: string;
  bytes: number;
}

const RETRIES = 3;

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function isPinned(path: string, pinned: Pick<Pinned, "sha256" | "bytes">) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === pinned.bytes && (await sha256Of(path)) === pinned.sha256;
  } catch {
    return false;
  }
}

async function open(fetchFn: Fetch, url: string): Promise<Response> {
  let failure = "";
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetchFn(url, { redirect: "follow" });
      if (response.ok && response.body) return response;
      failure = `${response.status} ${response.statusText}`.trim();
      if (response.status >= 400 && response.status < 500) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  throw new Error(`Couldn't fetch ${url}: ${failure}`);
}

/**
 * Downloads `pinned.url` to `path` unless a file with the pinned size and SHA-256 is already
 * there. A download that doesn't match is not kept: nothing unchecked is ever left at `path`.
 */
export async function download(fetchFn: Fetch, pinned: Pinned, path: string): Promise<boolean> {
  if (await isPinned(path, pinned)) return false;
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const response = await open(fetchFn, pinned.url);
  const hash = createHash("sha256");
  let bytes = 0;
  const counting = async function* (body: AsyncIterable<Uint8Array>) {
    for await (const chunk of body) {
      hash.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
  };
  try {
    await pipeline(
      Readable.from(counting(response.body as unknown as AsyncIterable<Uint8Array>)),
      createWriteStream(partial),
    );
    const sha256 = hash.digest("hex");
    if (bytes !== pinned.bytes || sha256 !== pinned.sha256) {
      throw new Error(
        `${pinned.url} doesn't match its pinned SHA-256 (${bytes} bytes, ${sha256}), so it was not kept.`,
      );
    }
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return true;
}
