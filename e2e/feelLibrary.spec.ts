import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  mindWrittenBefore,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  useOutputLocation,
} from "./app";
import { endFeel, startFeel } from "./feel";

let dataDir: string;
let sources: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(out);
});

const COUNT = 2000;

test("scrolling the Library with 2,000 Documents", async () => {
  test.setTimeout(300_000);
  const folder = join(sources, "Archive");
  await mkdir(folder);
  const paths = await Promise.all(
    Array.from({ length: COUNT }, async (_, index) => {
      const path = join(folder, `Report ${String(index + 1).padStart(4, "0")}.txt`);
      await writeFile(path, `Report ${index + 1}. The harbour handled ${index * 7} tonnes.\n`);
      return path;
    }),
  );
  const run = await startFeel(dataDir, "library-2000");
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await feel.step("add 2,000 Documents", async () => {
    await window.evaluate(async (files) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.addDocuments(files);
    }, paths);
    await expect
      .poll(
        () =>
          window.evaluate(
            async () =>
              (
                await (
                  globalThis as unknown as { incarnamind: CoreBridge }
                ).incarnamind.listDocuments()
              ).filter((each) => each.status === "ready").length,
          ),
        { timeout: 240_000 },
      )
      .toBe(COUNT);
  });

  const library = window.getByTestId("library");
  await feel.step("open the Library", async () => {
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(library.getByTestId("library-document").first()).toBeVisible();
  });
  await feel.step("show all 2,000", async () => {
    await pointAndClick(window, library.getByTestId("library-show-all"));
    await expect(library.getByTestId("library-document").nth(8)).toBeVisible();
  });
  const firstName =
    (await library.getByTestId("library-document-name").first().textContent()) ?? "";
  const firstRow = library.getByTestId("library-document").filter({ hasText: firstName }).first();
  await feel.step("scroll down", async () => {
    const box = await library.boundingBox();
    if (!box) throw new Error("The Library isn't showing.");
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let turn = 0; turn < 30; turn++) await window.mouse.wheel(0, 1200);
    await expect(firstRow).not.toBeInViewport();
  });
  await feel.step("scroll back up", async () => {
    for (let turn = 0; turn < 30; turn++) await window.mouse.wheel(0, -1200);
    await expect(firstRow).toBeInViewport();
  });

  await endFeel(run);
});

test("Export as Word", async () => {
  const run = await startFeel(dataDir, "export");
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, out);
  await mindWrittenBefore(window, "Harbour log", [
    { heading: "Arrivals" },
    { note: "Three ships came in on Monday, and two left on Tuesday." },
  ]);
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Harbour log" }),
  );
  await expect(window.locator('[data-testid="mind-editor"]:visible')).toContainText("Three ships");

  await feel.step("export as Word", async () => {
    await exportFromMenu(window, "docx");
    await expect(window.getByTestId("export-result").getByTestId("export-done")).toContainText(
      "Saved “Harbour log.docx”",
      { timeout: 30_000 },
    );
  });
  await feel.expectFocus("export as Word", window.getByTestId("export-mind"));

  await endFeel(run);
});
