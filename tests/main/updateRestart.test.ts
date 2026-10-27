import { describe, expect, test } from "vitest";
import { restartToInstall } from "../../src/main/updateRestart";

describe("restarting to install an update", () => {
  const attempt = async (quits: boolean, platform: NodeJS.Platform = "linux") => {
    const calls: string[] = [];
    await restartToInstall(
      { quitAndInstall: () => calls.push("quitAndInstall") },
      async () => {
        calls.push("settleQuit");
        return quits;
      },
      { releaseSingleInstanceLock: () => calls.push("releaseNative") },
      platform,
    );
    return calls;
  };

  test("settles quitting, then lets go of only the native AppImage lock before installing", async () => {
    expect(await attempt(true)).toEqual(["settleQuit", "releaseNative", "quitAndInstall"]);
  });

  test.each(["darwin", "win32"] as const)(
    "%s retains its native lock until exit",
    async (platform) => {
      expect(await attempt(true, platform)).toEqual(["settleQuit", "quitAndInstall"]);
    },
  );

  test("keeps the data folder and installs nothing when the User keeps the app open", async () => {
    expect(await attempt(false)).toEqual(["settleQuit"]);
  });
});
