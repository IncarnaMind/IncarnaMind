import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addDocuments,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * A figure keeps exactly the units its Document states (#1332). A sentence
 * cited to "The annual salary is 54,000", once a "£" is added to its figure,
 * checks as Unsupported, and its card names the currency as the part its
 * Citation doesn't support. The scripted model calls it supported: a program
 * catches the currency. English and Chinese.
 */
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

const CONTRACT =
  "Employment agreement between Harbourline Ltd and the Employee.\nThe annual salary is 54,000, paid monthly in arrears.\nThe notice period is three months.\n";
const SENTENCE = "The annual salary is 54,000, paid monthly in arrears.";
const COVERS = {
  en: "Your Citation supports the amount, 54,000, not the parts about the currency (£).",
  "zh-CN": "引用支持金额 54,000，但不支持币种（£）的部分。",
} as const;

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a cited figure given a currency its Document doesn't state checks as Unsupported, naming the currency (${language}, ${width}px)`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Employment agreement.txt"), CONTRACT);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setWindowSize(app, window, width, 900);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, "Employment agreement.txt")]);
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.type(SENTENCE);
      const line = editor.locator(":scope > p").first();

      // The sentence as the Document writes it is supported, and cited with Add as Citation.
      await slideSelect(window, line, "The annual", { line, words: "arrears." });
      const menu = window.getByTestId("selection-menu");
      await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
      const mark = window.getByTestId("claim-mark");
      await expect(mark).toHaveAttribute("data-check", "supported");
      await pointAndClick(window, mark);
      await pointAndClick(
        window,
        window.getByTestId("claim-card").getByTestId("claim-add-citation"),
      );
      await expect(line.getByTestId("citation")).toHaveAttribute("data-check", "found");

      // A "£" the Document never states, added to its figure.
      await slideSelect(window, line, "54,000");
      await window.keyboard.type("£54,000");
      // The Citation now sits after "arrears".
      await slideSelect(window, line, "The annual", { line, words: "arrears" });
      await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
      await expect(mark).toHaveAttribute("data-check", "unsupported");
      await pointAndClick(window, mark);
      await expect(window.getByTestId("claim-card").getByTestId("claim-covers")).toHaveText(
        COVERS[language],
      );
    } finally {
      await app.close();
    }
  });
}
