/**
 * The desktop app reads a file an agent names for a Canvas where it is, and nothing else (#3406): a
 * regular file within the limit, never through a link and never a folder, a device or a pipe, which
 * all read as "unreadable" so nothing more of the path is told. What it keeps goes under its hash.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashBytes } from "../../src/core/documents/files";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { createTempDataFolder } from "../helpers/core";

const LIMIT = 1024;

async function setUp() {
  const kept = join(await createTempDataFolder(), "Canvases");
  const named = await createTempDataFolder();
  return { files: createCanvasFiles(kept), kept, named };
}

describe("A file an agent names for a Canvas", () => {
  it("is read when it is a regular file within the limit", async () => {
    const { files, named } = await setUp();
    await writeFile(join(named, "chart.png"), "picture");
    // Where it is, as a Linked folder names it: links in the folders above it followed (#3499).
    expect(await files.readNamed(join(named, "chart.png"), LIMIT)).toEqual({
      kind: "read",
      bytes: new TextEncoder().encode("picture"),
      path: join(await realpath(named), "chart.png"),
    });
    await writeFile(join(named, "big.png"), new Uint8Array(LIMIT + 1));
    expect(await files.readNamed(join(named, "big.png"), LIMIT)).toEqual({ kind: "too-large" });
  });

  // protects=the path given back is the file whose bytes were read: through a link in its folders, the place it leads to (#3499); fails_when=the bytes come from one folder and the path names another
  it("through a link in its folders, is read and named where the link leads", async () => {
    const { files, named } = await setUp();
    const project = join(await createTempDataFolder(), "project");
    await mkdir(project);
    await writeFile(join(project, "deck.pptx"), "slides");
    await symlink(project, join(named, "shortcut"));
    expect(await files.readNamed(join(named, "shortcut", "deck.pptx"), LIMIT)).toEqual({
      kind: "read",
      bytes: new TextEncoder().encode("slides"),
      path: join(await realpath(project), "deck.pptx"),
    });
  });

  it("reads as unreadable, and nothing more, when it is a link, a folder, a pipe, a device or not there", async () => {
    const { files, named } = await setUp();
    const outside = join(await createTempDataFolder(), "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(named, "linked.png"));
    await mkdir(join(named, "folder.png"));
    const paths = [
      join(named, "linked.png"),
      join(named, "folder.png"),
      join(named, "missing.png"),
      "chart.png",
      "../secret.txt",
    ];
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [join(named, "pipe.png")]);
      paths.push(join(named, "pipe.png"), "/dev/zero", "/dev/null");
    }
    for (const path of paths) {
      expect(await files.readNamed(path, LIMIT), path).toEqual({ kind: "unreadable" });
    }
  });

  it("on Windows, never reaches a server or a device by its path", async () => {
    const files = createCanvasFiles(join(await createTempDataFolder(), "Canvases"), "win32");
    for (const path of [
      "\\\\server\\share\\chart.png",
      "//server/share/chart.png",
      "\\\\.\\PhysicalDrive0",
    ]) {
      expect(await files.readNamed(path, LIMIT), path).toEqual({ kind: "unreadable" });
    }
  });
});

describe("A Canvas's kept file", () => {
  it("is kept once under its SHA-256, and read back by it", async () => {
    const { files, kept } = await setUp();
    const bytes = new TextEncoder().encode("<p>Tides</p>");
    const hash = hashBytes(bytes);
    await files.write(hash, bytes);
    await files.write(hash, bytes);
    expect(await files.read(hash)).toEqual(bytes);
    expect(await readdir(join(kept, hash.slice(0, 2)))).toEqual([hash]);
    expect(await files.read("0".repeat(64))).toBeNull();
    await expect(files.read("../incarnamind.db")).rejects.toThrow();
  });
});
