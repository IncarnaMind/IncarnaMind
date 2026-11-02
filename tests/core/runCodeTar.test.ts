import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { type TarEntry, unpackTarZst, writeTarZst } from "../../src/core/runCode/tar";

const LIMITS = { maxBytes: 10_000_000, maxEntries: 1000 };

const longFolder = `python/lib/python3.14/site-packages/${"statsmodels/".repeat(12)}`;

async function archive(entries: TarEntry[], contents: Record<string, string | Buffer>) {
  const folder = await mkdtemp(join(tmpdir(), "tar-test-"));
  const file = join(folder, "runtime.tar.zst");
  await writeTarZst(
    file,
    entries,
    (entry) => Readable.from([Buffer.from(contents[entry.path] ?? "x".repeat(entry.size))]),
    3,
  );
  return { folder, file };
}

const file = (path: string, text: string, mode = 0o644): TarEntry => ({
  kind: "file",
  path,
  mode,
  mtime: 1_700_000_000,
  size: Buffer.byteLength(text),
});

describe("the runtime's archive", () => {
  test("unpacks files, folders, links and long paths with their modes and times", async () => {
    const big = Buffer.alloc(70_000, 7);
    const entries: TarEntry[] = [
      { kind: "directory", path: "python", mode: 0o755, mtime: 1_600_000_000 },
      file("python/bin/python3.14", "#!binary", 0o755),
      {
        kind: "symlink",
        path: "python/bin/python3",
        mode: 0o777,
        mtime: 1_700_000_000,
        target: "python3.14",
      },
      file(`${longFolder}api.py`, "import 汉字"),
      {
        kind: "file",
        path: "python/big.bin",
        mode: 0o644,
        mtime: 1_700_000_000,
        size: big.byteLength,
      },
      file("python/empty.txt", ""),
    ];
    const { folder, file: tar } = await archive(entries, {
      "python/bin/python3.14": "#!binary",
      [`${longFolder}api.py`]: "import 汉字",
      "python/big.bin": big,
    });
    const into = join(folder, "out");
    const done = await unpackTarZst(tar, into, LIMITS);
    expect(done).toEqual({ entries: 6, bytes: 8 + Buffer.byteLength("import 汉字") + 70_000 });
    expect(await readFile(join(into, longFolder, "api.py"), "utf8")).toBe("import 汉字");
    expect(
      createHash("sha256")
        .update(await readFile(join(into, "python/big.bin")))
        .digest("hex"),
    ).toBe(createHash("sha256").update(big).digest("hex"));
    expect(await readlink(join(into, "python/bin/python3"))).toBe("python3.14");
    expect((await stat(join(into, "python/bin/python3.14"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(into, "python/empty.txt"))).size).toBe(0);
    expect((await lstat(join(into, `${longFolder}api.py`))).mtimeMs).toBe(1_700_000_000_000);
    expect((await lstat(join(into, "python"))).mtimeMs).toBe(1_600_000_000_000);
  });

  test("the same entries make the same bytes", async () => {
    const entries = [file("python/a.txt", "a"), file("python/b.txt", "b")];
    const first = await archive(entries, { "python/a.txt": "a", "python/b.txt": "b" });
    const second = await archive(entries, { "python/a.txt": "a", "python/b.txt": "b" });
    expect(await readFile(first.file)).toEqual(await readFile(second.file));
  });

  test.each([
    ["a path that climbs out", [file("python/../../escaped.txt", "x")]],
    ["an absolute path", [file("/tmp/escaped.txt", "x")]],
    [
      "a link that points outside",
      [
        {
          kind: "symlink",
          path: "python/lib",
          mode: 0o777,
          mtime: 0,
          target: "../../etc",
        } as TarEntry,
      ],
    ],
    [
      "a file written through one of its links",
      [
        { kind: "symlink", path: "python/lib", mode: 0o777, mtime: 0, target: "bin" } as TarEntry,
        file("python/lib/x.txt", "x"),
      ],
    ],
  ])("refuses %s", async (_name, entries) => {
    const { folder, file: tar } = await archive(entries, {});
    await expect(unpackTarZst(tar, join(folder, "out"), LIMITS)).rejects.toThrow(
      /unsafe path|outside|inside one of its own links/,
    );
    await expect(stat(join(folder, "escaped.txt"))).rejects.toThrow();
  });

  test("refuses an archive past its limits", async () => {
    const { folder, file: tar } = await archive([file("python/a.txt", "abc")], {
      "python/a.txt": "abc",
    });
    await expect(
      unpackTarZst(tar, join(folder, "out"), { maxBytes: 2, maxEntries: 10 }),
    ).rejects.toThrow("more than allowed");
    const fine = await unpackTarZst(tar, join(folder, "out2"), { maxBytes: 3, maxEntries: 10 });
    expect(fine.bytes).toBe(3);
  });
});
