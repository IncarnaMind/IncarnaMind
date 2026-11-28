import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  frontMindName,
  interceptOpenExternal,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  nameMind,
  newMind,
  openDocumentMenu,
  openSettings,
  removeDataFolder,
  setWindowSize,
  showSourceLocations,
  urlsOpened,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a Mind created before quitting is still there after reopening the app", async () => {
  // First run: create a Mind. It appears in the sidebar and opens in the centre.
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await newMind(first.window);

  const created = first.window.getByTestId("mind-list-item");
  await expect(created).toHaveCount(1);
  const mindId = await created.getAttribute("data-mind-id");
  expect(mindId).toBeTruthy();
  await expect(first.window.getByTestId("mind-pane")).toHaveAttribute("data-mind-id", `${mindId}`);
  await expect(first.window.getByTestId("mind-editor")).toBeVisible();
  await first.app.close();

  // Second run on the same data folder: the Mind is listed and opens.
  const second = await launchApp(dataDir);
  const restored = second.window.getByTestId("mind-list-item");
  await expect(restored).toHaveCount(1);
  await expect(restored).toHaveAttribute("data-mind-id", `${mindId}`);
  await restored.click();
  await expect(second.window.getByTestId("mind-pane")).toHaveAttribute("data-mind-id", `${mindId}`);
  await expect(second.window.getByTestId("mind-editor")).toBeVisible();
  await second.app.close();
});

test("what was typed in a Mind, and its title, are still there after reopening the app", async () => {
  const paragraphs = ["Typed before quitting.", "A second paragraph."];

  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await newMind(first.window);
  await nameMind(first.window, "Field notes");
  const editor = first.window.getByTestId("mind-editor");
  await editor.click();
  await first.window.keyboard.type(paragraphs[0] ?? "");
  await first.window.keyboard.press("Enter");
  await first.window.keyboard.type(paragraphs[1] ?? "");
  await expect(editor.locator("p")).toHaveText(paragraphs);
  await expect(first.window.getByTestId("mind-list-item")).toHaveText("Field notes");
  await first.app.close();

  const second = await launchApp(dataDir);
  const item = second.window.getByTestId("mind-list-item");
  await expect(item).toHaveText("Field notes");
  await item.click();
  await expect(frontMindName(second.window)).toHaveText("Field notes");
  await expect(second.window.getByTestId("mind-editor").locator("p")).toHaveText(paragraphs);
  await second.app.close();
});

test("the sidebar lists the most recently edited Mind first, and a deleted Mind leaves it", async () => {
  const first = await launchApp(dataDir);
  const { window } = first;
  await dismissChatSetup(window);
  const items = window.getByTestId("mind-list-item");
  for (const title of ["Older", "Newer"]) {
    await newMind(window);
    await nameMind(window, title);
    await expect(items.first()).toHaveText(title);
  }
  await expect(items).toHaveText(["Newer", "Older"]);

  // Editing the older Mind moves it to the top.
  await items.filter({ hasText: "Older" }).click();
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("An edit");
  await expect(items).toHaveText(["Older", "Newer"]);

  // Deleting it asks nothing and removes it from the sidebar and closes its tab: the
  // other open Mind shows instead.
  const olderId = await items.filter({ hasText: "Older" }).getAttribute("data-mind-id");
  const older = window.getByTestId("mind-row").filter({ hasText: "Older" });
  await older.hover();
  await older.getByTestId("mind-menu").click();
  await older.getByTestId("mind.delete").click();
  await expect(items).toHaveText(["Newer"]);
  await expect(window.getByTestId("mind-tab").getByTestId("tab-title")).toHaveText(["Newer"]);
  await expect(window.getByTestId("mind-pane")).not.toHaveAttribute("data-mind-id", `${olderId}`);
  await first.app.close();

  // It stays deleted after a restart.
  const second = await launchApp(dataDir);
  await expect(second.window.getByTestId("mind-list-item")).toHaveText(["Newer"]);
  await second.app.close();
});

test("added files are processed, show as ready in the sidebar, and can be deleted", async () => {
  // The User's own files live outside the data folder.
  const sources = await createDataFolder();
  try {
    const notes = join(sources, "Reading notes.txt");
    const report = join(sources, "Report.pdf");
    await writeFile(notes, "Attention lets a model focus on the most relevant words.\n");
    await writeFile(
      report,
      buildPdf([{ lines: ["Quarterly report"] }, { lines: ["Revenue grew by ten percent."] }]),
    );

    const first = await launchApp(dataDir);
    const { window } = first;
    await dismissChatSetup(window);
    await window.getByTestId("add-documents-input").setInputFiles([notes, report]);

    const items = window.getByTestId("document-list-item");
    await expect(items).toHaveCount(2);
    const notesItem = items.filter({ hasText: "Reading notes" });
    const reportItem = items.filter({ hasText: "Report" });
    await expect(notesItem).toHaveAttribute("data-status", "ready");
    await expect(reportItem).toHaveAttribute("data-status", "ready");
    // A ready Document says nothing of its state (#2870).
    await expect(notesItem.getByTestId("document-status")).toHaveCount(0);
    await first.app.close();

    // After a restart both are still there. Deleting one (from its menu) asks nothing and removes it.
    const second = await launchApp(dataDir);
    const restored = second.window.getByTestId("document-list-item");
    await expect(restored).toHaveCount(2);
    const doomed = restored.filter({ hasText: "Reading notes" });
    await openDocumentMenu(doomed);
    await doomed.getByTestId("document.delete").click();
    await expect(restored).toHaveCount(1);
    await expect(restored).toHaveAttribute("data-status", "ready");
    await second.app.close();
  } finally {
    await removeDataFolder(sources);
  }
});

test("a saved ChatGPT plan's Continue with ChatGPT opens OpenAI's sign-in for IncarnaMind's own registration, and can be cancelled", async () => {
  const { app, window } = await launchApp(dataDir);
  await interceptOpenExternal(app);

  // A plan is no longer added in IncarnaMind (#3767): this one was saved before, and its own page
  // in Accounts and keys signs in again. Nothing is signed in here: the browser is stood in for.
  const providerId = await window.evaluate(
    async () =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
          kind: "chatgpt",
          modelId: "gpt-5.5",
        })
      ).id,
  );
  const settings = await openSettings(window, "ai");
  await settings.locator(`[data-testid="provider-row"][data-provider-id="${providerId}"]`).click();
  const section = settings.getByTestId("chatgpt-settings");
  await expect(section.getByTestId("chatgpt-continue")).toBeVisible();
  // Where the sign-in couldn't be kept safely (Linux without a keyring), that's said up front and
  // Continue waits, so OpenAI's page never opens for a sign-in that would have nowhere to go.
  const storage = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSecretStorage(),
  );
  if (!storage.canSave) {
    await expect(section.getByTestId("plain-text-secrets")).toBeVisible();
    await expect(section.getByTestId("chatgpt-continue")).toBeDisabled();
  }
  await acceptPlainTextKeys(window, section);
  await expect(section.getByTestId("chatgpt-continue")).toBeEnabled();
  await section.getByTestId("chatgpt-continue").click();
  await expect(section.getByTestId("chatgpt-cancel")).toBeVisible();
  await expect.poll(() => urlsOpened(app)).toHaveLength(1);
  const [opened] = await urlsOpened(app);
  const authorize = new URL(opened ?? "");
  expect(`${authorize.origin}${authorize.pathname}`).toBe(
    "https://auth.openai.com/api/accounts/authorize",
  );
  expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorize.searchParams.get("agent_name_hint")).toBe("IncarnaMind");
  expect(authorize.searchParams.get("redirect_uri")).toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
  );

  // Cancelling is the User's own doing: the button comes back, with nothing to explain.
  await section.getByTestId("chatgpt-cancel").click();
  await expect(section.getByTestId("chatgpt-continue")).toBeVisible();
  await expect(section.getByTestId("chatgpt-error")).toHaveCount(0);
  await app.close();
});

test("first run asks for no model; with no AI, a Note has no assistant and its foot says asking needs your AI, whose Connect opens Settings › AI with no way to add a model", async () => {
  const first = await launchApp(dataDir);
  const { window } = first;
  await expect(window.getByTestId("chat-setup")).toHaveCount(0);
  await newMind(window);
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("What is in my Documents?");

  // No old assistant and no model setup (#3767): one line where the Note's input would stand.
  const line = window.getByTestId("note-ask-no-ai");
  await expect(line).toHaveText("Asking needs your AI · Connect your AI");
  await expect(window.getByTestId("assistant")).toBeHidden();
  await expect(window.getByTestId("chat-readiness")).toHaveCount(0);
  await expect(window.getByTestId("model-setup")).toHaveCount(0);

  // ⌘J goes to the one thing that fixes it, and the words typed stay in the Note.
  await window.keyboard.press("ControlOrMeta+j");
  const connect = line.getByTestId("note-ask-connect");
  await expect(connect).toBeFocused();
  await expect(window.getByTestId("composer-input")).toBeHidden();
  await expect(window.getByTestId("mind-editor")).toContainText("What is in my Documents?");

  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(line).toHaveText("提问需要你的 AI · 连接你的 AI");
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "en" },
    }),
  );

  await connect.press("Enter");
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "ai");
  // A model is no longer set up in IncarnaMind: with none, nothing offers to add one.
  await expect(settings.getByTestId("ai-use-model-open")).toHaveCount(0);
  await expect(settings.getByTestId("models-add-provider")).toHaveCount(0);
  await first.app.close();
});

test("first run fits a small window; a long first line wraps, and the line where asking would stand fits the Note", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1000, 600);

  await newMind(window);
  await enterContent(window);
  // Long enough to wrap in the Note's measure, which has the window's width with no assistant (#3767).
  const long =
    "Reading notes on spring and neap tides, harbour tables, the pull of the Moon and what the ferry timetable makes of them";
  await window.keyboard.type(long);
  // Long, the first line wraps instead of being cut off.
  const line = window.getByTestId("mind-editor").locator("p").first();
  await expect(line).toHaveText(long);
  const lineBox = await line.boundingBox();
  if (!lineBox) throw new Error("The line isn't visible.");
  const lineHeight = await line.evaluate((p) => Number.parseFloat(getComputedStyle(p).lineHeight));
  expect(lineBox.height).toBeGreaterThan(lineHeight * 1.5);

  // With no AI (#3767), the line at the Note's foot stays within the Note's measure, uncut.
  const foot = window.getByTestId("note-foot-ask");
  const noAi = foot.getByTestId("note-ask-no-ai");
  await expect(noAi).toBeVisible();
  const [footBox, noAiBox] = await Promise.all([foot.boundingBox(), noAi.boundingBox()]);
  if (!footBox || !noAiBox) throw new Error("The line at the Note's foot isn't visible.");
  expect(noAiBox.x).toBeGreaterThanOrEqual(footBox.x - 0.5);
  expect(noAiBox.x + noAiBox.width).toBeLessThanOrEqual(footBox.x + footBox.width + 0.5);
  expect(await foot.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await app.close();
});

test("the window opens at the size and place it was left at", async () => {
  const first = await launchApp(dataDir, { keepWindow: true });
  // Not the default centred 1280 × 800, and wholly on the screen, however small it is.
  const left = await first.app.evaluate(({ BrowserWindow, screen }) => {
    const { workArea } = screen.getPrimaryDisplay();
    const bounds = {
      x: workArea.x + 40,
      y: workArea.y + 30,
      width: Math.min(1100, workArea.width - 80),
      height: Math.min(760, workArea.height - 60),
    };
    BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
    return bounds;
  });
  await first.app.close();

  const second = await launchApp(dataDir, { keepWindow: true });
  const bounds = await second.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getBounds(),
  );
  expect(bounds).toEqual(left);
  await second.app.close();
});

test("a Linked folder is a Folder in the one list of Folders: its files, from every depth, are in it, apart from those added on their own (#3613)", async () => {
  const sources = await createDataFolder();
  try {
    const library = join(await realpath(sources), "Library");
    await mkdir(join(library, "Projects", "2026"), { recursive: true });
    await writeFile(join(library, "Paper.txt"), "A paper about attention.\n");
    await writeFile(join(library, "Projects", "2026", "Plan.txt"), "The plan for the year.\n");
    const loose = join(sources, "Loose notes.txt");
    await writeFile(loose, "Notes kept for later.\n");

    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    const notInAFolder = window.getByTestId("not-in-a-folder").getByTestId("document-list-item");

    // A file added on its own, with no Linked folder yet: its row in the Documents, and no Folder.
    await addDocuments(window, [loose]);
    const looseItem = notInAFolder.filter({ hasText: "Loose notes" });
    await expect(looseItem).toHaveAttribute("data-depth", "0");
    await expect(window.getByTestId("folders-section")).toHaveCount(0);

    // "Link a folder…" links a folder once the User confirms in the link dialog. Its Folder comes,
    // with the mark, open with its files, flat, from its top and from its folders.
    await linkFolderFromSidebar(app, window, library);
    await showSourceLocations(window);
    const root = linkedFolderRow(window, "Library");
    await expect(root.getByTestId("folder-bound")).toBeVisible();
    const folder = window.getByTestId("library-folder").filter({ has: root });
    await expect(
      folder.getByTestId("document-list-item").filter({ hasText: "Paper" }),
    ).toHaveAttribute("data-depth", "1");
    await expect(
      folder.getByTestId("document-list-item").filter({ hasText: "Plan" }),
    ).toHaveAttribute("data-depth", "1");
    // The file added on its own stays in Not in a Folder.
    await expect(looseItem).toBeVisible();
    await expect(notInAFolder).toHaveCount(1);
    await app.close();
  } finally {
    await removeDataFolder(sources);
  }
});
