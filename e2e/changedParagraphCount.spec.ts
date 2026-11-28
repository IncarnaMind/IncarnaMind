import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * What the assistant did when it wrote its own text anew (#1488): the page's line and the
 * Answer's card give the same count, one for each paragraph it changed or added, and the rest read
 * as they are. The scripted model (src/main/fakeChat/minds.ts) writes a tide report of eight
 * paragraphs, then, asked to make it longer, gives its whole new text: three paragraphs edited,
 * one written anew and one added. A bulleted list given anew stays a list. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const CASES = [
  {
    language: "en",
    write: "Write the tide report",
    longer: "Make the tide report longer",
    title: "Tide report",
    written: [
      "Spring tides come at new and full moon.",
      "Neap tides come at the quarter moons.",
      "The harbour office posts the times each week.",
      "Boats rest on the mud at low water.",
      "Gulls wheel over the quay at dawn.",
      "The ferry runs twice a day in summer.",
      "Storms can raise the water by a metre.",
      "The lifeboat station opens on Sundays.",
    ],
    added: "Fishing boats leave on the first of the ebb.",
    pageLine: "Changed 5 paragraphs",
    card: "Changed 5 paragraphs in “Tide report”",
  },
  {
    language: "zh-CN",
    write: "写一份潮汐报告",
    longer: "把潮汐报告写长一点",
    title: "潮汐报告",
    written: [
      "大潮出现在新月和满月前后。",
      "小潮出现在上弦月和下弦月。",
      "港务处每周公布潮汐时间。",
      "退潮时船只停在泥滩上。",
      "黎明时海鸥在码头上空盘旋。",
      "夏季渡轮每天往返两次。",
      "风暴会让水位升高一米。",
      "救生艇站周日开放。",
    ],
    added: "渔船在退潮开始时出海。",
    pageLine: "修改了 5 个段落",
    card: "已修改“潮汐报告”中的 5 段",
  },
] as const;

for (const each of CASES) {
  test(`a report made longer says one count, 4 changed paragraphs and 1 added, on the page's line and the Answer's card (${each.language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, each.language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    await askInAssistant(window, each.write);
    const editor = window.getByTestId("mind-editor");
    const paragraphs = editor.locator(":scope > p");
    await expect(paragraphs).toHaveText([...each.written]);

    const answer = await askInAssistant(window, each.longer);

    await expect(paragraphs).toHaveCount(9);
    await expect(paragraphs.nth(5)).toHaveText(each.added);
    await expect(editor.getByTestId("applied-line").getByTestId("applied-count")).toHaveText(
      each.pageLine,
    );
    await expect(answer.getByTestId("mind-changes-title")).toHaveText(each.card);
    await motionSettled(window);
    await screenshot(window, `review-paragraphs-${each.language}`);
    await app.close();
  });
}

test("a bulleted list given anew stays a list: the item edited, the one left out gone, the new one added", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await askInAssistant(window, "Write the packing list");
  const editor = window.getByTestId("mind-editor");
  const items = editor.locator(":scope > ul > li");
  await expect(items).toHaveText(["A warm coat", "Tide tables for May", "A flask of tea"]);

  await askInAssistant(window, "Update the packing list");

  await expect(items).toHaveText(["A warm coat with a hood", "Tide tables for May", "Spare socks"]);
  await expect(editor.locator(":scope > ul")).toHaveCount(1);
  await expect(editor.getByTestId("applied-line").getByTestId("applied-count")).toHaveText(
    "Changed 2 paragraphs",
  );
  await motionSettled(window);
  await screenshot(window, "review-list-en");
  await app.close();
});
