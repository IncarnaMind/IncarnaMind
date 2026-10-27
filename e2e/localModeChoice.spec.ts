import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  addProviderPage,
  createDataFolder,
  launchApp,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

let dataDir: string;
let ollama: Server;
let ollamaUrl: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  // An Ollama that already has the recommended model: nothing is downloaded.
  ollama = createServer((request, response) => {
    response.writeHead(request.url === "/api/tags" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] }));
  });
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});
test.afterEach(async () => {
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
  await removeDataFolder(dataDir);
});

const localOnly = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getEmbeddingSettings()).localOnly;
  });

const language = (window: Page, value: "en" | "zh-CN") =>
  window.evaluate(
    (chosen) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: chosen },
      }),
    value,
  );

test("first run's local path starts ticked, because nothing in the cloud is set up; choosing the model turns Local mode on, and Undo turns it off; English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { ollama: ollamaUrl });
  await setWindowSize(app, window, 900, 700);
  const setup = await openSettings(window, "models");
  await addProviderPage(setup, "ollama");

  const box = setup.getByTestId("keep-local-box");
  const line = setup.getByTestId("keep-local-line");
  await expect(box).toBeChecked();
  await expect(setup.getByTestId("keep-local")).toContainText(
    "Also keep everything on this computer",
  );
  await expect(line).toHaveText("Nothing in the cloud is set up yet.");
  expect(Math.abs((await textLeft(line)) - (await textLeft(label(box))))).toBeLessThanOrEqual(1);

  await language(window, "zh-CN");
  await expect(setup.getByTestId("keep-local")).toContainText("同时让所有内容都留在这台电脑上");
  await expect(line).toHaveText("目前没有设置任何云端服务。");
  expect(Math.abs((await textLeft(line)) - (await textLeft(label(box))))).toBeLessThanOrEqual(1);
  await language(window, "en");

  await setup.getByTestId("ollama-use").click();
  await expect(setup.getByTestId("provider-page-title")).toHaveText("Ollama");
  await expect.poll(() => localOnly(window)).toBe(true);
  const undo = setup.getByTestId("undo-line-here");
  await expect(undo.getByTestId("undo-message")).toHaveText(
    "Turned on “Keep everything on this computer”",
  );
  await undo.getByTestId("undo-action").click();
  await expect.poll(() => localOnly(window)).toBe(false);
  await app.close();
});

/** The left edge of an element's text, not of its box. */
const textLeft = (element: Locator) =>
  element.evaluate((node) => {
    const range = document.createRange();
    const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error("No text.");
    range.selectNodeContents(text);
    return range.getBoundingClientRect().left;
  });

const label = (box: Locator) => box.locator("xpath=ancestor::label");

const chatModel = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).user.chatModel?.modelId ?? null;
  });

async function openLocalWay(window: Page): Promise<Locator> {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is in my Documents?");
  await window.keyboard.press("Enter");
  const setup = window.getByTestId("model-setup");
  await expect(setup.getByTestId("way-local")).toBeVisible();
  return setup;
}

async function expectPrivacySwitch(window: Page): Promise<void> {
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "privacy");
  const toggle = settings.getByTestId("local-only");
  await expect(toggle).toBeFocused();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeInViewport();
}

for (const [name, locale] of [
  ["English", "en"],
  ["Chinese", "zh-CN"],
] as const) {
  const zh = locale === "zh-CN";

  test(`with a cloud model and an agent set up, the box starts unticked and names what would pause; leaving it unticked keeps Local mode off; ticked, it turns on with Undo (${name})`, async () => {
    const { app, window } = await launchApp(dataDir, { ollama: ollamaUrl });
    await setWindowSize(app, window, 900, 700);
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({
        kind: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        modelId: "example-model",
      });
      await bridge.setAgentsEnabled(true);
      await bridge.connectAgent({ name: "Test agent" });
    });
    const page = await openSettings(window, "models");
    if (zh) await language(window, "zh-CN");
    await addProviderPage(page, "ollama");
    const box = page.getByTestId("keep-local-box");
    const line = page.getByTestId("keep-local-line");
    await expect(box).not.toBeChecked();
    // An agent connected while connecting agents isn't offered never listens, so nothing of it pauses.
    const pauses = !SHOW_AGENT_CONNECTION
      ? "llm.example.com"
      : zh
        ? "llm.example.com 和 1 个已连接的智能体"
        : "llm.example.com and 1 connected agent";
    await expect(line).toHaveText(
      zh ? `会暂停 ${pauses}，直到你关闭它。` : `Pauses ${pauses} until you turn it off.`,
    );
    expect(Math.abs((await textLeft(line)) - (await textLeft(label(box))))).toBeLessThanOrEqual(1);

    // Unticked: Ollama is added beside the cloud model, which stays the default, and Local mode stays off.
    await page.getByTestId("ollama-use").click();
    await expect(page.getByTestId("provider-page-title")).toHaveText("Ollama");
    expect(await localOnly(window)).toBe(false);
    await expect(page.getByTestId("undo-message")).toHaveCount(0);

    // Removed and added again, ticked by the keyboard.
    await page.getByTestId("provider-remove").click();
    await addProviderPage(page, "ollama");
    await box.focus();
    await window.keyboard.press("Space");
    await expect(box).toBeChecked();
    await page.getByTestId("ollama-use").click();
    await expect.poll(() => localOnly(window)).toBe(true);
    // Only a model on this computer can answer now: Ollama's is the default.
    await expect(page.getByTestId("provider-page-title")).toHaveText("Ollama");
    // Settings covers the sidebar's undo line, so the line shows in Settings.
    const undo = page.getByTestId("undo-line-here");
    await expect(undo.getByTestId("undo-message")).toHaveText(
      zh ? "已开启“所有内容都留在这台电脑上”" : "Turned on “Keep everything on this computer”",
    );
    await undo.getByTestId("undo-action").click();
    await expect.poll(() => localOnly(window)).toBe(false);
    await app.close();
  });

  test(`at setup, the local way says before the click that it keeps everything on this computer; the line then names the model and Local mode, Undo and Redo reach Local mode alone, and Change opens Privacy at its switch (${name})`, async () => {
    const { app, window } = await launchApp(dataDir, { ollama: ollamaUrl });
    await setWindowSize(app, window, 1100, 760);
    if (zh) await language(window, "zh-CN");
    const setup = await openLocalWay(window);

    const use = setup.getByTestId("ollama-use");
    const keeps = setup.getByTestId("setup-local-keeps");
    await expect(use).toBeEnabled();
    await expect(keeps).toHaveText(
      zh ? "所有内容都留在这台电脑上" : "Keeps everything on this computer",
    );
    const [button, line] = await Promise.all([use.boundingBox(), keeps.boundingBox()]);
    if (!button || !line) throw new Error("The local way isn't laid out.");
    expect(line.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(await localOnly(window)).toBe(false);

    await pointAndClick(window, use);
    await expect.poll(() => localOnly(window)).toBe(true);
    await expect(setup.getByTestId("setup-ready-title")).toBeVisible();
    const undo = setup.getByTestId("undo-line-here");
    const said = zh
      ? "使用 qwen3.5:4b · 所有内容都留在这台电脑上"
      : "Using qwen3.5:4b · Everything stays on this computer";
    await expect(undo.getByTestId("undo-message")).toHaveText(said);
    await expect(undo.getByTestId("undo-change-local-mode")).toHaveText(zh ? "更改" : "Change");
    await expect(undo.getByTestId("undo-action")).toHaveText(zh ? "撤销" : "Undo");
    // Shown in the card, where the User is, and not again at the sidebar's foot.
    await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveCount(0);

    await pointAndClick(window, undo.getByTestId("undo-action"));
    await expect.poll(() => localOnly(window)).toBe(false);
    expect(await chatModel(window)).toBe("qwen3.5:4b");
    // Undo took back Local mode alone, and the line after it says so.
    await expect(undo.getByTestId("undo-note")).toHaveText(
      zh
        ? "已关闭“所有内容都留在这台电脑上” · 仍在使用 qwen3.5:4b"
        : "Turned off “Keep everything on this computer” · Still using qwen3.5:4b",
    );
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => localOnly(window)).toBe(true);
    await expect(undo.getByTestId("undo-message")).toHaveText(said);

    await pointAndClick(window, undo.getByTestId("undo-change-local-mode"));
    await expectPrivacySwitch(window);
    await app.close();
  });

  test(`at a wide window, the setup card's line, Change and Undo stay in view (${name}, 1600 px)`, async () => {
    const { app, window } = await launchApp(dataDir, { ollama: ollamaUrl });
    await setWindowSize(app, window, 1600, 760);
    if (zh) await language(window, "zh-CN");
    const setup = await openLocalWay(window);

    await pointAndClick(window, setup.getByTestId("ollama-use"));
    await expect.poll(() => localOnly(window)).toBe(true);
    const undo = setup.getByTestId("undo-line-here");
    await expect(undo.getByTestId("undo-message")).toHaveText(
      zh
        ? "使用 qwen3.5:4b · 所有内容都留在这台电脑上"
        : "Using qwen3.5:4b · Everything stays on this computer",
    );
    await expect(undo).toBeInViewport();
    await expect(undo.getByTestId("undo-change-local-mode")).toBeVisible();
    await expect(undo.getByTestId("undo-action")).toBeVisible();
    await app.close();
  });

  test(`with the sidebar hidden, the line is in the setup card, and the keyboard alone reaches Change and the switch (${name})`, async () => {
    const { app, window } = await launchApp(dataDir, { ollama: ollamaUrl });
    await setWindowSize(app, window, 900, 700);
    if (zh) await language(window, "zh-CN");
    const setup = await openLocalWay(window);
    await window.keyboard.press("ControlOrMeta+Backslash");
    await expect(window.getByTestId("sidebar-panel")).toHaveAttribute("data-hidden", "true");

    await setup.getByTestId("ollama-use").focus();
    await window.keyboard.press("Enter");
    await expect.poll(() => localOnly(window)).toBe(true);
    const undo = setup.getByTestId("undo-line-here");
    await expect(undo.getByTestId("undo-message")).toHaveText(
      zh
        ? "使用 qwen3.5:4b · 所有内容都留在这台电脑上"
        : "Using qwen3.5:4b · Everything stays on this computer",
    );
    await expect(undo).toBeInViewport();

    // The keyboard alone reaches Change, and Enter opens the switch with the focus on it.
    const change = undo.getByTestId("undo-change-local-mode");
    for (let tabs = 0; tabs < 6; tabs++) {
      if (await change.evaluate((node) => node === document.activeElement)) break;
      await window.keyboard.press("Shift+Tab");
    }
    await expect(change).toBeFocused();
    await window.keyboard.press("Enter");
    await expectPrivacySwitch(window);

    // Esc back to the card, then Undo: the note shows there once, and the pill doesn't say it again.
    await window.keyboard.press("Escape");
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => localOnly(window)).toBe(false);
    await expect(undo.getByTestId("undo-note")).toHaveText(
      zh
        ? "已关闭“所有内容都留在这台电脑上” · 仍在使用 qwen3.5:4b"
        : "Turned off “Keep everything on this computer” · Still using qwen3.5:4b",
    );
    await expect(window.getByTestId("undo-note")).toHaveCount(1);
    await app.close();
  });
}

test("the line's row is kept in the card whether or not it shows, so the buttons under it don't move when it arrives", async () => {
  const { app, window } = await launchApp(dataDir, { ollama: "http://127.0.0.1:9" });
  await setWindowSize(app, window, 900, 760);
  const setup = await openLocalWay(window);
  const row = setup.getByTestId("setup-local-keeps");
  await expect(row).toHaveText("");
  const box = await row.boundingBox();
  if (!box) throw new Error("The line's row isn't laid out.");
  expect(box.height).toBeGreaterThanOrEqual(18);
  await app.close();
});
