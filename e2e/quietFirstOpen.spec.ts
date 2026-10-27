import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  launchApp,
  leaveFirstOpen,
  makeTagOnDocument,
  newMind,
  removeDataFolder,
  savedPath,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
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

test("a first open shows only the example page: no tab strip, no assistant, a slim sidebar (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  const sidebar = window.getByTestId("sidebar");
  await expect(window.getByTestId("mind-pane")).toBeVisible();

  await expect(window.getByTestId("tab-list")).toHaveCount(0);
  await expect(window.getByTestId("assistant")).toBeHidden();
  await expect(window.getByTestId("ask-pill")).toBeVisible();
  await expect(window.getByTestId("ask-pill")).toContainText("Ask anything");

  await expect(sidebar.getByTestId("open-library")).toHaveCount(0);
  await expect(sidebar.getByTestId("folders-section")).toHaveCount(0);
  await expect(sidebar.getByTestId("sidebar-tags")).toHaveCount(0);
  await expect(sidebar.getByTestId("document-list-item")).toHaveCount(0);
  await expect(sidebar.getByTestId("not-in-a-folder-title")).toHaveText("Examples");
  await expect(sidebar.getByTestId("mind-list-item")).toHaveCount(1);
  await expect(sidebar.getByTestId("sidebar-status")).toHaveCount(0);
  await expect(window.getByTestId("mind-count-button")).toHaveCount(0);

  await useLocalChatModel(window);
  await window.getByTestId("ask-pill").click();
  await expect(window.getByTestId("assistant")).toBeVisible();
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await expect(window.getByTestId("ask-pill")).toHaveCount(0);
  await app.close();
});

test("the quiet first open keeps the example's marks to its margin, but a check the User asks for shows the badge and its card (#909)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);
  await expect(window.getByTestId("claim-mark")).toHaveCount(1, { timeout: 30_000 });
  await expect(window.getByTestId("check-badge")).toHaveCount(0);

  // No model yet: Check this note can't run, and says so where the User asked.
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Check this note");
  await window.getByTestId("palette-item").filter({ hasText: "Check this note" }).first().click();
  await expect(window.getByTestId("check-badge")).toBeVisible();
  await expect(window.getByTestId("check-card")).toBeVisible();
  await app.close();
});

test("the tab strip comes with the second tab, and the Library with the first own Document (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await expect(window.getByTestId("tab-list")).toHaveCount(0);
  await newMind(window);
  await expect(window.getByTestId("tab-list")).toBeVisible();
  await expect(window.getByTestId("tab-title")).toHaveCount(2);

  const sidebar = window.getByTestId("sidebar");
  await expect(sidebar.getByTestId("open-library")).toHaveCount(0);
  await writeFile(join(sources, "Harbour notes.md"), "# Harbour notes\n\nTide tables.\n");
  await window
    .getByTestId("add-documents-input")
    .setInputFiles([join(sources, "Harbour notes.md")]);
  // On day one the Library row waits: it is one flat list called Documents (#1942).
  await expect(sidebar.getByTestId("not-in-a-folder-title")).toContainText("Documents");
  await expect(sidebar.getByTestId("open-library")).toHaveCount(0);
  // It comes once the first open's steps are put away.
  await leaveFirstOpen(window);
  await expect(sidebar.getByTestId("open-library")).toBeVisible();
  await app.close();
});

test("a file the first open can't take still says so in the footer, though its other news waits (#123)", async () => {
  await writeFile(join(sources, "Picture.png"), "not a document");
  const { app, window } = await launchApp(dataDir, { examples: true });
  const sidebar = window.getByTestId("sidebar");
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  await expect(sidebar.getByTestId("sidebar-status")).toHaveCount(0);
  await window.getByTestId("add-documents-input").setInputFiles([join(sources, "Picture.png")]);
  const skipped = sidebar.getByTestId("skipped-files");
  await expect(skipped).toBeVisible();
  await expect(skipped).toHaveAttribute("title", /Picture\.png/);
  await expect(sidebar.getByTestId("tagging-waiting")).toHaveCount(0);
  await app.close();
});

const taggingOf = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).map((each) => ({
      name: each.name,
      tagging: each.tagging,
    }));
  });

test("the examples alone keep the footer quiet, but the User's own file waiting for a Tagging model says so, and a saved model clears it (#1128)", async () => {
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  const sidebar = window.getByTestId("sidebar");
  const line = sidebar.getByTestId("tagging-waiting");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();

  // The examples need no model, so their Tags waiting for one is no news.
  await expect
    .poll(async () => {
      const documents = await taggingOf(window);
      return (
        documents.length > 0 && documents.every((each) => each.tagging === "waiting-for-provider")
      );
    })
    .toBe(true);
  await expect(sidebar.getByTestId("sidebar-status")).toHaveCount(0);

  await window.getByTestId("add-documents-input").setInputFiles([notes]);
  // Before a Tag exists, the footer says nothing (#1942); with one, it asks for the model.
  await expect(line).toHaveCount(0);
  await makeTagOnDocument(window, "Harbour notes");
  await expect(line).toBeVisible();
  await expect(line.getByTestId("status-label")).toHaveText("Tags need an AI model");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await expect(window.getByTestId("tab-list")).toHaveCount(0);

  const choose = line.getByTestId("tagging-waiting-setup");
  await expect(choose).toHaveText("Choose…");
  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("status-label")).toHaveText("打标签需要 AI 模型");
  await expect(choose).toHaveText("选择…");
  for (const [width, height] of [
    [900, 700],
    [1440, 900],
  ] as const) {
    await setWindowSize(app, window, width, height);
    const within = await sidebar.boundingBox();
    const button = await choose.boundingBox();
    expect(within && button && button.x + button.width <= within.x + within.width).toBe(true);
  }

  await choose.focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();

  await useLocalChatModel(window);
  await expect(line).toHaveCount(0);
  await expect
    .poll(
      async () => (await taggingOf(window)).find((each) => each.name === "Harbour notes")?.tagging,
    )
    .toBe("tagged");
  await app.close();
});

test("Tagging stopped for the User's own files shows in the footer on the first open, with Resume (#1129)", async () => {
  const notes = join(sources, "Harbour notes.md");
  await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setTaggingWithAi(null, false);
  });
  const sidebar = window.getByTestId("sidebar");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await window.getByTestId("add-documents-input").setInputFiles([notes]);
  // A Tag of the User's own: only then is Tags named (#1942).
  await makeTagOnDocument(window, "Harbour notes");
  const row = sidebar.getByTestId("tagging-stopped");
  await expect(row).toContainText("Tagging stopped");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await row.getByTestId("tagging-resume").focus();
  await window.keyboard.press("Enter");
  await expect(row).toHaveCount(0);
  await expect
    .poll(
      async () => (await taggingOf(window)).find((each) => each.name === "Harbour notes")?.tagging,
    )
    .toBe("tagged");
  await app.close();
});

test("Tagging paused by a rate limit shows in the footer on the first open, with Retry", async () => {
  const limited = join(sources, "Harbour notes.md");
  await writeFile(limited, "# Harbour notes\n\nThe invoice server was rate-limited.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" });
    await bridge.saveLibrarySettings({ ...(await bridge.getLibrary()).settings, automatic: true });
  });
  const sidebar = window.getByTestId("sidebar");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await window.getByTestId("add-documents-input").setInputFiles([limited]);
  await makeTagOnDocument(window, "Harbour notes");
  const row = sidebar.getByTestId("tagging-rate-limited");
  await expect(row.getByTestId("status-label")).toContainText("Rate limit reached");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await row.getByTestId("tagging-rate-limited-retry").focus();
  await window.keyboard.press("Enter");
  await expect(row).toHaveCount(0);
  await app.close();
});

test("a Mind of one's own made on the first open isn't listed under Examples (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  const section = window.getByTestId("sidebar").getByTestId("not-in-a-folder-title");
  await expect(section).toHaveText("Examples");
  await newMind(window);
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  // One flat list of the User's own things on day one, called Documents (#1942).
  await expect(section).toHaveText("Documents");
  await app.close();
});

test("the assistant comes with the first Question, and stays after a restart (#123)", async () => {
  const first = await launchApp(dataDir, { examples: true, fakeChat: true });
  await useLocalChatModel(first.window);
  await first.window.keyboard.press("ControlOrMeta+j");
  await expect(first.window.getByTestId("assistant")).toBeVisible();
  await first.window.keyboard.type("Is Northwind inside its leverage covenant?");
  await first.window.keyboard.press("Enter");
  await expect(assistantAnswers(first.window).last()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true, fakeChat: true });
  await expect(again.window.getByTestId("assistant")).toBeVisible();
  await expect(again.window.getByTestId("ask-pill")).toHaveCount(0);
  await again.app.close();
});

test("the quiet first open holds at 1,100 px in Chinese (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1100, 720);
  await setLanguage(window, "zh-CN");
  const pill = window.getByTestId("ask-pill");
  await expect(pill).toContainText("提问");
  const box = await pill.boundingBox();
  const card = await window.getByTestId("card").boundingBox();
  expect(box && card && box.x >= card.x && box.x + box.width <= card.x + card.width).toBe(true);
  await expect(window.getByTestId("sidebar").getByTestId("not-in-a-folder-title")).toHaveText(
    "示例",
  );
  await app.close();
});

test("File > Export names the Mind in front and exports it while the tab strip is hidden (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await expect(window.getByTestId("tab-list")).toHaveCount(0);
  await useOutputLocation(window, sources);
  const item = () =>
    app.evaluate(({ Menu }) => {
      const found = Menu.getApplicationMenu()
        ?.items.flatMap((menu) => menu.submenu?.items ?? [])
        .find((each) => each.id === "mind.export");
      return found ? { label: found.label, enabled: found.enabled } : null;
    });
  await expect
    .poll(item)
    .toEqual({ label: "Export “Draft: credit committee paper”…", enabled: true });

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.id === "mind.export")
      ?.click();
  });
  await savedPath(window, "Draft credit committee paper.docx");
  await app.close();
});

test("File > Export is disabled with no Mind open (#123)", async () => {
  const { app, window } = await launchApp(dataDir);
  await expect(window.getByTestId("mind-none-open")).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(({ Menu }) => {
        const found = Menu.getApplicationMenu()
          ?.items.flatMap((menu) => menu.submenu?.items ?? [])
          .find((each) => each.id === "mind.export");
        return found ? { label: found.label, enabled: found.enabled } : null;
      }),
    )
    .toEqual({ label: "Export…", enabled: false });
  await app.close();
});
