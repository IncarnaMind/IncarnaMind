import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge, SaveChatProviderInput } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  launchApp,
  makeTagOnDocument,
  removeDataFolder,
  setLanguage,
  setWindowSize,
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

const useKey = (window: Page, apiKey: string) => {
  const input: SaveChatProviderInput = { kind: "openai", apiKey, modelId: "gpt-6-luna" };
  return window.evaluate(async (provider) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider(provider);
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      automatic: true,
      turnOn: true,
    });
  }, input);
};

async function addNote(window: Page, name: string, text: string): Promise<void> {
  const path = join(sources, `${name}.txt`);
  await writeFile(path, text);
  await window.getByTestId("add-documents-input").setInputFiles([path]);
}

const taggingOf = (window: Page, name: string) =>
  window.evaluate(async (name) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDocuments()).find((each) => each.name === name)?.tagging;
  }, name);

test("a hidden sidebar's toggle shows a dot while Tagging needs the User, never for progress, and drops it once it is fixed (#1130)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await useKey(window, "sk-good");
  const toggle = window.getByTestId("sidebar-toggle");
  await expect(toggle).toHaveAccessibleName("Hide sidebar");

  await toggle.focus();
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Show sidebar");
  await expect(window.getByTestId("sidebar-toggle-dot")).toHaveCount(0);

  // Progress is no news: a Document taking a moment to tag shows no dot.
  await addNote(window, "Harbour notes", "Harbour notes. The tide tables are read slowly.");
  await expect.poll(() => taggingOf(window, "Harbour notes")).toMatch(/^(pending|tagging)$/);
  await expect(toggle).not.toHaveAttribute("data-needs-you");
  await expect.poll(() => taggingOf(window, "Harbour notes"), { timeout: 20_000 }).toBe("tagged");
  await expect(toggle).not.toHaveAttribute("data-needs-you");

  // A key the provider refuses: the Document waits for a key that works, and the dot says so.
  await useKey(window, "sk-refused");
  await addNote(window, "Invoice 60", "Invoice 60. Amount due: 120 EUR.");
  await expect.poll(() => taggingOf(window, "Invoice 60")).toBe("waiting-for-provider");
  await expect(toggle).toHaveAttribute("data-needs-you", "true");
  await expect(window.getByTestId("sidebar-toggle-dot")).toBeVisible();
  await expect(toggle).toHaveAccessibleName("Show sidebar · Tagging needs you");
  await expect(toggle).toHaveAttribute("title", /^Show sidebar · Tagging needs you \(/);
  await setLanguage(window, "zh-CN");
  await expect(toggle).toHaveAccessibleName("显示侧边栏 · 打标签需要你处理");
  await expect(toggle).toHaveAttribute("title", /^显示侧边栏 · 打标签需要你处理 \(/);
  await setLanguage(window, "en");
  for (const [width, height] of [
    [900, 700],
    [1440, 900],
  ] as const) {
    await setWindowSize(app, window, width, height);
    const [button, dot] = await Promise.all([
      toggle.boundingBox(),
      window.getByTestId("sidebar-toggle-dot").boundingBox(),
    ]);
    expect(button && dot).toBeTruthy();
    if (!button || !dot) continue;
    expect(dot.x).toBeGreaterThanOrEqual(button.x);
    expect(dot.y).toBeGreaterThanOrEqual(button.y);
    expect(dot.x + dot.width).toBeLessThanOrEqual(button.x + button.width);
    expect(dot.y + dot.height).toBeLessThanOrEqual(button.y + button.height);
  }

  // Opening the sidebar shows the line as before; fixing the key takes the dot away.
  await toggle.focus();
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(window.getByTestId("tagging-key-refused")).toBeVisible();
  await expect(window.getByTestId("sidebar-toggle-dot")).toHaveCount(0);
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("data-needs-you", "true");
  await useKey(window, "sk-good");
  await expect.poll(() => taggingOf(window, "Invoice 60"), { timeout: 20_000 }).toBe("tagged");
  await expect(toggle).not.toHaveAttribute("data-needs-you");
  await expect(toggle).toHaveAccessibleName("Show sidebar");

  // A model that can't be reached: Retry, in the footer, succeeding removes the dot too.
  await addNote(window, "Invoice 61", "Invoice 61. The invoice server was unreachable.");
  await expect.poll(() => taggingOf(window, "Invoice 61")).toBe("failed");
  await expect(toggle).toHaveAttribute("data-needs-you", "true");
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await window.getByTestId("tagging-failed-retry").click();
  await expect.poll(() => taggingOf(window, "Invoice 61")).toBe("tagged");
  await toggle.focus();
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).not.toHaveAttribute("data-needs-you");
  await app.close();
});

test("a hidden sidebar's dot holds at 900 px in Chinese when Tagging waits for a model", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 900, 700);
  await setLanguage(window, "zh-CN");
  const toggle = window.getByTestId("sidebar-toggle");
  await addNote(window, "Harbour notes", "Harbour notes. The tide tables.");
  await expect.poll(() => taggingOf(window, "Harbour notes")).toBe("waiting-for-provider");
  // A Tag of the User's own: only then is Tags named, and its model asked for (#1942).
  await makeTagOnDocument(window, "Harbour notes");
  await expect(toggle).not.toHaveAttribute("data-needs-you");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await toggle.focus();
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("data-needs-you", "true");
  await expect(toggle).toHaveAccessibleName("显示侧边栏 · 打标签需要你处理");
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(window.getByTestId("tagging-waiting").getByTestId("status-label")).toHaveText(
    "打标签需要 AI 模型",
  );
  await app.close();
});
