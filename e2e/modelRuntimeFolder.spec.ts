import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DATABASE_FILE } from "../src/core";
import { openDatabase } from "../src/core/storage";
import { modelRuntimeFolderPath } from "../src/main/modelRuntimeFolder";
import {
  createDataFolder,
  dismissChatSetup,
  interceptShowItemInFolder,
  launchApp,
  openPrivacySettings,
  pathsShown,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { lifecycleHomeEnv } from "./lifecycle";

let dataDir: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  test.skip(folderPath() === null, "The runtime's Windows library keeps no folder");
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});

const folderPath = () =>
  modelRuntimeFolderPath({ platform: process.platform, home, env: lifecycleHomeEnv(home) });

async function putRuntimeFolder(): Promise<string> {
  const path = folderPath();
  if (path === null) throw new Error("This computer's runtime keeps no folder.");
  await mkdir(path, { recursive: true });
  return path;
}

/** Starts the app once and quits, so the data folder is one an earlier version could have made. */
async function installedEarlier(): Promise<void> {
  const { app } = await launchApp(dataDir, { home });
  await app.close();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.run("UPDATE schema_migrations SET applied_at = '2026-10-15T09:00:00.000Z' WHERE version = 1");
  db.close();
}

const LINE_EN =
  "Microsoft’s model runtime keeps usage data in a folder on this computer, and earlier versions of IncarnaMind added to it. It is safe to delete.";

test("Privacy says where Microsoft's model runtime keeps usage data an earlier version added to, and shows the folder", async () => {
  const path = await putRuntimeFolder();
  await installedEarlier();
  const { app, window } = await launchApp(dataDir, { home });
  await interceptShowItemInFolder(app);
  await setWindowSize(app, window, 1000, 700);
  await dismissChatSetup(window);
  const privacy = await openPrivacySettings(window);

  const line = privacy.getByTestId("model-runtime-folder");
  await expect(line).toContainText(LINE_EN);
  await expect(line).toHaveAttribute("title", path);
  const show = line.getByTestId("model-runtime-folder-show");
  await expect(show).toHaveText(
    process.platform === "darwin" ? "Show in Finder" : "Show in folder",
  );
  await show.click();
  await expect.poll(() => pathsShown(app)).toEqual([path]);

  await setLanguage(window, "zh-CN");
  await expect(line).toContainText(
    "Microsoft 的模型运行库在这台电脑上的一个文件夹里保存了使用数据，早期版本的 IncarnaMind 也写入过。可以放心删除。",
  );
  await expect(show).toHaveText(process.platform === "darwin" ? "在访达中显示" : "在文件夹中显示");

  // The User deletes it in the file manager and comes back: the line goes.
  await rm(path, { recursive: true });
  await window.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await expect(line).toHaveCount(0);
});

test("Privacy says nothing of it when the folder isn't there", async () => {
  await installedEarlier();
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1000, 700);
  await dismissChatSetup(window);
  const privacy = await openPrivacySettings(window);
  await expect(privacy).toContainText("collects no usage data");
  await expect(privacy.getByTestId("model-runtime-folder")).toHaveCount(0);
});

test("Privacy says nothing of it on a new install, whoever made the folder", async () => {
  await putRuntimeFolder();
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1000, 700);
  await dismissChatSetup(window);
  const privacy = await openPrivacySettings(window);
  await expect(privacy).toContainText("collects no usage data");
  await expect(privacy.getByTestId("model-runtime-folder")).toHaveCount(0);
});
