import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readHypothesis } from "../../eval/meetings/hypotheses";

describe("Reading a transcriber's results", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "incarnamind-hypotheses-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("a case with no file is left out, not failed", async () => {
    await expect(readHypothesis(folder, "en-online-X")).resolves.toBeNull();
  });

  test("a file that is no JSON fails, naming the file", async () => {
    await writeFile(join(folder, "en-online-X.json"), '{"case": "en-online-X", "segments": [');
    await expect(readHypothesis(folder, "en-online-X")).rejects.toThrow(
      /en-online-X\.json isn't JSON/,
    );
  });

  test("a file for another case, or with no segments, fails", async () => {
    await writeFile(join(folder, "a.json"), JSON.stringify({ case: "b", segments: [] }));
    await expect(readHypothesis(folder, "a")).rejects.toThrow(/isn't a hypothesis for a/);
    await writeFile(join(folder, "c.json"), JSON.stringify({ case: "c" }));
    await expect(readHypothesis(folder, "c")).rejects.toThrow(/isn't a hypothesis for c/);
  });

  test("a hypothesis comes back as it was written", async () => {
    const written = { case: "d", transcriber: "t", segments: [{ start: 1, end: 2, text: "hi" }] };
    await writeFile(join(folder, "d.json"), JSON.stringify(written));
    await expect(readHypothesis(folder, "d")).resolves.toEqual(written);
  });
});
