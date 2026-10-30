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
import {
  acceptPlainTextKeys,
  addDocuments,
  addProviderForm,
  askInAssistant,
  closeSettings,
  continueSetup,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  makeTagOnDocument,
  newMind,
  openAdvancedModels,
  openServiceList,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const SENDS_EN = {
  lead: "Sends your questions and document text to OpenAI. · Details",
  onRequest:
    "Tagging and sorting your Documents send each Document’s name and an excerpt, with your Folder and Tag names, only when you turn them on or ask for them. Page images of scans go only if you allow them in Settings → Privacy.",
  items: [
    "your Questions, the note you’re in or one you name, matching passages with their Document names and pages, the names, Folders and Tags of the Documents a Question or a command finds (up to 50), and a Meeting’s Transcript",
    "each sentence you check",
    "the paragraph you pause on, for writing suggestions",
    "the text you ask the assistant to change",
  ],
};
const SENDS_ZH = {
  lead: "会把你的问题和文档内容发送给 OpenAI。 · 详情",
  onRequest:
    "给文档打标签和整理，会发送每个文档的名称和摘录，以及你的文件夹和标签名称；只有在你开启或要求时才会发送。扫描件的页面图片只有在你于“设置 → 隐私”中允许后才会发送。",
  items: [
    "你的问题、你所在或在问题中提到的笔记、相关段落及其文档名称和页码、问题或命令找到的文档的名称、文件夹和标签（最多 50 个），以及会议的转写稿",
    "你核对的每一句话",
    "写作建议时你停下的那一段",
    "你让助手修改的文字",
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

test("first run: choosing a provider with a key is the consent for what runs by itself, so no dialog comes before the Answer, and Tags start once they are turned on", async () => {
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
  await continueSetup(window);

  // A cloud model starts with tagging off: nothing is sent for a Document until the User turns it on.
  await addDocuments(window, [await invoice("Invoice 40")]);
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Invoice 40" }),
  ).toHaveAttribute("data-tagging", "off");
  const models = await openSettings(window, "models");
  const tagging = await openAdvancedModels(models);
  await tagging.scrollIntoViewIfNeeded();
  const automatic = tagging.getByRole("checkbox", {
    name: /^Tag and sort new Documents automatically/,
  });
  await expect(automatic).not.toBeChecked();
  await expect(tagging.getByTestId("tagging-automatic-sends")).toHaveText(
    "Sends each new Document’s name and first passages, and your Folder and Tag names, to OpenAI.",
  );
  await automatic.click();
  await expect(automatic).toBeChecked();
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

  // Settings › Privacy: OpenAI was allowed when it was chosen, for the uses that run by
  // themselves — Tags and sorting. Page images are a flow of their own and still ask.
  const settings = await openSettings(window, "privacy");
  const service = settings.getByTestId("data-service");
  await expect(service).toHaveCount(1);
  await expect(service).toHaveAttribute("data-consent", "partly");
  await expect(service.getByTestId("data-service-decision")).toContainText(
    "Some uses aren’t allowed yet",
  );
  await service.getByTestId("data-service-decision-details").click();
  for (const flow of ["chat", "edits", "checks", "suggestions", "tagging", "classification"]) {
    await expect(service.locator(`[data-testid="data-flow"][data-flow-id="${flow}"]`)).toHaveCount(
      1,
    );
  }
  await screenshot(window, "privacy-chosen-en");

  // Stopping OpenAI stops tagging too: the next Document waits, saying why, with Allow in place.
  await service.getByTestId("data-service-revoke").click();
  await expect(service).toHaveAttribute("data-consent", "not-asked");
  await closeSettings(window);
  await window.getByTestId("add-documents-input").setInputFiles([await invoice("Invoice 42")]);
  const second = window.getByTestId("document-list-item").filter({ hasText: "Invoice 42" });
  await expect(second).toHaveAttribute("data-status", "ready");
  await expect(second).toHaveAttribute("data-tagging", "waiting-for-provider");
  // A Tag of the User's own: only now is Tags named, and its permission asked for (#1942).
  await makeTagOnDocument(window, "Invoice 42");
  const status = window.getByTestId("tagging-waiting");
  await expect(status).toContainText("Tags need your OK");
  await expect(status).toHaveAttribute(
    "title",
    "Tags wait until you allow Document text to go to OpenAI.",
  );
  await screenshot(window, "tagging-permission-en");

  await status.getByTestId("tagging-waiting-allow").click();
  await expect(second).toHaveAttribute("data-tagging", "tagged", { timeout: 15_000 });
  await expect(status).toHaveCount(0);
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

test("Settings › Models says in one line what the ChatGPT plan sends, with the full list behind Details", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const settings = await openSettings(window, "models");

  const plan = settings.getByTestId("chatgpt-settings");
  await expect(plan).toContainText("No key needed. Counts toward your plan’s limits.");
  const sends = plan.getByTestId("provider-sends");
  await expect(sends.locator("p")).toHaveText(
    "Sends your questions and document text to OpenAI. · Details",
  );
  await sends.getByTestId("provider-sends-details").click();
  await expect(sends.getByRole("listitem")).toHaveText(SENDS_EN.items);
  await expect(sends.getByText(SENDS_EN.onRequest)).toBeVisible();
  await plan.scrollIntoViewIfNeeded();
  await screenshot(window, "choosing-line-chatgpt-en");
  await app.close();
});

test("in Chinese, adding a provider in Settings › Models says what goes to it above its button", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const settings = await openSettings(window, "models");
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
