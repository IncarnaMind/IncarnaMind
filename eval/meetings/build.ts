/**
 * Turns the pinned sources into cases (eval/meetings/README.md): fetches what is missing,
 * checks it against sources.json, and writes each case's tracks and reference into the cache.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";
import { download, type Fetch, type Pinned } from "../lib/download";
import { encodeWav, monoSamples, toPcm16 } from "../lib/wav";
import {
  type ArchiveEntry,
  alimeetingReference,
  extractEntries,
  parseTextGrid,
  speakerOf,
} from "./alimeeting";
import {
  amiReference,
  amiUtterances,
  headsetTracks,
  ofMeeting,
  roomRecording,
  talkTimes,
} from "./ami";
import { ascendSession, conversationTrack } from "./ascend";
import { caseFolderOf, hashesOf, isVerified, markVerified, readCases, sourcesFile } from "./cache";
import { gateTurns, onlineTracks } from "./tracks";
import type { CaseDefinition, Reference } from "./types";

export interface SourceFile extends Pinned {
  /** For a Parquet file of recordings: the row each meeting is in. */
  rows?: Record<string, number>;
}

export interface Sources {
  format: 1;
  /** Files fetched whole, by the name cases refer to them with. */
  files: Record<string, SourceFile>;
  /** The one archive that is read from its start and not kept. */
  alimeeting: { url: string; entries: (ArchiveEntry & { session: string })[] };
}

export interface Context {
  cache: string;
  fetchFn: Fetch;
  log: (message: string) => void;
  sources: Sources;
  /** The cases to work on: cases.json's, unless a test gives its own. */
  cases?: CaseDefinition[];
}

/** How far outside a speaker's annotated turns a headset track is kept. */
export const GATE_MARGIN_SECONDS = 0.25;

export async function loadSources(): Promise<Sources> {
  return JSON.parse(await readFile(sourcesFile, "utf8")) as Sources;
}

export async function ensureFile(ctx: Context, id: string): Promise<string> {
  const pinned = ctx.sources.files[id];
  if (!pinned) throw new Error(`sources.json doesn't list ${id}.`);
  const path = join(ctx.cache, "sources", id);
  if (await download(ctx.fetchFn, pinned, path)) ctx.log(`Fetched ${id} (${pinned.bytes} bytes)`);
  return path;
}

export async function ensureAlimeeting(ctx: Context, sessions: readonly string[]) {
  const wanted = ctx.sources.alimeeting.entries.filter((entry) => sessions.includes(entry.session));
  return extractEntries(
    ctx.fetchFn,
    ctx.sources.alimeeting.url,
    wanted,
    join(ctx.cache, "alimeeting"),
    ctx.log,
  );
}

const wavOf = (track: Float32Array) => encodeWav(toPcm16(track));
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

interface Built {
  files: Record<string, Uint8Array | string>;
  durationSeconds: number;
  speakers: number;
}

async function amiText(ctx: Context) {
  return amiUtterances(await readFile(await ensureFile(ctx, "ami-text"), "utf8"));
}

async function buildAmiOnline(ctx: Context, definition: CaseDefinition): Promise<Built> {
  const utterances = ofMeeting(await amiText(ctx), definition.recording);
  const me = definition.me ?? talkTimes(utterances)[0]?.[0];
  if (!me) throw new Error(`${definition.recording} has no speech.`);
  const tar = await ensureFile(ctx, `ami-ihm-${definition.recording}`);
  const { bySpeaker, length } = await headsetTracks(tar, utterances);
  const { mic, system } = onlineTracks(bySpeaker, me);
  return {
    files: {
      "mic.wav": wavOf(mic),
      "system.wav": wavOf(system),
      "reference.json": json(amiReference(utterances, (s) => (s === me ? "mic" : "system"))),
    },
    durationSeconds: length / MEETING_SAMPLE_RATE,
    speakers: bySpeaker.size,
  };
}

async function buildAmiRoom(ctx: Context, definition: CaseDefinition): Promise<Built> {
  const utterances = ofMeeting(await amiText(ctx), definition.recording);
  const shard = Object.entries(ctx.sources.files).find(
    ([, file]) => file.rows?.[definition.recording] !== undefined,
  );
  if (!shard) throw new Error(`sources.json doesn't say where ${definition.recording} is.`);
  const row = shard[1].rows?.[definition.recording] as number;
  const { bytes, seconds } = await roomRecording(
    await ensureFile(ctx, shard[0]),
    row,
    definition.recording,
  );
  return {
    files: {
      "room.wav": bytes,
      "reference.json": json(amiReference(utterances, () => "room")),
    },
    durationSeconds: seconds,
    speakers: new Set(utterances.map((utterance) => utterance.speaker)).size,
  };
}

async function gridOf(ctx: Context, session: string) {
  const entry = ctx.sources.alimeeting.entries.find((e) => e.file === `${session}.TextGrid`);
  if (!entry) throw new Error(`sources.json doesn't list the TextGrid of ${session}.`);
  return parseTextGrid(await readFile(join(ctx.cache, "alimeeting", entry.file), "utf8"));
}

async function buildAlimeetingOnline(ctx: Context, definition: CaseDefinition): Promise<Built> {
  const session = definition.recording;
  const tiers = await gridOf(ctx, session);
  const talk = tiers
    .map(
      (tier) =>
        [speakerOf(tier), tier.intervals.reduce((sum, i) => sum + i.end - i.start, 0)] as const,
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const me = definition.me ?? talk[0]?.[0];
  if (!me) throw new Error(`${session} has no speech.`);
  const bySpeaker = new Map<string, Float32Array>();
  let length = 0;
  for (const tier of tiers) {
    const speaker = speakerOf(tier);
    const near = monoSamples(
      await readFile(join(ctx.cache, "alimeeting", `${session}_N_${speaker}.wav`)),
      `${session} ${speaker}`,
    );
    length = Math.max(length, near.length);
    bySpeaker.set(speaker, gateTurns(near, tier.intervals, GATE_MARGIN_SECONDS));
  }
  for (const [speaker, track] of bySpeaker) {
    if (track.length !== length) {
      const padded = new Float32Array(length);
      padded.set(track);
      bySpeaker.set(speaker, padded);
    }
  }
  const { mic, system } = onlineTracks(bySpeaker, me);
  return {
    files: {
      "mic.wav": wavOf(mic),
      "system.wav": wavOf(system),
      "reference.json": json(alimeetingReference(tiers, (s) => (s === me ? "mic" : "system"))),
    },
    durationSeconds: length / MEETING_SAMPLE_RATE,
    speakers: bySpeaker.size,
  };
}

async function buildAlimeetingRoom(ctx: Context, definition: CaseDefinition): Promise<Built> {
  const session = definition.recording;
  const tiers = await gridOf(ctx, session);
  const bytes = await readFile(join(ctx.cache, "alimeeting", `${session}.far.wav`));
  return {
    files: {
      "room.wav": bytes,
      "reference.json": json(alimeetingReference(tiers, "room")),
    },
    durationSeconds: monoSamples(bytes, session).length / MEETING_SAMPLE_RATE,
    speakers: tiers.length,
  };
}

async function buildAscend(ctx: Context, definition: CaseDefinition): Promise<Built> {
  const session = Number(/(\d+)$/.exec(definition.recording)?.[1]);
  const built = await ascendSession(await ensureFile(ctx, "ascend-test"), session);
  return {
    files: {
      "conversation.wav": wavOf(conversationTrack(built)),
      "reference.json": json(built.reference satisfies Reference),
    },
    durationSeconds: built.length / MEETING_SAMPLE_RATE,
    speakers: built.speakers,
  };
}

const BUILDERS = {
  "ami-online": buildAmiOnline,
  "ami-room": buildAmiRoom,
  "alimeeting-online": buildAlimeetingOnline,
  "alimeeting-room": buildAlimeetingRoom,
  ascend: buildAscend,
} as const;

export interface Measured {
  durationSeconds: number;
  speakers: number;
  files: Record<string, string>;
}

/**
 * Builds one case into the cache and returns what it is made of. With `expected` (the pinned
 * definition) a case that comes out different is not kept and fails the run; without, as when
 * pinning, it is kept as it comes.
 */
export async function buildCase(
  ctx: Context,
  definition: CaseDefinition,
  expected: boolean,
): Promise<Measured> {
  const built = await BUILDERS[definition.source](ctx, definition);
  const folder = caseFolderOf(definition.id, ctx.cache);
  const partial = `${folder}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  for (const [name, bytes] of Object.entries(built.files))
    await writeFile(join(partial, name), bytes);
  const names = Object.keys(built.files);
  const files = await hashesOf(partial, names);
  const wrong = expected ? names.filter((name) => files[name] !== definition.files[name]) : [];
  if (wrong.length > 0 || (expected && names.length !== Object.keys(definition.files).length)) {
    await rm(partial, { recursive: true, force: true });
    throw new Error(
      `${definition.id}: ${wrong.join(", ") || "the files"} differ from what cases.json pins, so the case was not kept.`,
    );
  }
  await markVerified(partial, files);
  await rm(folder, { recursive: true, force: true });
  await rename(partial, folder);
  return { durationSeconds: built.durationSeconds, speakers: built.speakers, files };
}

export interface Ensured {
  cases: CaseDefinition[];
  /** The archive entries as they measured, which pinning writes to sources.json. */
  entries: ArchiveEntry[];
}

/**
 * Makes sure the cases are in the cache: the ones already built and checked are left alone,
 * and everything else is fetched and built. Needs no network when all are in the cache.
 */
export async function ensureCases(
  ctx: Context,
  ids: readonly string[] | null,
  options: { pin: boolean },
): Promise<Ensured> {
  const all = ctx.cases ?? (await readCases());
  const chosen = ids && ids.length > 0 ? all.filter((c) => ids.includes(c.id)) : all;
  const unknown = (ids ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`No such case: ${unknown.join(", ")}`);
  const todo: CaseDefinition[] = [];
  for (const definition of chosen) {
    const folder = caseFolderOf(definition.id, ctx.cache);
    if (!options.pin && (await isVerified(folder, definition))) {
      ctx.log(`${definition.id}: in the cache`);
    } else todo.push(definition);
  }
  const sessions = todo.filter((c) => c.source.startsWith("alimeeting")).map((c) => c.recording);
  const entries = sessions.length > 0 ? await ensureAlimeeting(ctx, sessions) : [];
  const cases: CaseDefinition[] = [];
  for (const definition of chosen) {
    if (!todo.includes(definition)) {
      cases.push(definition);
      continue;
    }
    ctx.log(`${definition.id}: building`);
    cases.push({ ...definition, ...(await buildCase(ctx, definition, !options.pin)) });
  }
  return { cases, entries };
}
