/**
 * Choosing a service is the consent for what it sends (ADR-0022, #718): the
 * place the User chooses the chat model's provider says what goes to it, and
 * no dialog follows, neither before the first Answer nor for Tags. Tagging,
 * background work, never asks: it waits and says so where its status shows.
 * Set INCARNAMIND_SCREENSHOTS to a folder to keep screenshots of each step.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  addDocuments,
  addProviderForm,
  askInAssistant,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  makeTagOnDocument,
  newMind,
  openPlanPage,
  openServiceList,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const SENDS_EN = {
  lead: "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to OpenAI. · Details",
  onRequest:
    "Tagging and organizing your Documents send each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions, the kinds of Document, your own Tags’ names and descriptions and your interface language, only when you turn them on or ask for them. Page images of scans go only if you allow them in Settings → Privacy.",
  items: [
    "your Questions, earlier Questions and Answers, the note you’re in or one you name, the names of up to 30 of your most recently changed notes, noting which an Answer wrote, matching passages with their Document names and pages, the names, Folders and Tags of the Documents and notes a Question or a command finds (up to 50), a Meeting’s Transcript, a picture you select in a note to ask about, the names and descriptions of Skills that are on and the instructions and files of Skills an Answer loads, and the capped reports of Analyses it runs; and, for a quick-tasks model that finds the quotes behind an Answer’s Citations, the Answer and its passages, or that checks what the assistant’s reply says it changed, the reply, the Question it answers and the record of what its Tools did",
    "each sentence you check, with its paragraph, the lines of the note above it that say what it is about (the headings it is under and its section so far, up to about 2,000 characters, never text you excluded) and its figures, and for a figure an Answer worked out, how it was worked out: its label, formula and inputs with their quotes and Document names (for a workbook’s figure, the cells and formulas it was worked out through), or an Analysis’s label and unit, the columns and rows it read and the heading above it; the passages it’s checked against with their Document names, pages or locations and which of a workbook’s rows hold values its formulas worked out; for a figure a check you start works out again over a sheet or a CSV file, the capped report of the code that worked it out (the file’s name and size, the figures and table rows it gave, what it printed, its warnings and errors); for a sentence about your Library itself, which a check you start, or the one on what the assistant writes, counts on this computer from IncarnaMind’s own lists, only the numbers its code gives, never the lists; every sentence of a note or file you check whole, to find its claims; the claims of a document you verify, once more with their numbers and pages, to write what it concludes; the heading above a sentence the assistant wrote; and after a new version of a Document, the cited sentences of the notes in its Folder, without how their figures were worked out",
    "the paragraph you pause on and up to 8 matching passages, each with its Document name and location, for writing suggestions",
    "the text you ask the assistant to change, the paragraphs it is in and, when the change rewrites or removes cited text, that Citation’s quote",
  ],
};
const SENDS_ZH = {
  lead: "你提问、修改或核对的内容，连同所需的笔记和文档内容，会发送给 OpenAI。 · 详情",
  onRequest:
    "给文档打标签和整理，会发送每个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹的名称和描述、文档类别、你自己的标签的名称和描述以及你的界面语言；只有在你开启或要求时才会发送。扫描件的页面图片只有在你于“设置 → 隐私”中允许后才会发送。",
  items: [
    "你的问题、此前的问答、当前笔记或你指定的笔记、最近修改的最多 30 篇笔记的名称（标出由回答写成的）、匹配的段落及其文档名称和页码、问题或命令找到的文档和笔记（最多 50 个）的名称、文件夹和标签、会议的转写稿、你在笔记中选中提问的图片、已开启技能的名称和描述、回答加载的技能的说明和文件，以及回答运行的数据分析报告（有上限）；快速任务模型为回答中的引用找出对应引文时，该回答及其段落；核对助手的回答中说做了的改动时，该回答、它回答的问题，以及工具实际做了什么的记录",
    "你核对的每一句话及其所在段落、笔记中它上方说明它在讲什么的内容（所属的标题和本节前文，最多约 2,000 个字符，不含已排除的内容）和数字；句中由回答算出的数字的算法：标签、公式及其输入的引文和文档名称（工作簿中的数字为其经过的单元格和公式），或数据分析的标签和单位、读取的列和行以及上方的标题；以及用于核对的段落、其文档名称、页码或位置和工作簿中哪些行的数值由公式算出；你发起的核对根据表格或 CSV 文件重算数字时，重算代码的报告（有上限）：文件名称和大小、算出的数字和表格行、打印的结果、警告和错误；句子讲的是资料库本身时，你发起的核对和对助手所写句子的核对会在这台电脑上按 IncarnaMind 自己的清单来数，只发送代码数出的数字，不发送清单；整篇核对笔记或文件时，其中每一句话（用于找出说法）；核对别人的文件时，找出的说法再带着编号和页码发送一次（用于写出文件的结论）；助手所写句子上方的标题；文档有新版本后，所在文件夹中笔记里带引用的句子（不含其中数字的算法）",
    "写作建议时你停下的那一段，以及最多 8 个匹配的段落（含文档名称和位置）",
    "你让助手修改的文字及其所在段落；修改会改写或删除带引用的文字时，还有该引用的引文",
  ],
};

/** The one line, then Details opening and closing the full list by keyboard; the list ends with what goes only on the User's word. */
async function expectSends(sends: Locator, words: typeof SENDS_EN): Promise<void> {
  await expect(sends.locator("p")).toHaveText(words.lead);
  await expect(sends.getByRole("listitem")).toHaveCount(0);
  const details = sends.getByTestId("provider-sends-details");
  await details.focus();
  await details.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(sends.getByRole("listitem")).toHaveText(words.items);
  await expect(sends.getByText(words.onRequest)).toBeVisible();
  await details.press("Enter");
  await expect(sends.getByRole("listitem")).toHaveCount(0);
}

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

/** Keeps every consent request the core raises from now on, whether or not a dialog shows it. */
async function recordConsentRequests(window: Page): Promise<() => Promise<string[]>> {
  await window.evaluate(() => {
    const scope = globalThis as unknown as { incarnamind: CoreBridge; consentAsked: string[] };
    scope.consentAsked = [];
    scope.incarnamind.on("consent.requested", (request) => {
      scope.consentAsked.push(request.flow.id);
    });
  });
  return () =>
    window.evaluate(() => (globalThis as unknown as { consentAsked: string[] }).consentAsked);
}

/** A text file in the sources folder, which the scripted tagger tags "Invoice". */
async function invoice(name: string): Promise<string> {
  const path = join(sources, `${name}.txt`);
  await writeFile(path, `${name}. Amount due: 120 EUR.\n`);
  return path;
}

test("first run: choosing a provider with a key is the consent for what runs by itself, so no dialog comes before the Answer, and choosing its model for Tags starts them", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  const consentAsked = await recordConsentRequests(window);

  // The line above the button says what goes to the provider.
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is due?");
  await window.keyboard.press("Enter");
  const setup = window.getByTestId("model-setup");
  await openServiceList(window, setup);
  const form = setup.getByTestId("provider-form");
  await form
    .locator("label")
    .filter({ hasText: /^OpenAI$/ })
    .click();
  await expectSends(form.getByTestId("provider-sends"), SENDS_EN);
  await acceptPlainTextKeys(window, form);
  await form.getByLabel(/^API key/).fill("sk-proj-not-a-real-key");
  await form.getByTestId("provider-sends").scrollIntoViewIfNeeded();
  await screenshot(window, "choosing-line-setup-en");
  await form.getByTestId("provider-use-key").click();
  await expect(window.getByTestId("composer-input")).toBeVisible();

  // Tags are on, but ask before the first Document goes (#2308, #3353): Settings › AI's switch
  // says what goes and that it asks first, and the footer asks with the first Document, saying
  // what goes. After its Allow, a Document is tagged without asking.
  const jobs = (await openSettings(window, "ai")).getByTestId("ai-jobs");
  const turnOn = jobs.getByTestId("tagging-automatic-organize");
  await expect(jobs.getByTestId("tagging-automatic-sends")).toContainText(
    "OpenAI receives the name",
  );
  await expect(turnOn).toBeChecked();
  await expect(jobs.getByTestId("tagging-automatic-asks")).toHaveText(
    "OpenAI isn’t allowed yet: IncarnaMind asks you before the first Document goes.",
  );
  await closeSettings(window);
  await addDocuments(window, [await invoice("Invoice 40")]);
  const allow = window.getByTestId("sort-consent").getByTestId("sort-consent-allow");
  await expect(allow).toHaveText("Allow OpenAI");
  await pointAndClick(window, allow);
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Invoice 40" }),
  ).toHaveAttribute("data-tagging", "tagged", { timeout: 15_000 });
  const models = await openSettings(window, "ai");
  const tagging = models.getByTestId("ai-jobs");
  const automatic = tagging.getByRole("switch", {
    name: /^Sort and tag new Documents as they arrive/,
  });
  await expect(automatic).toBeChecked();
  await expect(tagging.getByTestId("tagging-automatic-sends")).toHaveText(
    translate("en", "setup.sorting.sendsWhenOn", { service: "OpenAI" }),
  );
  await closeSettings(window);

  // A Document added since is tagged without asking.
  await window.getByTestId("add-documents-input").setInputFiles([await invoice("Invoice 41")]);
  const first = window.getByTestId("document-list-item").filter({ hasText: "Invoice 41" });
  await expect(first).toHaveAttribute("data-tagging", "tagged", { timeout: 15_000 });

  // A Question is answered without asking.
  await newMind(window);
  await askInAssistant(window, "What is due?");
  await expect(window.getByTestId("consent-dialog")).toBeHidden();
  expect(await consentAsked()).toEqual([]);

  // Settings › Privacy: OpenAI says once that it was allowed when it was chosen, for the uses that
  // run by themselves, and Tags when they were turned on. Organize asks when it first runs, and
  // page images are a flow of their own that still asks.
  const settings = await openSettings(window, "privacy");
  const service = settings.getByTestId("data-service");
  await expect(service).toHaveCount(1);
  await expect(service).toHaveAttribute("data-consent", "accepted");
  await expect(service.getByTestId("data-service-decision")).toContainText(
    /^Allowed when you chose OpenAI, /,
  );
  await service.getByTestId("data-service-decision-details").click();
  for (const flow of ["chat", "edits", "checks", "suggestions", "tagging"]) {
    await expect(service.locator(`[data-testid="data-flow"][data-flow-id="${flow}"]`)).toHaveCount(
      1,
    );
  }
  // Organize's consent is not among them: it asks when Organize first runs (#1569).
  await expect(
    service.locator('[data-testid="data-flow"][data-flow-id="classification"]'),
  ).toHaveCount(0);
  await screenshot(window, "privacy-chosen-en");

  // Stopping OpenAI stops tagging too: the next Document waits, and nothing asks again (#3353).
  await service.getByTestId("data-service-revoke").click();
  await expect(service).toHaveAttribute("data-consent", "not-asked");
  await closeSettings(window);
  await window.getByTestId("add-documents-input").setInputFiles([await invoice("Invoice 42")]);
  const second = window.getByTestId("document-list-item").filter({ hasText: "Invoice 42" });
  await expect(second).toHaveAttribute("data-status", "ready");
  await expect(second).toHaveAttribute("data-tagging", "off");
  await expect(window.getByTestId("sort-consent")).toHaveCount(0);
  await expect(window.getByTestId("tagging-waiting")).toHaveCount(0);

  // Settings › AI is where it is turned on again, with its line: a Document added after is tagged.
  const again = (await openSettings(window, "ai")).getByTestId("ai-jobs");
  const switchAgain = again.getByTestId("tagging-automatic-organize");
  await expect(switchAgain).not.toBeChecked();
  await expect(again.getByTestId("tagging-automatic-asks")).toHaveCount(0);
  await pointAndClick(window, switchAgain);
  await expect(switchAgain).toBeChecked();
  await closeSettings(window);
  await window.getByTestId("add-documents-input").setInputFiles([await invoice("Invoice 44")]);
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Invoice 44" }),
  ).toHaveAttribute("data-tagging", "tagged", { timeout: 15_000 });
  await expect(second).toHaveAttribute("data-tagging", "off");
  expect(await consentAsked()).toEqual([]);

  // Allowed for Tags alone, the service says some uses aren't allowed yet; Allow allows the rest.
  const reopened = (await openSettings(window, "privacy")).getByTestId("data-service");
  await expect(reopened).toHaveAttribute("data-consent", "partly");
  await expect(reopened.getByTestId("data-service-decision")).toContainText(
    "Some uses aren’t allowed yet",
  );
  await reopened.getByTestId("data-service-allow").click();
  await expect(reopened).toHaveAttribute("data-consent", "accepted");
  await app.close();
});

test("before a model is chosen, a new Document's tagging waits with its line, and nothing asks", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  const consentAsked = await recordConsentRequests(window);

  await addDocuments(window, [await invoice("Invoice 43")]);

  const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 43" });
  await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider");
  await makeTagOnDocument(window, "Invoice 43");
  const status = window.getByTestId("tagging-waiting");
  await expect(status.getByTestId("status-label")).toHaveText("Tags need an AI model");
  await expect(status).toHaveAttribute("title", "Tags come once you choose an AI model.");
  await expect(window.getByTestId("consent-dialog")).toBeHidden();
  expect(await consentAsked()).toEqual([]);

  await setLanguage(window, "zh-CN");
  await expect(status).toHaveAttribute("title", "选择 AI 模型后会自动打标签。");
  await app.close();
});

test("Settings › AI says in one line what the ChatGPT plan sends, with the full list behind Details", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const plan = await openPlanPage(window, "chatgpt");
  await expect(plan).toContainText("No key needed. Counts toward your plan’s limits.");
  const sends = plan.getByTestId("provider-sends");
  await expect(sends.locator("p")).toHaveText(
    "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to OpenAI. · Details",
  );
  await sends.getByTestId("provider-sends-details").click();
  await expect(sends.getByRole("listitem")).toHaveText(SENDS_EN.items);
  await expect(sends.getByText(SENDS_EN.onRequest)).toBeVisible();
  await plan.scrollIntoViewIfNeeded();
  await screenshot(window, "choosing-line-chatgpt-en");
  await app.close();
});

test("in Chinese, adding a provider in Settings › AI says what goes to it above its button", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const settings = await openSettings(window, "ai");
  await setLanguage(window, "zh-CN");

  const form = await addProviderForm(settings, "openai");

  const line = form.getByTestId("provider-sends");
  await expectSends(line, SENDS_ZH);
  await line.scrollIntoViewIfNeeded();
  // Right above the button it is said for.
  const lineBox = await line.boundingBox();
  const buttonBox = await form.getByTestId("provider-use-key").boundingBox();
  expect(lineBox && buttonBox && lineBox.y + lineBox.height <= buttonBox.y).toBe(true);
  await screenshot(window, "choosing-line-settings-zh");
  await app.close();
});
