import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addDocuments,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  makeTagOnDocument,
  motionSettled,
  openDocumentTags,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";

let dataDir: string;
/** Where the files a test adds are written: outside the data folder. */
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

test("a new Document is tagged automatically, and a Tag the User removes stays removed after a re-tag", async () => {
  const summary = join(sources, "Q3 summary.txt");
  await writeFile(summary, "Quarterly report for the sales team. Revenue grew in every region.\n");

  const first = await launchApp(dataDir, { fakeChat: true });
  const { window } = first;
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [summary]);

  // The scripted model applies every Tag whose name is a word in the Document: "Report".
  // Its row stays one line; its Tags menu shows its Tags.
  const item = window.getByTestId("document-list-item");
  await expect(item).toHaveAttribute("data-tagging", "tagged");
  let tags = await openDocumentTags(item);
  await expect(tags).toHaveText(["Report"]);
  await expect(tags).toHaveAttribute("data-source", "automatic");

  // The User takes it off, and adds another, in the same picker.
  await item.getByRole("option", { name: "Report", exact: true }).click();
  await expect(tags).toHaveCount(0);
  const invoice = item.getByRole("option", { name: "Invoice", exact: true });
  await invoice.click();
  await expect(invoice).toHaveAttribute("aria-selected", "true");
  await expect(tags).toHaveText(["Invoice"]);
  await expect(tags).toHaveAttribute("data-source", "user");
  await window.keyboard.press("Escape");
  await expect(item.getByTestId("document-tags-popover")).toBeHidden();

  // A new Tag, made in the Tags dialog (from the Tag picker's Manage Tags…), which re-tagging
  // can apply.
  await openDocumentTags(item);
  await item.getByTestId("open-tags-dialog").click();
  const dialog = window.getByTestId("tags-dialog");
  await expect(dialog.getByTestId("tag-row")).toHaveCount(7);
  await dialog.getByTestId("tag-name-input").fill("Quarterly");
  await dialog.getByTestId("tag-description-input").fill("Covers one quarter of a year.");
  await dialog.getByTestId("save-tag").click();
  await expect(dialog.getByTestId("tag-row")).toHaveCount(8);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  // Re-tagging the Document applies the new Tag; the removed one stays off, the added one on.
  await item.hover();
  await item.getByTestId("document-tags-menu").click();
  await window.getByTestId("retag-document").click();
  await expect(item).toHaveAttribute("data-tagging", "tagged");
  tags = await openDocumentTags(item);
  await expect(tags).toHaveText(["Invoice", "Quarterly"]);
  await window.keyboard.press("Escape");

  // The sidebar lists the Tags in use; one clicked shows its Documents in the Library.
  const tagRows = window.getByTestId("sidebar-tag");
  await expect(tagRows.getByTestId("row-text")).toHaveText(["Invoice", "Quarterly"]);
  await tagRows.filter({ hasText: "Quarterly" }).getByTestId("row-text").click();
  const library = window.getByTestId("library");
  await expect(library.locator('[data-testid="library-filter"][data-facet="tag"]')).toHaveText(
    "Tags: Quarterly",
  );
  await expect(library.getByTestId("library-document")).toHaveCount(1);
  await first.app.close();

  // Everything is still there after a restart.
  const second = await launchApp(dataDir, { fakeChat: true });
  const restored = second.window.getByTestId("document-list-item");
  await expect(await openDocumentTags(restored)).toHaveText(["Invoice", "Quarterly"]);
  await second.app.close();
});

test("without a model, Documents are ready to search, and one notice, not one per Document, says tagging waits", async () => {
  const files = {
    "Ideas.txt": "A report on ideas.\n",
    "Plans.txt": "Plans for the next quarter.\n",
    "Minutes.md": "# Minutes\n\nNotes from the weekly meeting.\n",
  };
  const paths: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    paths.push(join(sources, name));
    await writeFile(join(sources, name), text);
  }
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await addDocuments(window, paths);

  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(items.nth(index).getByTestId("document-status")).toHaveText("Ready");
    await expect(items.nth(index)).toHaveAttribute("data-tagging", "waiting-for-provider");
  }
  // No Tag anywhere yet: nothing names Tags, and the footer says nothing.
  const notice = window.getByTestId("tagging-waiting");
  await expect(notice).toHaveCount(0);
  await expect(window.getByTestId("document-tagging")).toHaveCount(0);
  for (let index = 0; index < 3; index++) {
    await expect(await openDocumentTags(items.nth(index))).toHaveCount(0);
    await window.keyboard.press("Escape");
  }

  // One Tag of the User's own: one notice, in the sidebar's footer, and no tagging line under
  // any Document.
  await makeTagOnDocument(window, "Ideas");
  await expect(notice).toHaveCount(1);
  await expect(window.getByTestId("sidebar-footer").getByTestId("tagging-waiting")).toBeVisible();
  await expect(notice).toContainText("Tags come once you choose an AI model.");

  // Its button opens Settings on its Models page, at Tagging under Advanced, where a chat model or
  // a Jev key can be set up.
  await notice.getByTestId("tagging-waiting-setup").click();
  const settings = window.getByTestId("settings");
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("data-page", "models");
  await expect(settings.getByTestId("model-defaults")).toBeVisible();
  await expect(settings.getByTestId("models-advanced")).toHaveAttribute("open", "");
  await expect(settings.getByTestId("tagging-automatic-line")).toHaveText(
    "No model to tag with yet. Set one up.",
  );
  await expect(settings.getByTestId("tagging-automatic").getByRole("radio")).toBeFocused();
  await expect(settings.getByTestId("jev-settings")).toBeVisible();
  await closeSettings(window);

  // Once a model is set up, the Documents are tagged and the notice goes.
  await useLocalChatModel(window);
  for (let index = 0; index < 3; index++) {
    await expect(items.nth(index)).toHaveAttribute("data-tagging", "tagged");
  }
  await expect(notice).toHaveCount(0);
  await app.close();
});

test("a Document's Tags menu near the window's bottom opens upward with its first item focused, and Esc closes only it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const files = await Promise.all(
    ["One", "Two", "Three", "Four", "Five", "Six"].map(async (name) => {
      const path = join(sources, `${name}.txt`);
      await writeFile(path, `${name} notes about tides.`);
      return path;
    }),
  );
  await addDocuments(window, files);
  await window.getByTestId("open-document").first().click();
  await expect(window.getByTestId("viewer")).toBeVisible();
  await setWindowSize(app, window, 1000, 470);
  await expect.poll(() => window.evaluate(() => globalThis.innerHeight)).toBeLessThan(600);

  const last = window.getByTestId("document-list-item").last();
  const menu = last.getByTestId("document-tags-popover");
  // Where the menu is laid out in the first frame drawn once it shows (as it grows in place
  // there, its transform aside: offsetTop and offsetHeight leave it out).
  await menu.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("The menu isn't an HTML element.");
    const firstFrame = new Promise((resolve) => {
      const measure = () => {
        const top = element.offsetTop;
        resolve({ top, bottom: top + element.offsetHeight });
      };
      element.addEventListener("beforetoggle", () => requestAnimationFrame(measure), {
        once: true,
      });
    });
    Object.assign(element, { firstFrame });
  });
  await last.hover();
  await last.getByTestId("document-tags-menu").click();
  await expect(menu).toBeVisible();
  // Measured once it has grown from its button.
  await motionSettled(window);
  const box = await menu.boundingBox();
  const height = await window.evaluate(() => globalThis.innerHeight);
  if (!box) throw new Error("The menu isn't visible.");
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  // It is drawn there from the first frame, not below the window and then moved up.
  const firstFrame = await menu.evaluate(
    (element) =>
      (element as unknown as { firstFrame: Promise<{ top: number; bottom: number }> }).firstFrame,
  );
  expect(firstFrame.top).toBeCloseTo(box.y, 0);
  expect(firstFrame.bottom).toBeCloseTo(box.y + box.height, 0);
  // The picker takes the focus into its field, ready to type a Tag.
  await expect(menu.getByTestId("tag-picker-input")).toBeFocused();

  // Esc closes the menu at once, and leaves the Document's tab open, its copy fading included.
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(window.getByTestId("viewer")).toBeVisible();
  await motionSettled(window);
  await expect(window.getByTestId("viewer")).toBeVisible();
  await app.close();
});
