import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  frontMindName,
  launchApp,
  nameMind,
  newMind,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * The assistant changes Minds and makes them (#202). The scripted model
 * (src/main/fakeChat/minds.ts) calls edit_mind for a request to shorten,
 * which drops "very" and "really" (非常), and create_mind for a new note;
 * anything else is answered. Each change applies in its Mind at once, and
 * the Answer's line says so, with Undo (#1559). Set INCARNAMIND_SCREENSHOTS to
 * a folder to also save screenshots.
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

/** A new Mind, named, and its Notes typed as a person types them. */
async function writeMind(window: Page, title: string, notes: string[]): Promise<void> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, title);
  for (const [index, line] of notes.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText(notes);
}

test("a Question is answered and changes nothing; a request to shorten applies in the Mind at once, which the steps name, and its line's Undo takes it back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  const note = "The quarter was very good, and sales were really strong.";
  await writeMind(window, "Q3 review", [note]);
  const editor = window.getByTestId("mind-editor");

  const answered = await askInAssistant(window, "How was the quarter?");
  await expect(answered.getByTestId("assistant-answer-text")).toContainText("scripted");
  await expect(answered.getByTestId("mind-changes")).toHaveCount(0);
  await expect(editor.locator("p")).toHaveText([note]);

  const changed = await askInAssistant(window, "Could you shorten the summary?");
  await expect(editor.locator("p")).toHaveText(["The quarter was good, and sales were strong."]);
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(changed.getByTestId("mind-changes-title")).toHaveText(
    "Changed 1 paragraph in “Q3 review”",
  );
  // The Mind is the one in front, so its line has no Open.
  await expect(changed.getByTestId("mind-changes-open")).toHaveCount(0);
  const timeline = await openSteps(window, changed);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(
    /Edited “Q3 review” · 2 changes/,
  );
  await screenshot(window, "assistant-changed-mind");

  await pointAndClick(window, changed.getByTestId("mind-changes-undo"));
  await expect(editor.locator("p")).toHaveText([note]);
  await expect(changed.getByTestId("mind-changes-undone")).toHaveText("Undone");
});

test("a request for a new note makes a Mind beside the one in focus, its text applied, and its line has Open and Undo; in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "第三季度", ["销售非常好。"]);

  const answer = await askInAssistant(window, "新建一篇叫“田野计划”的笔记，写上三个步骤");

  const tab = window.getByTestId("mind-tab").filter({ hasText: "田野计划" });
  await expect(tab).toBeVisible();
  await expect(window.getByTestId("mind-tab").filter({ hasText: "第三季度" })).toBeVisible();
  await expect(frontMindName(window)).toHaveText("田野计划");
  await expect(window.getByTestId("proposals-count")).toHaveCount(0);
  await expect(answer.getByTestId("mind-changes-title")).toHaveText("已写入“田野计划”");
  await expect(answer.getByTestId("mind-changes-open")).toHaveText("打开");
  await expect(answer.getByTestId("mind-changes-undo")).toHaveText("撤销");
  const timeline = await openSteps(window, answer);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(/新建了“田野计划”/);
  await screenshot(window, "assistant-made-mind-zh");
});

test("a change in a Mind not in front names it, with Open and Undo, beside the line of the Mind the turn made", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Project plan", ["Hire a designer."]);
  await writeMind(window, "Q3 review", ["The quarter was good."]);

  const answer = await askInAssistant(
    window,
    "Add Ship the beta in May to Project plan and make a new note called Fieldwork plan",
  );
  const titles = answer.getByTestId("mind-changes-title");
  await expect(titles).toHaveText([
    "Wrote 1 paragraph in “Project plan”",
    "Wrote “Fieldwork plan”",
  ]);
  await expect(window.getByTestId("proposals-count")).toHaveCount(0);
  await expect(frontMindName(window)).toHaveText("Fieldwork plan");
  await screenshot(window, "card-two-minds");

  await pointAndClick(window, answer.getByTestId("mind-changes-open").first());
  await expect(frontMindName(window)).toHaveText("Project plan");
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("p")).toHaveText(["Hire a designer.", "Ship the beta in May"]);
  // In front now, the Mind's line keeps its Undo.
  await pointAndClick(window, answer.getByTestId("mind-changes-undo").first());
  await expect(editor.locator("p")).toHaveText(["Hire a designer."]);
  await expect(window.getByTestId("mind-tab").filter({ hasText: "Fieldwork plan" })).toHaveCount(1);
});

test("one Mind changed: its line counts the paragraphs, and ⌘Z in the Mind takes the change back; in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await writeMind(window, "第三季度", ["销售非常好，利润真的很高。"]);

  const answer = await askInAssistant(window, "能把这段缩短吗？");
  const title = answer.getByTestId("mind-changes-title");
  await expect(title).toHaveText("已修改“第三季度”中的 1 段");
  await expect(answer.getByTestId("mind-changes-left")).toHaveCount(0);
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("p")).toHaveText(["销售好，利润很高。"]);
  await screenshot(window, "card-one-mind-zh");

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("p")).toHaveText(["销售非常好，利润真的很高。"]);
  await expect(answer.getByTestId("mind-changes-undone")).toHaveText("已撤销");
});

test("“Create a new note called Fieldwork plan” makes a Mind at once, its title its first line and the cursor under it, with no Answer", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  const answers = assistantAnswers(window);
  const before = await answers.count();

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Create a new note called Fieldwork plan");
  await window.keyboard.press("Enter");

  await expect(window.getByTestId("mind-tab").filter({ hasText: "Fieldwork plan" })).toBeVisible();
  await expect(frontMindName(window)).toHaveText("Fieldwork plan");
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toBeFocused();
  await expect(editor.locator(":scope > h1")).toHaveText("Fieldwork plan");
  await window.keyboard.type("First visit: the roastery.");
  await expect(editor.locator(":scope > *")).toHaveText([
    "Fieldwork plan",
    "First visit: the roastery.",
  ]);
  await expect(answers).toHaveCount(before);
  await expect(window.getByTestId("composer-input")).toHaveValue("");
  await screenshot(window, "empty-note-by-name");
});

test("with no Mind open, a request to change one says so, and New Mind makes one and asks it again there", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await expect(window.getByTestId("mind-tab")).toHaveCount(0);

  const answer = await askInAssistant(window, "Add a risks section");
  await expect(answer.getByTestId("assistant-answer-text")).toContainText("No Mind is open");
  const offer = answer.getByTestId("mind-changes-no-mind");
  await expect(offer).toContainText("No Mind was open to change.");
  await screenshot(window, "no-mind-open");
  await pointAndClick(window, offer.getByTestId("mind-changes-new-mind"));

  // The request goes to the new Mind, asked again from it, and applies there as asked (#880).
  await expect(window.getByTestId("mind-tab")).toHaveCount(1);
  const again = assistantAnswers(window).last();
  await expect(assistantAnswers(window)).toHaveCount(2);
  await expect(again).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(window.getByTestId("applied-count")).toHaveText("Wrote 1 paragraph");
  await expect(window.getByTestId("mind-editor")).toContainText("a risks section");
  await expect(again.getByTestId("mind-changes-no-mind")).toHaveCount(0);
});

test("a change the assistant makes in a Mind comes in paragraph by paragraph, with Writing… on the next, applies, and its line counts them", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  const last = "Hiring was very slow, and the new office opened really late in the year.";
  await writeMind(window, "Q3 review", [
    "The quarter was very good, and sales were really strong.",
    "Margins were really thin in the north, and very wide in the south.",
    last,
  ]);
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator("p");

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Shorten the summary slowly");
  await window.keyboard.press("Enter");

  // The first paragraph is changed, and counted on the line, while the last is still to come.
  const answer = assistantAnswers(window).last();
  const writing = editor.getByTestId("mind-writing");
  await expect(writing).toHaveText("Writing…", { timeout: 15_000 });
  await expect(answer.getByTestId("mind-changes-title")).toContainText("in “Q3 review”");
  await expect(paragraphs.nth(2)).toHaveText(last);
  await screenshot(window, "assistant-edit-streaming");

  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(writing).toHaveCount(0);
  await expect(paragraphs).toHaveText([
    "The quarter was good, and sales were strong.",
    "Margins were thin in the north, and wide in the south.",
    "Hiring was slow, and the new office opened late in the year.",
  ]);
  await expect(window.getByTestId("proposals-count")).toHaveCount(0);
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Changed 3 paragraphs in “Q3 review”",
  );
  await screenshot(window, "assistant-edit-done");
});

test("a new Mind's text comes in Block by Block as the assistant writes it, with Writing… where the next goes", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Q3 review", ["The quarter was good."]);

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Can you make a new note called Field notes with a summary slowly");
  await window.keyboard.press("Enter");

  // Opened as soon as it is made: its heading is in while its paragraph is still being written.
  await expect(window.getByTestId("mind-tab").filter({ hasText: "Field notes" })).toBeVisible();
  const writing = window.getByTestId("mind-writing");
  await expect(writing).toBeVisible();
  await expect(writing).toHaveText("Writing…");
  await expect(window.getByTestId("mind-editor").locator("h2")).toHaveText(["Summary"]);
  await screenshot(window, "streaming-new-mind");

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(writing).toHaveCount(0);
  await expect(window.getByTestId("proposals-count")).toHaveCount(0);
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Wrote “Field notes with a summary”",
  );
});

test("a table the assistant writes into a Mind is a table, and its line counts it as one, in English and Chinese (#961)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Q3 review", ["The quarter was good.", "Sales were strong."]);
  const editor = window.getByTestId("mind-editor");

  const answer = await askInAssistant(window, "Make the summary longer, with a table");
  const rows = editor.locator("table tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator("th")).toHaveText(["Term", "What it says"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["The quarter", "was good."]);
  await expect(editor.locator("p", { hasText: "|" })).toHaveCount(0);
  await expect(window.getByTestId("proposals-count")).toHaveCount(0);
  const title = answer.getByTestId("mind-changes").getByTestId("mind-changes-title");
  await expect(title).toHaveText("Added a table to “Q3 review”");
  const kept = answer.getByTestId("mind-changes").getByTestId("mind-changes-kept");
  await expect(kept).toHaveText("· 1 source shown as text, not linked");
  await screenshot(window, "assistant-table");
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await expect(title).toHaveText("在“Q3 review”中添加了 1 个表格");
  await expect(kept).toHaveText("· 1 处出处未关联，显示为文字");
  await screenshot(window, "assistant-table-zh");
});
