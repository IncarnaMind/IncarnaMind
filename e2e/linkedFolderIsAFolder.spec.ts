import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  confirmLink,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  openDocumentMenu,
  previewLink,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * A linked folder is a Folder like any other (#3613): linking a folder on disk makes a Folder
 * bound to it at once, its files filed in it as they arrive, in the one list of Folders with a
 * mark that says where it is on disk. Its menu has its folder's actions, Unlink… in Delete's place,
 * and File as one Folder to turn the filing off and on. Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save stills there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(target: Page | Locator, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  if ("waitForLoadState" in target) await motionSettled(target);
  else await motionSettled(target.page());
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** The pointer at rest over the empty main area, so no row shows its actions in place of its state. */
async function rest(window: Page) {
  const size = await window.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return { width: innerWidth, height: innerHeight };
  });
  await window.mouse.move(Math.round(size.width * 0.6), size.height - 12);
}

const INTERVIEWS: Record<string, string> = {
  "Interview plan.md":
    "# Interview plan\n\nTwelve conversations about how readers use the branch library.\n",
  "2025 Spring/Participant 01.md":
    "# Participant 01\n\nVisits on Saturdays, mostly for the study rooms.\n",
  "2025 Spring/Participant 02.md": "# Participant 02\n\nBorrows audiobooks for the commute.\n",
  "2025 Autumn/Participant 03.md":
    "# Participant 03\n\nCame for the coding club, stayed for the reading group.\n",
  "2025 Autumn/Participant 04.md":
    "# Participant 04\n\nWould like longer opening hours on weekdays.\n",
  "2025 Autumn/Debrief/Debrief.md":
    "# Debrief\n\nThe study rooms come up in eight of twelve interviews.\n",
};
const FIELD_NOTES: Record<string, string> = {
  "Site visit, east branch.md":
    "# Site visit\n\nThe east branch has four study rooms, all booked by noon.\n",
  "Site visit, harbour branch.md": "# Site visit\n\nThe harbour branch opens late on Thursdays.\n",
};
const OWN: Record<string, string> = {
  "Reading list.md": "# Reading list\n\nPublic libraries as third places.\n",
  "Ethics approval.md": "# Ethics approval\n\nApproved for interviews with adult library users.\n",
};

async function writeTree(root: string, tree: Record<string, string>) {
  for (const [path, text] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

const boundFolders = (window: Page) =>
  bridge(window).then((core) =>
    core.evaluate(async (each) =>
      (await each.getLibrary()).groups
        .filter((group) => group.boundFolderId !== null)
        .map((group) => ({ name: group.name, keepInside: group.keepInside })),
    ),
  );

let dataDir: string;
let home: string;
let disk: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  disk = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(disk);
});

async function sidebarShots(app: ElectronApplication, window: Page, name: string) {
  const sidebar = window.getByTestId("sidebar");
  await setWindowSize(app, window, 1440, 900);
  await rest(window);
  await shot(sidebar, `${name}-sidebar-light`);
  await window.emulateMedia({ colorScheme: "dark" });
  await shot(sidebar, `${name}-sidebar-dark`);
  await window.emulateMedia({ colorScheme: "light" });
}

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);

  // protects=linking a folder makes a Folder bound to it at once, its files filed in it, in the one list of Folders with its mark, no separate list and no read-only label; its menu turns the filing off and on with Undo, and removing a Document there says the file stays (#3613); fails_when=the files land in Not in a Folder, a separate list or "read-only" shows, the Folder has no mark, or the menu lacks File as one Folder
  test(`a new User links a folder and gets a Folder (${language})`, async () => {
    test.setTimeout(150_000);
    const work = join(disk, "Interviews");
    await writeTree(work, INTERVIEWS);
    const { app, window } = await launchApp(dataDir, { home });
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);

      const dialog = await previewLink(app, window, work);
      await expect(dialog.getByTestId("link-folder-promise")).toHaveText(
        t("linkedFolders.preview.becomesFolder"),
      );
      await shot(window, `link-dialog-${language}`);
      await confirmLink(dialog);
      await expectReadyDocuments(window, Object.keys(INTERVIEWS).length);
      await expect
        .poll(() => boundFolders(window))
        .toEqual([{ name: "Interviews", keepInside: false }]);

      const folder = sidebarFolder(window, "Interviews");
      await expect(folder.getByTestId("folder-bound")).toBeVisible();
      await expect(folder.getByTestId("document-list-item")).toHaveCount(5);
      await expect(window.getByTestId("not-in-a-folder")).toHaveCount(0);
      await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);
      await expect(
        window.getByText(language === "en" ? "read-only" : "只读", { exact: true }),
      ).toHaveCount(0);
      await expect(folder.getByTestId("browse-count").first()).toHaveText("6");
      await shot(window, `s1-wide-${language}`);
      await window.getByTestId("open-library").click();
      await expect(window.getByTestId("library").getByTestId("folder-bound")).toBeVisible();
      await shot(window, `s1-library-wide-${language}`);

      await folder.getByTestId("folder-row").hover();
      await folder.getByTestId("folder-menu").click();
      const menu = folder.getByTestId("folder-actions");
      await expect(menu.getByTestId("linkedFolder.fileAsFolder")).toBeVisible();
      await expect(menu.getByTestId("linkedFolder.unlink")).toBeVisible();
      await expect(menu.getByTestId("folder.delete")).toHaveCount(0);
      await shot(window, `menu-${language}`);
      await menu.getByTestId("file.info").click();
      const info = window.getByTestId("info-panel");
      await expect(info.getByTestId("info-path")).toHaveText(work);
      await expect(info.getByTestId("info-promise")).toHaveText(t("folder.bound.promise"));
      await shot(window, `info-${language}`);
      await window.keyboard.press("Escape");

      const document = folder
        .getByTestId("document-list-item")
        .filter({ hasText: "Participant 02" });
      await openDocumentMenu(document);
      const remove = window.getByTestId("document.delete");
      await expect(remove).toHaveText(t("documents.removeAction"));
      await shot(window, `doc-menu-${language}`);
      await remove.click();
      await expect(window.getByTestId("undo-message")).toHaveText(
        t("object.removed.keepsFile", { name: "Participant 02", folder: "Interviews" }),
      );
      await shot(window, `doc-removed-${language}`);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(folder.getByTestId("document-list-item")).toHaveCount(5);

      await folder.getByTestId("folder-row").hover();
      await folder.getByTestId("folder-menu").click();
      await folder.getByTestId("folder-actions").getByTestId("linkedFolder.fileAsFolder").click();
      await expect.poll(() => boundFolders(window)).toEqual([]);
      const row = window.getByTestId("linked-folder-row");
      await expect(row).toHaveCount(1);
      await expect(window.getByTestId("undo-message")).toHaveText(
        t("undo.fileAsFolder.off", { name: "Interviews" }),
      );
      await shot(window, `off-${language}`);
      await row.hover();
      await row.getByTestId("linked-folder-menu").click();
      await expect(
        row.getByTestId("linked-folder-actions").getByTestId("linkedFolder.fileAsFolder"),
      ).toBeVisible();
      await shot(window, `off-menu-${language}`);
      await window.keyboard.press("Escape");
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => boundFolders(window)).toHaveLength(1);

      await setWindowSize(app, window, 900, 700);
      await rest(window);
      await shot(window, `s1-narrow-${language}`);
      await sidebarShots(app, window, `s1-${language}`);
    } finally {
      await app.close();
    }
  });

  // protects=a User with their own Folders who links two folders sees one list of Folders, each linked one with its mark and its state at the row's end (#3613); fails_when=the linked folders show in a list of their own
  test(`own Folders and two linked folders, one list (${language})`, async () => {
    test.setTimeout(150_000);
    await writeTree(join(disk, "Interviews"), INTERVIEWS);
    await writeTree(join(disk, "Field notes"), FIELD_NOTES);
    await writeTree(join(disk, "Loose"), OWN);
    const { app, window } = await launchApp(dataDir, { home });
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      const core = await bridge(window);
      const [thesis] = await core.evaluate(
        async (each, loose) => {
          const made = await each.createLibraryGroup({ name: "Thesis", description: "" });
          await each.createLibraryGroup({ name: "Admin", description: "" });
          await each.addDocuments([`${loose}/Reading list.md`], { groupId: made.id });
          await each.createMind({ title: "Chapter 2 draft", headed: true, folderId: made.id });
          return [made.id];
        },
        join(disk, "Loose"),
      );
      expect(thesis).toBeTruthy();
      await core.evaluate(
        async (each, paths) => {
          for (const path of paths) await each.addLinkedFolder(path);
        },
        [join(disk, "Interviews"), join(disk, "Field notes")],
      );
      await expectReadyDocuments(window, 9);
      await expect.poll(async () => (await boundFolders(window)).length).toBe(2);
      for (const name of ["Thesis", "Admin", "Interviews", "Field notes"]) {
        await expect(sidebarFolder(window, name)).toBeVisible();
      }
      for (const name of ["Thesis", "Field notes"]) {
        await sidebarFolder(window, name).getByTestId("folder-row").click();
      }
      await expect(window.getByTestId("library-folders").getByTestId("folder-status")).toHaveCount(
        0,
      );
      await rest(window);
      await shot(window, `s2-wide-${language}`);
      await window.getByTestId("open-library").click();
      await shot(window, `s2-library-wide-${language}`);
      await core.evaluate(async (each) => {
        const field = (await each.listLinkedFolders()).find((one) =>
          one.path.endsWith("Field notes"),
        );
        if (field) await each.setLinkedFolderPaused(field.id, true);
      });
      await expect(
        sidebarFolder(window, "Field notes").getByTestId("folder-status"),
      ).toHaveAttribute("data-state", "paused");
      await shot(window, `s2-paused-${language}`);
      await setWindowSize(app, window, 900, 700);
      await rest(window);
      await shot(window, `s2-narrow-${language}`);
      await sidebarShots(app, window, `s2-${language}`);
    } finally {
      await app.close();
    }
  });

  // protects=a bound Folder whose drive is unplugged stays in the list, muted, saying Unavailable, and its details say where it was (#3613)
  test(`a linked folder on an unplugged drive (${language})`, async () => {
    test.setTimeout(150_000);
    const drive = join(disk, "Field notes");
    await writeTree(drive, FIELD_NOTES);
    let running = await launchApp(dataDir, { home });
    await dismissChatSetup(running.window);
    await setLanguage(running.window, language);
    await (await bridge(running.window)).evaluate(
      (each, path) => each.addLinkedFolder(path),
      drive,
    );
    await expectReadyDocuments(running.window, 2);
    await running.app.close();
    await rename(drive, join(disk, "Field notes (unplugged)"));
    running = await launchApp(dataDir, { home });
    const { app, window } = running;
    try {
      await setWindowSize(app, window, 1440, 900);
      const folder = sidebarFolder(window, "Field notes");
      await expect(folder.locator('[data-state="unavailable"]').first()).toBeVisible({
        timeout: 15_000,
      });
      await folder.getByTestId("folder-row").click();
      await rest(window);
      await shot(window, `s3-wide-${language}`);
      await folder.getByTestId("folder-row").hover();
      await folder.getByTestId("folder-menu").click();
      await expect(folder.getByTestId("linkedFolder.locate")).toBeVisible();
      await shot(window, `s3-menu-${language}`);
      await window.keyboard.press("Escape");
      await sidebarShots(app, window, `s3-${language}`);
    } finally {
      await app.close();
    }
  });
}
