import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildCase, type Context, ensureCases, type Sources } from "../../eval/meetings/build";
import { caseFolderOf, loadCase, markVerified, readCases, sha256 } from "../../eval/meetings/cache";
import type { CaseDefinition } from "../../eval/meetings/types";
import { floatWav, tarOf } from "../helpers/meetingFiles";

const sources = JSON.parse(
  await readFile(new URL("../../eval/meetings/sources.json", import.meta.url), "utf8"),
) as Sources;
const cases = await readCases();

describe("The meeting set's pins", () => {
  test("every case is pinned: its files, how long it is, and who is in it", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.durationSeconds, c.id).toBeGreaterThan(0);
      expect(Object.keys(c.files), c.id).toContain("reference.json");
      for (const hash of Object.values(c.files)) expect(hash, c.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("there are at least 30 minutes for each language in each setting, and 20 of mixed", () => {
    const minutes = (language: string, setting: string) =>
      cases
        .filter((c) => c.language === language && c.setting === setting)
        .reduce((sum, c) => sum + c.durationSeconds, 0) / 60;
    for (const language of ["en", "zh"]) {
      for (const setting of ["online", "room"]) {
        expect(minutes(language, setting), `${language} ${setting}`).toBeGreaterThanOrEqual(30);
      }
    }
    const mixed = cases.filter((c) => c.language === "mixed");
    expect(mixed.reduce((sum, c) => sum + c.durationSeconds, 0) / 60).toBeGreaterThanOrEqual(20);
  });

  test("an online call keeps the microphone and the system audio as separate tracks; a room has three speakers or more", () => {
    for (const c of cases.filter((c) => c.setting === "online")) {
      expect(Object.keys(c.files).sort(), c.id).toEqual([
        "mic.wav",
        "reference.json",
        "system.wav",
      ]);
      expect(c.me, c.id).toBeTruthy();
      expect(c.speakers, c.id).toBeGreaterThanOrEqual(3);
    }
    for (const c of cases.filter((c) => c.setting === "room")) {
      expect(Object.keys(c.files).sort(), c.id).toEqual(["reference.json", "room.wav"]);
      expect(c.speakers, c.id).toBeGreaterThanOrEqual(3);
    }
  });

  test("everything a case is made of is pinned in sources.json, with a hash and a size", () => {
    for (const [id, file] of Object.entries(sources.files)) {
      expect(file.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes, id).toBeGreaterThan(0);
      expect(file.url, id).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    }
    for (const entry of sources.alimeeting.entries) {
      expect(entry.sha256, entry.name).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.keptSha256, entry.name).toMatch(/^[0-9a-f]{64}$/);
    }
    const sessionFiles = (session: string) =>
      sources.alimeeting.entries.filter((e) => e.session === session).map((e) => e.file);
    for (const c of cases) {
      if (c.source === "ami-online")
        expect(sources.files, c.id).toHaveProperty(`ami-ihm-${c.recording}`);
      if (c.source === "ami-room") {
        const shards = Object.values(sources.files).filter(
          (f) => f.rows?.[c.recording] !== undefined,
        );
        expect(shards, c.id).toHaveLength(1);
      }
      if (c.source === "ascend") expect(sources.files, c.id).toHaveProperty("ascend-test");
      if (c.source === "alimeeting-room") {
        expect(sessionFiles(c.recording), c.id).toEqual(
          expect.arrayContaining([`${c.recording}.far.wav`, `${c.recording}.TextGrid`]),
        );
      }
      if (c.source === "alimeeting-online") {
        const near = sessionFiles(c.recording).filter((f) => f.includes("_N_SPK"));
        expect(near, c.id).toHaveLength(c.speakers);
      }
    }
  });
});

describe("Making the cases", () => {
  let cache: string;
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), "incarnamind-meetings-cache-"));
  });
  afterEach(async () => {
    await rm(cache, { recursive: true, force: true });
  });

  const throwing = (async () => {
    throw new Error("no network");
  }) as unknown as typeof fetch;

  const text = [
    "AMI_ES2004b_H00_MEO015_0000100_0000200 OKAY",
    "AMI_ES2004b_H01_FEE013_0000300_0000400 SO TWENTY FIVE",
    "AMI_ES2004b_H02_FEE016_0000500_0000600 RIGHT",
  ].join("\n");
  const clip = (value: number) => floatWav(new Float32Array(1600).fill(value));
  const tar = gzipSync(
    tarOf([
      { name: "ES2004b/eval_ami_es2004b_h00_meo015_0000100_0000200.wav", data: clip(0.5) },
      { name: "ES2004b/eval_ami_es2004b_h01_fee013_0000300_0000400.wav", data: clip(0.25) },
      { name: "ES2004b/eval_ami_es2004b_h02_fee016_0000500_0000600.wav", data: clip(0.125) },
    ]),
  );
  const served: Record<string, Buffer> = {
    "https://example.test/text": Buffer.from(text),
    "https://example.test/ES2004b.tar.gz": tar,
  };
  const fakeSources: Sources = {
    format: 1,
    files: {
      "ami-text": {
        url: "https://example.test/text",
        sha256: sha256(served["https://example.test/text"] as Buffer),
        bytes: text.length,
      },
      "ami-ihm-ES2004b": {
        url: "https://example.test/ES2004b.tar.gz",
        sha256: sha256(tar),
        bytes: tar.length,
      },
    },
    alimeeting: { url: "https://example.test/ali", entries: [] },
  };
  const serving = (async (url: string) =>
    new Response(new Uint8Array(served[url] as Buffer))) as unknown as typeof fetch;
  const definition: CaseDefinition = {
    id: "en-online-ES2004b",
    language: "en",
    setting: "online",
    source: "ami-online",
    recording: "ES2004b",
    me: "FEE013",
    durationSeconds: 0,
    speakers: 0,
    files: {},
  };
  const context = (fetchFn: typeof fetch, list?: CaseDefinition[]): Context => ({
    cache,
    fetchFn,
    log: () => {},
    sources: fakeSources,
    cases: list,
  });

  test("a case is made of its tracks and its reference, with the microphone and the others apart", async () => {
    const measured = await buildCase(context(serving), definition, false);
    expect(Object.keys(measured.files).sort()).toEqual(["mic.wav", "reference.json", "system.wav"]);
    expect(measured.speakers).toBe(3);
    expect(measured.durationSeconds).toBeCloseTo(6.5);
    const loaded = await loadCase({ ...definition, ...measured }, cache);
    expect(loaded.reference.segments.map((s) => [s.speaker, s.track])).toEqual([
      ["MEO015", "system"],
      ["FEE013", "mic"],
      ["FEE016", "system"],
    ]);
    expect(Object.keys(loaded.tracks).sort()).toEqual(["mic", "system"]);
  });

  test("a case that comes out different from its pin is not kept", async () => {
    const measured = await buildCase(context(serving), definition, false);
    const pinned = { ...definition, ...measured };
    await rm(caseFolderOf(definition.id, cache), { recursive: true });
    await buildCase(context(serving), pinned, true);
    await rm(caseFolderOf(definition.id, cache), { recursive: true });
    const wrong = { ...pinned, files: { ...pinned.files, "mic.wav": "0".repeat(64) } };
    await expect(buildCase(context(serving), wrong, true)).rejects.toThrow(/mic\.wav differ/);
    await expect(readFile(join(caseFolderOf(definition.id, cache), "mic.wav"))).rejects.toThrow();
    await expect(
      readFile(`${caseFolderOf(definition.id, cache)}.partial/mic.wav`),
    ).rejects.toThrow();
  });

  test("once the cases are in the cache, nothing is fetched", async () => {
    const measured = await buildCase(context(serving), definition, false);
    const pinned = { ...definition, ...measured };
    const { cases: ensured } = await ensureCases(context(throwing, [pinned]), null, { pin: false });
    expect(ensured).toEqual([pinned]);
  });

  test("a case that isn't in the cache is refused with the command that fetches it", async () => {
    await expect(loadCase(definition, cache)).rejects.toThrow(/npm run eval:meetings:fetch/);
    const folder = caseFolderOf(definition.id, cache);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "reference.json"), "{}");
    await markVerified(folder, { "reference.json": sha256(Buffer.from("{}")) });
    await expect(loadCase({ ...definition, files: { "mic.wav": "x" } }, cache)).rejects.toThrow(
      /isn't the case cases\.json pins/,
    );
  });

  test("a case built under a pin that has since moved is not taken as cached, nor scored", async () => {
    const measured = await buildCase(context(serving), definition, false);
    const pinned = { ...definition, ...measured };
    const moved = { ...pinned, files: { ...pinned.files, "mic.wav": "0".repeat(64) } };
    await expect(loadCase(moved, cache)).rejects.toThrow(/isn't the case cases\.json pins/);
    await expect(ensureCases(context(throwing, [moved]), null, { pin: false })).rejects.toThrow(
      /mic\.wav differ/,
    );
    await expect(loadCase(pinned, cache)).resolves.toMatchObject({ folder: expect.any(String) });
  });

  test("a name that isn't a case is an error", async () => {
    await expect(
      ensureCases(context(throwing, [definition]), ["nope"], { pin: false }),
    ).rejects.toThrow(/No such case: nope/);
  });
});
