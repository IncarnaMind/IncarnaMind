import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A request to write from a Mind whose scope holds 2 of the User's 7 Documents says so above
 * its reply, with Use all (#1149): that writes the new Mind's text again from all 7 in its
 * place, which ⌘Z there takes back, and the Mind's scope stays. In English with Tab and Enter,
 * in Chinese from ⌘K. A chart asked for is drawn again from the new table (#1091). The model
 * is the smoke tests' fake.
 */

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

const LEASES = [1, 2, 3, 4, 5, 6, 7].map((unit) => `Lease ${unit}`);

const tab = (window: Page, title: string) =>
  window
    .locator('[data-testid="tab-group"][data-focused] [data-testid="mind-tab"]')
    .filter({ hasText: title });

/**
 * Seven leases, the first two in the Folder "Two leases", and the Mind "Lease notes" there.
 * `rent`: each says its unit's monthly rent, a figure to chart.
 */
async function addLeases(
  app: ElectronApplication,
  window: Page,
  language: "en" | "zh-CN",
  { empty = false, rent = false } = {},
) {
  await setLanguage(window, language);
  await setWindowSize(app, window, 1600, 900);
  const paths = await Promise.all(
    LEASES.map(async (name, index) => {
      const path = join(sources, `${name}.md`);
      const unit = index + 1;
      await writeFile(
        path,
        rent
          ? `# ${name}\n\nThe monthly rent for unit ${unit} is €${(1000 + unit * 100).toLocaleString("en")}.\n`
          : `# ${name}\n\nThe lease rent for unit ${unit} is due monthly.\n`,
      );
      return path;
    }),
  );
  await addDocuments(window, paths);
  await newMind(window);
  await nameMind(window, "Lease notes");
  if (!empty) await window.keyboard.type("My notes on the leases.");
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Two leases", description: "" });
    const documents = await core.listDocuments();
    for (const document of documents.filter((each) => /^Lease [12]$/.test(each.name))) {
      await core.assignDocumentGroup(document.id, folder.id);
    }
    const mind = (await core.listMinds()).find((each) => each.title === "Lease notes");
    if (mind) await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });
  });
  await expect(window.getByTestId("composer-scope")).toContainText("Two leases");
}

for (const [language, request, line, useAll] of [
  [
    "en",
    "Write a summary of my leases",
    "From 2 of your 7 Documents (this Mind’s scope) · Use all",
    "keyboard",
  ],
  [
    "zh-CN",
    "根据我的租约写一份总结",
    "来自 2 个文档（此笔记的范围，共 7 个）· 改用全部",
    "palette",
  ],
] as const) {
  test(`“${request}” says it is from 2 of 7, and Use all writes it again from all 7 (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addLeases(app, window, language);

    const answer = await askInAssistant(window, request);

    const from = answer.getByTestId("answer-written-from");
    await expect(from).toHaveText(line);
    const lineBox = await from.boundingBox();
    const replyBox = await answer.getByTestId("assistant-answer-text").boundingBox();
    expect(lineBox && replyBox && lineBox.y < replyBox.y).toBe(true);
    const editor = window.getByTestId("mind-editor");
    await expect(tab(window, "Summary")).toHaveAttribute("aria-selected", "true");
    await expect(editor).toContainText("Written from Lease 1, Lease 2.");
    await expect(editor).not.toContainText(line);

    if (useAll === "keyboard") {
      await answer.getByTestId("assistant-answer-text").click();
      const action = from.getByTestId("answer-written-from-all");
      for (let press = 0; press < 12; press++) {
        if (await action.evaluate((element) => element === document.activeElement)) break;
        await window.keyboard.press("Shift+Tab");
      }
      await expect(action).toBeFocused();
      await window.keyboard.press("Enter");
    } else {
      await answer.getByTestId("assistant-answer-text").click();
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type("改用全部文档重写回答");
      await expect(window.getByTestId("palette-item").first()).toContainText(
        "改用全部文档重写回答",
      );
      await window.keyboard.press("Enter");
    }

    const rewritten = assistantAnswers(window).last();
    await expect(rewritten).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(rewritten.getByTestId("answer-written-from")).toHaveCount(0);
    await expect(editor).toContainText(`Written from ${LEASES.join(", ")}.`);
    await expect(
      window.locator('[data-testid="mind-tab"]').filter({ hasText: "Summary" }),
    ).toHaveCount(1);

    // Applied as one change, which the reply's card and ⌘Z in the Mind take back.
    const undo = rewritten.getByTestId("mind-changes-undo");
    await expect(undo).toBeVisible();
    await expect(undo).not.toHaveAttribute("aria-disabled");
    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).toContainText("Written from Lease 1, Lease 2.");
    await expect(editor).not.toContainText("Lease 7");
    await expect(rewritten.getByTestId("mind-changes-undone")).toBeVisible();

    await tab(window, "Lease notes").click();
    await expect(editor).toContainText("My notes on the leases.");
    await expect(window.getByTestId("composer-scope")).toContainText("Two leases");
  });
}

test("in an empty Mind the request filled, Use all writes it again there, and ⌘Z brings the 2-Document text back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addLeases(app, window, "en", { empty: true });

  const answer = await askInAssistant(window, "Write a summary of my leases");

  const editor = window.getByTestId("mind-editor");
  await expect(tab(window, "Lease notes")).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("Written from Lease 1, Lease 2.");
  await expect(window.locator('[data-testid="mind-tab"]')).toHaveCount(1);
  await answer.getByTestId("answer-written-from-all").click();
  const rewritten = assistantAnswers(window).last();
  await expect(rewritten).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(editor).toContainText(`Written from ${LEASES.join(", ")}.`);
  await expect(window.locator('[data-testid="mind-tab"]')).toHaveCount(1);
  const undo = rewritten.getByTestId("mind-changes-undo");
  await expect(undo).not.toHaveAttribute("aria-disabled");

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");

  await expect(editor).toContainText("Written from Lease 1, Lease 2.");
  await expect(editor).not.toContainText("Lease 7");
});

test("a chart from 2 of the 7 leases, written again with Use all, is drawn from the new table, and ⌘Z brings back the table and chart of 2", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addLeases(app, window, "en", { rent: true });

  const answer = await askInAssistant(window, "Make a bar chart of rent by lease");

  const editor = window.getByTestId("mind-editor");
  const chart = editor.getByTestId("chart");
  const points = chart.getByTestId("chart-point");
  const rows = editor.locator("table").first().locator("tr");
  await expect(points).toHaveCount(2);
  await expect(rows).toHaveCount(3);
  await expect(chart.getByTestId("chart-changed")).toHaveCount(0);
  await answer.getByTestId("answer-written-from-all").click();
  const rewritten = assistantAnswers(window).last();
  await expect(rewritten).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(chart).toHaveCount(1);
  await expect.poll(() => points.count()).toBeGreaterThan(2);
  await expect(rows).toHaveCount((await points.count()) + 1);
  await expect(chart.getByTestId("chart-changed")).toHaveCount(0);

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");

  await expect(chart).toHaveCount(1);
  await expect(points).toHaveCount(2);
  await expect(rows).toHaveCount(3);
  await expect(editor).toContainText("My notes on the leases.");
});
