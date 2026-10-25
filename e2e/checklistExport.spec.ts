import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  exportFromMenu,
  focusSettled,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openDocumentAt,
  pointAndClick,
  removeDataFolder,
  savedLine,
  setLanguage,
  useOutputLocation as setOutputLocation,
  setWindowSize,
} from "./app";

let dataDir: string;
let output: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  output = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(output);
});

async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Markdown archive keeps checklist states when added back to the Library (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 720);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await newMind(window);
      await nameMind(window, "Checklist 清单");
      const editor = window.getByTestId("mind-editor");
      await pointAndClick(window, editor);
      await focusSettled(window, editor);
      await window.keyboard.type("[ ] ");
      await window.keyboard.insertText("核查清单项");
      await window.keyboard.press("Enter");
      await window.keyboard.insertText("Submit report");
      await window.keyboard.press("Enter");
      const boxes = editor.getByRole("checkbox");
      await expect(boxes).toHaveCount(3);
      await pointAndClick(window, boxes.first());
      await expect(boxes.first()).toBeChecked();
      await expect(boxes.nth(1)).not.toBeChecked();
      await expect(boxes.nth(2)).not.toBeChecked();
      await screenshot(window, `checklist-source-${language}`);

      await setOutputLocation(window, output);
      await exportFromMenu(window, "markdown");
      await expect(window.getByTestId("export-done")).toHaveText(
        savedLine("Checklist 清单.md", output, language),
      );
      const path = join(output, "Checklist 清单.md");
      const markdown = await readFile(path, "utf8");
      expect(markdown).toContain("- [x] 核查清单项\n- [ ] Submit report\n- [ ] \n");

      await addDocuments(window, [path]);
      await openDocumentAt(window, {
        documentId: await documentIdOf(window, "Checklist 清单"),
      });
      const viewer = window.getByTestId("viewer-text");
      await expect(viewer).toHaveAttribute("data-view", "formatted");
      const imported = viewer.getByRole("checkbox");
      await expect(imported).toHaveCount(3);
      await expect(imported.first()).toBeChecked();
      await expect(imported.nth(1)).not.toBeChecked();
      await expect(imported.nth(2)).not.toBeChecked();
      await expect(viewer).toContainText("核查清单项");
      await expect(viewer).toContainText("Submit report");
      await screenshot(window, `checklist-imported-${language}`);
    } finally {
      await app.close();
    }
  });
}
