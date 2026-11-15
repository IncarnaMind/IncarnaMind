import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { LOG_FILE } from "../src/main/log";
import { createDataFolder, launchApp, removeDataFolder } from "./app";

/*
 * The harness fails a test whose app logged an uncaught error in its main process (#1741), so an
 * error in product code can't pass every spec silently. This checks the check: it fails the test
 * that saw one, and not one that saw none. Asserted in the test, so a check that works is a test
 * that passes, and one that stops working, or a launch that breaks, is a test that fails.
 */

const mainLog = (dataDir: string): string => {
  try {
    return readFileSync(join(dataDir, "logs", LOG_FILE), "utf8");
  } catch {
    return "";
  }
};

/** Throws once in the app's main process, from a timer, as an uncaught error does. */
const throwInMain = (app: ElectronApplication, message: string) =>
  app.evaluate((_electron, text) => {
    setTimeout(() => {
      throw new Error(text);
    }, 50);
  }, message);

/** Tears the folder down if the test failed before it did, so a failure leaves no app running. */
async function withDataFolder(body: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await createDataFolder();
  let removed = false;
  try {
    await body(dataDir);
    removed = true;
  } finally {
    // What failed is what the test reports; this only stops its app and folder outliving it.
    if (!removed) await removeDataFolder(dataDir).catch(() => undefined);
  }
}

test("an uncaught error in the app's main process fails the test that saw it", async () => {
  await withDataFolder(async (dataDir) => {
    const { app } = await launchApp(dataDir);
    await throwInMain(app, "deliberate for the harness");
    await expect.poll(() => mainLog(dataDir)).toContain("deliberate for the harness");

    await expect(removeDataFolder(dataDir)).rejects.toThrow(
      /main process threw an uncaught error[\s\S]*deliberate for the harness/,
    );
  });
});

test("an app that logged no uncaught error is torn down without one", async () => {
  await withDataFolder(async (dataDir) => {
    await launchApp(dataDir);

    await expect(removeDataFolder(dataDir)).resolves.toBeUndefined();
  });
});
