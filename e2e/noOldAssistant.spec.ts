import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  frontMind,
  launchApp,
  newMind,
  openProviderRow,
  openSettings,
  pointAndClick,
  removeDataFolder,
  saveProvider,
  setLanguage,
  setWindowSize,
  useCloudChatModel,
  useLocalChatModel,
  writeNote,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * A User who never connected an AI meets no old assistant (#3767): no model is set up inside
 * IncarnaMind. With no model and no AI, there is no assistant column, no Ask anything
 * pill and no line at a Note's top; where asking would be, one line says what it needs, with
 * Connect your AI, which opens Settings › AI. A profile that already has a model keeps it and can
 * remove it, but nothing new is added there.
 */

let dataDir: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
});

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

/** The line at the foot of the Note in view that says what asking needs. */
const noteFoot = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused]').getByTestId("note-ask-no-ai");

/** Nothing of the old assistant is drawn: no column, no pill, no line at a Note's top. */
async function noOldAssistant(window: Page) {
  await expect(window.getByTestId("assistant")).toBeHidden();
  await expect(window.locator("[data-ask-pill]")).toHaveCount(0);
  await expect(window.getByTestId("ask-pill")).toHaveCount(0);
  await expect(window.getByTestId("chat-readiness")).toHaveCount(0);
}

test("a new User who skips the AI step finds Home and their first Note with one line to connect their AI", async () => {
  const launched = await launchApp(dataDir, { firstRunSetup: true });
  app = launched.app;
  const window = launched.window;
  await setWindowSize(launched.app, window, 1440, 900);
  await window.getByTestId("setup-skip").click();
  await expect(window.getByTestId("setup-panel")).toHaveAttribute("data-step", "ai");
  // The step offers the User's own AI and nothing that sets a model up here.
  await expect(window.getByTestId("setup-apps")).toBeVisible();
  await expect(window.getByTestId("setup-in-app-open")).toHaveCount(0);
  await expect(window.getByTestId("setup-key")).toHaveCount(0);
  // Skips what is left of the setup, as a new User in a hurry does.
  const panel = window.getByTestId("setup-panel");
  while ((await panel.count()) > 0) {
    const at = await panel.getAttribute("data-step");
    await panel.getByTestId("setup-skip").click();
    await expect(window.locator(`[data-testid="setup-panel"][data-step="${at}"]`)).toHaveCount(0);
  }

  await window.getByTestId("sidebar-home").click();
  const home = window.getByTestId("home");
  await expect(home).toBeVisible();
  const line = home.getByTestId("home-ask-no-ai");
  await expect(line).toHaveText(/^Asking needs your AI\s*·\s*Connect your AI$/);
  // The one black button on an empty Home is Add files…; the line stands under the buttons.
  await expect(home.getByTestId("home-add-files")).toHaveAttribute("class", /(^|\s)bg-ink(\s|$)/);
  const buttons = await home.getByTestId("home-new-mind").boundingBox();
  const under = await line.boundingBox();
  expect(buttons && under && under.y > buttons.y).toBe(true);
  await expect(home.getByTestId("home-ask-input")).toHaveCount(0);
  await expect(window.getByTestId("home-foot-ask")).toHaveCount(0);
  await noOldAssistant(window);
  await shot(window, "home-empty-en-1440");

  await newMind(window);
  const foot = noteFoot(window);
  await expect(foot).toHaveText(/^Asking needs your AI\s*·\s*Connect your AI$/);
  await noOldAssistant(window);
  // ⌘J has no column to open: the Note stays as it is.
  await window.keyboard.press("ControlOrMeta+j");
  await noOldAssistant(window);
  await shot(window, "note-en-1440");

  await setLanguage(window, "zh-CN");
  await expect(foot).toHaveText(/^提问需要你的 AI\s*·\s*连接你的 AI$/);
  await foot.getByTestId("note-ask-connect").click();
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "ai");
  await expect(settings.locator('[data-testid^="ai-use-model"]')).toHaveCount(0);
  await expect(settings).not.toContainText("在 IncarnaMind 里用一个模型");
});

test("a profile from before first setup, with Notes and no AI, says what asking needs at Home's foot and a Note's", async () => {
  const launched = await launchApp(dataDir);
  app = launched.app;
  const window = launched.window;
  await setWindowSize(launched.app, window, 1440, 900);
  const mindId = await writeNote(window, "Ferry delays", [
    { text: "The 07:40 crossing leaves late most weekdays." },
  ]);
  await window.getByTestId("sidebar-home").click();
  const foot = window.getByTestId("home-foot-ask");
  await expect(foot.getByTestId("home-foot-no-ai")).toHaveText(
    /^Asking needs your AI\s*·\s*Connect your AI$/,
  );
  // With content, Home has no input that can't answer and no line among its buttons.
  await expect(window.getByTestId("home-ask-input")).toHaveCount(0);
  await expect(window.getByTestId("home-ask-no-ai")).toHaveCount(0);
  await noOldAssistant(window);
  await shot(window, "home-content-en-1440");

  await window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first().click();
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
  await expect(noteFoot(window)).toBeVisible();
  await noOldAssistant(window);

  // Organize with no AI says what it needs and the way to connect one.
  const sources = await createDataFolder();
  try {
    const survey = join(sources, "Harbour survey.md");
    await writeFile(survey, "# Harbour survey\n\nThe berth depth at the north quay.\n");
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.createLibraryGroup({ name: "Harbour", description: "" });
    });
    await addDocuments(window, [survey]);
    await pointAndClick(window, window.getByTestId("open-library"));
    const library = window.getByTestId("library");
    await pointAndClick(window, library.getByTestId("library-organize"));
    const needs = library.getByTestId("library-organize-needs-ai");
    await expect(needs.locator("p")).toHaveText("Organizing needs your AI");
    const connect = needs.getByTestId("library-organize-connect-ai");
    await expect(connect).toHaveText("Connect your AI");
    await pointAndClick(window, connect);
  } finally {
    await removeDataFolder(sources);
  }
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
});

test("a profile with a model keeps it and can remove it, and nothing new is added in IncarnaMind", async () => {
  const launched = await launchApp(dataDir, { fakeChat: true });
  app = launched.app;
  const window = launched.window;
  await useLocalChatModel(window);
  await newMind(window);
  // With a model, the assistant answers in its panel.
  await expect(window.getByTestId("assistant")).toBeVisible();
  await expect(noteFoot(window)).toHaveCount(0);

  const settings = await openSettings(window, "ai");
  const row = settings.getByTestId("provider-row").first();
  await expect(row).toBeVisible();
  // Add a key… lists only keys for meetings and search: no plan, no model on this computer, and
  // no company whose key would only answer Questions.
  await settings.getByTestId("models-add-provider").click();
  const sheet = settings.getByTestId("ai-add-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-entry^="plan:"]')).toHaveCount(0);
  await expect(sheet.locator('[data-catalog-id="anthropic"]')).toHaveCount(0);
  await expect(sheet.locator('[data-catalog-id="ollama"]')).toHaveCount(0);
  await expect(
    sheet.getByTestId("provider-directory-job").filter({ hasText: "Answers" }),
  ).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await row.click();
  await expect(settings.getByTestId("provider-models")).toBeVisible();
  await expect(settings.getByTestId("provider-add-model")).toHaveCount(0);
  await settings.getByTestId("provider-remove").click();
  await expect(settings.getByTestId("models-removed")).toHaveText(/^Removed .+\.$/);
  await expect(settings.getByTestId("provider-row")).toHaveCount(0);
  await window.keyboard.press("Escape");

  // Removed, the profile is one that never set a model up.
  await noOldAssistant(window);
  await expect(noteFoot(window)).toBeVisible();
});

test("a saved Qwen lists only the regions saved: picking the other opens its own page, and no key form opens", async () => {
  const launched = await launchApp(dataDir, { fakeChat: true });
  app = launched.app;
  const window = launched.window;
  const china = await saveProvider(window, {
    kind: "qwen",
    endpoint: "cn",
    modelId: "qwen3.7-plus",
    apiKey: "sk-qwen-cn-test",
  });
  // Saved on one region, the page offers no other: a second region would be a new key.
  const settings = await openProviderRow(window, china);
  await expect(settings.getByTestId("provider-page")).toBeVisible();
  await expect(settings.getByTestId("provider-page-region")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  const international = await saveProvider(window, {
    kind: "qwen",
    endpoint: "intl",
    modelId: "qwen3.7-plus",
    apiKey: "sk-qwen-intl-test",
  });
  await openProviderRow(window, china);
  await settings.getByTestId("provider-page-region").click();
  await settings.getByTestId("provider-page-region-menu").locator('[data-value="intl"]').click();
  await expect(settings.getByTestId("provider-page")).toHaveAttribute(
    "data-provider-id",
    international,
  );
  await expect(settings.getByTestId("provider-add")).toHaveCount(0);
});

test("with no model, a key for meetings and search is added from the transcription picker, and never answers Questions", async () => {
  const launched = await launchApp(dataDir, { fakeChat: true });
  app = launched.app;
  const window = launched.window;
  await setWindowSize(launched.app, window, 1440, 900);
  const settings = await openSettings(window, "ai");
  await settings.getByTestId("meetings-route").selectOption({ label: "Add a key…" });
  const sheet = settings.getByTestId("ai-add-sheet");
  await expect(sheet).toBeVisible();
  // Keys for meetings and search only: no plan, no company whose key only answers Questions.
  await expect(sheet.locator('[data-entry^="plan:"]')).toHaveCount(0);
  await expect(sheet.locator('[data-catalog-id="anthropic"]')).toHaveCount(0);
  await expect(sheet.locator('[data-catalog-id="ollama"]')).toHaveCount(0);
  const jobs = await sheet.getByTestId("provider-directory-job").allTextContents();
  expect(new Set(jobs)).toEqual(new Set(["Transcription", "Search"]));
  const openai = sheet.locator('[data-catalog-id="openai"]');
  await expect(openai.getByTestId("provider-directory-job")).toHaveText([
    "Transcription",
    "Search",
  ]);
  await openai.click();
  await expect(sheet).toBeHidden();

  const form = settings.getByTestId("provider-add");
  await expect(form).toHaveAttribute("data-catalog-id", "openai");
  await acceptPlainTextKeys(window, form);
  // A key saved for these jobs asks for no model.
  await expect(form.getByTestId("provider-model")).toHaveCount(0);
  await expect(form.getByTestId("provider-model-line")).toHaveCount(0);
  await form.getByLabel(/^API key/).fill("sk-openai-for-meetings");
  await form.getByTestId("provider-use-key").click();
  await expect(settings.getByTestId("provider-page")).toBeVisible();
  await settings.getByTestId("models-back").click();
  await expect(
    settings.getByTestId("meetings-route").locator('option[value="openai"]'),
  ).toHaveCount(1);
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // Questions still have no model: no assistant, and the Note says what asking needs.
  await newMind(window);
  await noOldAssistant(window);
  await expect(noteFoot(window)).toBeVisible();
  expect(
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.getSettings()).user.chatModel;
    }),
  ).toBeNull();
});

test("with a Claude model, an OpenAI key added for transcription leaves the Questions model picker with Claude's models alone", async () => {
  const launched = await launchApp(dataDir, { fakeChat: true });
  app = launched.app;
  const window = launched.window;
  await setWindowSize(launched.app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await useCloudChatModel(window);
  const claude = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).user.chatModel?.providerId ?? "";
  });
  const settings = await openSettings(window, "ai");
  const answers = settings.getByTestId("model-default-chatModel");
  const answerValues = () =>
    answers.evaluate((select) =>
      [...(select as HTMLSelectElement).options].map((each) => each.value).filter(Boolean),
    );
  await expect.poll(answerValues).not.toEqual([]);
  const before = await answerValues();
  expect(before.every((value) => value.startsWith(`${claude}\n`))).toBe(true);

  await settings.getByTestId("meetings-route").selectOption({ label: "Add a key…" });
  const sheet = settings.getByTestId("ai-add-sheet");
  await sheet.locator('[data-catalog-id="openai"]').click();
  const form = settings.getByTestId("provider-add");
  await expect(form).toHaveAttribute("data-catalog-id", "openai");
  await form.getByLabel(/^API key/).fill("sk-openai-for-meetings");
  await form.getByTestId("provider-use-key").click();
  await expect(settings.getByTestId("provider-page")).toBeVisible();
  await settings.getByTestId("models-back").click();
  await expect(
    settings.getByTestId("meetings-route").locator('option[value="openai"]'),
  ).toHaveCount(1);

  // The Questions picker still lists Claude's models alone, and Claude still answers.
  await expect.poll(answerValues).toEqual(before);
  await expect(answers).toHaveValue(new RegExp(`^${claude}\\n`));
});
