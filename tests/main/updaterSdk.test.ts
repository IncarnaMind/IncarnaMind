import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UpdaterAppFixture, UpdaterSdkFixture } from "../helpers/updaterSdk";

let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "incarnamind-updater-sdk-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

test("an enabled downloaded updater registers its real quit handler and honours a later veto", async () => {
  const app = new UpdaterAppFixture(folder);
  const sdk = new UpdaterSdkFixture(app);
  sdk.autoInstallOnAppQuit = true;
  await sdk.completeFixtureDownload();
  expect(app.events.listenerCount("quit")).toBe(1);
  sdk.autoInstallOnAppQuit = false;
  app.quit();
  expect(sdk.installations).toEqual([]);
});

test("a disabled download never registers a quit handler when enabled later", async () => {
  const app = new UpdaterAppFixture(folder);
  const sdk = new UpdaterSdkFixture(app);
  sdk.autoInstallOnAppQuit = false;
  await sdk.completeFixtureDownload();
  expect(app.events.listenerCount("quit")).toBe(0);
  sdk.autoInstallOnAppQuit = true;
  app.quit();
  expect(sdk.installations).toEqual([]);
});

test.each([false, true])(
  "preparation precedes the real SDK terminal install (failure=%s)",
  async (fails) => {
    const app = new UpdaterAppFixture(folder);
    const order: string[] = [];
    const prepare = vi.fn(() => order.push("prepare"));
    app.events.on("quit", prepare);
    const sdk = new UpdaterSdkFixture(app, () => order.push("install"));
    const error = new Error("The fixture installer failed.");
    if (fails) sdk.installationError = error;
    const failed = vi.fn((seen: Error) => {
      expect(seen).toBe(error);
      expect(prepare).toHaveBeenCalledOnce();
      order.push("error");
    });
    sdk.on("error", failed);
    sdk.autoInstallOnAppQuit = true;
    await sdk.completeFixtureDownload();
    expect(app.events.listenerCount("quit")).toBe(2);
    app.quit();
    expect(sdk.installations).toEqual([
      { isSilent: true, isForceRunAfter: false, isAdminRightsRequired: false },
    ]);
    expect(order).toEqual(fails ? ["prepare", "install", "error"] : ["prepare", "install"]);
    expect(failed).toHaveBeenCalledTimes(fails ? 1 : 0);
  },
);

test("an explicit installer error followed by terminal quit does not install twice", async () => {
  const app = new UpdaterAppFixture(folder);
  const order: string[] = [];
  const sdk = new UpdaterSdkFixture(app, () => order.push("install"));
  sdk.autoInstallOnAppQuit = true;
  await sdk.completeFixtureDownload();
  sdk.installationError = new Error("The explicit fixture installer failed.");
  const failed = vi.fn(() => {
    order.push("error");
    app.quit();
  });
  sdk.on("error", failed);
  sdk.quitAndInstall();
  expect(sdk.installations).toEqual([
    { isSilent: false, isForceRunAfter: true, isAdminRightsRequired: false },
  ]);
  expect(failed).toHaveBeenCalledOnce();
  expect(order).toEqual(["install", "error"]);
  expect(sdk.autoInstallOnAppQuit).toBe(true);
});

test("terminal auto-install remains one-shot when its error causes another terminal event", async () => {
  const app = new UpdaterAppFixture(folder);
  const sdk = new UpdaterSdkFixture(app);
  sdk.autoInstallOnAppQuit = true;
  await sdk.completeFixtureDownload();
  sdk.installationError = new Error("The automatic fixture installer failed.");
  const failed = vi.fn(() => app.quit());
  sdk.on("error", failed);
  app.quit();
  app.quit();
  expect(sdk.installations).toEqual([
    { isSilent: true, isForceRunAfter: false, isAdminRightsRequired: false },
  ]);
  expect(failed).toHaveBeenCalledOnce();
  expect(sdk.autoInstallOnAppQuit).toBe(true);
});

test("reporting a terminal preparation failure does not cancel the real SDK install", async () => {
  const app = new UpdaterAppFixture(folder);
  const order: string[] = [];
  const parent = join(folder, "not-a-directory");
  writeFileSync(parent, "fixture");
  const failures: unknown[] = [];
  app.events.on("quit", () => {
    order.push("prepare");
    try {
      writeFileSync(join(parent, "handoff.json"), "{}");
    } catch (error) {
      failures.push(error);
      order.push("prepare-error");
    }
  });
  const sdk = new UpdaterSdkFixture(app, () => order.push("install"));
  sdk.autoInstallOnAppQuit = true;
  await sdk.completeFixtureDownload();
  app.quit();
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(Error);
  expect(order).toEqual(["prepare", "prepare-error", "install"]);
  expect(sdk.installations).toHaveLength(1);
  expect(sdk.autoInstallOnAppQuit).toBe(true);
});
