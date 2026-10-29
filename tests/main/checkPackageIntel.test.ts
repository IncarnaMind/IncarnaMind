import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  return stderr.split("\n").filter((line) => /Intel|Apple silicon/.test(line));
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
