import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { appLink } from "../src/shared/appLinks";
import { createDataFolder, frontMindName, launchApp, removeDataFolder } from "./app";

/*
 * The app's own link (#3534, ADR-0033): handed over by the system, it shows its Note in front,
 * whether it comes while IncarnaMind runs (macOS sends it as an event) or starts it (Windows and
 * Linux start the app with it as an argument). One for a Note that isn't there opens nothing.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

type Bridge = { incarnamind: CoreBridge };
const made = (window: Page, title: string) =>
  window.evaluate(
    async (name) =>
      (await (globalThis as unknown as Bridge).incarnamind.createMind({ title: name })).id,
    title,
  );
const tabs = (window: Page) => window.getByTestId("mind-tab");

test("an app link shows its Note in front, while the app runs and when it starts it; one for a Note that isn't there opens nothing", async () => {
  const running = await launchApp(dataDir);
  const { app, window } = running;
  const harbour = await made(window, "Harbour report");
  const tides = await made(window, "Tide notes");
  const handOver = (link: string) =>
    app.evaluate(({ app: electron }, url) => {
      electron.emit("open-url", { preventDefault: () => undefined }, url);
    }, link);

  await handOver(appLink({ kind: "note", id: harbour }));
  await expect(frontMindName(window)).toHaveText("Harbour report");
  await handOver(appLink({ kind: "note", id: tides }));
  await expect(frontMindName(window)).toHaveText("Tide notes");
  const open = await tabs(window).count();

  await handOver(appLink({ kind: "note", id: crypto.randomUUID() }));
  await handOver(`${appLink({ kind: "note", id: harbour })}?delete=1`);
  await expect(frontMindName(window)).toHaveText("Tide notes");
  await expect(tabs(window)).toHaveCount(open);
  await app.close();

  const started = await launchApp(dataDir, { extraArgs: [appLink({ kind: "note", id: harbour })] });
  await expect(frontMindName(started.window)).toHaveText("Harbour report");
  await started.app.close();
});
