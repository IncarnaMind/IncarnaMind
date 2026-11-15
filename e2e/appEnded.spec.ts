import { expect, test } from "@playwright/test";
import { createDataFolder, describeEarlyExit, launchApp, removeDataFolder } from "./app";

/*
 * A test whose app dies under it fails with Playwright's "Target page, context or browser has been
 * closed" and nothing about why (#3000). The harness keeps how the app's process ended and says it
 * in the failure of a test that lost its app, so a flake like that names its cause. A closed app
 * and a running one are not named.
 */

test("an app killed before its test closes it is named by the signal that ended it", async () => {
  const dataDir = await createDataFolder();
  try {
    const { app } = await launchApp(dataDir);
    const pid = app.process().pid;
    if (pid === undefined) throw new Error("The app has no process.");

    process.kill(pid, "SIGKILL");

    // Windows has no signals: a killed process there ends with an exit code.
    const how = process.platform === "win32" ? /exit code \d+/ : /signal SIGKILL/;
    await expect
      .poll(() => describeEarlyExit(dataDir))
      .toMatch(
        new RegExp(
          `ended \\d+\\.\\d s after it launched, before the test closed it: ${how.source}`,
        ),
      );
  } finally {
    await removeDataFolder(dataDir);
  }
});

test("an app the test closes, and one still running, are not named", async () => {
  const dataDir = await createDataFolder();
  try {
    const { app } = await launchApp(dataDir);
    expect(describeEarlyExit(dataDir)).toBeNull();

    await app.close();

    expect(describeEarlyExit(dataDir)).toBeNull();
  } finally {
    await removeDataFolder(dataDir);
  }
});
