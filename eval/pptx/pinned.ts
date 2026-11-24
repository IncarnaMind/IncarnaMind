import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A file pinned by URL and SHA-256, from the cache or fetched into it; a changed file stops the run. */
export async function fetchPinned(
  url: string,
  expected: string,
  cache: string,
): Promise<Uint8Array> {
  const file = join(cache, `${expected}.pptx`);
  if (existsSync(file)) {
    const kept = new Uint8Array(readFileSync(file));
    if (sha256(kept) === expected) return kept;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`${url} has changed: SHA-256 ${got}, pinned ${expected}.`);
  await writeFile(file, bytes);
  return bytes;
}
