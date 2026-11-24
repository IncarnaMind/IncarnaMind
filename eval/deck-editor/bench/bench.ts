import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

export const workDir = process.env.DECK_EDITOR_DIR ?? "";
const root = join(__dirname, "../../..");

/** Opens one arm's page in the bench's window, with a home, data folder and request log of the run's own. */
export async function openBench(
  page: string,
  name: string,
): Promise<{ app: ElectronApplication; window: Page; requests: string }> {
  if (!workDir) throw new Error("Set DECK_EDITOR_DIR.");
  const data = join(workDir, "data", name);
  mkdirSync(data, { recursive: true });
  const requests = join(workDir, "logs", `requests-${name}.jsonl`);
  const executable = join(
    root,
    "node_modules/electron/dist",
    readFileSync(join(root, "node_modules/electron/path.txt"), "utf8"),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [
      join(workDir, "bench/host/host.js"),
      "--page",
      page,
      "--requests",
      requests,
      "--data",
      data,
      "--use-mock-keychain",
    ],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(workDir, "home"),
      TMPDIR: join(workDir, "tmp"),
      LANG: "en_US.UTF-8",
    },
  });
  const window = await app.firstWindow();
  return { app, window, requests };
}
