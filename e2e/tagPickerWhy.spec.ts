import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openDocumentTags,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

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

async function addNote(window: Page, name: string, text: string): Promise<Locator> {
  const path = join(sources, `${name}.txt`);
  await writeFile(path, text);
  await window.getByTestId("add-documents-input").setInputFiles([path]);
  const item = window.getByTestId("document-list-item").filter({ hasText: name });
  await expect(item).toHaveAttribute("data-status", "ready");
  return item;
}

const why = (item: Locator) => item.getByTestId("document-tagging-why");

test("the Tag picker says why a Document has no Tags: no Tag fits, or no Tags yet with Add a Tag, and Tags come once one exists (#1129)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);

  // The scripted model applies a Tag only when its name is a word in the Document.
  const tides = await addNote(window, "Tide tables", "The harbour master publishes the tides.");
  await expect(tides).toHaveAttribute("data-tagging", "tagged");
  await openDocumentTags(tides);
  await expect(why(tides)).toHaveText("No Tag fits");
  await expect(why(tides)).toHaveAttribute("data-why", "noFit");
  await expect(why(tides).getByRole("button")).toHaveCount(0);
  await setLanguage(window, "zh-CN");
  await expect(why(tides)).toHaveText("没有合适的标签");
  await setLanguage(window, "en");
  await window.keyboard.press("Escape");
  await expect(tides.getByTestId("document-tags-popover")).toBeHidden();

  // Every Tag deleted: a Document the model never saw says so, and so does one checked before.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const tag of await bridge.listTags()) await bridge.deleteTag(tag.id);
  });
  const quarterly = await addNote(
    window,
    "Quarterly review",
    "Quarterly report for the sales team. Revenue grew.",
  );
  await expect(quarterly).toHaveAttribute("data-tagging", "no-tags");
  await openDocumentTags(quarterly);
  const line = why(quarterly);
  await expect(line).toHaveText("No Tags yet·Add a Tag");
  await expect(line).toHaveAttribute("data-why", "noTags");
  await window.keyboard.press("Escape");
  await openDocumentTags(tides);
  await expect(why(tides)).toHaveAttribute("data-why", "noTags");
  await window.keyboard.press("Escape");

  await openDocumentTags(quarterly);
  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("还没有标签·添加标签");
  await setLanguage(window, "en");
  await expect(line).toHaveText("No Tags yet·Add a Tag");

  // Tab from the field reaches Add a Tag, and Enter opens where Tags are made.
  await expect(quarterly.getByTestId("tag-picker-input")).toBeFocused();
  await window.keyboard.press("Tab");
  await expect(quarterly.getByTestId("document-tagging-add-tag")).toBeFocused();
  await window.keyboard.press("Enter");
  const dialog = window.getByTestId("tags-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("tag-name-input").fill("Report");
  await dialog.getByTestId("tag-description-input").fill("A report on how things went.");
  await dialog.getByTestId("save-tag").click();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  // The Document that had no Tags to choose from is checked against the new one.
  await expect(quarterly).toHaveAttribute("data-tagging", "tagged");
  const tokens = await openDocumentTags(quarterly);
  await expect(tokens).toHaveText(["Report"]);
  await expect(why(quarterly)).toHaveCount(0);
  await window.keyboard.press("Escape");

  // The Document checked before that Tag existed has no line: no Tag was shown not to fit.
  await openDocumentTags(tides);
  await expect(why(tides)).toHaveCount(0);
  await app.close();
});

test("the line holds in the picker at 900 px in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 900, 700);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const tag of await bridge.listTags()) await bridge.deleteTag(tag.id);
  });
  await setLanguage(window, "zh-CN");
  const note = await addNote(window, "Quarterly review", "Quarterly report for the sales team.");
  await openDocumentTags(note);
  const picker = note.getByTestId("document-tags-popover");
  const line = why(note);
  await expect(line).toHaveText("还没有标签·添加标签");
  const [pickerBox, lineBox, buttonBox] = await Promise.all([
    picker.boundingBox(),
    line.boundingBox(),
    note.getByTestId("document-tagging-add-tag").boundingBox(),
  ]);
  expect(pickerBox && lineBox && buttonBox).toBeTruthy();
  if (!pickerBox || !lineBox || !buttonBox) return;
  expect(lineBox.x).toBeGreaterThanOrEqual(pickerBox.x);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(pickerBox.x + pickerBox.width);
  await app.close();
});
