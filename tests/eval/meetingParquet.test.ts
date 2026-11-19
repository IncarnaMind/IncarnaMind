import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { compressors } from "hyparquet-compressors";
import { describe, expect, test } from "vitest";
import { roomRecording } from "../../eval/meetings/ami";
import { ascendSession, ascendSpeaker } from "../../eval/meetings/ascend";
import { meetingsCache } from "../../eval/meetings/cache";

const pinned = JSON.parse(
  await readFile(new URL("../../eval/meetings/sources.json", import.meta.url), "utf8"),
) as { files: Record<string, { bytes: number }> };

async function cached(id: string): Promise<string | null> {
  const path = join(meetingsCache(), "sources", id);
  try {
    return (await stat(path)).size === pinned.files[id]?.bytes ? path : null;
  } catch {
    return null;
  }
}
const ascend = await cached("ascend-test");
const partner = await cached("ascend-train-2");
const ami = await cached("ami-sdm-test-0");

describe("Reading Parquet, as the corpora ship it", () => {
  test("the Snappy decompressor the Parquet files need loads and decodes", () => {
    const literal = Uint8Array.from([5, 16, 104, 101, 108, 108, 111]);
    expect(new TextDecoder().decode(compressors.SNAPPY?.(literal, 5))).toBe("hello");
  });

  test("speakers in different dialogues with the same session number cannot be mixed", () => {
    const turn = (line: number, start: number) => ({
      line,
      start,
      text: "hello",
      samples: new Float32Array(16_000),
    });
    const first = { speaker: 17, utterances: [turn(3818, 1), turn(3823, 5)] };
    const unrelated = { speaker: 3, utterances: [turn(6487, 1), turn(6489, 5)] };
    expect(() => ascendSession(first, unrelated)).toThrow(/no interleaved dialogue/);
    const partner = { speaker: 18, utterances: [turn(3812, 0), turn(3820, 3)] };
    const session = ascendSession(first, partner);
    expect(session.reference.segments.map(({ speaker, start }) => [speaker, start])).toEqual([
      ["spk18", 0],
      ["spk17", 1],
      ["spk18", 3],
      ["spk17", 5],
    ]);
  });

  test.skipIf(!ascend || !partner)(
    "a complete ASCEND dialogue is assembled across two cached splits",
    async () => {
      if (!ascend || !partner) throw new Error("Missing pinned ASCEND files.");
      const left = await ascendSpeaker(ascend, 3, 3);
      const right = await ascendSpeaker(partner, 3, 4);
      const session = ascendSession(left, right);
      expect(session.speakers).toBe(2);
      expect(session.reference.segments).toHaveLength(321);
      expect(session.length / 16_000 / 60).toBeGreaterThan(24);
      expect(session.reference.segments.every((s) => s.track === "conversation")).toBe(true);
    },
  );

  test.skipIf(!ami)(
    "a meeting's room recording is read from its row of the cached file",
    async () => {
      const { seconds } = await roomRecording(ami as string, 3, "ES2004b");
      expect(seconds / 60).toBeGreaterThan(39);
      await expect(roomRecording(ami as string, 4, "ES2004b")).rejects.toThrow(/Row 4/);
    },
  );
});
