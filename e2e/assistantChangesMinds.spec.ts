import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  focusSettled,
  frontMindName,
  launchApp,
  nameMind,
  newMind,
  openSteps,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * The assistant changes Minds and makes them (#202): what the User types
 * decides. The scripted model (src/main/fakeChat/minds.ts) calls edit_mind for
 * a request to shorten, which drops "very" and "really" (非常), and
 * create_mind for a new note; anything else is answered. Each change waits in
 * its Mind as changes to accept or reject. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save screenshots.
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

test("a Question is answered and changes nothing; a request to shorten comes back as changes in the Mind, which the steps name", async () => {
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
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(editor.locator("p")).toHaveText([note]);

  const changed = await askInAssistant(window, "Could you shorten the summary?");
  const bar = window.getByTestId("proposals-bar");
  await expect(bar.getByTestId("proposals-count")).toHaveText("2 changes from the assistant");
  await expect(changed.getByTestId("assistant-answer-text")).toHaveText(
    "Proposed 2 changes in “Q3 review” (from 10 to 8 words).",
  );
  const timeline = await openSteps(window, changed);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(
    /Edited “Q3 review” · 2 changes/,
  );
  await screenshot(window, "assistant-changed-mind");

  await pointAndClick(window, bar.getByTestId("proposals-accept-all"));
  await expect(editor.locator("p")).toHaveText(["The quarter was good, and sales were strong."]);
});

test("a request for a new note makes a Mind beside the one in focus, its text as changes; in Chinese", async () => {
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
  await expect(window.getByTestId("proposals-count")).toHaveText("来自助手的 2 处修订");
  const timeline = await openSteps(window, answer);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(/新建了“田野计划” · 2 处修订/);
  await screenshot(window, "assistant-made-mind-zh");
});

test("the card lists each Mind changed: Open shows the change, Reject all removes the new Mind and its tab, Undo brings both back, Accept all keeps them", async () => {
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
  const card = answer.getByTestId("mind-changes");
  await expect(card.getByTestId("mind-changes-title")).toHaveText("2 Minds changed");
  const rows = card.getByTestId("mind-changes-row");
  await expect(rows.nth(0)).toContainText("Edited: Project plan· 1 waiting");
  await expect(rows.nth(1)).toContainText("Created: Fieldwork plan· 2 waiting");
  await expect(rows.nth(0).locator(".mind-changes-name")).toHaveAttribute(
    "title",
    "Wrote 1 paragraph in “Project plan”",
  );
  await screenshot(window, "card-two-minds");

  await pointAndClick(window, rows.nth(0).getByTestId("mind-changes-open"));
  await expect(frontMindName(window)).toHaveText("Project plan");
  await expect(window.getByTestId("proposals-count")).toHaveText("1 change from the assistant");

  await pointAndClick(window, card.getByTestId("mind-changes-reject-all"));
  const made = window.getByTestId("mind-tab").filter({ hasText: "Fieldwork plan" });
  await expect(made).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("Edited: Project plan· none waiting");
  await expect(rows.nth(1)).toContainText("Removed: Fieldwork plan");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(answer.getByTestId("answer-added")).toContainText("Rejected 3 changes");

  await pointAndClick(window, answer.getByTestId("answer-added-undo"));
  await expect(rows.nth(1)).toContainText("Created: Fieldwork plan· 2 waiting");
  await expect(made).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("· 1 waiting");

  await pointAndClick(window, card.getByTestId("mind-changes-accept-all"));
  await expect(rows.nth(0)).toContainText("· none waiting");
  await expect(card.getByTestId("mind-changes-accept-all")).toHaveCount(0);
  await pointAndClick(window, rows.nth(0).getByTestId("mind-changes-open"));
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText([
    "Hire a designer.",
    "Ship the beta in May",
  ]);
});

test("one Mind changed: the card says what was changed and how much of it waits, Review goes to the first, Accept all applies them, and ⌘Z takes them back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await writeMind(window, "第三季度", ["销售非常好，利润真的很高。"]);

  const answer = await askInAssistant(window, "能把这段缩短吗？");
  const card = answer.getByTestId("mind-changes");
  const title = card.getByTestId("mind-changes-title");
  const left = card.getByTestId("mind-changes-left");
  await expect(title).toHaveText("在“第三季度”中已修改 2 处");
  await expect(left).toHaveText("· 2 处待确认");
  await expect(card.getByTestId("mind-changes-row")).toHaveCount(0);
  await screenshot(window, "card-one-mind-zh");

  await pointAndClick(window, card.getByTestId("mind-changes-review"));
  await expect(window.getByTestId("mind-editor")).toBeFocused();

  await pointAndClick(window, card.getByTestId("mind-changes-accept-all"));
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("p")).toHaveText(["销售好，利润很高。"]);
  await expect(title).toHaveText("在“第三季度”中已修改 2 处");
  await expect(left).toHaveText("· 没有待确认的修订");

  await window.keyboard.press("ControlOrMeta+z");
  await expect(left).toHaveText("· 2 处待确认");
  await expect(window.getByTestId("proposals-count")).toHaveText("来自助手的 2 处修订");
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

test("changes stay in their Mind when the User moves to another and back, and go out of date once their words are edited", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Q3 review", ["Sales were really strong, and margins were very high."]);
  await askInAssistant(window, "Could you shorten the summary?");
  const count = window.getByTestId("proposals-count");
  await expect(count).toHaveText("2 changes from the assistant");

  await writeMind(window, "Project plan", ["Hire a designer."]);
  await expect(count).toHaveCount(0);
  await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "Q3 review" }));
  await expect(count).toHaveText("2 changes from the assistant");

  const editor = window.getByTestId("mind-editor");
  await editor.focus();
  await editor.evaluate((dom) => {
    const { view, commands } = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      const removed = node.marks.some((mark) => mark.type.name === "proposalDelete");
      if (at < 0 && node.isText && removed) at = pos + 2;
    });
    commands.setTextSelection(at);
  });
  await window.keyboard.type("l");
  await expect(window.getByTestId("change-out-of-date")).toHaveCount(1);
});

test("Reject all keeps a Mind the assistant made once the User has written in it, and Undo brings its changes back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Q3 review", ["The quarter was good."]);

  const answer = await askInAssistant(
    window,
    "Can you make a new note called Fieldwork plan with a summary",
  );
  const card = answer.getByTestId("mind-changes");
  const fact = "Created “Fieldwork plan with a summary” and wrote 1 paragraph";
  await expect(card.getByTestId("mind-changes-title")).toHaveText(fact);
  await expect(card.getByTestId("mind-changes-left")).toHaveText("· 2 waiting");
  const made = window.getByTestId("mind-tab").filter({ hasText: "Fieldwork plan with a summary" });
  await expect(made).toHaveCount(1);

  // The scripted draft begins with a heading of its own, so no title goes above it (#908).
  // The User writes a line of their own in it, under the changes: from its start, then the end.
  await pointAndClick(window, made);
  await expect(frontMindName(window)).toHaveText("Fieldwork plan with a summary");
  await expect(window.getByTestId("proposals-count")).toHaveText("2 changes from the assistant");
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator(":scope > h1")).toHaveCount(0);
  await editor.focus();
  await focusSettled(window, editor);
  await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  // The cursor is in the first change once its bar shows.
  await expect(window.getByTestId("change-bar")).toContainText("Change 1 of 2");
  await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await expect(window.getByTestId("change-bar")).toContainText("Change 2 of 2");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Ask the roastery about Tuesdays.");
  await expect(editor.locator("p").last()).toHaveText("Ask the roastery about Tuesdays.");

  await pointAndClick(window, card.getByTestId("mind-changes-reject-all"));
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(made).toHaveCount(1);
  await expect(editor.locator("p")).toHaveText(["Ask the roastery about Tuesdays."]);
  await expect(card.getByTestId("mind-changes-title")).toHaveText(fact);
  await expect(card.getByTestId("mind-changes-left")).toHaveText("· none waiting");
  await expect(answer.getByTestId("answer-added")).toContainText("Rejected 2 changes");

  await pointAndClick(window, answer.getByTestId("answer-added-undo"));
  await expect(window.getByTestId("proposals-count")).toHaveText("2 changes from the assistant");
  await expect(card.getByTestId("mind-changes-left")).toHaveText("· 2 waiting");
  await expect(editor).toContainText("Ask the roastery about Tuesdays.");
  await expect(made).toHaveCount(1);
});

test("Reject all keeps a Mind the assistant made once something of it was accepted", async () => {
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
  const rows = answer.getByTestId("mind-changes-row");
  await expect(rows.nth(1)).toContainText("Created: Fieldwork plan· 2 waiting");

  // Fieldwork plan is open beside, with the cursor in its first change: ⌘↵ accepts that one.
  await pointAndClick(window, rows.nth(1).getByTestId("mind-changes-open"));
  await expect(frontMindName(window)).toHaveText("Fieldwork plan");
  await expect(window.getByTestId("change-bar")).toContainText("Change 1 of 2");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(rows.nth(1)).toContainText("· 1 waiting");

  await pointAndClick(window, answer.getByTestId("mind-changes-reject-all"));
  await expect(rows.nth(1)).toContainText("Created: Fieldwork plan· none waiting");
  await expect(window.getByTestId("mind-tab").filter({ hasText: "Fieldwork plan" })).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("· none waiting");
});

test("a change the assistant makes in a Mind comes in paragraph by paragraph, with Writing… on the next, and its card counts the changes as they come", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Q3 review", [
    "The quarter was very good, and sales were really strong.",
    "Margins were really thin in the north, and very wide in the south.",
    "Hiring was very slow, and the new office opened really late in the year.",
  ]);
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator("p");

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Shorten the summary slowly");
  await window.keyboard.press("Enter");

  // The first paragraph is changes, and counted on the card, while the last is still to come.
  const answer = assistantAnswers(window).last();
  await expect(paragraphs.first().locator("del.proposal-delete")).toHaveText(["very ", "really "], {
    timeout: 15_000,
  });
  const writing = editor.getByTestId("mind-writing");
  await expect(writing).toHaveText("Writing…");
  await expect(paragraphs.nth(2).locator("del.proposal-delete")).toHaveCount(0);
  await expect(answer.getByTestId("mind-changes-title")).toContainText("in “Q3 review”");
  await screenshot(window, "assistant-edit-streaming");

  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(writing).toHaveCount(0);
  await expect(window.getByTestId("proposals-count")).toHaveText("6 changes from the assistant");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Changed 6 places in “Q3 review”",
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
  await expect(window.getByTestId("proposals-count")).toHaveText("2 changes from the assistant");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Created “Field notes with a summary” and wrote 1 paragraph",
  );
});

test("a table the assistant writes into a Mind is a table, and the card counts it as one, in English and Chinese (#961)", async () => {
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
  await expect(window.getByTestId("proposals-count")).toHaveText("1 change from the assistant");
  const title = answer.getByTestId("mind-changes").getByTestId("mind-changes-title");
  await expect(title).toHaveText("Added a table to “Q3 review”");
  const kept = answer.getByTestId("mind-changes").getByTestId("mind-changes-kept");
  await expect(kept).toHaveText(
    "· 1 source in the table couldn't be linked, so it's shown as text",
  );
  await screenshot(window, "assistant-table");

  await pointAndClick(window, window.getByTestId("proposals-accept-all"));
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(rows).toHaveCount(4);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await expect(title).toHaveText("在“Q3 review”中添加了 1 个表格");
  await expect(kept).toHaveText("· 表格中有 1 处出处无法关联，已作为文字显示");
  await screenshot(window, "assistant-table-zh");
});

for (const [width, language] of [
  [1100, "en"],
  [1440, "en"],
  [1100, "zh-CN"],
  [1440, "zh-CN"],
] as const) {
  test(`a change bar near the right edge stays beside the assistant, never under it, at ${width} px in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    const zh = language === "zh-CN";
    const note = (
      zh ? "销售非常好，利润真的很高。" : "Sales were very good and the margin was really strong. "
    ).repeat(zh ? 14 : 7);
    await writeMind(window, zh ? "第三季度" : "Q3 review", [note.trim()]);
    await askInAssistant(window, zh ? "缩短摘要" : "Could you shorten the summary?");

    // The change farthest to the right, on one line (a change that wraps has no one place to point at):
    // where a bar the width of its words reaches under the assistant.
    const changes = window.getByTestId("mind-editor").locator(".proposal-delete");
    const rights = await changes.evaluateAll((each) =>
      each.map((element) =>
        element.getClientRects().length === 1 ? element.getBoundingClientRect().right : -1,
      ),
    );
    expect(rights.length).toBeGreaterThan(4);
    const far = changes.nth(rights.indexOf(Math.max(...rights)));
    await pointAt(window, far);

    const bar = window.getByTestId("change-bar");
    await expect(bar).toBeVisible();
    await screenshot(window, `change-bar-${width}-${language}`);
    const [shown, panel, change] = await Promise.all([
      bar.boundingBox(),
      window.getByTestId("assistant").boundingBox(),
      far.boundingBox(),
    ]);
    if (!shown || !panel || !change) throw new Error("Something isn't visible.");
    // Where the Mind fills the card, the change is near enough the edge for the bar to need to move; at 1,440 its column ends well short of it.
    if (width < 1200) expect(change.x + shown.width).toBeGreaterThan(panel.x);
    expect(shown.x + shown.width).toBeLessThanOrEqual(panel.x);
  });
}
