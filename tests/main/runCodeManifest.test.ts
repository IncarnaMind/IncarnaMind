import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readPythonManifest, runtimePlatform } from "../../src/main/runCode";
import { missingPackages } from "../../src/main/sandbox";

const GOOD = {
  file: "python-runtime-darwin-arm64.tar.zst",
  url: "https://github.com/IncarnaMind/IncarnaMind/releases/download/v0.2.0/python-runtime-darwin-arm64.tar.zst",
  size: 74_123_456,
  sha256: "a".repeat(64),
  platform: "darwin-arm64",
  python: "3.14.10",
  packages: { numpy: "2.5.4", pandas: "3.1.0" },
};

async function manifest(content: unknown) {
  const folder = await mkdtemp(join(tmpdir(), "manifest-"));
  const file = join(folder, "runtime.json");
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  const warnings: string[] = [];
  const read = readPythonManifest(file, "darwin-arm64", (reason) => warnings.push(reason));
  return { read, warnings };
}

describe("the runtime manifest built into the app", () => {
  test("is read as the build wrote it", async () => {
    const { read, warnings } = await manifest(GOOD);
    expect(read).toEqual(GOOD);
    expect(warnings).toEqual([]);
  });

  test("a copy without one runs bash alone, and says nothing", async () => {
    const warnings: string[] = [];
    expect(
      readPythonManifest(join(tmpdir(), "no-such-runtime.json"), "linux-x64", (r) =>
        warnings.push(r),
      ),
    ).toBe(null);
    expect(warnings).toEqual([]);
  });

  test.each([
    ["another platform's", { ...GOOD, platform: "linux-x64" }],
    ["a short hash", { ...GOOD, sha256: "abc" }],
    ["a plain-http host", { ...GOOD, url: "http://example.com/python.tar.zst" }],
    ["a file with a folder in its name", { ...GOOD, file: "../python.tar.zst" }],
    ["no size", { ...GOOD, size: 0 }],
    ["a package without a version", { ...GOOD, packages: { numpy: "" } }],
    ["not JSON", "{"],
  ])("refuses %s, and the log says why", async (_name, content) => {
    const { read, warnings } = await manifest(content);
    expect(read).toBe(null);
    expect(warnings).toHaveLength(1);
  });

  test("a stand-in release on this computer is allowed, as tests serve one", async () => {
    const { read } = await manifest({
      ...GOOD,
      url: "http://127.0.0.1:4100/python-runtime-darwin-arm64.tar.zst",
    });
    expect(read?.url).toBe("http://127.0.0.1:4100/python-runtime-darwin-arm64.tar.zst");
  });

  test("names this computer as the archives do", () => {
    expect(runtimePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(runtimePlatform("linux", "x64")).toBe("linux-x64");
  });
});

test("the packages a Linux sandbox lacks are named as distributions name them", () => {
  expect(missingPackages(["bubblewrap (bwrap) not installed", "socat not installed"])).toEqual([
    "bubblewrap",
    "socat",
  ]);
  expect(missingPackages(["socat not installed"])).toEqual(["socat"]);
  expect(missingPackages(["ripgrep (rg) not found"])).toEqual(["ripgrep"]);
  expect(missingPackages(["seccomp not available"])).toEqual([]);
});
