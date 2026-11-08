import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  leaveText,
  motionSettled,
  organizeWithChatModel,
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
 * Organize where the User is, with no Folders yet (#2308, #1569): after linking a folder, and
 * after adding ten Documents, the Library's Not in a Folder offers Organize and ⌘K lists it.
 * Organize proposes Folders from what the Documents say (the scripted model names one for each
 * first word of their names) in the Review, and makes none of them until Confirm; one Undo takes
 * the Confirm back, Folders and all. In English and Chinese.
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
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary()).groups
        .map((group) => group.name)
        .sort(),
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

const loose = (window: Page) =>
  window
    .getByTestId("library")
    .locator('[data-testid="library-section"][data-section="not-in-a-folder"]');

/** A card of the Review, by the name of the Folder it proposes. */
const card = (window: Page, name: string) =>
  window.getByTestId("organize-review-card").filter({
    has: window
      .getByTestId("organize-review-card-name")
      .filter({ hasText: new RegExp(`^${name}$`) }),
  });

/** The Review's line: "8 Documents will move into 2 new Folders. Nothing has moved yet." */
const willMove = (language: "en" | "zh-CN", documents: number, folders: number) =>
  translate(language, "organizeReview.willMove", {
    documents: translate(language, "organizeReview.documents", { count: documents }),
    into: translate(language, "organizeReview.into.new", { count: folders }),
  });

/** The Review proposes Kitchen and Race with `each` Documents in each, and nothing is made yet. */
async function proposed(window: Page, language: "en" | "zh-CN", each: number): Promise<void> {
  await expect(window.getByTestId("organize-review")).toBeVisible({ timeout: 30_000 });
  await expect(window.getByTestId("organize-review-title")).toHaveText(
    translate(language, "organizeReview.title"),
  );
  await expect(window.getByTestId("organize-review-will-move")).toHaveText(
    willMove(language, each * 2, 2),
  );
  for (const name of ["Kitchen", "Race"])
    await expect(card(window, name).getByTestId("organize-review-row")).toHaveCount(each);
  expect(await bridge(window).folders()).toEqual([]);
  await expect(sidebarFolder(window, "Kitchen")).toHaveCount(0);
}

test("after linking a folder, the Library and ⌘K offer Organize, which proposes Folders that Confirm makes and one Undo takes back", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await useLocalChatModel(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1400, 900);
    await setLanguage(window, "en");
    await organizeWithChatModel(window);
    // Three of each: a new Folder needs at least three Documents.
    await files(3);
    await window.evaluate(async (path) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(
        path,
      );
    }, sources);
    await expect.poll(() => bridge(window).ready(), { timeout: 30_000 }).toBe(6);

    await runCommand(window, "library.open", "Open the Library");
    const organize = loose(window).getByTestId("library-organize");
    await expect(organize).toHaveText("Organize");
    await motionSettled(window);
    await screenshot(window, "organize-offered-en");
    expect(await paletteOffers(window, "library.organize", "Organize Documents")).toBe(1);

    await pointAndClick(window, organize);
    await proposed(window, "en", 3);
    await screenshot(window, "organize-proposed-en");

    // Confirm makes the Folders and files the Documents in them.
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(window.getByTestId("organize-review")).toHaveCount(0);
    await expect.poll(() => bridge(window).folders()).toEqual(["Kitchen", "Race"]);
    await expect(sidebarFolder(window, "Kitchen")).toBeVisible();
    await expect(sidebarFolder(window, "Race")).toBeVisible();

    // One Undo takes the Folders back, and brings the Review back as it was.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => bridge(window).folders()).toEqual([]);
    await proposed(window, "en", 3);

    // Redo makes them again.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => bridge(window).folders()).toEqual(["Kitchen", "Race"]);
    await expect(window.getByTestId("organize-review")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("after adding ten Documents, in Chinese, ⌘K's Organize proposes Folders for them in the Review", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await useLocalChatModel(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 800);
    await setLanguage(window, "zh-CN");
    await organizeWithChatModel(window);
    await addDocuments(window, await files(5));
    await expect.poll(() => bridge(window).ready(), { timeout: 30_000 }).toBe(10);

    await runCommand(window, "library.open", "打开资料库");
    await expect(loose(window).getByTestId("library-organize")).toHaveText("整理");
    await motionSettled(window);
    await screenshot(window, "organize-offered-zh");
    expect(await paletteOffers(window, "library.organize", "整理不在文件夹中")).toBe(1);

    await runCommand(window, "library.organize", "整理不在文件夹中的文档");
    await proposed(window, "zh-CN", 5);
    await screenshot(window, "organize-proposed-zh");
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`the Library's one primary action organizes 8 loose Documents, in ${language} (#1942)`, async () => {
    test.setTimeout(180_000);
    const paths = await files(4);
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    await useLocalChatModel(window);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await organizeWithChatModel(window);
      await window.getByTestId("add-documents-input").setInputFiles(paths.slice(0, 7));
      await expect.poll(() => bridge(window).ready(), { timeout: 30_000 }).toBe(7);
      await runCommand(
        window,
        "library.open",
        language === "en" ? "Open the Library" : "打开资料库",
      );
      const button = window.getByTestId("library-sort-into-folders");
      // Seven is one short: nothing offers Folders yet.
      await expect(button).toHaveCount(0);

      await window.getByTestId("add-documents-input").setInputFiles(paths.slice(7));
      await expect.poll(() => bridge(window).ready(), { timeout: 30_000 }).toBe(8);
      await expect(button).toBeVisible();
      await expect(button).toHaveText(translate(language, "library.organizeCount", { count: "8" }));

      // It holds at the narrowest and the widest window, inside them.
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 700);
        await expect(button).toBeVisible();
        const [box, size] = await Promise.all([
          button.boundingBox(),
          window.evaluate(() => ({ width: innerWidth })),
        ]);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
        await motionSettled(window);
        await screenshot(window, `sort-offer-${language}-${width}`);
      }

      // One click, in place: the Review proposes Folders from what the Documents say.
      await pointAndClick(window, button);
      await proposed(window, language, 4);

      // Confirmed, there are Folders and the offer is gone; its Undo brings the Review back.
      await pointAndClick(window, window.getByTestId("organize-review-confirm"));
      await expect.poll(() => bridge(window).folders()).toEqual(["Kitchen", "Race"]);
      await expect(button).toHaveCount(0);
      const undoLine = window.getByTestId("undo-line-here");
      await expect(undoLine.getByTestId("undo-message")).toHaveText(
        translate(language, "organizeReview.organized", { count: 8 }),
      );
      await pointAndClick(window, undoLine.getByTestId("undo-action"));
      await expect.poll(() => bridge(window).folders()).toEqual([]);
      await proposed(window, language, 4);

      // Discarded, nothing waits, and the offer is there again.
      await pointAndClick(window, window.getByTestId("organize-review-menu"));
      await pointAndClick(window, window.getByTestId("organize-review-discard"));
      await expect(window.getByTestId("organize-review")).toHaveCount(0);
      await expect(button).toBeVisible();
      expect(await bridge(window).folders()).toEqual([]);
    } finally {
      await app.close();
    }
  });
}

test("the offer stays hidden on a Library of the example's Documents alone (#1942)", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    examples: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1400, 900);
    // Ten example Documents, and none of the User's own: the old count would offer to sort them.
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createExamples("papers");
      await core.createExamples("contracts");
      await core.createExamples("meetings");
    });
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            return (await core.listDocuments()).length;
          }),
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(8);
    await runCommand(window, "library.open", "Open the Library");
    await expect(window.getByTestId("library")).toBeVisible();
    await expect(window.getByTestId("library-document").first()).toBeVisible();
    expect(await window.getByTestId("library-document").count()).toBeGreaterThanOrEqual(8);
    await expect(window.getByTestId("library-sort-into-folders")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
