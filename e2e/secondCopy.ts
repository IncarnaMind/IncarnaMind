import { spawn } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";

export async function startAnotherCopy(app: ElectronApplication) {
  const { execPath, argv, env } = await app.evaluate(() => ({
    execPath: process.execPath,
    argv: process.argv.slice(1),
    env: { ...process.env },
  }));
  return spawn(execPath, argv, { env, stdio: "ignore" });
}
