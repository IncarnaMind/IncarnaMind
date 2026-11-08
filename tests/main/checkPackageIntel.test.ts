import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterEach, beforeEach, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-package.mjs", import.meta.url));

let parent = "";
let folder = "";
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "incarnamind-check-package-"));
  // A checkout in a folder named like the Intel app's must not read as one.
  folder = join(parent, "mac");
  await mkdir(join(folder, "app", "out"), { recursive: true });
  await writeFile(join(folder, "app", "package.json"), "{}");
  await writeFile(join(folder, "app", "out", "index.js"), "");
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

async function packApp(platformFolder: string) {
  const resources = join(
    folder,
    "dist",
    platformFolder,
    "IncarnaMind.app",
    "Contents",
    "Resources",
  );
  await mkdir(resources, { recursive: true });
  await createPackage(join(folder, "app"), join(resources, "app.asar"));
}

const updates = (files: string[]) =>
  `version: 1.0.0\nfiles:\n${files.map((file) => `  - url: ${file}\n    sha512: x\n`).join("")}path: ${files[0]}\n`;

/** The package check's failures about Intel Macs (#2199); this fake package fails its other checks too. */
function intelFailures(): string[] {
  const { stderr } = spawnSync(process.execPath, [SCRIPT, join(folder, "dist")], {
    encoding: "utf8",
  });
  return stderr.split("\n").filter((line) => /Intel|Apple silicon|latest-mac\.yml/.test(line));
}

test("an Intel macOS app, installer or update file fails the package check", async () => {
  await packApp("mac-arm64");
  await packApp("mac");
  await writeFile(join(folder, "dist", "IncarnaMind-1.0.0-mac-x64.dmg"), "");
  await writeFile(
    join(folder, "dist", "latest-mac.yml"),
    updates(["IncarnaMind-1.0.0-mac-arm64.zip", "IncarnaMind-1.0.0-mac-x64.zip"]),
  );
  const failures = intelFailures();
  expect(failures).toHaveLength(3);
  expect(failures.join("\n")).toContain(join("dist", "mac", "IncarnaMind.app"));
  expect(failures.join("\n")).toContain("IncarnaMind-1.0.0-mac-x64.dmg");
  expect(failures.join("\n")).toContain(
    "latest-mac.yml offers files that aren't for Apple silicon: IncarnaMind-1.0.0-mac-x64.zip",
  );
});

test("an Apple silicon build passes it", async () => {
  await packApp("mac-arm64");
  await writeFile(join(folder, "dist", "IncarnaMind-1.0.0-mac-arm64.dmg"), "");
  await writeFile(
    join(folder, "dist", "latest-mac.yml"),
    updates(["IncarnaMind-1.0.0-mac-arm64.zip", "IncarnaMind-1.0.0-mac-arm64.dmg"]),
  );
  expect(intelFailures()).toEqual([]);
});

test("a universal macOS app and its update file fail it too", async () => {
  await packApp("mac-universal");
  await writeFile(
    join(folder, "dist", "latest-mac.yml"),
    updates(["IncarnaMind-1.0.0-mac-universal.zip"]),
  );
  const failures = intelFailures().join("\n");
  expect(failures).toContain(join("dist", "mac-universal", "IncarnaMind.app"));
  expect(failures).toContain(
    "latest-mac.yml offers files that aren't for Apple silicon: IncarnaMind-1.0.0-mac-universal.zip",
  );
});

test("a latest-mac.yml that offers no file at all fails it", async () => {
  await packApp("mac-arm64");
  await writeFile(join(folder, "dist", "latest-mac.yml"), "version: 1.0.0\nfiles: []\n");
  expect(intelFailures()).toEqual(["FAIL: latest-mac.yml offers no file to update to"]);
});

const lipo = spawnSync("lipo", ["-archs", process.execPath], { encoding: "utf8" });

test.skipIf(lipo.status !== 0 || lipo.stdout.trim() !== "arm64")(
  "on macOS it reads an app's architectures from its executable, whatever its folder is called",
  async () => {
    await packApp("mac-arm64");
    const programs = join(folder, "dist", "mac-arm64", "IncarnaMind.app", "Contents", "MacOS");
    await mkdir(programs, { recursive: true });
    await symlink(process.execPath, join(programs, "IncarnaMind"));
    expect(intelFailures()).toEqual([]);
    await rm(join(programs, "IncarnaMind"));
    // A system program built for both Intel and Apple silicon.
    await symlink("/usr/bin/true", join(programs, "IncarnaMind"));
    expect(intelFailures().join("\n")).toContain(join("dist", "mac-arm64", "IncarnaMind.app"));
  },
);

/** The package check's failures about run_code's Python (ADR-0025). */
function nativePythonFailures(): string[] {
  const { stderr } = spawnSync(process.execPath, [SCRIPT, join(folder, "dist")], {
    encoding: "utf8",
  });
  return stderr.split("\n").filter((line) => /python-native|run_code's Python/.test(line));
}

const resourcesOf = (platformFolder: string) =>
  join(folder, "dist", platformFolder, "IncarnaMind.app", "Contents", "Resources");

async function writeRuntimeJson(platformFolder: string, runtime: object) {
  await mkdir(join(resourcesOf(platformFolder), "python-native"), { recursive: true });
  await writeFile(
    join(resourcesOf(platformFolder), "python-native", "runtime.json"),
    JSON.stringify(runtime),
  );
}

const runtime = {
  file: "python-runtime-darwin-arm64.tar.zst",
  url: "https://example.invalid/python-runtime-darwin-arm64.tar.zst",
  size: 81_000_000,
  sha256: "a".repeat(64),
  platform: "darwin-arm64",
  python: "3.14.10",
  packages: { numpy: "2.5.4" },
};

test("a macOS app needs the runtime.json of run_code's Python beside app.asar", async () => {
  await packApp("mac-arm64");
  expect(nativePythonFailures()).toEqual([
    `FAIL: ${join(resourcesOf("mac-arm64"), "app.asar")} has no python-native/runtime.json beside it (npm run python:native)`,
  ]);
  await writeRuntimeJson("mac-arm64", runtime);
  expect(nativePythonFailures()).toEqual([]);
});

test("a runtime.json without a SHA-256 and size, or for another platform, fails the check", async () => {
  await packApp("mac-arm64");
  await writeRuntimeJson("mac-arm64", { ...runtime, sha256: "", platform: "linux-x64" });
  const failures = nativePythonFailures().join("\n");
  expect(failures).toContain("gives no SHA-256 and size for run_code's Python");
  expect(failures).toContain("python-native/runtime.json is for linux-x64, not darwin-arm64");
});

test("the runtime's archive inside the app fails the check", async () => {
  await packApp("mac-arm64");
  await writeRuntimeJson("mac-arm64", runtime);
  const archive = join(
    resourcesOf("mac-arm64"),
    "python-native",
    "python-runtime-darwin-arm64.tar.zst",
  );
  await writeFile(archive, "");
  // Beside the apps, where python:native writes it for the release, it is no part of any app.
  await writeFile(join(folder, "dist", "python-runtime-darwin-arm64.tar.zst"), "");
  expect(nativePythonFailures()).toEqual([
    `FAIL: ${archive} is run_code's Python, which the app downloads and never ships`,
  ]);
});

/** The package check's failures about the Mac calendar helper (#190). */
function calendarHelperFailures(): string[] {
  const { stderr } = spawnSync(process.execPath, [SCRIPT, join(folder, "dist")], {
    encoding: "utf8",
  });
  return stderr.split("\n").filter((line) => /calendar helper|calendar-helper/.test(line));
}

test("a macOS app without an executable calendar helper beside app.asar fails the check", async () => {
  await packApp("mac-arm64");
  const helper = join(resourcesOf("mac-arm64"), "calendar-helper");
  expect(calendarHelperFailures()).toEqual([
    `FAIL: ${join(resourcesOf("mac-arm64"), "app.asar")} has no executable calendar-helper beside it (#190)`,
  ]);
  await writeFile(helper, "");
  expect(calendarHelperFailures()).toHaveLength(1);
  await chmod(helper, 0o755);
  expect(calendarHelperFailures()).toEqual([]);
});

test("a calendar helper in an app for another system fails the check", async () => {
  const resources = join(folder, "dist", "linux-unpacked", "resources");
  await mkdir(resources, { recursive: true });
  await createPackage(join(folder, "app"), join(resources, "app.asar"));
  await writeFile(join(resources, "calendar-helper"), "");
  expect(calendarHelperFailures()).toEqual([
    `FAIL: ${join(resources, "calendar-helper")} is the Mac calendar helper, in an app for another system`,
  ]);
});

test.skipIf(lipo.status !== 0 || lipo.stdout.trim() !== "arm64")(
  "on macOS a calendar helper built for Intel Macs too fails the check",
  async () => {
    await packApp("mac-arm64");
    const helper = join(resourcesOf("mac-arm64"), "calendar-helper");
    // A system program built for both Intel and Apple silicon.
    await copyFile("/usr/bin/true", helper);
    await chmod(helper, 0o755);
    expect(calendarHelperFailures().join("\n")).toContain("not Apple silicon alone");
  },
);
