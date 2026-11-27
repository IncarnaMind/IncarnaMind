import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The applied line sits with the paragraph it changed (#1018): under the paragraph above it,
 * nearer to the one it changed. The scripted model's "shorten" drops "very" and "really" (非常
 * and 真的) from the second paragraph. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const SIZES = [
  { width: 1600, height: 900 },
  { width: 900, height: 900 },
] as const;

interface Case {
  language: "en" | "zh-CN";
  lines: readonly [string, string];
  ask: string;
  shortened: string;
}

const CASES: readonly Case[] = [
  {
    language: "en",
    lines: [
      "Tides rise twice a day along this coast.",
      "The tides here are very strong and really regular.",
    ],
    ask: "shorten it",
    shortened: "The tides here are strong and regular.",
  },
  {
    language: "zh-CN",
    lines: ["潮水每天涨落两次。", "潮水非常强，而且真的很有规律。"],
    ask: "缩短",
    shortened: "潮水强，而且很有规律。",
  },
];

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const gapsAround = async (line: Locator, above: Locator, below: Locator) => {
  const [lineBox, aboveBox, belowBox] = await Promise.all([
    line.boundingBox(),
    above.boundingBox(),
    below.boundingBox(),
  ]);
  if (!lineBox || !aboveBox || !belowBox) throw new Error("The line or a paragraph isn't drawn.");
  return {
    above: lineBox.y - (aboveBox.y + aboveBox.height),
    below: belowBox.y - (lineBox.y + lineBox.height),
  };
};

for (const { language, lines, ask, shortened } of CASES) {
  test(`the applied line sits with the paragraph it changed, nearer to it than to the paragraph above, wide and narrow (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);

    for (const { width, height } of SIZES) {
      await setWindowSize(app, window, width, height);
      await newMind(window);
      const editor = frontMind(window).getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.type(lines[0]);
      await window.keyboard.press("Enter");
      await window.keyboard.type(lines[1]);
      const paragraphs = editor.locator(":scope > p");
      await expect(paragraphs).toHaveText([...lines]);
      const [first, note] = [paragraphs.first(), paragraphs.nth(1)];
      const line = editor.getByTestId("applied-line");

      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.press("ControlOrMeta+j");
      await expect(window.getByTestId("composer-input")).toBeFocused();
      await window.keyboard.type(ask);
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("edit-pending")).toHaveCount(0);
      await expect(note).toHaveText(shortened);
      await expect(line).toBeVisible();

      const applied = await gapsAround(line, first, note);
      expect(applied.below).toBeGreaterThanOrEqual(0);
      expect(applied.below).toBeLessThan(applied.above);
      await expect(line.getByTestId("applied-count")).toHaveCSS("font-weight", "400");
      await motionSettled(window);
      await screenshot(window, `applied-line-place-${language}-${width}`);
    }
    await app.close();
  });
}
