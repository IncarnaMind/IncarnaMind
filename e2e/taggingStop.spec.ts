/**
 * Tagging says where it goes, and can be stopped per Folder: once a key
 * is saved, the sidebar's status names the company the Documents go to, with
 * Stop. Stop keeps that Folder's new Documents from being sent, across a
 * restart, until "Tag with AI" in the Folder's ⋯ menu turns it back on. The
 * status stays on one line, with what is sent in its popover, so the tree
 * above it never moves (#1021). Set INCARNAMIND_SCREENSHOTS to a folder to
 * keep screenshots of each step.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { channelFor } from "../src/shared/bridge";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addProviderForm,
  closeSettings,
  createDataFolder,
  launchApp,
  makeTagOnDocument,
  motionSettled,
  openDocumentTags,
  openSettings,
  removeDataFolder,
  runFromPalette,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const FOLDER = "Corran Homes v. Brazos Steel";

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

async function slowFile(name: string): Promise<string> {
  const path = join(sources, `${name}.md`);
  await writeFile(path, `${name}. Read slowly: the facts of the case.\n`);
  return path;
}

async function createFolder(window: Page, name: string): Promise<string> {
  return window.evaluate(async (name) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.createLibraryGroup({ name, description: "The lawsuit's papers" })).id;
  }, name);
}

async function addToFolder(window: Page, paths: string[], groupId: string): Promise<void> {
  await window.evaluate(
    async ([paths, groupId]) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.addDocuments(paths, { groupId });
    },
    [paths, groupId] as const,
  );
}

async function openFolder(window: Page, name: string): Promise<void> {
  const row = sidebarFolder(window, name).getByTestId("folder-row");
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

const documentItem = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });

async function pasteKey(window: Page): Promise<void> {
  const settings = await openSettings(window, "models");
  const form = await addProviderForm(settings, "anthropic");
  await acceptPlainTextKeys(window, form);
  await form.getByLabel(/^API key/).fill("sk-ant-not-a-real-key");
  await form.getByTestId("provider-use-key").click();
  await closeSettings(window);
  // A cloud model starts with tagging off: the User turns it on.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: true });
  });
}

test("the status names where Tagging goes; Stop keeps the Folder's new Documents from going, until Tag with AI", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  const folderId = await createFolder(window, FOLDER);
  await addToFolder(window, [await slowFile("Opening note")], folderId);
  await openFolder(window, FOLDER);
  const footer = window.getByTestId("sidebar-status");
  // A Tag of the User's own: only now is Tags named (#1942).
  await makeTagOnDocument(window, "Opening note");
  await expect(footer.getByTestId("tagging-waiting")).toContainText("Tags need an AI model");

  // Documents added before the key and the switch aren't tagged by it: only those added since.
  await pasteKey(window);
  await addToFolder(
    window,
    await Promise.all(
      [
        "Supply contract",
        "Purchase order PO-2291",
        "Delivery log, March 2025",
        "Draft brief: motion for summary judgment",
      ].map(slowFile),
    ),
    folderId,
  );
  const status = footer.getByTestId("tagging-status");
  await expect(status.getByTestId("status-label")).toHaveText(
    /^Tagging [2-4] Documents with Anthropic…$/,
  );
  await expect(footer.getByTestId("tagging-waiting")).toHaveCount(0);
  const stop = status.getByTestId("tagging-stop");
  await expect(stop).toHaveText("Stop");
  await expect(stop).toHaveAttribute(
    "title",
    `Stop, and don’t tag new Documents in “${FOLDER}” with AI until you turn it back on`,
  );
  await screenshot(window, "tagging-status-stop-en");

  await stop.click();
  await expect(window.getByTestId("undo-message")).toHaveText(`Stopped Tagging in “${FOLDER}”`);
  await expect(status).toHaveCount(0);
  await expect(documentItem(window, "Delivery log")).toHaveAttribute("data-tagging", "stopped");

  await addToFolder(window, [await slowFile("Expert report")], folderId);
  await expect(documentItem(window, "Expert report")).toHaveAttribute("data-tagging", "stopped");
  await expect(footer.getByTestId("tagging-status")).toHaveCount(0);
  await screenshot(window, "tagging-stopped-undo-en");
  await app.close();

  const again = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const folder = sidebarFolder(again.window, FOLDER);
  await openFolder(again.window, FOLDER);
  await expect(documentItem(again.window, "Expert report")).toHaveAttribute(
    "data-tagging",
    "stopped",
  );
  const settings = await openSettings(again.window, "models");
  await expect(settings.getByTestId("models-advanced")).toHaveAttribute("open", "");
  await expect(settings.getByTestId("tagging-stopped")).toContainText(
    `Tagging with AI is stopped for Documents in “${FOLDER}”.`,
  );
  await expect(settings.getByTestId("tagging-restart")).toHaveText("Tag with AI");
  await settings.getByTestId("tagging-stopped").scrollIntoViewIfNeeded();
  await screenshot(again.window, "tagging-stopped-settings-en");
  await closeSettings(again.window);

  await folder.getByTestId("folder-row").hover();
  await folder.getByTestId("folder-menu").click();
  const tagWithAi = folder.getByTestId("folder.tagWithAi");
  await expect(tagWithAi).toHaveText("Tag with AI");
  await motionSettled(again.window);
  await screenshot(again.window, "tagging-stopped-folder-menu-en");
  await tagWithAi.click();
  await expect(again.window.getByTestId("undo-message")).toHaveText(
    `Tagging Documents in “${FOLDER}” with AI again`,
  );
  await expect(
    again.window
      .getByTestId("sidebar-status")
      .getByTestId("tagging-status")
      .getByTestId("status-label"),
  ).toHaveText(/^Tagging [1-6] Documents? with Anthropic…$/);
  await expect(documentItem(again.window, "Expert report")).not.toHaveAttribute(
    "data-tagging",
    "stopped",
  );
  await again.app.close();
});

test("in Chinese, the status names the company, and Stop names the Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 800);
  await setLanguage(window, "zh-CN");
  const folderId = await createFolder(window, FOLDER);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-not-a-real-key",
      modelId: "claude-sonnet-5-5",
    });
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: true });
  });
  await addToFolder(
    window,
    await Promise.all(
      ["Supply contract", "Purchase order", "Delivery log", "Draft brief"].map(slowFile),
    ),
    folderId,
  );
  await openFolder(window, FOLDER);
  const status = window.getByTestId("sidebar-status").getByTestId("tagging-status");
  await expect(status.getByTestId("status-label")).toHaveText(
    /^正在用 Anthropic 为 [2-4] 个文档打标签…$/,
  );
  const stop = status.getByTestId("tagging-stop");
  await expect(stop).toHaveText("停止");
  await expect(stop).toHaveAttribute(
    "title",
    `停止。重新开启前，不再用 AI 给“${FOLDER}”里的新文档打标签`,
  );
  await screenshot(window, "tagging-status-stop-zh");
  await stop.click();
  await expect(window.getByTestId("undo-message")).toHaveText(`已停止给“${FOLDER}”里的文档打标签`);
  await app.close();
});

async function saveAnthropicKey(window: Page): Promise<string> {
  await acceptPlainTextKeys(window);
  return window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-not-a-real-key",
      modelId: "claude-sonnet-5-5",
    });
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: true });
    return provider.id;
  });
}

const stoppedItems = (window: Page) =>
  window.locator('[data-testid="document-list-item"][data-tagging="stopped"]');

test("⌘K stops Tagging, and turns it back on for Documents not in a Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  await saveAnthropicKey(window);
  await window
    .getByTestId("add-documents-input")
    .setInputFiles(
      await Promise.all(["Field notes", "Site visit", "Interview", "Survey"].map(slowFile)),
    );
  const status = window.getByTestId("sidebar-status").getByTestId("tagging-status");
  await expect(status).toBeVisible();

  await runFromPalette(window, "Stop Tagging");
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Stopped Tagging Documents not in a Folder",
  );
  await expect(status).toHaveCount(0);
  await expect(stoppedItems(window).first()).toBeVisible();

  await runFromPalette(window, "Tag Documents not in a Folder with AI");
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Tagging Documents not in a Folder with AI again",
  );
  await expect(stoppedItems(window)).toHaveCount(0);
  await app.close();
});

test("after Stop, the status row and a new Document's Tag picker say Tagging stopped, and Resume tags it, in English and Chinese (#1129)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  await saveAnthropicKey(window);
  await window
    .getByTestId("add-documents-input")
    .setInputFiles(
      await Promise.all(["Field notes", "Site visit", "Interview", "Survey"].map(slowFile)),
    );
  const footer = window.getByTestId("sidebar-status");
  await expect(footer.getByTestId("tagging-status")).toBeVisible();
  await runFromPalette(window, "Stop Tagging");
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Stopped Tagging Documents not in a Folder",
  );

  await window.getByTestId("add-documents-input").setInputFiles([await slowFile("Expert report")]);
  const report = documentItem(window, "Expert report");
  await expect(report).toHaveAttribute("data-tagging", "stopped");
  const row = footer.getByTestId("tagging-stopped");
  await expect(row.getByTestId("status-label")).toHaveText("Tagging stopped");
  await expect(row.getByTestId("tagging-resume")).toHaveText("Resume");
  await openDocumentTags(report);
  const line = report.getByTestId("document-tagging-why");
  await expect(line).toHaveText("Tagging stopped·Resume");
  await setLanguage(window, "zh-CN");
  await expect(row.getByTestId("status-label")).toHaveText("已停止打标签");
  await expect(row.getByTestId("tagging-resume")).toHaveText("继续");
  await expect(line).toHaveText("已停止打标签·继续");
  await setLanguage(window, "en");
  await window.keyboard.press("Escape");

  // Resume from the row, with the keyboard.
  await row.getByTestId("tagging-resume").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Tagging Documents not in a Folder with AI again",
  );
  await expect(stoppedItems(window)).toHaveCount(0);
  await expect(report).toHaveAttribute("data-tagging", "tagged", { timeout: 20_000 });
  await expect(row).toHaveCount(0);

  // Stopped again, a new Document's own picker resumes it, with Tab and Enter.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.setTaggingWithAi(null, false);
  });
  await window.getByTestId("add-documents-input").setInputFiles([await slowFile("Witness list")]);
  const witness = documentItem(window, "Witness list");
  await expect(witness).toHaveAttribute("data-tagging", "stopped");
  await openDocumentTags(witness);
  await expect(witness.getByTestId("tag-picker-input")).toBeFocused();
  await window.keyboard.press("Tab");
  await expect(witness.getByTestId("document-tagging-resume")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(witness).toHaveAttribute("data-tagging", "tagged", { timeout: 20_000 });
  await app.close();
});

test("while Organize runs, the status names the company too, with Stop", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  const providerId = await saveAnthropicKey(window);
  await createFolder(window, FOLDER);
  await window.evaluate(async (providerId) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId, modelId: "claude-sonnet-5-5" } },
      automatic: true,
    });
    // Page images of a scan go only where the User allows them.
    await core.allowDataFlow("scan-images", "https://api.anthropic.com");
  }, providerId);
  const scan = join(sources, "Scanned receipt.pdf");
  await writeFile(scan, buildPdf([{ image: true }]));
  await window
    .getByTestId("add-documents-input")
    .setInputFiles([
      ...(await Promise.all(["Field notes", "Site visit", "Interview", "Survey"].map(slowFile))),
      scan,
    ]);
  const progress = window.getByTestId("sidebar-status").getByTestId("organization-progress");
  await expect(progress.getByTestId("status-label")).toHaveText(
    /^Organizing [2-5] Documents with Anthropic…$/,
  );
  await progress.getByTestId("status-label").click();
  await expect(window.getByTestId("status-sends")).toHaveText(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to Anthropic. Page images of scans are included.",
  );
  await screenshot(window, "organize-status-stop-en");
  await progress.getByTestId("tagging-stop").click();
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Stopped Tagging Documents not in a Folder",
  );
  await expect(progress).toHaveCount(0);
  await app.close();
});

async function saveLocalTagger(window: Page): Promise<void> {
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: true });
  });
}

const setTagging = (window: Page, folderId: string, on: boolean) =>
  window.evaluate(
    async ([folderId, on]) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTaggingWithAi(folderId, on);
    },
    [folderId, on] as const,
  );

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element has no box.");
  return box;
}

const sameBox = (before: Box, during: Box) => {
  expect(Math.abs(during.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(during.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(during.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(during.height - before.height)).toBeLessThanOrEqual(1);
};

const LINES = {
  en: {
    cloud: /^Tagging \d+ Documents? with Anthropic…$/,
    local: /^Tagging \d+ Documents?…$/,
    cloudSends:
      "The names and descriptions of your Tags, and each Document’s name, outline and short excerpts, go to Anthropic.",
    localSends:
      "The names and descriptions of your Tags, and each Document’s name, outline and short excerpts, stay on this computer.",
  },
  "zh-CN": {
    cloud: /^正在用 Anthropic 为 \d+ 个文档打标签…$/,
    local: /^正在为 \d+ 个文档打标签…$/,
    cloudSends: "标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 Anthropic。",
    localSends: "标签的名称和描述，以及每个文档的名称、目录和简短摘录，都留在这台电脑上。",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const localText of [false, true]) {
    test(`Organize discloses separate text and scan destinations (${language}, ${localText ? "local text" : "cloud text"})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, localText ? 1100 : 1440, 900);
        if (language === "zh-CN") await setLanguage(window, language);
        const folderId = await createFolder(window, FOLDER);
        await window.evaluate(async (localText) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const text = await core.saveChatProvider(
            localText
              ? { kind: "ollama", modelId: "local-text" }
              : { kind: "openai", apiKey: "sk-test", modelId: "o3-mini" },
          );
          const images = await core.saveChatProvider({
            kind: "anthropic",
            apiKey: "sk-test",
            modelId: "claude-haiku-5-5",
          });
          await core.updateSettings({
            user: {
              imageModel: {
                providerId: images.id,
                modelId: "claude-haiku-5-5",
              },
            },
          });
          await core.saveLibrarySettings({
            classifier: {
              kind: "chat",
              choice: {
                providerId: text.id,
                modelId: localText ? "local-text" : "o3-mini",
              },
            },
            automatic: true,
          });
          await core.allowDataFlow("scan-images", "https://api.anthropic.com");
        }, localText);
        const scan = join(sources, "Scanned receipt.pdf");
        await writeFile(scan, buildPdf([{ image: true }]));
        await window
          .getByTestId("add-documents-input")
          .setInputFiles([
            ...(await Promise.all(
              ["Field notes", "Site visit", "Interview", "Survey"].map(slowFile),
            )),
            scan,
          ]);
        const progress = window.getByTestId("sidebar-status").getByTestId("organization-progress");
        const label = progress.getByTestId("status-label");
        const expectedLabel =
          language === "en"
            ? localText
              ? /^Organizing \d+ Documents?…$/
              : /^Organizing \d+ Documents? with OpenAI…$/
            : localText
              ? /^正在整理 \d+ 个文档…$/
              : /^正在用 OpenAI 整理 \d+ 个文档…$/;
        await expect(label).toHaveText(expectedLabel);
        await expect(label).toHaveAttribute("type", "button");
        await label.click();
        const textClause =
          language === "en"
            ? localText
              ? "For text Documents, the names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, stay on this computer."
              : "For text Documents, the names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to OpenAI."
            : localText
              ? "对于有文本的文档，文件夹和标签的名称和描述，以及文档的名称、目录和简短摘录，都留在这台电脑上。"
              : "对于有文本的文档，文件夹和标签的名称和描述，以及文档的名称、目录和简短摘录，都会发送到 OpenAI。";
        const imageClause =
          language === "en"
            ? "For scans, page images, the Document’s name and type, and the names and descriptions of your Folders and Tags go to Anthropic."
            : "扫描件的页面图片、文档名称和类型，以及文件夹和标签的名称和描述，都会发送到 Anthropic。";
        const disclosure = textClause + (language === "en" ? " " : "") + imageClause;
        await expect(window.getByTestId("status-sends")).toHaveText(disclosure);
        await motionSettled(window);
        await screenshot(window, `organize-mixed-${language}-${localText ? "local" : "cloud"}`);
        if (!localText) {
          await holdFlowList(app, true);
          await window.evaluate(
            async ({ folderId, name }) => {
              const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              await core.updateLibraryGroup(folderId, {
                name,
                description: "The lawsuit's documents",
              });
            },
            { folderId, name: FOLDER },
          );
          await expect(window.getByTestId("error-notice-message").first()).toContainText(
            "Flow list unavailable",
          );
          await expect(window.getByTestId("status-sends")).toHaveText(disclosure);
          await expect(label).toBeFocused();
          await releaseFlowList(app);
        }
        await progress.getByTestId("tagging-stop").click();
        await expect(progress).not.toBeVisible();
      } finally {
        await app.close();
      }
    });
  }
}

const FLOW_LIST = channelFor("listRegisteredDataFlows");

/** Holds the flow list's answer, as a core busy enough to be slow would: nothing is said about what is sent until it is let go. */
async function holdFlowList(app: ElectronApplication, fail = false): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, fail }) => {
      // Electron keeps invoked handlers here; it has no public way to hold one for a test.
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers;
      const answer = handlers.get(channel);
      if (!answer) throw new Error(`Electron has no ${channel} handler to hold.`);
      const held = globalThis as unknown as { releaseFlows?: () => void };
      const waiting: (() => void)[] = [];
      handlers.set(channel, (...args) => {
        if (fail) throw new Error("Flow list unavailable");
        return new Promise((resolve) => {
          waiting.push(() => resolve(answer(...args)));
        });
      });
      held.releaseFlows = () => {
        handlers.set(channel, answer);
        for (const resolve of waiting.splice(0)) resolve();
      };
    },
    { channel: FLOW_LIST, fail },
  );
}

async function releaseFlowList(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (globalThis as unknown as { releaseFlows?: () => void }).releaseFlows?.();
  });
}

for (const cloud of [true, false] as const) {
  test(`the line names the service before the flows are read, and says nothing more until they are (${cloud ? "a service" : "this computer"})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1280, 800);
    if (cloud) await saveAnthropicKey(window);
    else await saveLocalTagger(window);
    await holdFlowList(app);
    await window
      .getByTestId("add-documents-input")
      .setInputFiles(
        await Promise.all(
          ["Supply contract", "Purchase order", "Delivery log", "Draft brief"].map(slowFile),
        ),
      );
    const status = window.getByTestId("sidebar-status").getByTestId("tagging-status");
    const label = status.getByTestId("status-label");

    // The flows aren't known: the line names the service, or none on this computer, and opens no popover.
    await expect(label).toHaveText(cloud ? LINES.en.cloud : LINES.en.local);
    await label.hover();
    await expect(window.getByTestId("status-sends")).toHaveCount(0);

    await releaseFlowList(app);
    // Once the flows are read, the label opens what is sent; the pointer has to move onto it then.
    await expect(label).toHaveAttribute("type", "button");
    await window.mouse.move(600, 300);
    await label.hover();
    await expect(window.getByTestId("status-sends")).toHaveText(
      cloud ? LINES.en.cloudSends : LINES.en.localSends,
    );
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const cloud of [true, false] as const) {
    test(`the Tagging status is one line, with what is sent in its popover (${language}, ${cloud ? "a service" : "this computer"})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      const folderId = await createFolder(window, FOLDER);
      // Enough Minds that the tree scrolls, so anything that grows the footer moves it.
      await window.evaluate(
        async ([folderId, count]) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          for (let index = 1; index <= count; index++) {
            await core.createMind({ title: `Matter note ${index}`, folderId });
          }
        },
        [folderId, 30] as const,
      );
      await openFolder(window, FOLDER);
      if (cloud) await saveAnthropicKey(window);
      else await saveLocalTagger(window);
      await setTagging(window, folderId, false);
      await addToFolder(
        window,
        await Promise.all(
          ["Supply contract", "Purchase order", "Delivery log", "Draft brief"].map(slowFile),
        ),
        folderId,
      );
      // A Tag of the User's own: only now is Tags named (#1942).
      await makeTagOnDocument(window, "Supply contract");
      const status = window.getByTestId("sidebar-status");
      await expect(status.getByTestId("tagging-stopped")).toBeVisible({ timeout: 20_000 });

      for (const width of [1440, 1100] as const) {
        await setWindowSize(app, window, width, 900);
        const tree = window.getByTestId("sidebar-tree");
        await tree.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const folderRow = sidebarFolder(window, FOLDER).getByTestId("folder-row");
        const before = {
          tree: await boxOf(tree),
          footer: await boxOf(window.getByTestId("sidebar-footer")),
          folder: await boxOf(folderRow),
        };

        await setTagging(window, folderId, true);
        const tagging = status.getByTestId("tagging-status");
        await expect(tagging).toBeVisible({ timeout: 20_000 });
        const label = tagging.getByTestId("status-label");
        await expect(label).toHaveText(cloud ? LINES[language].cloud : LINES[language].local);
        sameBox(before.tree, await boxOf(tree));
        sameBox(before.footer, await boxOf(window.getByTestId("sidebar-footer")));
        sameBox(before.folder, await boxOf(folderRow));
        await screenshot(
          window,
          cloud ? `after-${language}-${width}` : `after-${language}-${width}-local`,
        );

        // Cut with an ellipsis before Stop, never after it.
        expect(await label.evaluate((element) => getComputedStyle(element).textOverflow)).toBe(
          "ellipsis",
        );
        if (cloud) {
          expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
          );
        }
        const labelBox = await boxOf(label);
        const stop = tagging.getByTestId("tagging-stop");
        const stopBox = await boxOf(stop);
        const rowBox = await boxOf(tagging);
        expect(stopBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width - 1);
        expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
        expect(stopBox.width).toBeGreaterThanOrEqual(28);
        expect(stopBox.height).toBeGreaterThanOrEqual(28);

        const tip = window.getByTestId("status-sends");
        await expect(label).toHaveAttribute("type", "button");
        await label.hover();
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText(
          cloud ? LINES[language].cloudSends : LINES[language].localSends,
        );
        await motionSettled(window);
        await screenshot(
          window,
          cloud ? `after-${language}-${width}-popover` : `after-${language}-${width}-local-popover`,
        );
        await window.mouse.move(600, 300);
        await expect(tip).toBeHidden();
        await label.click();
        await expect(tip).toBeVisible();
        await window.mouse.move(600, 300);
        await expect(tip).toBeVisible();
        await window.keyboard.press("Escape");
        await expect(tip).toBeHidden();

        await stop.click();
        await expect(tagging).toHaveCount(0);
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("undo-message")).toHaveCount(0);
        await setTagging(window, folderId, false);
        await addToFolder(window, [await slowFile(`Expert report ${width}`)], folderId);
        await expect(status.getByTestId("tagging-stopped")).toBeVisible();
      }
      await app.close();
    });
  }
}
