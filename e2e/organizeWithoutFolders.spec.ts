import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  useLocalChatModel,
} from "./app";

/*
 * Organize where the User is, with no Folders yet (#2308): after linking a folder, and after
 * adding ten Documents, the Library's Not in a Folder offers Organize and ⌘K lists it. Organize
 * proposes Folders from what the Documents say (the scripted model names one for each first word
 * of their names), suggests one for each in To review, and one Undo takes back the suggestions and
 * the Folders it made. In English and Chinese.
 */

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const bridge = (window: Page) => ({
  folders: () =>
    window.evaluate(async () =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary()
      ).groups.map((group) => group.name),
    ),
  ready: () =>
    window.evaluate(
      async () =>
        (
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
        ).filter((each) => each.status === "ready").length,
    ),
});

/** Files on two subjects, `each` of each. */
async function files(each: number): Promise<string[]> {
  const paths: string[] = [];
  for (let at = 1; at <= each; at++) {
    const kitchen = join(sources, `Kitchen ${at}.txt`);
    await writeFile(kitchen, `Kitchen renovation, item ${at}: a quote for quartz countertops.`);
    const race = join(sources, `Race ${at}.txt`);
    await writeFile(race, `Marathon training, week ${at}: easy runs and one long run.`);
    paths.push(kitchen, race);
  }
  return paths;
}

/** Organize sorts with the scripted model on this computer, as the setup's sorting step sets it. */
async function sortWithLocalModel(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [provider] = await core.listChatProviders();
    if (!provider) throw new Error("No AI model was set up.");
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({
      ...settings,
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
      automatic: false,
    });
  });
}

const loose = (window: Page) =>
  window
    .getByTestId("library")
    .locator('[data-testid="library-section"][data-section="not-in-a-folder"]');

test("after linking a folder, the Library and ⌘K offer Organize, which proposes Folders and one Undo takes them back", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await useLocalChatModel(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1400, 900);
    await setLanguage(window, "en");
    await sortWithLocalModel(window);
    await files(2);
    await window.evaluate(async (path) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(
        path,
      );
    }, sources);
    await expect.poll(() => bridge(window).ready(), { timeout: 30_000 }).toBe(4);

    await runCommand(window, "library.open", "Open the Library");
    const organize = loose(window).getByTestId("library-organize");
    await expect(organize).toHaveText("Organize");
    await motionSettled(window);
    await screenshot(window, "organize-offered-en");
    expect(await paletteOffers(window, "library.organize", "Organize Documents")).toBe(1);

    await pointAndClick(window, organize);
    const review = window.getByTestId("library-review");
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "Sorted 4 Documents: 2 → Kitchen, 2 → Race",
      { timeout: 30_000 },
    );
    await expect(sidebarFolder(window, "Kitchen")).toBeVisible();
    await expect(sidebarFolder(window, "Race")).toBeVisible();
    expect(await bridge(window).folders()).toEqual(["Kitchen", "Race"]);
    await screenshot(window, "organize-proposed-en");

    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => bridge(window).folders()).toEqual([]);
    await expect(review).toHaveCount(0);
    await expect(organize).toBeVisible();

    // Redo brings the Folders back with their suggestions.
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => bridge(window).folders()).toEqual(["Kitchen", "Race"]);
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "Sorted 4 Documents: 2 → Kitchen, 2 → Race",
    );
  } finally {
    await app.close();
  }
});

test("after adding ten Documents, in Chinese, ⌘K's Organize proposes Folders and suggests one for each", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await useLocalChatModel(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 800);
    await setLanguage(window, "zh-CN");
    await sortWithLocalModel(window);
    await addDocuments(window, await files(5));
    await expect.poll(() => bridge(window).ready(), { timeout: 30_000 }).toBe(10);

    await runCommand(window, "library.open", "打开资料库");
    await expect(loose(window).getByTestId("library-organize")).toHaveText("整理");
    await motionSettled(window);
    await screenshot(window, "organize-offered-zh");
    expect(await paletteOffers(window, "library.organize", "整理不在文件夹中")).toBe(1);

    await runCommand(window, "library.organize", "整理不在文件夹中的文档");
    await expect(
      window.getByTestId("library-review").getByTestId("library-review-summary"),
    ).toHaveText("已整理 10 个文档：5 个 → “Kitchen”，5 个 → “Race”", { timeout: 30_000 });
    expect(await bridge(window).folders()).toEqual(["Kitchen", "Race"]);
    await screenshot(window, "organize-proposed-zh");
  } finally {
    await app.close();
  }
});
