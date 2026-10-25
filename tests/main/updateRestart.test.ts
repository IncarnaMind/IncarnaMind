import { describe, expect, test } from "vitest";
import { restartToInstall } from "../../src/main/updateRestart";

describe("restarting to install an update", () => {
  const attempt = async (quits: boolean) => {
    const calls: string[] = [];
    await restartToInstall(
      { quitAndInstall: () => calls.push("quitAndInstall") },
      async () => {
        calls.push("settleQuit");
        return quits;
      },
      () => calls.push("release"),
    );
    return calls;
  };

  test("settles quitting first, then lets go of the data folder, then installs", async () => {
    expect(await attempt(true)).toEqual(["settleQuit", "release", "quitAndInstall"]);
  });

  test("keeps the data folder and installs nothing when the User keeps the app open", async () => {
    expect(await attempt(false)).toEqual(["settleQuit"]);
  });
});
