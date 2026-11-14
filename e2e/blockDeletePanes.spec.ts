import { expect, type Locator, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  splitFromTabMenu,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** The words of the Block a pane's cursor is in, as the editor holds it. */
const cursorIn = (pane: Locator) =>
  pane.evaluate((dom) => {
    const { editor } = dom as unknown as { editor: Editor };
    return editor.state.selection.$from.parent.textContent;
  });

test("⇧⌘⌫ deletes the Block the cursor is in, in the pane the key was pressed in, with the same Note open in two panes", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await mindWrittenBefore(window, "Pane notes", [
    { note: "Alpha" },
    { note: "Bravo" },
    { note: "Charlie" },
    { note: "Delta" },
  ]);
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Pane notes" }),
  );
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveCount(4);
  await splitFromTabMenu(window);
  const groups = window.getByTestId("tab-group");
  await expect(groups).toHaveCount(2);
  const leftEditor = groups.nth(0).getByTestId("mind-editor");
  const rightEditor = groups.nth(1).getByTestId("mind-editor");
  const left = leftEditor.locator("p");
  const right = rightEditor.locator("p");
  await expect(left).toHaveCount(4);
  await expect(right).toHaveCount(4);
  const both = async (words: string[]) => {
    await expect(left).toHaveText(words);
    await expect(right).toHaveText(words);
  };

  // The left pane's cursor is in Alpha, the right pane's in Bravo, and the key is pressed in the
  // right: Bravo goes, whichever pane the Note's first editor is.
  await pointAndClick(window, left.nth(0));
  await pointAndClick(window, right.nth(1));
  await expect.poll(() => cursorIn(leftEditor)).toBe("Alpha");
  await expect.poll(() => cursorIn(rightEditor)).toBe("Bravo");
  await window.keyboard.press("ControlOrMeta+Shift+Backspace");
  await both(["Alpha", "Charlie", "Delta"]);

  // The other way round: the right pane's cursor is in Delta, the left's in Alpha, and the key is
  // pressed in the left: Alpha goes.
  await pointAndClick(window, right.nth(2));
  await pointAndClick(window, left.nth(0));
  await expect.poll(() => cursorIn(rightEditor)).toBe("Delta");
  await expect.poll(() => cursorIn(leftEditor)).toBe("Alpha");
  await window.keyboard.press("ControlOrMeta+Shift+Backspace");
  await both(["Charlie", "Delta"]);
  await app.close();
});
