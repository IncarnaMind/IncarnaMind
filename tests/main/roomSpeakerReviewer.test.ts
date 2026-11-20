import { expect, test } from "vitest";
import { redirectAllowedByDefault } from "../../src/core/embedding/modelSources";
import { roomEngine } from "../../src/main/meetings/roomModels";
import { readRoomTurns } from "../../src/main/meetings/roomSpeakerReviewer";

test("the pinned engine archives use the release CDN on supported platforms", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const) {
    const source = roomEngine(platform, arch);
    const file = source?.files[0];
    if (!source || !file) throw new Error("Expected a pinned platform release.");
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    const asked = new URL(file.path, source.baseUrl);
    const asset = new URL("https://release-assets.githubusercontent.com/one-release-file");
    expect(redirectAllowedByDefault(asked, asked, asset)).toBe(true);
    for (const url of [
      "http://release-assets.githubusercontent.com/x",
      "https://other.githubusercontent.com/x",
      "https://release-assets.githubusercontent.com.unrelated.test/x",
    ]) {
      expect(redirectAllowedByDefault(asked, asked, new URL(url))).toBe(false);
    }
    expect(
      redirectAllowedByDefault(new URL("https://github.com/other/archive"), asked, asset),
    ).toBe(false);
  }
  expect(roomEngine("linux", "ia32")).toBeUndefined();
});

test("RTTM keeps simultaneous speech and rejects invalid time or a fifth voice", () => {
  const turn = (start: string, duration: string, name: string) =>
    `SPEAKER room 1 ${start} ${duration} <NA> <NA> ${name} <NA> <NA>`;
  expect(readRoomTurns([turn("0.123", "2.5", "a"), turn("1", "1", "b")].join("\n"))).toEqual([
    { startMs: 123, endMs: 2623, voice: 0 },
    { startMs: 1000, endMs: 2000, voice: 1 },
  ]);
  expect(readRoomTurns("")).toEqual([]);
  expect(() => readRoomTurns(turn("-2", "1", "a"))).toThrow();
  expect(() => readRoomTurns(turn("NaN", "1", "a"))).toThrow();
  expect(() =>
    readRoomTurns(["a", "b", "c", "d", "e"].map((voice) => turn("0", "1", voice)).join("\n")),
  ).toThrow();
});
