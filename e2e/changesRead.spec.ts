import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
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
 * How what an AI edit did reads on the Note's line (#1028; DESIGN.md, AI edits), after ⌘J: a
 * paragraph counts once however its words changed, a section rewritten counts by its paragraphs,
 * a list item replaced by one about something else counts as a paragraph added, and a table
 * counts as one table. The scripted model does what "replace X with Y" (把 X 换成 Y) says. Set
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

async function mindWith(window: Page, lines: readonly string[]): Promise<Locator> {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  await expect(editor.locator(":scope > p")).toHaveText(lines);
  return editor;
}

test("a résumé's section rewritten as a whole counts by paragraph on the line, the title included", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 1100, 760);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("## 履历亮点与待核实事项");
  for (const line of [
    "跨医疗、金融两个行业的数据分析经验。",
    "熟悉财务建模与估值。",
    "英语 CET-6，雅思 7.5。",
  ]) {
    await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  await expect(editor.locator(":scope > h2")).toHaveText("履历亮点与待核实事项");
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("重写这一节");
  await window.keyboard.press("Enter");

  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 4 个段落");
  await expect(editor.locator(":scope > h2")).toHaveText("核心优势");
  await motionSettled(window);
  await screenshot(window, "changes-section-zh");
  await app.close();
});

/** A Mind with a heading and a bulleted list under it, typed as the User would. */
async function listWith(window: Page, heading: string, items: readonly string[]): Promise<Locator> {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(`## ${heading}`);
  await window.keyboard.press("Enter");
  await window.keyboard.type("- ");
  for (const [index, item] of items.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(item);
  }
  await expect(editor.locator("li")).toHaveText(items);
  return editor;
}

/** ⌘J over the whole Mind, saying what to change, and the edit applied. */
async function changeAll(window: Page, instruction: string) {
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(instruction);
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("edit-pending")).toHaveCount(0);
}

for (const language of ["en", "zh-CN"] as const) {
  // A reply without names doesn't say the old item goes, and the new one says none of its words: it is added, and the old one stays as left out (#2356).
  test(`a résumé's list item replaced by one about something else, the reply not quoting the old one: the new item comes once, the old one stays as left out, and the line says a paragraph was added (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 760);
    const [heading, items, old, made, start] =
      language === "en"
        ? [
            "Experience",
            [
              "Led quarterly forecasting for a team of twelve analysts",
              "Presented findings to the board every month",
              "Cut the month-end close from ten days to six",
            ],
            "Led quarterly forecasting for a team of twelve analysts",
            "Ran the forecast cycle each quarter",
            "Ran the forecast cycle…",
          ]
        : [
            "教育经历",
            ["2016.09—2018.06 上海财经大学 会计学 硕士", "2012.09—2016.06 复旦大学 金融学 学士"],
            "2016.09—2018.06 上海财经大学 会计学 硕士",
            "2018.10—至今 Quillmere Hart Advisory, Senior Manager",
            "2018.10—…",
          ];
    const editor = await listWith(window, heading, items);

    await changeAll(
      window,
      language === "en" ? `replace ${old} with ${made}` : `把${old}换成${made}`,
    );

    const line = editor.getByTestId("applied-line");
    await expect(line.getByTestId("applied-count")).toHaveText(
      translate(language, "edit.added.named", { start }),
    );
    // The old item's own line, "Kept 1 Block the edit left out · Remove it", sits in its list item.
    await expect(editor.locator("li")).toContainText(
      items.flatMap((item) => (item === old ? [made, old] : [item])),
    );
    await expect(editor.locator("li")).toHaveCount(items.length + 1);
    await expect(editor.getByTestId("applied-kept")).toHaveCount(1);
    await motionSettled(window);
    await screenshot(window, `changes-item-replaced-${language}`);
    await app.close();
  });

  test(`a table added by Edit with AI counts as one table on its line (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 760);
    const [line, instruction, count] =
      language === "en"
        ? ["Spring tides are strongest at new moon.", "add a table", "Added a table"]
        : ["新月时大潮最强。", "加一个表格", "添加了 1 个表格"];
    const editor = await mindWith(window, [line]);

    await changeAll(window, instruction);

    const applied = editor.getByTestId("applied-line");
    await expect(editor.locator("table")).toHaveCount(1);
    await expect(applied.getByTestId("applied-count")).toHaveText(count);
    // Its Undo is under the paragraph, on the applied line, not at the sidebar's foot.
    await expect(window.getByTestId("undo-message")).toHaveCount(0);
    await app.close();
  });
}
