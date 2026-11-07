import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Organize proposes, and nothing is kept until the User confirms it (#1569): a new User adds
 * files, presses Organize, and the Review fills the Library's page with the Folders it proposes.
 * Unticking a row and renaming a new Folder change what Confirm will do; Confirm makes the
 * Folders and files the ticked Documents in one step, and one Undo takes all of it back and
 * brings the Review back as it was. In English and Chinese, wide and at the narrowest window.
 * Organize This Folder proposes subfolders inside one Folder, and Not Now leaves a count.
 */

type Language = "en" | "zh-CN";

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
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const core = (window: Page) => ({
  folders: () =>
    window.evaluate(async () =>
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary()).groups
        .map((group) => group.name)
        .sort(),
    ),
  filed: () =>
    window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [library, documents] = await Promise.all([bridge.getLibrary(), bridge.listDocuments()]);
      const names = new Map(documents.map((each) => [each.id, each.name]));
      const folders = new Map(library.groups.map((each) => [each.id, each.name]));
      return library.assignments
        .filter((each) => each.groupId !== null)
        .map((each) => `${names.get(each.documentId)} → ${folders.get(each.groupId ?? "")}`)
        .sort();
    }),
  waiting: () =>
    window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getOrganizeReview())
          .count,
    ),
});

/** Organize plans with the scripted model on this computer, which needs no consent. */
async function organizeWithLocalModel(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [provider] = await bridge.listChatProviders();
    if (!provider) throw new Error("No AI model was set up.");
    const { settings } = await bridge.getLibrary();
    await bridge.saveLibrarySettings({
      ...settings,
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
      automatic: false,
    });
  });
}

/** Files on three subjects: four kitchen quotes, four race plans and two garden notes. */
async function files(): Promise<string[]> {
  const paths: string[] = [];
  const write = async (name: string, text: string) => {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  };
  for (let at = 1; at <= 4; at++) {
    await write(`Kitchen ${at}.txt`, `Kitchen renovation, item ${at}: quartz countertops.`);
    await write(`Race ${at}.txt`, `Marathon training, week ${at}: easy runs and a long run.`);
  }
  for (let at = 1; at <= 2; at++) await write(`Garden ${at}.txt`, `Tomatoes, row ${at}.`);
  return paths;
}

async function start(language: Language, width: number, height: number) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await useLocalChatModel(window);
  await dismissChatSetup(window);
  await setWindowSize(app, window, width, height);
  await setLanguage(window, language);
  await organizeWithLocalModel(window);
  return { app, window };
}

const t = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

/** A card by its Folder's own name; a subfolder's is headed by its path, "Contracts › Lease". */
const card = (window: Page, name: string) =>
  window.getByTestId("organize-review-card").filter({
    has: window.getByTestId("organize-review-card-name").filter({
      hasText: new RegExp(`(^|› )${name}$`),
    }),
  });

const row = (window: Page, name: string) =>
  window.getByTestId("organize-review-row").filter({
    has: window.getByTestId("organize-review-name").getByText(name, { exact: true }),
  });

for (const [language, width, height] of [
  ["en", 1440, 900],
  ["zh-CN", 1440, 900],
  ["en", 900, 700],
  ["zh-CN", 900, 700],
] as const) {
  test(`${language} at ${width}: Organize ends in the Review, and Confirm and its one Undo keep the User's edits`, async () => {
    test.setTimeout(150_000);
    const say = t(language);
    let app: ElectronApplication | undefined;
    try {
      const started = await start(language, width, height);
      app = started.app;
      const { window } = started;
      await addDocuments(window, await files());
      await runCommand(window, "library.open", say("library.open"));

      const organize = window.getByTestId("library-sort-into-folders");
      await expect(organize).toHaveText(say("library.organizeCount", { count: "10" }));
      await screenshot(window, `library-organize-${language}-${width}`);
      await pointAndClick(window, organize);

      // The Review opens once the plan has ended; nothing is filed and no Folder is made yet.
      const page = window.getByTestId("organize-review");
      await expect(page).toBeVisible({ timeout: 30_000 });
      await expect(window.getByTestId("organize-review-title")).toHaveText(
        say("organizeReview.title"),
      );
      const willMove = window.getByTestId("organize-review-will-move");
      const sentence = (documents: number, into: string) =>
        say("organizeReview.willMove", {
          documents: say("organizeReview.documents", { count: documents }),
          into,
        });
      await expect(willMove).toHaveText(
        sentence(8, say("organizeReview.into.new", { count: 2 })),
      );
      await expect(card(window, "Kitchen").getByTestId("organize-review-row")).toHaveCount(4);
      await expect(card(window, "Race").getByTestId("organize-review-row")).toHaveCount(4);
      await expect(window.getByTestId("organize-review-left-out-row")).toHaveCount(2);
      await expect(window.getByTestId("organize-review-reason").first()).toHaveText(
        say("organizeReview.leftOut.doesntFit"),
      );
      expect(await core(window).folders()).toEqual([]);
      expect(await core(window).filed()).toEqual([]);
      // The bar stays in sight, under the page's top, with Confirm in it.
      const bar = window.getByTestId("organize-review-bar");
      const confirm = window.getByTestId("organize-review-confirm");
      await expect(confirm).toBeEnabled();
      const [barBox, confirmBox] = await Promise.all([bar.boundingBox(), confirm.boundingBox()]);
      expect(confirmBox && barBox && confirmBox.y >= barBox.y).toBe(true);
      await screenshot(window, `review-${language}-${width}`);

      // Untick one Document: Confirm will leave it where it is.
      await pointAndClick(window, row(window, "Race 4").getByTestId("organize-review-tick"));
      await expect(row(window, "Race 4")).toHaveAttribute("data-ticked", "false");
      await expect(willMove).toHaveText(
        sentence(7, say("organizeReview.into.new", { count: 2 })),
      );

      // Rename a new Folder in place.
      await pointAndClick(window, card(window, "Kitchen").getByTestId("organize-review-card-name"));
      const field = window.getByTestId("organize-review-rename");
      await expect(field).toBeFocused();
      await field.fill("Home");
      await window.keyboard.press("Enter");
      await expect(card(window, "Home")).toBeVisible();
      expect(await core(window).folders()).toEqual([]);

      // Confirm, by its keys: the Folders are made and the ticked Documents filed, in one step.
      await window.keyboard.press("ControlOrMeta+Enter");
      await expect(page).toHaveCount(0);
      await expect(window.getByTestId("undo-line-here").getByTestId("undo-message")).toHaveText(
        say("organizeReview.organized", { count: 7 }),
      );
      expect(await core(window).folders()).toEqual(["Home", "Race"]);
      expect(await core(window).filed()).toHaveLength(7);
      expect((await core(window).filed()).some((each) => each.startsWith("Race 4"))).toBe(false);
      await screenshot(window, `confirmed-${language}-${width}`);

      // One Undo takes it all back and brings the Review back, with the User's edits.
      await window.getByTestId("undo-line-here").getByTestId("undo-action").click();
      await expect(page).toBeVisible();
      await expect.poll(() => core(window).folders()).toEqual([]);
      expect(await core(window).filed()).toEqual([]);
      await expect(card(window, "Home")).toBeVisible();
      await expect(row(window, "Race 4")).toHaveAttribute("data-ticked", "false");

      // Not Now keeps it, and the Library's top and the sidebar count what Confirm would file.
      await pointAndClick(window, window.getByTestId("organize-review-not-now"));
      await expect(page).toHaveCount(0);
      await expect(window.getByTestId("organize-waiting")).toContainText(
        say("organizeReview.waiting", { count: "7" }),
      );
      await expect(window.getByTestId("library-row-count")).toHaveAttribute("data-waiting", "true");
      await screenshot(window, `not-now-${language}-${width}`);
      await pointAndClick(window, window.getByTestId("organize-waiting-review"));
      await expect(page).toBeVisible();
      expect(await core(window).waiting()).toBe(7);
    } finally {
      await app?.close();
    }
  });
}

test("Organize This Folder proposes subfolders inside it, and moves nothing out of it", async () => {
  test.setTimeout(120_000);
  const language: Language = "en";
  const say = t(language);
  let app: ElectronApplication | undefined;
  try {
    const started = await start(language, 1440, 900);
    app = started.app;
    const { window } = started;
    const paths: string[] = [];
    for (let at = 1; at <= 3; at++) {
      for (const [name, text] of [
        [`Lease ${at}.txt`, `Lease of the Harbour Street office, schedule ${at}.`],
        [`NDA ${at}.txt`, `Mutual NDA with a supplier, clause ${at}.`],
      ]) {
        const path = join(sources, name);
        await writeFile(path, text);
        paths.push(path);
      }
    }
    await addDocuments(window, paths);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: "Contracts", description: "" });
      for (const document of await bridge.listDocuments())
        await bridge.assignDocumentGroup(document.id, folder.id);
    });
    await runCommand(window, "library.open", say("library.open"));
    // The Folder's ⋯ in the Library has it, as its right-click menu and ⌘K do.
    const head = window
      .getByTestId("library")
      .getByTestId("library-section")
      .filter({ hasText: "Contracts" })
      .getByTestId("library-section-head");
    await head.hover();
    await pointAndClick(window, head.getByTestId("folder-menu"));
    await pointAndClick(
      window,
      window.getByTestId("folder-actions").filter({ visible: true }).getByTestId("folder.organize"),
    );
    await expect(window.getByTestId("organize-review-title")).toHaveText(
      say("organizeReview.title.sub", { folder: "Contracts" }),
      { timeout: 30_000 },
    );
    await expect(window.getByTestId("organize-review-proposed")).toContainText(
      say("organizeReview.section.newSubfolders"),
    );
    await expect(card(window, "Lease")).toContainText("Contracts ›");
    await screenshot(window, "organize-this-folder-en");
    expect(await core(window).folders()).toEqual(["Contracts"]);
  } finally {
    await app?.close();
  }
});

test("Move to, Try Again and Discard change the Suggestions, each taken back by one Undo", async () => {
  test.setTimeout(150_000);
  const language: Language = "en";
  const say = t(language);
  let app: ElectronApplication | undefined;
  try {
    const started = await start(language, 1440, 900);
    app = started.app;
    const { window } = started;
    await addDocuments(window, await files());
    await runCommand(window, "library.open", say("library.open"));
    await pointAndClick(window, window.getByTestId("library-sort-into-folders"));
    const page = window.getByTestId("organize-review");
    await expect(page).toBeVisible({ timeout: 30_000 });
    const rows = (name: string) => card(window, name).getByTestId("organize-review-row");

    // Move to… another card in the Review, from the row's ⋯; ⌘Z puts it back.
    await row(window, "Race 4").hover();
    await pointAndClick(window, row(window, "Race 4").getByTestId("organize-review-row-menu"));
    await pointAndClick(
      window,
      window
        .getByTestId("organize-review-move-to")
        .getByTestId("organize-review-move-to-card")
        .filter({ hasText: "Kitchen" }),
    );
    await expect(rows("Kitchen")).toHaveCount(5);
    await expect(rows("Race")).toHaveCount(3);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(rows("Kitchen")).toHaveCount(4);
    await expect(rows("Race")).toHaveCount(4);

    // Fewer Folders can't go under three; Try Again plans again and keeps what the User changed.
    await pointAndClick(window, row(window, "Race 4").getByTestId("organize-review-tick"));
    await expect(row(window, "Race 4")).toHaveAttribute("data-ticked", "false");
    await pointAndClick(window, window.getByTestId("organize-review-menu"));
    await expect(window.getByTestId("organize-review-fewer")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await pointAndClick(window, window.getByTestId("organize-review-again"));
    await expect(page).toBeVisible({ timeout: 30_000 });
    await expect(rows("Kitchen")).toHaveCount(4);
    await expect(row(window, "Race 4")).toHaveAttribute("data-ticked", "false");
    expect(await core(window).folders()).toEqual([]);

    // Discard sets them all aside; its Undo brings them, and the Review, back.
    await pointAndClick(window, window.getByTestId("organize-review-menu"));
    await pointAndClick(window, window.getByTestId("organize-review-discard"));
    await expect(page).toHaveCount(0);
    await expect(window.getByTestId("undo-line-here").getByTestId("undo-message")).toHaveText(
      say("organizeReview.discarded"),
    );
    await expect.poll(() => core(window).waiting()).toBe(0);
    await expect(window.getByTestId("organize-waiting")).toHaveCount(0);
    await window.getByTestId("undo-line-here").getByTestId("undo-action").click();
    await expect(page).toBeVisible();
    await expect.poll(() => core(window).waiting()).toBe(7);
    await expect(row(window, "Race 4")).toHaveAttribute("data-ticked", "false");
  } finally {
    await app?.close();
  }
});
