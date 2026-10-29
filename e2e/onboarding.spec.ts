import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  continueSetup,
  createDataFolder,
  dismissChatSetup,
  examplesMenu,
  expectReadyDocuments,
  frontMind,
  gettingStarted,
  interceptOpenDialog,
  launchApp,
  leaveFirstOpen,
  leaveText,
  linkedFolderRow,
  markSteps,
  newMind,
  paletteFound,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
  useLocalChatModel,
} from "./app";

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

/**
 * Moves the mouse onto an element as a person does, in steps, checks that it
 * is what is under the pointer there (nothing covers it), and clicks.
 * `atX`: that far into it from its left edge, instead of its middle;
 * `through`: it lets the pointer through to what is under it, which is clicked.
 */
async function pointAndClick(
  window: Page,
  target: Locator,
  { atX, through = false }: { atX?: number; through?: boolean } = {},
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  const x = box.x + (atX ?? box.width / 2);
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y, { steps: 8 });
  const hit = await target.evaluate(
    (element, [px, py]) => {
      const under = document.elementFromPoint(px as number, py as number);
      return under !== null && (under === element || element.contains(under));
    },
    [x, y],
  );
  expect(hit).toBe(!through);
  await window.mouse.click(x, y);
}

/** Words a newcomer shouldn't meet on the first screens: the left column of #763's glossary. */
const JARGON = [
  /\bindex(?:es|ed|ing)?\b/i,
  /\bPassages?\b/,
  /\bMCP\b/,
  /\bchat model/i,
  /\bembedding/i,
  /\brerank/i,
  /\bproviders?\b/i,
  /\blocal mode\b/i,
  /\bOCR\b/,
  /\btokens?\b/i,
  /\bstdio\b/,
  /\bendpoint/i,
  /\bOAuth\b/,
  /\b(?:claude|gpt|qwen|llama|gemini|deepseek)[\w.]*[-:][\w.:-]+/i,
  /索引|嵌入|重排序|重新排序|对话模型|提供商|本地模式/,
];

/** Each region's text, as shown, has none of the glossary's words. */
async function expectPlainWords(regions: Locator[]): Promise<void> {
  for (const region of regions) {
    const text = await region.innerText();
    for (const word of JARGON) expect(text, `${word} on the first screens`).not.toMatch(word);
  }
}

test("a first run opens on the credit paper with no model set up: its Citations are found and open the PDF at the quote, and its wrong figure's card says what the results say", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);

  const pane = window.getByTestId("mind-pane");
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "Draft: credit committee paper",
  );
  await expect(pane.getByTestId("first-open-steps")).toContainText("Welcome to IncarnaMind");
  await expect(window.getByTestId("mind-list-item").getByTestId("example-chip")).toHaveText(
    "Example",
  );
  await expectReadyDocuments(window, 2);
  // No model needed: no setup over it, and no "set up a chat model" notice in it.
  await expect(window.getByTestId("chat-setup")).toBeHidden();
  await expect(pane.getByTestId("chat-readiness")).toHaveCount(0);

  const answer = pane.getByTestId("answer");
  await expect(answer.getByTestId("answer-example")).toHaveText("Example Answer · no model needed");
  // Both Citations are checked against the Documents' text: the quotes are found.
  const checks = pane.getByTestId("mind-editor").getByTestId("citation-chip");
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  // The draft's wrong figure is already checked: contradicted.
  const mark = pane.getByTestId("claim-mark");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-check", "contradicted");

  // The example's red ≠: its card says what the results say, and quotes them where they say it.
  await expect(step(window, "files")).toHaveAttribute("data-state", "open");
  await expect(step(window, "citation")).toHaveAttribute("data-state", "later");
  await expect(mark).not.toHaveAttribute("data-guided");
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "contradicted");
  await expect(card.getByTestId("claim-says")).toHaveText(
    "The Q3 results say gross margin was 38.6%, not 36.8%.",
  );
  await expect(card.getByTestId("claim-source")).toHaveText(
    "Northwind Retail · Q3 2026 results · p. 1",
  );
  await expect(card.getByTestId("claim-quote")).toHaveText(
    "Group gross margin was 38.6%, down from 40.3% a year earlier, with online the main drag.",
  );
  // A claim the check caught is not a Citation checked: the steps don't tick.
  await expect(step(window, "citation")).toHaveAttribute("data-state", "later");
  await expect(step(window, "question")).toHaveAttribute("data-state", "later");
  await window.keyboard.press("Escape");

  // A Citation opens the results at the page it quotes, the quote highlighted.
  await pointAndClick(window, checks.nth(0));
  await expect(window.getByTestId("citation-card")).toBeVisible();
  await expect(window.getByTestId("viewer-title")).toHaveText("Northwind Retail · Q3 2026 results");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  const highlight = window
    .getByTestId("viewer")
    .locator('[data-page-number="1"] [data-quote-highlight]');
  await expect(highlight.first()).toBeInViewport();
  await expect
    .poll(async () => (await highlight.allTextContents()).join(""))
    .toContain("Net debt to EBITDA was 3.1 times");
  await window.keyboard.press("Escape");
  await expect(step(window, "citation")).toHaveAttribute("data-state", "done");

  // Step 2's ready Question brings the assistant with its Answer, written in advance with no
  // model, its Citations found, and ticks the step.
  await markSteps(window, { indexed: true });
  await expect(step(window, "files")).toHaveAttribute("data-state", "done");
  await expect(step(window, "question")).toHaveAttribute("data-state", "open");
  const assistant = window.getByTestId("assistant");
  await expect(assistant).toBeHidden();
  const ready = step(window, "question").getByTestId("first-open-ready");
  // The whole Question is the line's name and its tooltip; a narrower line would cut it at a
  // word's end, and clicking asks it whole.
  const askLabel = "Ask: “What leverage does the agreement allow?”";
  await expect(ready).toHaveAttribute("aria-label", askLabel);
  await expect(ready).toHaveAttribute("title", askLabel);
  const shownAsk = await ready.innerText();
  if (shownAsk !== askLabel) {
    expect(shownAsk.endsWith("…"), "cut").toBe(true);
    expect(askLabel.startsWith(shownAsk.slice(0, -1))).toBe(true);
    expect(askLabel.slice(shownAsk.length - 1), "a word's end").toMatch(/^\s/u);
  }
  await pointAndClick(window, ready);
  await expect(assistant).toBeVisible();
  await expect(assistant.getByTestId("assistant-question")).toContainText(
    "What leverage does the agreement allow?",
  );
  const readyAnswer = assistantAnswers(window).last();
  await expect(readyAnswer).toHaveAttribute("data-status", "done");
  await expect(readyAnswer.getByTestId("answer-example")).toHaveText(
    "Example Answer · no model needed",
  );
  const chips = readyAnswer.getByTestId("citation-chip");
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) await expect(chip).toHaveAttribute("data-check", "found");
  await expect(step(window, "question")).toHaveAttribute("data-state", "done");
  await expect(step(window, "question")).toContainText("Asked a question");
  // All three are done, and there is no model: the card asks for one (#1027).
  await expect(step(window, "citation")).toHaveAttribute("data-state", "done");
  await expect(pane.getByTestId("first-open-steps")).toContainText(
    "Choose an AI model to ask about your own files.",
  );
  await expect(window.getByTestId("chat-setup")).toHaveCount(0);

  await leaveFirstOpen(window);
  const addOwn = pane.getByTestId("example-add-own");
  await expect(addOwn).toHaveText("Add your Documents");
  await pointAndClick(window, addOwn);
  const ways = window.getByTestId("example-add-items");
  await expect(ways.getByRole("menuitem")).toHaveText(["Add files…", "Link a folder…"]);
  await expect(ways.getByRole("menuitem").first()).toBeFocused();
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "Draft: credit committee paper",
  );
  await expect(window.getByTestId("chat-setup")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(addOwn).toBeFocused();
  await setLanguage(window, "zh-CN");
  await expect(addOwn).toHaveText("添加你的文档");
  await pointAndClick(window, addOwn);
  await expect(ways.getByRole("menuitem")).toHaveText(["添加文件…", "添加关联文件夹…"]);
  await window.keyboard.press("Escape");

  await setLanguage(window, "en");
  await expect(window.getByTestId("document-list-item")).toHaveText([
    /Northwind Retail · (Q3 2026 results|Senior facilities agreement \(excerpt\))/,
    /Northwind Retail · (Q3 2026 results|Senior facilities agreement \(excerpt\))/,
  ]);
  // The example’s Linked folder is no Linked folder of the User’s: on day one the section
  // waits for one of their own (#1942).
  await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);
});

test("removing the examples deletes the example Mind, its Documents and the copies of their files, and they aren't made again", async () => {
  const first = await launchApp(dataDir, { examples: true });
  const window = first.window;
  await leaveFirstOpen(window);
  await expect(window.getByTestId("example-banner")).toBeVisible();

  await pointAndClick(window, window.getByTestId("example-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await expect(window.getByTestId("document-list-item")).toHaveCount(0);
  await expect(linkedFolderRow(window, "Examples")).toHaveCount(0);
  await expect(window.getByTestId("mind-none-open")).toBeVisible();
  // Moving on from the example: setting up a chat model is offered now.
  await dismissChatSetup(window);
  await expect
    .poll(() =>
      access(join(dataDir, "Examples")).then(
        () => "there",
        () => "gone",
      ),
    )
    .toBe("gone");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true });
  await expect(again.window.getByTestId("home")).toBeVisible();
  await expect(again.window.getByTestId("mind-list-item")).toHaveCount(0);
  await again.window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.createExamples();
  });
  await expect(again.window.getByTestId("mind-list-item")).toHaveCount(1);
  await again.app.close();
});

test("the footer asks for a model to tag only once a Document of the User's own carries a Tag (#1942)", async () => {
  const own = join(sources, "Harbour notes.md");
  await writeFile(own, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  await leaveFirstOpen(window);
  const items = window.getByTestId("document-list-item");
  const notice = window.getByTestId("sidebar-footer").getByTestId("tagging-waiting");

  // The examples are ready and their tagging waits for a model, but they need none: no notice.
  await expect(items).toHaveCount(2);
  for (const item of await items.all()) {
    await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider", {
      timeout: 30_000,
    });
  }
  await expect(notice).toHaveCount(0);

  // A Document of one's own with no model, and no Tag anywhere: nothing names Tags yet.
  await window.getByTestId("add-documents-input").setInputFiles([own]);
  const added = items.filter({ hasText: "Harbour notes" });
  await expect(added).toHaveAttribute("data-tagging", "waiting-for-provider");
  await expect(notice).toHaveCount(0);

  // A Tag of the User's own: the notice comes.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [document] = (await bridge.listDocuments()).filter(
      (each) => each.name === "Harbour notes",
    );
    const tag = await bridge.createTag({ name: "Harbour", description: "" });
    if (document) await bridge.addTagToDocuments([document.id], tag.id);
  });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Tags need an AI model");
  // One 28px line, never wrapping: the whole sentence is on hover (#763).
  await expect(notice).toHaveAttribute("title", "Tags come once you choose an AI model.");
  await expect(notice.getByTestId("tagging-waiting-setup")).toHaveText("Choose…");
  await setLanguage(window, "zh-CN");
  await expect(notice).toContainText("打标签需要 AI 模型");
  await expect(notice.getByTestId("tagging-waiting-setup")).toHaveText("选择…");
  await notice.getByTestId("tagging-waiting-setup").click();
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
  await app.close();
});

test("an empty Mind of one's own shows no second start guide, the example's steps tick as Documents are added and a Question is asked, and it says what to try next once all are done", async () => {
  await writeFile(
    join(sources, "Harbour notes.md"),
    "# Harbour notes\n\nThe harbour master publishes the tide tables every January.\n",
  );
  const { window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await expect(step(window, "files")).toHaveAttribute("data-state", "open");

  await newMind(window);
  await dismissChatSetup(window);
  // The first-run card has been seen: an empty note of one's own shows no second guide (#1940).
  await expect(window.getByTestId("first-open-steps")).toBeHidden();
  const editor = frontMind(window).getByTestId("mind-editor");
  await expect(window.getByTestId("start-guide")).toHaveCount(0);
  await expect(editor).not.toContainText("Start in three steps");
  await expect(editor).not.toContainText("Connect an app…");

  await window
    .getByTestId("add-documents-input")
    .setInputFiles([join(sources, "Harbour notes.md")]);
  await expect.poll(() => gettingStarted(window)).toMatchObject({ indexed: true });

  await useLocalChatModel(window);
  const hint = window.getByTestId("end-hint");
  await expect(hint).toHaveAttribute("data-place", "empty");
  await pointAndClick(window, window.getByTestId("mind-editor").locator("p").first());
  await expect(hint).toHaveAttribute("data-armed", "true");
  await pointAndClick(window, hint.getByTestId("end-hint-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("When are the tide tables published?");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("assistant-question")).toContainText(
    "When are the tide tables published?",
  );
  await expect(assistantAnswers(window)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect.poll(() => gettingStarted(window)).toMatchObject({ askedOwn: true });
  await expect(window.getByTestId("mind-editor").getByTestId("question")).toHaveCount(0);
  await expect(window.getByTestId("start-guide")).toHaveCount(0);

  // The examples fold to one row once a Document of one's own is there (#1944).
  // Tagging finishes in the background and adds the Tags section above it: wait, so the row holds still.
  await expect(window.getByTestId("sidebar").getByTestId("sidebar-tags")).toBeVisible({
    timeout: 30_000,
  });
  await pointAndClick(window, window.getByTestId("example-section").getByTestId("mind-list-item"));
  const checks = window
    .getByTestId("mind-pane")
    .getByTestId("mind-editor")
    .getByTestId("citation-chip");
  await expect(checks.nth(0)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  await expect(step(window, "files")).toHaveAttribute("data-state", "done");
  await pointAndClick(window, checks.nth(0));
  await expect(step(window, "citation")).toHaveAttribute("data-state", "done");
  await window.keyboard.press("Escape");
  await pointAndClick(window, window.getByTestId("mind-pane").getByTestId("claim-mark"));
  const steps = window.getByTestId("first-open-steps");
  await expect(steps).toContainText("You’re set up.");
  await expect(steps.locator('[data-testid="first-open-step"][data-state="done"]')).toHaveText([
    /Added your Documents/,
    /Asked a question/,
    /Checked a Citation/,
  ]);
  await expect(steps.getByTestId("first-open-next").first()).toBeVisible();
  await pointAndClick(window, steps.getByTestId("first-open-hide"));
  await expect(steps).toHaveCount(0);
});

test("the steps card's first step offers Add files… and Link a folder… at once, and the first screens and the start guide speak plainly, in English and Chinese (#766)", async () => {
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);
  const pane = window.getByTestId("mind-pane");
  const checks = pane.getByTestId("mind-editor").getByTestId("citation-chip");
  await expect(checks.nth(0)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  const firstScreen = [
    window.getByTestId("sidebar"),
    pane.getByTestId("first-open-steps"),
    window.getByTestId("assistant"),
  ];
  await expectPlainWords(firstScreen);

  await pointAndClick(window, checks.nth(0));
  await window.keyboard.press("Escape");
  await expect(step(window, "citation")).toHaveAttribute("data-state", "done");
  await pointAndClick(window, pane.getByTestId("claim-mark"));
  await window.keyboard.press("Escape");
  await expect(step(window, "citation")).toHaveAttribute("data-state", "done");
  await markSteps(window, { askedOwn: true });
  const files = step(window, "files");
  await expect(files).toHaveAttribute("data-state", "open");
  await expect(files.getByTestId("first-open-step-do")).toHaveAccessibleName("Add your Documents");
  await expect(files).toContainText("Reading your files");
  const offered = files.locator('button:not([data-testid="first-open-step-do"])');
  await expect(offered).toHaveText(["Add files…", "Link a folder…"]);
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "Draft: credit committee paper",
  );
  await expect(window.getByTestId("chat-setup")).toBeHidden();

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await expect(files.getByTestId("first-open-step-do")).toHaveAccessibleName("添加你的文档");
  await expect(files).toContainText("读取你的文件");
  await expect(offered).toHaveText(["添加文件…", "添加关联文件夹…"]);
  await expectPlainWords(firstScreen);
  const card = await pane.getByTestId("first-open-steps").boundingBox();
  const buttons = await offered.last().boundingBox();
  expect((buttons?.x ?? 0) + (buttons?.width ?? 0)).toBeLessThanOrEqual(
    (card?.x ?? 0) + (card?.width ?? 0),
  );
  await newMind(window);
  await dismissChatSetup(window);
  // The first-run card has been seen: an empty note of one's own shows no guide (#1940).
  await expect(window.getByTestId("start-guide")).toHaveCount(0);
  await setLanguage(window, "en");
  await expectPlainWords([window.getByTestId("sidebar")]);
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ has: window.getByTestId("example-chip") }),
  );
  await setLanguage(window, "zh-CN");
  await interceptOpenDialog(app, notes);
  await pointAndClick(window, offered.first());
  // Done with no model: one more step, in place of "You're set up." (#1027).
  const steps = pane.getByTestId("first-open-steps");
  await expect(steps).toContainText("选择 AI 模型，就能就你自己的文件提问。", {
    timeout: 15_000,
  });
  await expect(steps).not.toContainText("准备好了。");
  await pointAndClick(window, steps.getByTestId("first-open-choose-model"));
  const setup = window.getByTestId("model-setup");
  await expect(setup).toContainText("设置你的 AI");
  await expect(setup).toContainText("使用自己的密钥");
  await expect(setup.getByTestId("setup-key")).toHaveAccessibleName("使用自己的密钥");
  await expectPlainWords([setup]);
  await setLanguage(window, "en");
  await expect(setup).toContainText("Use your own key");
  await expect(setup.getByTestId("setup-key")).toHaveAccessibleName("Use your own key");
  await expectPlainWords([setup]);
  await setLanguage(window, "zh-CN");
  await useLocalChatModel(window);
  await expect(steps).toContainText("准备好了。");
  await continueSetup(window);
});

test('"Ask" is ticked by an Answer that arrives, not by one that fails (#766)', async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  await markSteps(window, { indexed: true });
  const asked = step(window, "question");
  await expect(asked).toHaveAttribute("data-state", "open");

  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Send a blank reply");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "failed", {
    timeout: 15_000,
  });
  await expect(asked).toHaveAttribute("data-state", "open");

  await window.getByTestId("composer-input").click();
  await window.keyboard.type("What was gross margin in Q3?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect(asked).toHaveAttribute("data-state", "done");
});

test("in Chinese, the ready Question is the Chinese example's, answered with no model, and the card holds at 1,100 px (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1100, 720);
  await setLanguage(window, "zh-CN");
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "授信委员会报告（草稿）",
    {
      timeout: 30_000,
    },
  );
  const checks = window
    .getByTestId("mind-pane")
    .getByTestId("mind-editor")
    .getByTestId("citation-chip");
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  await markSteps(window, { indexed: true });

  const ready = step(window, "question").getByTestId("first-open-ready");
  await expect(ready).toHaveText("提问：贷款协议对杠杆率上限是怎么规定的？");
  await expect(step(window, "question")).toContainText("输入你自己的问题");
  const card = await window.getByTestId("first-open-steps").boundingBox();
  const button = await ready.boundingBox();
  expect(button && card && button.x + button.width <= card.x + card.width).toBe(true);

  await pointAndClick(window, ready);
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer.getByTestId("answer-example")).toHaveText("示例回答 · 无需模型");
  await expect(answer.getByTestId("citation-chip")).toHaveCount(2);
  await expect(step(window, "question")).toHaveAttribute("data-state", "done");
  await expect(step(window, "question")).toContainText("已提过问题");
  // Not a Question of the User's own: the usage-data ask still waits for one.
  expect((await gettingStarted(window)).askedOwn).toBe(false);
  await app.close();
});

const OWN_FILES = [
  {
    language: "en",
    name: "Project brief.md",
    text: "# Project brief\n\nThe project brief sets out the harbour plan.\n",
    asks: "Ask: “What does ‘Project brief’ say?”",
    question: "What does ‘Project brief’ say?",
  },
  {
    language: "zh-CN",
    name: "项目简报.md",
    text: "# 项目简报\n\n项目简报写明了港口计划。\n",
    asks: "提问：“项目简报”讲了什么？",
    question: "“项目简报”讲了什么？",
  },
] as const;

for (const { language, name, text, asks, question } of OWN_FILES) {
  test(`a file added from step 1 is what the ready Question asks about, and its Answer cites it (${language}, #2084)`, async () => {
    const file = join(sources, name);
    await writeFile(file, text);
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await useLocalChatModel(window);
    const files = step(window, "files");
    await expect(files).toHaveAttribute("data-state", "open");
    await interceptOpenDialog(app, file);
    await pointAndClick(window, files.getByTestId("first-open-add-files"));

    // Read, the file is the one step 2 offers a Question about.
    const ready = step(window, "question").getByTestId("first-open-ready");
    await expect(ready).toHaveText(asks, { timeout: 30_000 });
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 800);
      const shown = await ready.boundingBox();
      const card = await window.getByTestId("first-open-steps").boundingBox();
      expect(shown && card && shown.x + shown.width <= card.x + card.width).toBe(true);
    }
    await setWindowSize(app, window, 1440, 900);
    await pointAndClick(window, ready);

    // Its Answer reads that file, and cites it: the example's Question was never asked.
    await expect(window.getByTestId("assistant-question").last()).toContainText(question);
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    const chip = answer.getByTestId("citation-chip").first();
    await expect(chip).toBeVisible();
    await pointAndClick(window, chip);
    await expect(
      window.getByTestId("citation-card").getByText(name.replace(/\.md$/, ""), { exact: true }),
    ).toBeVisible();
    // The Answer that arrived is what ticks the step, not the click.
    await expect(step(window, "question")).toHaveAttribute("data-state", "done");
    await app.close();
  });
}

test("the first own Question starts a fresh conversation, without the example's turns (#2084)", async () => {
  const file = join(sources, "Harbour brief.md");
  await writeFile(
    file,
    "# Harbour brief\n\nThe harbour master publishes the tide tables every spring.\n",
  );
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  await expectReadyDocuments(window, 2);
  await markSteps(window, { indexed: true });
  // The example's Answer in an open conversation first.
  await pointAndClick(window, step(window, "question").getByTestId("first-open-ready"));
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 30_000,
  });
  await expect(window.getByTestId("assistant-question")).toHaveCount(1);
  await markSteps(window, { askedReady: false });

  // Their own file makes the ready Question theirs; asking it leaves the example's turns behind.
  await window.getByTestId("add-documents-input").setInputFiles([file]);
  const ready = step(window, "question").getByTestId("first-open-ready");
  await expect(ready).toHaveAttribute("title", /Harbour brief/, { timeout: 30_000 });
  await pointAndClick(window, ready);
  await expect(window.getByTestId("assistant-question")).toHaveCount(1);
  await expect(window.getByTestId("assistant-question")).toContainText(
    "What does ‘Harbour brief’ say?",
  );
  await expect(window.getByTestId("assistant-answer")).toHaveCount(1);
  await expect(window.getByTestId("assistant-answer").getByTestId("answer-example")).toHaveCount(0);
  await app.close();
});

test("a Question that can't be asked says why in the card's row, where it was clicked (#2084)", async () => {
  const file = join(sources, "Harbour brief.md");
  await writeFile(
    file,
    "# Harbour brief\n\nThe harbour master publishes the tide tables every spring.\n",
  );
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  // A model off this computer with local mode on: asking is refused before anything is sent.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" });
    await bridge.setLocalOnly(true);
  });
  await window.getByTestId("add-documents-input").setInputFiles([file]);
  const ready = step(window, "question").getByTestId("first-open-ready");
  await expect(ready).toHaveAttribute("title", /Harbour brief/, { timeout: 30_000 });
  await pointAndClick(window, ready);
  const card = window.getByTestId("first-open-steps");
  await expect(card.getByTestId("first-open-ready-not-ready")).toBeVisible();
  // The example Note's composer is the one on screen; it is not where this problem goes.
  await expect(window.getByTestId("composer-not-ready")).toHaveCount(0);
  await app.close();
});

test("while the ready Question's Answer streams, its button waits and asks once (#2084)", async () => {
  // The scripted model answers a Question that says "slowly" slowly enough to see the button.
  const file = join(sources, "Harbour times slowly.md");
  await writeFile(
    file,
    "# Harbour times\n\nHarbours publish the times of high water every 12 months.\n",
  );
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  await window.getByTestId("add-documents-input").setInputFiles([file]);
  const ready = step(window, "question").getByTestId("first-open-ready");
  await expect(ready).toHaveAttribute("title", /Harbour times slowly/, { timeout: 30_000 });
  await pointAndClick(window, ready);
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(ready).toBeDisabled();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(window.getByTestId("assistant-question")).toHaveCount(1);
  await expect(step(window, "question")).toHaveAttribute("data-state", "done");
  await app.close();
});

test("Add files… with only a file it can't take says why in step 1, which stays open (#123)", async () => {
  const picture = join(sources, "Picture.png");
  await writeFile(picture, "not a document");
  const { app, window } = await launchApp(dataDir, { examples: true });
  const files = step(window, "files");
  await expect(files).toHaveAttribute("data-state", "open");
  await interceptOpenDialog(app, picture);
  await pointAndClick(window, files.getByTestId("first-open-add-files"));
  const problem = files.getByTestId("first-open-skipped");
  await expect(problem).toContainText("Only PDF, Word, PowerPoint, Excel, CSV, TXT and Markdown");
  await expect(problem).toContainText("Picture.png");
  await expect(files).toHaveAttribute("data-state", "open");
  await app.close();
});

test("a damaged PDF as the only file of one's own leaves step 1 open, says which and why there, and never You're set up; a file it reads finishes it (#1457)", async () => {
  const damaged = join(sources, "damaged.pdf");
  await writeFile(damaged, "%PDF-1.4 this is not a PDF");
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  await markSteps(window, { askedReady: true, citationChecked: true });
  const steps = window.getByTestId("first-open-steps");
  const files = step(window, "files");
  await expect(files).toHaveAttribute("data-state", "open");

  await interceptOpenDialog(app, damaged);
  await pointAndClick(window, files.getByTestId("first-open-add-files"));
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "damaged" }),
  ).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
  const unread = files.getByTestId("first-open-unread");
  await expect(unread).toContainText("1 file couldn’t be read");
  await expect(files).toHaveAttribute("data-state", "open");
  await expect(files.getByTestId("first-open-add-files")).toBeVisible();
  await expect(steps).not.toContainText("You’re set up.");
  await expect(steps.getByTestId("first-open-choose-model")).toHaveCount(0);
  expect((await gettingStarted(window)).indexed).toBe(false);

  await pointAndClick(window, unread.getByTestId("first-open-unread-show"));
  const row = unread.getByTestId("unread-file");
  await expect(row).toHaveText(/^damaged\.pdf: The file is damaged/);
  await setWindowSize(app, window, 900, 760);
  const card = await steps.boundingBox();
  const line = await row.boundingBox();
  expect(line && card && line.x + line.width <= card.x + card.width).toBe(true);
  await setWindowSize(app, window, 1440, 900);
  await pointAndClick(window, row.getByTestId("unread-file-open"));
  await expect(window.getByTestId("viewer-title")).toHaveText("damaged");
  await expect(files).toHaveAttribute("data-state", "open");

  await interceptOpenDialog(app, notes);
  await pointAndClick(window, files.getByTestId("first-open-add-files"));
  await expect(files).toHaveAttribute("data-state", "done", { timeout: 15_000 });
  await expect(steps).toContainText("You’re set up.");
  await app.close();
});

test("✕ ends the first open at any step, and so does Remove the examples or a deleted example, after a restart too (#123)", async () => {
  const shellIsBack = async (window: Page) => {
    await expect(window.getByTestId("assistant")).toBeVisible();
    await expect(window.getByTestId("ask-pill")).toHaveCount(0);
    await expect(window.getByTestId("sidebar").getByTestId("sidebar-status")).toHaveCount(1);
  };
  const first = await launchApp(dataDir, { examples: true });
  const hide = first.window.getByTestId("first-open-hide");
  await expect(step(first.window, "files")).toHaveAttribute("data-state", "open");
  await pointAndClick(first.window, hide);
  await expect(first.window.getByTestId("first-open-steps")).toHaveCount(0);
  await expect(first.window.getByTestId("tab-list")).toBeVisible();
  await shellIsBack(first.window);
  await first.app.close();

  const removing = await createDataFolder();
  const second = await launchApp(removing, { examples: true });
  await pointAndClick(
    second.window,
    (await examplesMenu(second.window)).getByTestId("examples-remove"),
  );
  await expect(second.window.getByTestId("mind-list-item")).toHaveCount(0);
  await dismissChatSetup(second.window);
  await shellIsBack(second.window);
  await second.app.close();
  const afterRemoving = await launchApp(removing, { examples: true });
  await dismissChatSetup(afterRemoving.window);
  await shellIsBack(afterRemoving.window);
  await afterRemoving.app.close();
  await removeDataFolder(removing);

  const deleting = await createDataFolder();
  const third = await launchApp(deleting, { examples: true });
  await expect(third.window.getByTestId("first-open-steps")).toBeVisible();
  await third.window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { mindId } = await bridge.getExamples();
    if (mindId) await bridge.deleteMind(mindId);
  });
  await third.app.close();
  const afterDeleting = await launchApp(deleting, { examples: true });
  await dismissChatSetup(afterDeleting.window);
  await shellIsBack(afterDeleting.window);
  await afterDeleting.app.close();
  await removeDataFolder(deleting);
});

test("a double-click on the ready Question asks it once, and Enter on it moves the focus to the next step (#123)", async () => {
  const first = await launchApp(dataDir, { examples: true });
  const pane = first.window.getByTestId("mind-pane");
  await expect(pane.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted", {
    timeout: 20_000,
  });
  await markSteps(first.window, { indexed: true });
  await step(first.window, "question").getByTestId("first-open-ready").dblclick();
  await expect(assistantAnswers(first.window).last()).toHaveAttribute("data-status", "done");
  await expect
    .poll(() =>
      first.window.evaluate(
        async () =>
          (
            await (
              globalThis as unknown as { incarnamind: CoreBridge }
            ).incarnamind.listConversations()
          ).length,
      ),
    )
    .toBe(1);
  await first.app.close();

  const keyboard = await createDataFolder();
  const second = await launchApp(keyboard, { examples: true });
  await expect(second.window.getByTestId("mind-pane").getByTestId("claim-mark")).toHaveAttribute(
    "data-check",
    "contradicted",
    { timeout: 20_000 },
  );
  await markSteps(second.window, { indexed: true });
  await step(second.window, "question").getByTestId("first-open-ready").focus();
  await second.window.keyboard.press("Enter");
  await expect(step(second.window, "citation").getByTestId("first-open-step-do")).toBeFocused();
  await second.app.close();
  await removeDataFolder(keyboard);
});

test("on a fresh install, a first checked Citation from the User's own file takes eight steps", async () => {
  const notes = join(sources, "Harbour notes.md");
  await writeFile(
    notes,
    "# Harbour notes\n\nThe harbour master publishes the tide tables every Monday morning.\n",
  );
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    await expect(window.getByTestId("mind-pane")).toBeVisible();
    const taken: string[] = [];
    const step = async (name: string, action: () => Promise<unknown>) => {
      taken.push(name);
      await action();
    };

    await step("drop the file", () =>
      window.getByTestId("add-documents-input").setInputFiles([notes]),
    );
    await expect(
      window.locator('[data-testid="document-list-item"][data-status="ready"]').filter({
        hasText: "Harbour notes",
      }),
    ).toHaveCount(1);
    await step("⌘J", () => window.keyboard.press("ControlOrMeta+j"));
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await step("type the Question", () =>
      window.keyboard.type("When does the harbour master publish the tide tables?"),
    );
    await step("Enter", () => window.keyboard.press("Enter"));
    const card = window.getByTestId("model-setup");
    const field = card.getByTestId("setup-key");
    await step("Paste an API key", () => pointAndClick(window, field));
    await expect(field).toBeFocused();
    await step("paste the key", () => window.keyboard.insertText("sk-ant-a-key-from-the-company"));
    await step("Enter", () => window.keyboard.press("Enter"));
    await step("Use this", () => continueSetup(window));

    const citation = assistantAnswers(window).last().getByTestId("citation").first();
    await expect(citation).toHaveAttribute("data-check", "found", { timeout: 20_000 });
    await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      /Harbour notes/,
    );
    expect(taken).toHaveLength(8);
  } finally {
    await app.close();
  }
});

test("the steps can be hidden once all are done, and stay hidden", async () => {
  const first = await launchApp(dataDir, { examples: true });
  await useLocalChatModel(first.window);
  await markSteps(first.window, { citationChecked: true, askedOwn: true, indexed: true });
  const steps = first.window.getByTestId("first-open-steps");
  await expect(steps).toContainText("You’re set up.");
  await pointAndClick(first.window, steps.getByTestId("first-open-hide"));
  await expect(steps).toHaveCount(0);
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true });
  await expect(again.window.getByTestId("home")).toBeVisible();
  await again.window.getByTestId("mind-tab").click();
  await expect(again.window.getByTestId("example-banner")).toBeVisible();
  await expect(again.window.getByTestId("first-open-steps")).toHaveCount(0);
  await again.app.close();
});

test("finishing the steps with no model asks for one in the card, never says You're set up, and brings nothing back by itself; a saved model sets it up (#1027)", async () => {
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);
  const pane = window.getByTestId("mind-pane");
  await expect(pane.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted", {
    timeout: 20_000,
  });
  await markSteps(window, { askedReady: true, citationChecked: true });
  await window.getByTestId("add-documents-input").setInputFiles([notes]);

  const steps = pane.getByTestId("first-open-steps");
  await expect(step(window, "files")).toHaveAttribute("data-state", "done");
  await expect(steps).toContainText("Choose an AI model to ask about your own files.");
  await expect(steps).not.toContainText("You’re set up.");
  await expect(steps.getByTestId("first-open-next")).toHaveCount(0);
  // Each part of the shell still waits for its own moment. The card asks for the model, and the
  // footer's one line says the files wait for it (#1128).
  const sidebar = window.getByTestId("sidebar");
  await expect(window.getByTestId("tab-list")).toHaveCount(0);
  await expect(window.getByTestId("assistant")).toBeHidden();
  await expect(window.getByTestId("ask-pill")).toBeVisible();
  // Day one names no Tags: the card asks for the model, and the footer says nothing (#1942).
  await expect(sidebar.getByTestId("tagging-waiting")).toHaveCount(0);

  await pointAndClick(window, steps.getByTestId("first-open-choose-model"));
  const setup = window.getByTestId("model-setup");
  await expect(window.getByTestId("assistant")).toBeVisible();
  await expect(setup.getByRole("heading", { level: 2 })).toHaveText("Set up your AI");
  await useLocalChatModel(window);
  await expect(steps).toContainText("You’re set up.");
  await expect(steps.getByTestId("first-open-next").first()).toBeVisible();
  await continueSetup(window);
  await expect(sidebar.getByTestId("tagging-waiting")).toHaveCount(0);
  await expect(window.getByTestId("composer-input")).toBeVisible();
  await app.close();
});

test("by keyboard alone: Choose a model takes the focus into the setup, and a saved model brings it to the composer (#1027)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await markSteps(window, { citationChecked: true, askedReady: true, indexed: true });
  const choose = window.getByTestId("first-open-steps").getByTestId("first-open-choose-model");
  await choose.focus();
  await window.keyboard.press("Enter");
  const setup = window.getByTestId("model-setup");
  // The key field takes the focus as the card opens (#1922).
  await expect(setup.getByTestId("setup-key")).toBeFocused();
  await window.keyboard.insertText("sk-ant-a-key-from-the-company");
  await window.keyboard.press("Enter");
  // Steps 2 and 3 follow, each one key away: Tab to Use this, Enter, and on to the next step.
  const transcription = setup.getByTestId("setup-transcription");
  await expect(transcription).toBeFocused();
  await window.keyboard.press("Tab");
  await expect(setup.getByTestId("setup-transcription-use")).toBeFocused();
  await window.keyboard.press("Enter");
  const sorting = setup.getByTestId("models-sorting");
  await expect(sorting).toBeFocused();
  await window.keyboard.press("Tab");
  await expect(setup.getByTestId("setup-sorting-use")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(setup).toHaveCount(0);
  await expect(window.getByTestId("first-open-steps")).toContainText("You’re set up.");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await app.close();
});

test("on the quiet first open the tagging question still shows, with Allow, in the footer (#1027)", async () => {
  const invoice = join(sources, "Invoice 41.txt");
  await writeFile(invoice, "Invoice 41. Amount due: 120 EUR.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
    });
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: true });
    if (provider.service) await core.revokeConsent("tagging", provider.service.id);
  });
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await window.getByTestId("add-documents-input").setInputFiles([invoice]);
  const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 41" });
  await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider");
  // A Tag of the User's own: only now is Tags named, so only now is the sending asked about (#1942).
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [document] = (await core.listDocuments()).filter((each) => each.name === "Invoice 41");
    const tag = await core.createTag({ name: "Invoices", description: "" });
    if (document) await core.addTagToDocuments([document.id], tag.id);
  });
  const question = window.getByTestId("sidebar").getByTestId("tagging-waiting");
  await expect(question).toContainText("Tags need your OK");
  await expect(window.getByTestId("tab-list")).toHaveCount(0);
  await question.getByTestId("tagging-waiting-allow").click();
  await expect(item).toHaveAttribute("data-tagging", "tagged", { timeout: 15_000 });
  await app.close();
});

test("scrolled to the end, the example's last line sits above the Ask pill, and the page fades out above it (#1027)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  const pill = window.getByTestId("ask-pill");
  const fade = window.getByTestId("ask-pill-fade");
  for (const [width, height] of [
    [1440, 900],
    [1100, 760],
  ] as const) {
    await setWindowSize(app, window, width, height);
    await expect(pill).toBeVisible();
    await window
      .getByTestId("mind-pane")
      .evaluate((pane) => pane.parentElement?.scrollTo({ top: pane.parentElement.scrollHeight }));
    const lastLine = window.getByTestId("mind-editor").locator(":scope > *").last();
    await expect
      .poll(async () => {
        const line = await lastLine.boundingBox();
        const ask = await pill.boundingBox();
        return line && ask ? ask.y - (line.y + line.height) : null;
      })
      .toBeGreaterThanOrEqual(0);
    const ask = await pill.boundingBox();
    const faded = await fade.boundingBox();
    expect(ask && faded && faded.y <= ask.y - 56 + 1).toBe(true);
  }
  await app.close();
});

test("the hint at the end of a Mind focuses the composer when its link is clicked once the cursor is on its line, and is otherwise the line to write on; Add to note asks instead of filling the example", async () => {
  const { window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await leaveFirstOpen(window);
  const editor = window.getByTestId("mind-editor");
  const hint = window.getByTestId("end-hint");
  await expect(hint).toHaveAttribute("data-place", "afterAnswer");
  const shortcut = process.platform === "darwin" ? "⌘J" : "Ctrl+J";
  await expect(hint).toHaveText(
    `Try it: write a line here, or press ${shortcut} to ask your own Question`,
  );

  // Before the cursor is on the line, a click on the link puts the cursor there, to write.
  await expect(hint).not.toHaveAttribute("data-armed");
  await pointAndClick(window, hint.getByTestId("end-hint-ask"), { through: true });
  await expect(hint).toHaveAttribute("data-armed", "true");
  await expect(editor.getByTestId("question")).toHaveCount(1);
  await window.keyboard.type("Online margin should recover once Leeds opens.");
  const last = editor.locator(":scope > *").last();
  await expect(last).toHaveText("Online margin should recover once Leeds opens.");
  await expect(editor.getByTestId("question")).toHaveCount(1);
  // A Note at the end: no hint, as after an Answer only.
  await expect(hint).toHaveCount(0);

  // An empty line after a Note has none.
  await window.keyboard.press("Enter");
  await expect(hint).toHaveCount(0);
  await window.keyboard.press("Backspace");
  // Back on the Note: put the cursor on a new empty line right after the Answer.
  await pointAndClick(window, last, { atX: 2 });
  // The editor takes the click's place from the browser's selectionchange: wait, as a person would.
  await expect
    .poll(() =>
      editor.evaluate(
        (dom) => (dom as unknown as { editor: Editor }).editor.state.selection.$from.parentOffset,
      ),
    )
    .toBe(0);
  await window.keyboard.press("Enter");
  await window.keyboard.press("ArrowUp");
  // An empty line after an Answer, not at the end, shows the hint while it is written in.
  await expect(hint).toHaveAttribute("data-place", "afterAnswer");

  // Its link focuses the composer; the Question asked there is answered in the assistant, the
  // Mind left as it was.
  await pointAndClick(window, hint.getByTestId("end-hint-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await useLocalChatModel(window);
  await window.keyboard.type("What was the online gross margin in Q3?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(editor.getByTestId("question")).toHaveCount(1);
  await expect(editor.locator('[data-origin="conversation"]')).toHaveCount(0);
  // The example is never a target of Add to note (#1940): it asks which note, and nothing goes in.
  await expect(answer.getByTestId("answer-add-label")).toHaveText("Add to note");
  await pointAndClick(window, answer.getByTestId("answer-add"));
  await expect(window.getByTestId("add-to-picker")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("add-to-picker")).toHaveCount(0);
  await expect(editor.locator('[data-origin="conversation"]')).toHaveCount(0);
  await expect(editor.getByTestId("question")).toHaveCount(1);
});

test("the Examples row's ⋯ offers the other examples in an order picked once per install; each opens in a new tab and is made once (#123)", async () => {
  const first = await launchApp(dataDir, { examples: true });
  const { app, window } = first;
  await setWindowSize(app, window, 1100, 720);
  await expect(window.getByTestId("first-open-steps")).toBeVisible();

  const groupsShown = async () =>
    (await examplesMenu(window))
      .getByTestId("example-more-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("data-group")));
  const choose = async (group: string) => {
    const menu = await examplesMenu(window);
    await pointAndClick(window, menu.locator(`[data-group="${group}"]`));
    await expect(menu).toBeHidden();
  };
  const tabs = window.getByTestId("tab-title");
  await expect(tabs).toHaveCount(0);
  const order = await groupsShown();
  expect([...order].sort()).toEqual(["contracts", "meetings", "papers"]);
  await window.keyboard.press("Escape");

  // Contracts opens beside the first example, which stays in its own tab.
  await choose("contracts");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toHaveText("Draft: credit committee paper");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  expect(await groupsShown()).toEqual(order);
  await window.keyboard.press("Escape");

  // From the first example again, Contracts shows the one made, not a second.
  await pointAndClick(window, tabs.first());
  await choose("contracts");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await expect(tabs).toHaveCount(2);
  await app.close();

  // The same order after a restart.
  const again = await launchApp(dataDir, { examples: true });
  const credit = again.window.getByTestId("mind-tab").getByTestId("tab-title").first();
  await expect(credit).toHaveText("Draft: credit committee paper");
  const menu = await examplesMenu(again.window);
  expect(
    await menu
      .getByTestId("example-more-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("data-group"))),
  ).toEqual(order);
  await again.app.close();
});

test("Remove the examples removes every example Mind made, and Undo brings them back (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  const menu = await examplesMenu(window);
  await pointAndClick(window, menu.locator('[data-group="papers"]'));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await dismissChatSetup(window);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await app.close();
});

test("Undo after Remove the examples brings back the same Minds and Documents, and leaves nothing of them in Recently deleted (#1292)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  const menu = await examplesMenu(window);
  await pointAndClick(window, menu.locator('[data-group="papers"]'));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await expectReadyDocuments(window, 5);

  const held = () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [minds, linkedFolders, documents, deleted] = await Promise.all([
        core.listMinds(),
        core.listLinkedFolders(),
        core.listDocuments(),
        core.listDeleted(),
      ]);
      return {
        minds: minds.map((each) => each.id).sort(),
        linkedFolders: linkedFolders.map((each) => each.id).sort(),
        documents: documents.map((each) => each.id).sort(),
        deleted: deleted.map((each) => `${each.kind}:${each.id}`),
      };
    });
  const before = await held();
  expect(before.minds).toHaveLength(2);
  expect(before.documents).toHaveLength(5);

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  // What Undo has to take back: the Minds wait in Recently deleted, until it does.
  expect((await held()).deleted).toHaveLength(2);

  await dismissChatSetup(window);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  // Settled first: an embedding or a scan still running after Undo could change what is held.
  await expectReadyDocuments(window, 5);
  await expect.poll(held).toEqual({ ...before, deleted: [] });
  const back = await held();
  expect(back.minds).toHaveLength(before.minds.length);
  expect(back.linkedFolders).toHaveLength(before.linkedFolders.length);
  expect(back.documents).toHaveLength(before.documents.length);
  expect(back.deleted).toEqual([]);
  await app.close();
});

const paletteItems = paletteFound;

async function askPalette(window: Page, text: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(text);
}

const helpItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const found = Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.id === "examples.show");
    return found ? { label: found.label, visible: found.visible } : null;
  });

test("the Examples row's ⋯ removes the examples with Undo, and the commands show only in the right state (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  const steps = window.getByTestId("first-open-steps");
  await expect(steps).toBeVisible();

  await askPalette(window, "the examples");
  await expect(paletteItems(window)).toHaveText([/Remove the examples/]);
  await window.keyboard.press("Escape");
  await expect.poll(() => helpItem(app)).toMatchObject({ visible: false });

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "Removed the examples",
  );
  await dismissChatSetup(window);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(1);

  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.press("Escape");
  await askPalette(window, "Remove the examples");
  await paletteItems(window).first().click();
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);

  await expect
    .poll(() => helpItem(app))
    .toEqual({
      label: "Show the examples again",
      visible: true,
    });
  await askPalette(window, "the examples");
  await expect(paletteItems(window).first()).toHaveText(/Show the examples again/);
  await expect(paletteItems(window).filter({ hasText: /^Remove the examples/ })).toHaveCount(0);
  await window.keyboard.press("Escape");

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.id === "examples.show")
      ?.click();
  });
  await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "Showed the examples",
  );
  await expect.poll(() => helpItem(app)).toMatchObject({ visible: false });
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await app.close();
});
