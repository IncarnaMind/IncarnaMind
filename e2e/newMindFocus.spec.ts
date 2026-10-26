import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  newEditorShownFocused,
  newMindAndType,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  watchNewEditorFocus,
} from "./app";

/*
 * #2000: ⌘T returns before the core has made the Mind, so keys typed while its editor is still
 * being drawn had nowhere to go and the first of them was lost. They are held and put in the new
 * Mind once its text has the focus, and its text has that focus as the editor shows.
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
