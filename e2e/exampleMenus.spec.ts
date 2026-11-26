import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  exampleRow,
  launchApp,
  newMind,
  openExample,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Where the examples are found and put away, now that the example Note holds no card or banner
 * (#3791): the sidebar's Examples heading and the example Note's own ⋯ offer the other examples
 * and removing them, with Undo, and the example's Documents stay reachable without its Note.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("the example's Documents stay reachable when its Mind is deleted after the User added files (#1944)", async () => {
  const sources = await createDataFolder();
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await openExample(window);
    await setWindowSize(app, window, 1440, 900);
    await window.getByTestId("add-documents-input").setInputFiles([notes]);
    await expect(window.getByTestId("example-section").getByTestId("mind-list-item")).toBeVisible({
      timeout: 20_000,
    });
    const sidebar = window.getByTestId("sidebar");
    await expect(sidebar.getByTestId("document-list-item")).toHaveCount(1);
    // Under the Examples heading nothing is badged: the heading says it, and the example's Linked
    // folder isn't listed there.
    const examples = window.getByTestId("example-section");
    await expect(examples.getByTestId("example-chip")).toHaveCount(0);
    await expect(examples.getByTestId("linked-folder-row")).toHaveCount(0);

    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { mindId } = await bridge.getExamples();
      if (mindId) await bridge.deleteMind(mindId);
    });
    // The Note's row goes with its Mind; the Examples section stays, listing the example's own
    // Documents, under its ⋯, until the User removes them: its folder is never a Folder (#3613).
    const exampleDocuments = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const examples = await bridge.getExamples();
      return (await bridge.listDocuments())
        .filter((doc) => doc.linkedFolderId === examples.linkedFolderId)
        .map((doc) => doc.name);
    });
    expect(exampleDocuments).toHaveLength(2);
    const left = window.getByTestId("example-section");
    await expect(left.getByTestId("mind-list-item")).toHaveCount(0);
    await expect
      .poll(async () =>
        (
          await left.getByTestId("document-list-item").getByTestId("row-text").allInnerTexts()
        ).sort(),
      )
      .toEqual([...exampleDocuments].sort());
    await expect(left.getByTestId("examples-menu")).toBeAttached();
    await expect(window.locator("[data-linked-folder-id]")).toHaveCount(0);
    await expect(
      window.getByTestId("library-folders").getByTestId("document-list-item"),
    ).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});

test("the Examples heading's ⋯ and the keyboard open the examples' menu, and the row's ⋯ is the Note's own (#1944, #1942)", async () => {
  const sources = await createDataFolder();
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await openExample(window);
    await setWindowSize(app, window, 1440, 900);
    await window.getByTestId("add-documents-input").setInputFiles([notes]);
    const example = window.getByTestId("example-section");
    await expect(example).toBeVisible({ timeout: 20_000 });
    await expect(example.getByTestId("mind-row").getByTestId("row-text")).toHaveText(
      "Draft: credit committee paper",
    );
    const menu = window.getByTestId("examples-actions");
    const button = example.getByTestId("examples-menu");

    await example.getByTestId("example-section-heading").hover();
    await pointAndClick(window, button);
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("example-more-link")).toHaveCount(4);
    await expect(menu.getByTestId("examples-remove")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // The keyboard reaches the heading's menu too.
    await button.focus();
    await window.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("example-more-link")).toHaveCount(4);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // The row keeps its own ⋯, the Note's menu, without the examples' actions.
    await pointAndClick(window, example.getByTestId("mind-menu"));
    await expect(window.getByTestId("mind-actions")).toBeVisible();
    await expect(window.getByTestId("mind-actions").getByTestId("examples-remove")).toHaveCount(0);
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});

test("the Examples row's ⋯ offers the other examples and removing them, which Undo takes back (#1195)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  await setWindowSize(app, window, 1440, 900);
  // The example Note itself holds only its line above the input: no banner offers these.
  await expect(window.getByTestId("example-line")).toBeVisible();
  await expect(window.getByTestId("example-more")).toHaveCount(0);

  const row = window.getByTestId("sidebar").getByTestId("not-in-a-folder");
  await row.hover();
  await pointAndClick(window, row.getByTestId("examples-menu"));
  const menu = row.getByTestId("examples-actions");
  await expect(menu).toBeVisible();
  const groups = menu.getByTestId("example-more-link");
  await expect(groups).toHaveCount(4);
  await pointAndClick(window, groups.first());
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);

  await row.hover();
  await pointAndClick(window, row.getByTestId("examples-menu"));
  await pointAndClick(window, menu.getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "Removed the examples",
  );
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await app.close();
});

const WORDS = {
  en: { more: "Try an example closer to your work:", remove: "Remove the examples" },
  "zh-CN": { more: "换一个和你工作更相关的示例：", remove: "移除示例" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`an example Mind's page ⋯ offers the other examples and removing them, after an own Mind has been made, with Undo (${language}) (#1195)`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    await openExample(window);
    await setWindowSize(app, window, 900, 900);
    await setLanguage(window, language);
    await dismissChatSetup(window);
    const examples = exampleRow(window);

    await newMind(window);
    const own = await openPageMenu(window);
    await expect(own.getByTestId("examples-remove")).toHaveCount(0);
    await expect(own.getByTestId("example-more-link")).toHaveCount(0);
    await window.keyboard.press("Escape");

    await pointAndClick(window, examples);
    const menu = await openPageMenu(window);
    await expect(menu.getByTestId("example-more-link")).toHaveCount(4);
    await expect(menu).toContainText(WORDS[language].more);
    const remove = menu.getByTestId("examples-remove");
    await expect(remove).toHaveText(WORDS[language].remove);
    const rule = remove.locator("xpath=preceding-sibling::*[1]");
    await expect(rule).toBeEmpty();
    await expect(rule.locator("xpath=preceding-sibling::*[1]")).toHaveAttribute(
      "data-testid",
      "example-more-link",
    );
    const [groupsAt, removeAt, deleteAt] = await Promise.all([
      menu.getByTestId("example-more-link").last().boundingBox(),
      remove.boundingBox(),
      menu.getByTestId("mind.delete").boundingBox(),
    ]);
    expect(groupsAt && removeAt && deleteAt && groupsAt.y < removeAt.y).toBe(true);
    expect(removeAt && deleteAt && removeAt.y < deleteAt.y).toBe(true);

    await pointAndClick(window, menu.getByTestId("example-more-link").first());
    await expect(examples).toHaveCount(2);
    const again = await openPageMenu(window);
    await pointAndClick(window, again.getByTestId("examples-remove"));
    await expect(examples).toHaveCount(0);
    await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
      language === "en" ? "Removed the examples" : "已移除示例",
    );
    await window.keyboard.press("ControlOrMeta+z");
    await expect(examples).toHaveCount(2);
    await app.close();
  });
}
