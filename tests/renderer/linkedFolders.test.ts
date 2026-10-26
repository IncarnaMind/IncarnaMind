import { describe, expect, test } from "vitest";
import type { LinkedFolder } from "../../src/core/api";
import {
  fileStatusLabel,
  folderName,
  formatBytes,
  formatCount,
  formatDuration,
  indexingShare,
  linkedFolderRowState,
  rowStateLabel,
} from "../../src/renderer/src/linkedFolders";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

type Shape = Pick<LinkedFolder, "status" | "progress" | "onlineOnly">;

/** A Linked folder that is up to date, with ten files indexed and nothing online only. */
const folder = (changes: Partial<Shape> = {}): Shape => ({
  status: "watching",
  progress: { files: 10, indexed: 10 },
  onlineOnly: { files: 0, bytes: 0, downloading: false },
  ...changes,
});

describe("a Linked folder's row state", () => {
  test("up to date with something in it says nothing; with nothing in it, that it has no files", () => {
    expect(linkedFolderRowState(folder(), true)).toEqual({ kind: "idle" });
    expect(linkedFolderRowState(folder({ progress: { files: 0, indexed: 0 } }), false)).toEqual({
      kind: "empty",
    });
  });

  test("files still to index show as indexing, while scanning or after", () => {
    const progress = { files: 3214, indexed: 120 };
    expect(linkedFolderRowState(folder({ status: "scanning", progress }), true)).toEqual({
      kind: "indexing",
      ...progress,
    });
    expect(linkedFolderRowState(folder({ status: "watching", progress }), true)).toEqual({
      kind: "indexing",
      ...progress,
    });
  });

  test("scanning with everything indexed is a check for changes, even in an empty folder", () => {
    expect(linkedFolderRowState(folder({ status: "scanning" }), true)).toEqual({
      kind: "checking",
    });
    expect(
      linkedFolderRowState(
        folder({ status: "scanning", progress: { files: 0, indexed: 0 } }),
        false,
      ),
    ).toEqual({ kind: "checking" });
  });

  test("the most pressing state wins: unavailable, then paused, then downloading, then indexing", () => {
    const busy = {
      progress: { files: 10, indexed: 2 },
      onlineOnly: { files: 4, bytes: 100, downloading: true },
    };
    expect(linkedFolderRowState(folder({ ...busy, status: "unavailable" }), true).kind).toBe(
      "unavailable",
    );
    expect(linkedFolderRowState(folder({ ...busy, status: "paused" }), true)).toEqual({
      kind: "paused",
      files: 10,
      indexed: 2,
    });
    expect(linkedFolderRowState(folder({ ...busy, status: "scanning" }), true)).toEqual({
      kind: "downloading",
      files: 4,
    });
  });

  test("online-only files show once everything else is indexed, ahead of an empty folder", () => {
    const onlineOnly = { files: 12, bytes: 5_000_000, downloading: false };
    expect(linkedFolderRowState(folder({ onlineOnly }), true)).toEqual({
      kind: "online-only",
      files: 12,
    });
    expect(
      linkedFolderRowState(folder({ onlineOnly, progress: { files: 0, indexed: 0 } }), false),
    ).toEqual({ kind: "online-only", files: 12 });
  });

  test("the thin bar shows how far indexing is, only while there is some left", () => {
    expect(indexingShare({ kind: "indexing", files: 4, indexed: 1 })).toBe(0.25);
    expect(indexingShare({ kind: "paused", files: 4, indexed: 3 })).toBe(0.75);
    expect(indexingShare({ kind: "paused", files: 4, indexed: 4 })).toBeNull();
    expect(indexingShare({ kind: "checking" })).toBeNull();
    expect(indexingShare({ kind: "idle" })).toBeNull();
  });
});

describe("what a Linked folder's row says", () => {
  test("indexing counts with digit grouping, and has a shorter form for a narrow sidebar", () => {
    expect(rowStateLabel({ kind: "indexing", indexed: 120, files: 3214 }, en, "en")).toEqual({
      short: "Reading 120 of 3,214",
      compact: "120 of 3,214",
      full: "Reading 120 of 3,214 files, newest first",
    });
    expect(rowStateLabel({ kind: "indexing", indexed: 120, files: 3214 }, zh, "zh-CN")).toEqual({
      short: "正在读取 120/3,214",
      compact: "120 / 3,214",
      full: "正在读取 3,214 个文件，已完成 120 个，最新的优先",
    });
  });

  test("each state's short words, and nothing when idle", () => {
    const short = (state: Parameters<typeof rowStateLabel>[0]) =>
      rowStateLabel(state, en, "en")?.short ?? null;
    expect(short({ kind: "paused", indexed: 2, files: 10 })).toBe("Paused");
    expect(short({ kind: "unavailable" })).toBe("Unavailable");
    expect(short({ kind: "online-only", files: 12 })).toBe("12 online-only");
    expect(short({ kind: "empty" })).toBe("No supported files");
    expect(rowStateLabel({ kind: "empty" }, en, "en")?.compact).toBe("No files");
    expect(short({ kind: "checking" })).toBe("Checking…");
    expect(short({ kind: "downloading", files: 3 })).toBe("Downloading…");
    expect(short({ kind: "idle" })).toBeNull();
  });

  test("the full words say how far a paused folder got, and count one online-only file as one", () => {
    expect(rowStateLabel({ kind: "paused", indexed: 2, files: 10 }, en, "en")?.full).toBe(
      "Reading is paused: 2 of 10 files read",
    );
    expect(rowStateLabel({ kind: "paused", indexed: 10, files: 10 }, en, "en")?.full).toBe(
      "Reading is paused",
    );
    expect(rowStateLabel({ kind: "online-only", files: 1 }, en, "en")?.full).toBe(
      "1 online-only file isn’t downloaded, so it isn’t read",
    );
    expect(rowStateLabel({ kind: "online-only", files: 1200 }, en, "en")?.full).toBe(
      "1,200 online-only files aren’t downloaded, so they aren’t read",
    );
  });
});

describe("the link dialog's numbers", () => {
  test("sizes in decimal units, one decimal under ten", () => {
    expect(formatBytes(0, en)).toBe("1 KB");
    expect(formatBytes(640_000, en)).toBe("640 KB");
    expect(formatBytes(3_400_000, en)).toBe("3.4 MB");
    expect(formatBytes(12_400_000, en)).toBe("12 MB");
    expect(formatBytes(1_230_000_000, en)).toBe("1.2 GB");
    expect(formatBytes(48_000_000_000, en)).toBe("48 GB");
  });

  test("the time estimate is rough: under a minute, minutes, then hours", () => {
    expect(formatDuration(0, en)).toBe("under a minute");
    expect(formatDuration(59, en)).toBe("under a minute");
    expect(formatDuration(80, en)).toBe("about a minute");
    expect(formatDuration(4 * 60 + 20, en)).toBe("about 4 minutes");
    expect(formatDuration(59 * 60 + 40, en)).toBe("about an hour");
    expect(formatDuration(2.4 * 3600, en)).toBe("about 2 hours");
    expect(formatDuration(30, zh)).toBe("不到 1 分钟");
    expect(formatDuration(600, zh)).toBe("约 10 分钟");
    expect(formatDuration(3 * 3600, zh)).toBe("约 3 小时");
  });

  test("counts group their digits in the interface language", () => {
    expect(formatCount(3214, "en")).toBe("3,214");
    expect(formatCount(12, "zh-CN")).toBe("12");
    expect(formatCount(1731, "en")).toBe("1,731");
    expect(formatCount(1731, "zh-CN")).toBe("1,731");
  });
});

describe("names and labels", () => {
  test("a folder's name is the last part of its path, on any system", () => {
    expect(folderName("/Users/ada/Papers")).toBe("Papers");
    expect(folderName("/Users/ada/Papers/")).toBe("Papers");
    expect(folderName("C:\\Users\\ada\\Zotero\\storage")).toBe("storage");
  });

  test("a Document's file status: words for missing and unavailable, nothing when it's there", () => {
    expect(fileStatusLabel("available")).toBeNull();
    const missing = fileStatusLabel("missing");
    expect(missing && en(missing.short)).toBe("Missing");
    expect(missing && en(missing.reason)).toBe("The file is missing from its folder.");
    const unavailable = fileStatusLabel("unavailable");
    expect(unavailable && en(unavailable.short)).toBe("Unavailable");
    expect(unavailable && en(unavailable.reason)).toBe("The file can’t be reached right now.");
  });
});
