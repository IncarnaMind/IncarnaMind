import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  tagDocument,
} from "./app";

/*
 * Notices by kind (#157). An error from the core is said in plain words, with the technical text
 * one click away under Details, and stays until the User dismisses it. What worked ("Copied")
 * goes by itself after a few seconds. Esc closes either, the newest first. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of the notices there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** A Document in the Library, whose row is open on the Library's page. */
async function libraryWithADocument(window: Page): Promise<Locator> {
  const path = join(sources, "Tides.txt");
  await writeFile(path, "Spring tides happen at new moon and at full moon.\n");
  await addDocuments(window, [path]);
  await window.getByTestId("open-library").click();
  return window.getByTestId("library-document");
}

/** Renames the Document to a name the core refuses as too long. */
async function renameTooLong(window: Page, row: Locator, length = 501): Promise<void> {
  await row.locator("[data-row-main]").focus();
  await window.keyboard.press("F2");
  await row.getByRole("textbox").fill("x".repeat(length));
  await window.keyboard.press("Enter");
}

/** The words the core gives for it. */
const TOO_LONG = "A Document’s name can’t be longer than 500 characters.";

/** Stands in for the clipboard, so Copy path works in a window nobody is looking at. */
async function stubClipboard(window: Page): Promise<void> {
  await window.evaluate(() => {
    navigator.clipboard.writeText = async () => undefined;
  });
}

/** Copy path on the first Document in the sidebar, by its key, as a person would. */
async function copyPath(window: Page): Promise<void> {
  await window.getByTestId("document-list-item").first().getByTestId("open-document").focus();
  await window.keyboard.press("ControlOrMeta+Alt+c");
}

test("an error from the core says it in plain words, with the technical text under Details, and stays", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await stubClipboard(window);
    const row = await libraryWithADocument(window);
    await renameTooLong(window, row);

    const notice = window.getByTestId("error-notice");
    await expect(notice).toHaveCount(1);
    await expect(notice.getByTestId("error-notice-message")).toHaveText(
      `That didn’t work: ${TOO_LONG}`,
    );
    await expect(notice).toHaveAttribute("role", "alert");

    // The technical text is behind Details: the method that failed and the error's class, with
    // its sentence, and nothing of Electron's wrapping or a stack.
    const details = notice.getByTestId("error-notice-details");
    await expect(details).not.toHaveJSProperty("open", true);
    await details.getByText("Details").click();
    await expect(details).toHaveJSProperty("open", true);
    await expect(details).toContainText("core:renameDocument");
    await expect(details).toContainText(`InvalidInputError: ${TOO_LONG}`);
    await screenshot(window, "notice-details-open");
    const said = (await notice.textContent()) ?? "";
    expect(said).not.toContain("Error invoking remote method");
    expect(said).not.toMatch(/\n\s+at /);

    // It never goes by itself: a confirmation that comes after it has gone while it is still here.
    await copyPath(window);
    const copied = window.getByTestId("copied-line");
    await expect(copied).toHaveText("Copied");
    await expect(copied).toHaveText("", { timeout: 10_000 });
    await expect(notice).toHaveCount(1);
    await expect(details).toHaveJSProperty("open", true);

    // Its button dismisses it.
    await notice.getByTestId("error-notice-dismiss").click();
    await expect(notice).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("Esc closes the newest notice, an error or a confirmation, one at a time; two errors stay together", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await stubClipboard(window);
    await (await coreOf(window)).evaluate((core) =>
      core.createLibraryGroup({ name: "Finance", description: "Invoices" }),
    );
    const row = await libraryWithADocument(window);

    // Two different failures: both stay, the older above.
    await renameTooLong(window, row);
    const notices = window.getByTestId("error-notice");
    await expect(notices).toHaveCount(1);
    await sidebarFolder(window, "Finance").getByTestId("folder-row").click({ button: "right" });
    await window.getByTestId("folder.open").click();
    const name = window
      .getByTestId("library")
      .getByTestId("library-section-name")
      .filter({ hasText: "Finance" });
    await name.dblclick();
    await window.getByTestId("library-section-rename").fill("x".repeat(101));
    await window.keyboard.press("Enter");
    await expect(notices).toHaveCount(2);
    await expect(notices.first().getByTestId("error-notice-message")).toContainText(TOO_LONG);
    await expect(notices.last().getByTestId("error-notice-message")).toContainText("1–100");
    await screenshot(window, "notices-two-errors");

    // A confirmation is the newest: Esc closes it, and both errors stay.
    await copyPath(window);
    const copied = window.getByTestId("copied-line");
    await expect(copied).toHaveText("Copied");
    await window.keyboard.press("Escape");
    await expect(copied).toHaveText("", { timeout: 1000 });
    await expect(notices).toHaveCount(2);

    // Then the errors, the newest first.
    await window.keyboard.press("Escape");
    await expect(notices).toHaveCount(1);
    await expect(notices.first().getByTestId("error-notice-message")).toContainText(TOO_LONG);
    await window.keyboard.press("Escape");
    await expect(notices).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("Esc closes a menu before it closes a notice", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const row = await libraryWithADocument(window);
    await renameTooLong(window, row);
    const notice = window.getByTestId("error-notice");
    await expect(notice).toHaveCount(1);

    // An error while a menu is open: the menu is the innermost thing, so Esc closes it first.
    await window.getByTestId("plus-menu").focus();
    await window.keyboard.press("Enter");
    const menu = window.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(notice).toHaveCount(1);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(notice).toHaveCount(1);
    await window.keyboard.press("Escape");
    await expect(notice).toHaveCount(0);
  } finally {
    await app.close();
  }
});

for (const { width, label } of [
  { width: 900, label: "narrowest" },
  { width: 1600, label: "wide" },
]) {
  test(`in Chinese the notice's words are Chinese, and a long name in a message stays inside it at the ${label} window`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 700);
      await setLanguage(window, "zh-CN");
      await dismissChatSetup(window);
      // The Tags view shows once there is a Document to tag. The core's message names the Tag that
      // is in the way: 100 characters with no space.
      const path = join(sources, "Tides.txt");
      await writeFile(path, "Spring tides happen at new moon and at full moon.\n");
      await addDocuments(window, [path]);
      const long = "月".repeat(100);
      await (await coreOf(window)).evaluate(async (core, name) => {
        await core.createTag({ name });
        await core.createTag({ name: "Moons" });
      }, long);
      await tagDocument(window, "Tides", "Moons");
      // A new Tag named what another is: the core refuses it, and its message names the Tag in the way.
      await window.getByTestId("tags-toggle").hover();
      await window.getByTestId("tags-add").click();
      await window.getByTestId("sidebar-tag-new-name").fill(long);
      await window.keyboard.press("Enter");

      const notice = window.getByTestId("error-notice");
      const message = notice.getByTestId("error-notice-message");
      await expect(message).toContainText("无法完成操作：");
      await expect(notice.getByTestId("error-notice-dismiss")).toHaveText("关闭");
      const details = notice.getByTestId("error-notice-details");
      await details.getByText("详情").click();
      // Whatever its length, the whole of it is under Details.
      await expect(details).toContainText(long);
      await screenshot(window, `notice-zh-long-${width}`);

      // It sits inside the window and its words stay inside it.
      const box = await notice.boundingBox();
      const size = await window.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      if (!box) throw new Error("The notice isn't visible.");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.w);
      expect(box.y + box.height).toBeLessThanOrEqual(size.h);
      expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });
}

for (const width of [900, 1600]) {
  test(`in Chinese, a Document's name that is too long is refused in Chinese, with the English sentence under Details, at ${width}px`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 700);
      await setLanguage(window, "zh-CN");
      await dismissChatSetup(window);
      const row = await libraryWithADocument(window);
      await renameTooLong(window, row, 600);

      // The core's own sentence in the interface language (#627): nothing it says is English.
      const notice = window.getByTestId("error-notice");
      await expect(notice.getByTestId("error-notice-message")).toHaveText(
        "无法完成操作：文档名称不能超过 500 个字符。",
      );
      await expect(notice.getByTestId("error-notice-dismiss")).toHaveText("关闭");
      const details = notice.getByTestId("error-notice-details");
      await expect(details.locator("summary")).toHaveText("详情");

      // Details keeps the English sentence, for a bug report.
      await details.getByText("详情").click();
      await expect(details).toContainText("core:renameDocument");
      await expect(details).toContainText(`InvalidInputError: ${TOO_LONG}`);
      await expect(details).not.toContainText("wording");
      await screenshot(window, `notice-zh-document-name-${width}`);
    } finally {
      await app.close();
    }
  });
}

test("Esc closes an error notice while the focus is in the empty Library search field", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const row = await libraryWithADocument(window);
    await renameTooLong(window, row);
    const notice = window.getByTestId("error-notice");
    await expect(notice).toHaveCount(1);

    // The search is empty, so the field leaves Esc to the notice behind it.
    const search = window.getByTestId("library-search");
    await search.focus();
    await expect(search).toHaveValue("");
    await window.keyboard.press("Escape");
    await expect(notice).toHaveCount(0);
  } finally {
    await app.close();
  }
});
