import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalCache } from "../lib/cache";
import type { CaseDefinition, CaseFolder, Reference, Track } from "./types";

export const meetingsCache = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  join(evalCache(env), "meetings");

export const casesFile = join(dirname(fileURLToPath(import.meta.url)), "cases.json");
export const sourcesFile = join(dirname(fileURLToPath(import.meta.url)), "sources.json");

const VERIFIED = "verified.json";
const TRACK_FILES: Record<string, Track> = {
  "mic.wav": "mic",
  "system.wav": "system",
  "room.wav": "room",
  "conversation.wav": "conversation",
};

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function readCases(): Promise<CaseDefinition[]> {
  return (JSON.parse(await readFile(casesFile, "utf8")) as { cases: CaseDefinition[] }).cases;
}

/** Writes `bytes` to `path` only whole: a file that is there was finished. */
export async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
}

export const caseFolderOf = (id: string, cache = meetingsCache()) => join(cache, "cases", id);

export async function hashesOf(folder: string, names: readonly string[]) {
  const out: Record<string, string> = {};
  for (const name of [...names].sort()) out[name] = sha256(await readFile(join(folder, name)));
  return out;
}

/** Records the hashes the case's files were checked against, with their sizes. */
export async function markVerified(folder: string, hashes: Readonly<Record<string, string>>) {
  const sizes: Record<string, number> = {};
  for (const name of Object.keys(hashes).sort())
    sizes[name] = (await stat(join(folder, name))).size;
  await writeAtomic(join(folder, VERIFIED), JSON.stringify({ sizes, hashes }));
}

export async function isVerified(folder: string, definition: CaseDefinition): Promise<boolean> {
  try {
    const { sizes, hashes } = JSON.parse(await readFile(join(folder, VERIFIED), "utf8")) as {
      sizes: Record<string, number>;
      hashes: Record<string, string>;
    };
    const names = Object.keys(definition.files).sort();
    if (JSON.stringify(Object.keys(hashes).sort()) !== JSON.stringify(names)) return false;
    for (const name of names) {
      if (hashes[name] !== definition.files[name]) return false;
      if ((await stat(join(folder, name))).size !== sizes[name]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeCase(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true });
}

/** A case as fetch left it; fails if it isn't there or isn't the one cases.json pins, so that a run never scores a half-built or outdated one. */
export async function loadCase(
  definition: CaseDefinition,
  cache = meetingsCache(),
): Promise<CaseFolder> {
  const folder = caseFolderOf(definition.id, cache);
  if (!(await isVerified(folder, definition))) {
    throw new Error(
      `${definition.id} isn't in ${folder}, or isn't the case cases.json pins. Run: npm run eval:meetings:fetch`,
    );
  }
  const tracks: CaseFolder["tracks"] = {};
  for (const name of Object.keys(definition.files)) {
    const track = TRACK_FILES[name];
    if (track) tracks[track] = join(folder, name);
  }
  const reference = JSON.parse(await readFile(join(folder, "reference.json"), "utf8")) as Reference;
  return { definition, folder, tracks, reference };
}
