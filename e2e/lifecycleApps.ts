import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import { isRecord } from "../src/core/errors";
import versions from "../tests/fixtures/lifecycle-versions.json";

export interface LifecycleApps {
  oldApp: string;
  updatedApp: string;
  oldVersion: string;
  updatedVersion: string;
  env: Record<string, string>;
}

const root = resolve(__dirname, "..");

function archiveOf(executable: string): string {
  return process.platform === "darwin"
    ? join(dirname(dirname(executable)), "Resources", "app.asar")
    : join(dirname(executable), "resources", "app.asar");
}

function packagedVersion(archive: string, expected: string): string {
  const value: unknown = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  if (!isRecord(value) || value.version !== expected)
    throw new Error(`The lifecycle package must have version ${expected}.`);
  return expected;
}

async function linked(source: string, destination: string): Promise<void> {
  try {
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    if ((await realpath(destination)) !== (await realpath(source))) throw error;
  }
}

async function localApp(folder: string, version: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  for (const name of ["resources", "build", "node_modules"])
    await linked(join(root, name), join(folder, name));
  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      name: "incarnamind",
      productName: "IncarnaMind",
      version,
      main: join(root, "out", "main", "lifecycle.cjs"),
    }),
  );
  return folder;
}

export async function prepareLifecycleApps(folder: string): Promise<LifecycleApps> {
  const packaged = process.env.INCARNAMIND_PACKAGED_APP;
  const updated = process.env.INCARNAMIND_PACKAGED_UPDATED_APP;
  let oldApp: string;
  let updatedApp: string;
  let oldVersion = versions.old;
  let updatedVersion = versions.updated;
  if (packaged !== undefined) {
    if (!packaged.trim() || !updated?.trim())
      throw new Error("Both packaged lifecycle executable paths are required.");
    oldApp = archiveOf(resolve(packaged));
    updatedApp = archiveOf(resolve(updated));
    oldVersion = packagedVersion(oldApp, versions.old);
    updatedVersion = packagedVersion(updatedApp, versions.updated);
  } else {
    await access(join(root, "out", "main", "index.js"));
    const bootstrap = join(root, "out", "main", "lifecycle.cjs");
    const temporary = `${bootstrap}.${randomUUID()}.tmp`;
    try {
      await copyFile(join(__dirname, "lifecycleMain.cjs"), temporary);
      await rename(temporary, bootstrap);
    } finally {
      await rm(temporary, { force: true });
    }
    oldApp = await localApp(join(folder, "old-app"), versions.old);
    updatedApp = await localApp(join(folder, "updated-app"), versions.updated);
  }
  return {
    oldApp,
    updatedApp,
    oldVersion,
    updatedVersion,
    env: {
      ...(packaged &&
        updated && {
          INCARNAMIND_PACKAGED_APP: packaged,
          INCARNAMIND_PACKAGED_UPDATED_APP: updated,
        }),
      INCARNAMIND_TEST_APP_DIR: oldApp,
      INCARNAMIND_TEST_UPDATED_APP_DIR: updatedApp,
      INCARNAMIND_TEST_UPDATE_APP: oldApp,
      INCARNAMIND_TEST_UPDATE_VERSION: updatedVersion,
    },
  };
}
