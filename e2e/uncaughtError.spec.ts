import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { LOG_FILE } from "../src/main/log";
import { createDataFolder, launchApp, removeDataFolder } from "./app";

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

test("an uncaught error in the app's main process fails the test that saw it", async () => {
  // The failure under test is removeDataFolder's, so everything that sets it up skips instead:
  // a teardown that passes then makes Playwright report this expected failure as an unexpected
  // pass, and a setup that broke cannot pass for the wrong reason.
  test.fail();
  const dataDir = await createDataFolder();
  try {
    const setup = await launchApp(dataDir).then(
      async ({ app }) => {
        await throwInMain(app, "deliberate for the harness");
        await expect.poll(() => mainLog(dataDir)).toContain("deliberate for the harness");
        return true;
      },
      (error: unknown) => String(error),
    );
    if (setup !== true) test.skip(true, `the deliberate error could not be made: ${setup}`);
  } finally {
    await removeDataFolder(dataDir);
  }
});
