import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import {
  addDocuments,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  organizeWithChatModel,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Nothing tagging proposes is kept until the User confirms it (#2339): new Documents are tagged
 * with one kind each, which waits in Suggested Tags, a Review with no Folders in it. Confirm adds
 * them as the User's Tags in one step, named in the interface's language, and one Undo takes them
 * off and brings the Review back. In English and Chinese, wide and at the narrowest window.
 * Organize on Documents with nothing in common, and no Folder there or proposed, leaves each out
 * as too few like it for one: the Tags it proposes open the Review alone, and a run that proposes
 * nothing opens none and says why at the Library's top.
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
/** The window in light and dark, when screenshots are asked for. */
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  for (const appearance of ["light", "dark"] as const) {
    await window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          device: { appearance: value },
        }),
      appearance,
    );
    await motionSettled(window);
    await window.screenshot({ path: join(SCREENSHOTS, `${name}-${appearance}.png`) });
  }
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      device: { appearance: "light" },
    }),
  );
}

const t = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

/** Files the scripted model gives a kind each by the kind's name in them, and one it gives none. */
async function files(): Promise<string[]> {
  const paths: string[] = [];
  for (const [name, text] of [
    ["Harbour Street lease", "Contract for the Harbour Street office, for two years."],
    ["Pilot boat 4471", "Invoice 4471 for pilot boat services, due in 30 days."],
    ["Q3 sales", "Report on the third quarter: sales grew in every region."],
    ["Tide tables", "The harbour master publishes the times of high water."],
  ] as const) {
    const path = join(sources, `${name}.txt`);
    await writeFile(path, text);
    paths.push(path);
  }
  return paths;
}

const chipsOf = (row: ReturnType<Page["getByTestId"]>) => row.getByTestId("tag-chip");

/** The Documents that carry a Tag, as the core lists them. */
const tagged = (window: Page) =>
  window.evaluate(async () =>
    (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments())
      .filter((each) => each.tags.length > 0)
      .map((each) => each.name),
  );

const libraryRow = (window: Page, name: string) =>
  window.getByTestId("library-document").filter({
    has: window.getByTestId("library-document-name").getByText(name, { exact: true }),
  });

for (const [language, width, height] of [
  ["en", 1440, 900],
  ["zh-CN", 1440, 900],
  ["en", 900, 700],
  ["zh-CN", 900, 700],
] as const) {
  test(`${language} at ${width}: a new Document's kind waits in Suggested Tags, and Confirm and its one Undo add and take off the Tags`, async () => {
    test.setTimeout(120_000);
    const say = t(language);
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp(dataDir, { fakeChat: true });
      app = launched.app;
      const { window } = launched;
      await connectLocalChatModel(window);
      await dismissChatSetup(window);
      await setWindowSize(app, window, width, height);
      await setLanguage(window, language);
      await addDocuments(window, await files());
      const items = window.getByTestId("document-list-item");
      await expect(items).toHaveCount(4);
      for (const item of await items.all())
        await expect(item).toHaveAttribute("data-tagging", "tagged");

      // Tagged, the Documents carry no Tag yet: three kinds wait for the User.
      await runCommand(window, "library.open", say("library.open"));
      const lease = libraryRow(window, "Harbour Street lease");
      await expect(lease).toBeVisible();
      await expect(window.getByTestId("library-document").getByTestId("tag-chip")).toHaveCount(0);
      await expect(window.getByTestId("organize-waiting")).toContainText(
        say("organizeReview.waiting", { count: "3" }),
      );
      await pointAndClick(window, window.getByTestId("organize-waiting-review"));

      const page = window.getByTestId("organize-review");
      await expect(window.getByTestId("organize-review-title")).toHaveText(
        say("organizeReview.title.tags"),
      );
      await expect(window.getByTestId("organize-review-will-move")).toHaveText(
        say("organizeReview.willTag", {
          documents: say("organizeReview.documents", { count: 3 }),
        }),
      );
      const chips = page.getByTestId("organize-review-chip");
      await expect(chips).toHaveCount(3);
      expect((await chips.allTextContents()).sort()).toEqual(
        [say("tags.kind.contract"), say("tags.kind.invoice"), say("tags.kind.report")].sort(),
      );
      // No Folder is offered: a row has no ⋯ and can't be dragged.
      await expect(page.getByTestId("organize-review-row-menu")).toHaveCount(0);
      await screenshot(window, `suggested-tags-${language}-${width}`);

      // Confirm, by its keys: the Tags are added as the User's, in one step.
      await window.keyboard.press("ControlOrMeta+Enter");
      await expect(page).toHaveCount(0);
      await expect(window.getByTestId("undo-line-here").getByTestId("undo-message")).toHaveText(
        say("organizeReview.tagged", { count: 3 }),
      );
      await expect(chipsOf(lease)).toHaveText(say("tags.kind.contract"));
      await expect(chipsOf(lease)).toHaveAttribute("data-source", "user");
      await expect(chipsOf(libraryRow(window, "Tide tables"))).toHaveCount(0);
      await screenshot(window, `tagged-${language}-${width}`);

      // One Undo takes them all off and brings the Review back.
      await window.getByTestId("undo-line-here").getByTestId("undo-action").click();
      await expect(page).toBeVisible();
      await expect(chips).toHaveCount(3);
      expect(await tagged(window)).toEqual([]);

      // Confirmed again, a kind is named in the interface's language: switching it renames the Tag.
      await window.keyboard.press("ControlOrMeta+Enter");
      await expect(page).toHaveCount(0);
      await expect(chipsOf(lease)).toHaveText(say("tags.kind.contract"));
      const other: Language = language === "en" ? "zh-CN" : "en";
      await setLanguage(window, other);
      await expect(chipsOf(lease)).toHaveText(t(other)("tags.kind.contract"));
      await setLanguage(window, language);
      await expect(chipsOf(lease)).toHaveText(say("tags.kind.contract"));
    } finally {
      await app?.close();
    }
  });
}

/** Five Documents with nothing in common, as many first words; with `kinds`, two say a kind. */
async function unrelated(kinds: boolean): Promise<string[]> {
  const paths: string[] = [];
  for (const [name, text] of [
    ["Lease Harbour Street", kinds ? "Contract for the office, two years." : "Keys to the office."],
    [
      "Pilot boat",
      kinds ? "Invoice 4471 for pilot boat services." : "The pilot boat sails at six.",
    ],
    ["Marathon training", "Week six: easy runs and one long run."],
    ["Tomato seeds", "Sow the tomatoes indoors in March."],
    ["Violin scales", "Practise the scales slowly, then faster."],
  ] as const) {
    const path = join(sources, `${name}.txt`);
    await writeFile(path, text);
    paths.push(path);
  }
  return paths;
}

const loose = (window: Page) =>
  window
    .getByTestId("library")
    .locator('[data-testid="library-section"][data-section="not-in-a-folder"]');

/**
 * The scripted model on this computer, Organize on it with tagging turned on, as setup's Use this
 * leaves them, and five Documents in the Library; then Organize, from the Library.
 */
async function organizing(language: Language, kinds: boolean) {
  const launched = await launchApp(dataDir, { fakeChat: true });
  const { app, window } = launched;
  await connectLocalChatModel(window);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await setLanguage(window, language);
  await organizeWithChatModel(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { settings } = await bridge.getLibrary();
    await bridge.saveLibrarySettings({ ...settings, turnOn: true });
  });
  await addDocuments(window, await unrelated(kinds));
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(5);
  for (const item of await items.all())
    await expect(item).toHaveAttribute("data-tagging", "tagged");
  await runCommand(window, "library.open", t(language)("library.open"));
  await pointAndClick(window, loose(window).getByTestId("library-organize"));
  return launched;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: with no Folder there or proposed, a Document left out is too few like it, and the Tags proposed open the Review alone`, async () => {
    test.setTimeout(120_000);
    const say = t(language);
    let app: ElectronApplication | undefined;
    try {
      const launched = await organizing(language, true);
      app = launched.app;
      const { window } = launched;

      const page = window.getByTestId("organize-review");
      await expect(window.getByTestId("organize-review-title")).toHaveText(
        say("organizeReview.title.tags"),
      );
      await expect(
        page.getByTestId("organize-review-tags-only").getByTestId("organize-review-row"),
      ).toHaveCount(2);
      const reasons = page.getByTestId("organize-review-reason");
      await expect(reasons).toHaveCount(3);
      await expect(reasons).toHaveText(Array(3).fill(say("organizeReview.leftOut.tooFew")));
      await expect(page).not.toContainText(say("organizeReview.leftOut.doesntFit"));
      await screenshot(window, `too-few-${language}`);
    } finally {
      await app?.close();
    }
  });

  test(`${language}: a run that proposes nothing opens no Review, and the Library's top says why`, async () => {
    test.setTimeout(120_000);
    const say = t(language);
    let app: ElectronApplication | undefined;
    try {
      const launched = await organizing(language, false);
      app = launched.app;
      const { window } = launched;

      const line = window.getByTestId("organize-apart");
      await expect(line).toHaveText(say("organizeReview.apart", { count: "5" }));
      await expect(window.getByTestId("organize-review")).toHaveCount(0);
      await expect(window.getByTestId("organize-waiting")).toHaveCount(0);
      // Nothing was grouped, so the Library's head doesn't say they are sorted.
      await expect(window.getByTestId("library-sorted")).toHaveCount(0);
      expect(await tagged(window)).toEqual([]);
      await screenshot(window, `apart-${language}`);
    } finally {
      await app?.close();
    }
  });
}
