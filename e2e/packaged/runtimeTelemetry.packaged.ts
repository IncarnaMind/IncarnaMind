import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { coreOf, dismissChatSetup, setWindowSize } from "../app";
import {
  copyModelsIn,
  copyModelsOut,
  launchPackaged,
  packagedExecutable,
  packagedLogLines,
  runtimeTelemetryFolders,
} from "./app";

test.skip(process.platform !== "darwin", "CI builds and runs the packaged app on macOS only");

let app: ElectronApplication | undefined;
let dataDir = "";
const folders: string[] = [];

test.afterEach(async () => {
  const testInfo = test.info();
  await app?.close();
  app = undefined;
  if (testInfo.status !== testInfo.expectedStatus && dataDir) {
    const lines = await packagedLogLines(dataDir, /ERROR|WARN/);
    await testInfo.attach("app log", { body: lines.join("\n"), contentType: "text/plain" });
    console.log(lines.slice(-30).join("\n"));
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const paragraphs = Array.from(
  { length: 200 },
  (_, at) =>
    `Harbour log, entry ${at + 1}. The tide table for berth ${at + 1} lists the water level, the pilot's call and the lock keeper's hours.`,
);

// protects=the models' runtime, onnxruntime, sends no usage telemetry from the packaged app: it makes none of the folder it keeps its device id and event queue in, after the reranking model has really run (#2145); fails_when=an engine process starts without the runtime's opt-out, which the runtime ignores only in a CI run, or on a computer where a Check or a search ranks results; no_claim=Windows and Linux (the runtime's Windows library has no folder or connection), network traffic as such, or the speech engine.
test("the packaged app's reranking model runs without onnxruntime's telemetry folder", async () => {
  test.setTimeout(20 * 60_000);
  expect(existsSync(packagedExecutable), `${packagedExecutable} isn't built yet`).toBe(true);
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
  const sources = await mkdtemp(join(tmpdir(), "incarnamind-sources-"));
  folders.push(home, dataDir, sources);
  await copyModelsIn(dataDir);
  app = await launchPackaged(home, dataDir, { testHooks: true });
  const window = await app.firstWindow();
  await setWindowSize(app, window, 1000, 640);
  await dismissChatSetup(window);

  const path = join(sources, "harbour.txt");
  await writeFile(path, paragraphs.join("\n\n"));
  await window.getByTestId("add-documents-input").setInputFiles(path);
  const row = window.getByTestId("document-list-item").filter({ hasText: "harbour" });
  await expect.poll(() => row.getAttribute("data-status"), { timeout: 3 * 60_000 }).toBe("ready");

  // The built-in reranking model downloads itself once a Document is ready to search.
  const bridge = await coreOf(window);
  await expect
    .poll(() => bridge.evaluate((core) => core.getRerankSettings().then((r) => r.model.state)), {
      timeout: 15 * 60_000,
    })
    .toBe("ready");
  const found = await bridge.evaluate((core) => core.searchEvidence("tide table lock keeper"));
  expect(found.passages.length).toBeGreaterThan(1);
  // Null until the model has run, in the reranking process.
  await expect
    .poll(() => bridge.evaluate((core) => core.getRerankSettings().then((r) => r.runsOn)), {
      timeout: 2 * 60_000,
    })
    .not.toBeNull();
  await bridge.dispose();

  await app.close();
  app = undefined;
  // A folder here means onnxruntime ran with its telemetry on.
  expect(runtimeTelemetryFolders(home).filter(existsSync)).toEqual([]);
  await copyModelsOut(dataDir);
});
