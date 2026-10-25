import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { compressors } from "hyparquet-compressors";
import { describe, expect, test } from "vitest";
import { roomRecording } from "../../eval/meetings/ami";
import { ascendSession } from "../../eval/meetings/ascend";
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
const ami = await cached("ami-sdm-test-0");

describe("Reading Parquet, as the corpora ship it", () => {
  test("the Snappy decompressor the Parquet files need loads and decodes", () => {
    const literal = Uint8Array.from([5, 16, 104, 101, 108, 108, 111]);
    expect(new TextDecoder().decode(compressors.SNAPPY?.(literal, 5))).toBe("hello");
  });

  test.skipIf(!ascend)("an ASCEND session is laid out again from the cached file", async () => {
    const session = await ascendSession(ascend as string, 3);
    expect(session.speakers).toBe(2);
    expect(session.reference.segments).toHaveLength(356);
    expect(session.length / 16_000 / 60).toBeGreaterThan(21);
    expect(session.reference.segments.every((s) => s.track === "conversation")).toBe(true);
  });

  test.skipIf(!ami)(
    "a meeting's room recording is read from its row of the cached file",
    async () => {
      const { seconds } = await roomRecording(ami as string, 3, "ES2004b");
      expect(seconds / 60).toBeGreaterThan(39);
      await expect(roomRecording(ami as string, 4, "ES2004b")).rejects.toThrow(/Row 4/);
    },
  );
});
