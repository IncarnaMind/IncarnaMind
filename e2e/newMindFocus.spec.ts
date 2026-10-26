import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  newEditorShownFocused,
  newMind,
  newMindAndType,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  watchNewEditorFocus,
} from "./app";

/*
 * #2000: ⌘T returns before the core has made the Mind, so keys typed while its editor is still
 * being drawn had nowhere to go and the first of them was lost. The focus moves at once to a
 * blank spot, so nothing typed meanwhile reaches the Mind the User left, and what is typed is
 * held and put in the new Mind once its text has the focus. A Mind that isn't shown releases
 * the hold and gives the focus back.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LANGUAGES = ["en", "zh-CN"] as const;
const ROUNDS = 20;

/** A Mind the User was in, with a line of their own, its text under the cursor. */
async function noteOfTheUser(window: Page, text: string) {
  await newMind(window);
  await window.keyboard.insertText(text);
  const editor = frontMind(window).getByTestId("mind-editor");
  await expect(editor).toHaveText(text);
  return editor;
}

/** A six-times slower renderer, where a Mind takes longer to be drawn than a person takes to type. */
async function busyComputer(window: Page) {
  const devtools = await window.context().newCDPSession(window);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  return devtools;
}

/** The core refuses every layout change, so the new Mind's tab never opens. */
async function refuseOpens(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      }
    )._invokeHandlers;
    if (!handlers.get("core:changeLayout")) throw new Error("The changeLayout handler is missing.");
    ipcMain.removeHandler("core:changeLayout");
    ipcMain.handle("core:changeLayout", async () => {
      throw new Error("The layout was refused.");
    });
  });
}

for (const language of LANGUAGES) {
  test(`every key typed at once after ⌘T lands in the new Mind, whose text has the focus as it shows (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    const devtools = await window.context().newCDPSession(window);
    // A busy computer, whose editor is drawn later than a fast typist takes to type five letters.
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: 6 });

    const editor = frontMind(window).getByTestId("mind-editor");
    for (let round = 1; round <= ROUNDS; round++) {
      const word = `test${round}`;
      await watchNewEditorFocus(window);
      await newMindAndType(window, word);
      await expect(editor, `round ${round} of ${ROUNDS}`).toHaveText(word);
      await expect(editor, `round ${round} of ${ROUNDS}`).toBeFocused();
      expect(await newEditorShownFocused(window), `round ${round} of ${ROUNDS}`).toBe(true);
    }
    // One tab and one Mind per round: no ⌘T was lost either.
    await expect(window.getByTestId("mind-tab")).toHaveCount(ROUNDS);
    await app.close();
  });
}

test("a Backspace typed the instant ⌘T makes a Mind leaves the Mind the User left untouched, and the letters still land in the new one (en)", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await noteOfTheUser(window, "Keep me.");
  // A busy computer: the Mind takes longer to be made than a person takes to press the next key.
  await busyComputer(window);

  await window.keyboard.press("ControlOrMeta+t");
  await window.keyboard.press("Backspace");
  await window.keyboard.type("test");
  await expect(frontMind(window).getByTestId("mind-editor")).toHaveText("test");

  // Back to the Mind the User left: its own line is whole.
  await window.keyboard.press("ControlOrMeta+w");
  await expect(frontMind(window).getByTestId("mind-editor")).toHaveText("Keep me.");
  await app.close();
});

test("an input method composing the instant ⌘T makes a Mind leaves the Mind the User left untouched, and the letters after it still land in the new one (zh-CN)", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 1440, 900);
  await noteOfTheUser(window, "留着。");

  // A busy computer: the Mind takes longer to be made than a person takes to compose a word.
  const devtools = await busyComputer(window);
  try {
    await window.keyboard.press("ControlOrMeta+t");
    await devtools.send("Input.imeSetComposition", {
      text: "nihao",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await devtools.send("Input.insertText", { text: "你" });
    await window.keyboard.type("test");
  } finally {
    await devtools.detach();
  }
  // The composed word goes nowhere, or into the new Mind; never into the one the User left.
  await expect(frontMind(window).getByTestId("mind-editor")).toHaveText(/^(你)?test$/);

  await window.keyboard.press("ControlOrMeta+w");
  await expect(frontMind(window).getByTestId("mind-editor")).toHaveText("留着。");
  await app.close();
});

test("a refused open releases the hold and gives the focus back, so no letter is swallowed (en)", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  const editor = await noteOfTheUser(window, "Keep me.");

  await refuseOpens(app);
  await window.keyboard.press("ControlOrMeta+t");
  // The refusal is said where it happened; by then the hold is gone and the focus is back.
  await expect(window.getByTestId("error-notice")).toHaveCount(1);
  await expect(window.getByTestId("new-mind-keys")).toHaveCount(0);
  await expect(editor).toBeFocused();
  await window.keyboard.type(" more");
  await expect(editor).toHaveText("Keep me. more");
  await expect(window.getByTestId("mind-tab")).toHaveCount(1);
  await app.close();
});
