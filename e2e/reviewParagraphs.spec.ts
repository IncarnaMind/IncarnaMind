import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Review changes after the assistant wrote its own text anew (#1488): only the paragraphs it
 * changed are marked, word by word or with one "Was: …" line, the one it added is marked as
 * added, the rest read as they are, and the count is the same on the page's line, the
 * Answer's card and Review's own line. The scripted model (src/main/fakeChat/minds.ts) writes
 * a tide report of eight paragraphs, then, asked to make it longer, gives its whole new text:
 * three paragraphs edited, one written anew and one added. A bulleted list given anew stays a
 * list. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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
    restored: "Spring tides come at new and full moon.",
    pageLine: "Changed 5 paragraphs",
    card: "Changed 5 paragraphs in “Tide report”",
    review: "5 paragraphs changed by the assistant",
    reviewAfterRestore: "4 paragraphs changed by the assistant",
    was: "Was: Neap tides come at the quarter moons.",
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
    restored: "大潮出现在新月和满月前后。",
    pageLine: "修改了 5 个段落",
    card: "已修改“潮汐报告”中的 5 段",
    review: "助手修改的 5 个段落",
    reviewAfterRestore: "助手修改的 4 个段落",
    was: "原文：小潮出现在上弦月和下弦月。",
  },
] as const;

async function marked(editor: Locator) {
  const marks = editor.page().locator(".applied-new, del");
  return {
    changed: await editor.locator(":scope > p").filter({ has: marks }).count(),
    added: await editor.locator(":scope > p.applied-new--block").count(),
    unmarked: await editor
      .locator(":scope > p:not(.applied-new--block)")
      .filter({ hasNot: marks })
      .count(),
  };
}

const fitsWidth = (editor: Locator) =>
  editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);

for (const each of CASES) {
  test(`a report made longer shows its 4 changed paragraphs and 1 added in Review changes, the rest as they are, one count everywhere, wide and narrow (${each.language})`, async () => {
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
    const line = editor.getByTestId("applied-line");
    const count = line.getByTestId("applied-count");
    await expect(count).toHaveText(each.pageLine);
    await expect(answer.getByTestId("mind-changes-title")).toHaveText(each.card);

    await pointAndClick(window, line.getByTestId("applied-review"));
    await expect(count).toHaveText(each.review);
    expect(await marked(editor)).toEqual({ changed: 4, added: 1, unmarked: 4 });
    await expect(paragraphs.nth(5)).toHaveClass(/applied-new--block/);
    await expect(editor.locator(".applied-old--block")).toHaveCount(0);
    const was = editor.getByTestId("change-was-line");
    await expect(was).toHaveText([each.was]);
    const [wasBox, rewrittenBox] = await Promise.all([
      was.boundingBox(),
      paragraphs.nth(1).boundingBox(),
    ]);
    expect((wasBox?.y ?? 0) + (wasBox?.height ?? 0)).toBeLessThanOrEqual(
      (rewrittenBox?.y ?? 0) + 1,
    );
    await motionSettled(window);
    await screenshot(window, `review-paragraphs-wide-${each.language}`);

    await setWindowSize(app, window, 900, 900);
    await expect(count).toHaveText(each.review);
    expect(await marked(editor)).toEqual({ changed: 4, added: 1, unmarked: 4 });
    expect(await fitsWidth(editor)).toBe(true);
    await motionSettled(window);
    await screenshot(window, `review-paragraphs-narrow-${each.language}`);
    await setWindowSize(app, window, 1440, 900);

    // Restore original takes back the one change it is under, and the count follows.
    await pointAndClick(window, paragraphs.first().getByTestId("change-restore"));
    await expect(paragraphs.first()).toHaveText(each.restored);
    await expect(count).toHaveText(each.reviewAfterRestore);

    // Undo all, from Review's own line, brings back the report as it was written.
    await pointAndClick(window, line.getByTestId("applied-undo-all"));
    await expect(paragraphs).toHaveText([...each.written]);
    await app.close();
  });
}

test("a bulleted list given anew stays a list in Review changes: the item edited marked in place, the one left out struck as an item, the new one added", async () => {
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
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 2 paragraphs");
  await pointAndClick(window, line.getByTestId("applied-review"));
  await expect(line.getByTestId("applied-count")).toHaveText(
    "2 paragraphs changed by the assistant",
  );
  await expect(editor.locator(":scope > ul")).toHaveCount(1);
  await expect(items).toHaveCount(4);
  await expect(items.nth(0).locator(".applied-new")).toHaveText(" with a hood");
  await expect(items.nth(1).locator(".applied-new, del")).toHaveCount(0);
  await expect(items.nth(2)).toHaveClass(/applied-old/);
  await expect(items.nth(2)).toHaveText("A flask of tea");
  await expect(items.nth(2).locator("p")).toHaveCSS("text-decoration-line", "line-through");
  await expect(items.nth(2)).toHaveCSS("display", "list-item");
  await expect(items.nth(3)).toHaveClass(/applied-new--block/);
  await expect(items.nth(3)).toHaveText("Spare socks");
  await motionSettled(window);
  await screenshot(window, "review-list-en");

  const restores = editor.getByTestId("change-restore");
  await expect(restores).toHaveCount(3);
  await pointAndClick(window, restores.nth(1));
  await expect(items).toHaveCount(4);
  await expect(items.nth(2)).toHaveText("A flask of tea");
  await expect(items.nth(2)).not.toHaveClass(/applied-old/);
  await expect(items.nth(3)).toHaveText("Spare socks");
  await pointAndClick(window, restores.last());
  await expect(items).toHaveCount(3);
  await expect(items.nth(2)).toHaveText("A flask of tea");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "1 paragraph changed by the assistant",
  );
  await app.close();
});
