import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  askInAssistant,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  frontMindName,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * ⌘K: names, the registry's commands, and the words inside Minds and
 * Documents, by keyboard and from the sidebar's Search.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const palette = (window: Page) => window.getByTestId("palette");
const group = (window: Page, id: string) =>
  palette(window).locator(`[data-testid="palette-group"][data-group="${id}"]`);

async function openPalette(window: Page) {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(palette(window)).toBeVisible();
  await expect(window.getByTestId("palette-search")).toBeFocused();
}

/** A new Mind with these lines, named by its first. */
async function writeMind(window: Page, lines: string[]) {
  await newMind(window);
  await enterContent(window);
  for (const [index, line] of lines.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
}

/** Whether the focus is in a Mind's text. */
const focusInNote = (window: Page) =>
  window.evaluate(() => document.activeElement?.closest(".ProseMirror") !== null);

test("a word only inside a Mind is found, and so is a Chinese word, and Enter opens the Mind at it", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);
  await writeMind(window, [
    "Supplier review",
    "The pilot boarded near Rotterdam at dawn.",
    "本季度的财务报表显示利润增长。",
  ]);
  await writeMind(window, ["Stand-up notes", "Leeds account handover."]);

  await openPalette(window);
  await window.keyboard.type("Rotterdam");
  const notes = group(window, "notes");
  await expect(notes.getByTestId("palette-item")).toHaveCount(1);
  await expect(notes).toContainText("Supplier review");
  await expect(notes.locator("b")).toHaveText("Rotterdam");
  // Nothing is named so: names come first, and there are none.
  await expect(group(window, "minds")).toHaveCount(0);

  // Opened from the other Mind: Enter shows this one, its name in the front tab.
  await window.keyboard.press("Enter");
  await expect(palette(window)).toBeHidden();
  await expect(frontMindName(window)).toHaveText("Supplier review");
  await expect.poll(() => focusInNote(window)).toBe(true);
  // The cursor is in the line the words were found in.
  await expect
    .poll(() => window.evaluate(() => document.getSelection()?.anchorNode?.textContent ?? ""))
    .toContain("Rotterdam");

  await openPalette(window);
  await window.keyboard.type("财务");
  await expect(group(window, "notes")).toContainText("Supplier review");
  await expect(group(window, "notes")).not.toContainText("Stand-up notes");
});

test("the words inside a Mind are found as soon as they are typed", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);
  await writeMind(window, ["Harbour log", "Tides in Bergen"]);

  await openPalette(window);
  await window.keyboard.type("Bergen");
  await expect(group(window, "notes")).toContainText("Harbour log");
  await window.keyboard.press("Escape");
  await expect(palette(window)).toBeHidden();
  await expect.poll(() => focusInNote(window)).toBe(true);

  // Typing on where the cursor was, then searching at once.
  await window.keyboard.type(" and the moon over Ålesund");
  await openPalette(window);
  await window.keyboard.type("alesund");
  await expect(group(window, "notes")).toContainText("Harbour log");
  await expect(group(window, "notes").locator("b")).toHaveText("Ålesund");
});

test("a press on the dimmed area closes ⌘K, and one inside it doesn't", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1280, 660);
    await dismissChatSetup(window);
    await writeMind(window, ["Harbour log", "Tides in Bergen"]);

    await openPalette(window);
    // Inside: the press lands in the field and the palette stays.
    await window.getByTestId("palette-search").click();
    await window.keyboard.type("Bergen");
    await expect(palette(window)).toBeVisible();
    await expect(group(window, "notes")).toContainText("Harbour log");

    // Outside: the press lands on the dimmed area, clear of the palette, and closes it.
    const box = await palette(window).boundingBox();
    if (!box) throw new Error("The palette isn't on the page.");
    expect(box.x).toBeGreaterThan(24);
    await window.mouse.click(box.x - 24, box.y + box.height / 2);
    await expect(palette(window)).toBeHidden();
    await expect.poll(() => focusInNote(window)).toBe(true);
  } finally {
    await app.close();
  }
});

test("names, commands and the words in Documents, all by keyboard; Esc closes and gives the focus back", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);
  const sources = join(dataDir, "sources");
  await mkdir(sources);
  const msa = join(sources, "Aldermoor MSA.txt");
  await writeFile(msa, "Either party may end this contract on ninety days' written notice.");
  await addDocuments(window, [msa]);
  await writeMind(window, ["Stand-up notes"]);
  await writeMind(window, ["Contract checklist"]);

  // From the sidebar's Search, by keyboard: the row takes the focus back.
  const search = window.getByTestId("sidebar-search");
  await expect(search).toContainText(/⌘K|Ctrl\+K/);
  await search.focus();
  await window.keyboard.press("Enter");
  await expect(palette(window)).toBeVisible();
  // Nothing typed: the Minds edited last, but not the one in front, then the few actions on top.
  await expect(group(window, "recent")).toContainText("Stand-up notes");
  await expect(group(window, "recent")).not.toContainText("Contract checklist");
  await expect(group(window, "actions")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(palette(window)).toBeHidden();
  await expect(search).toBeFocused();

  // ⌘K again closes it.
  await openPalette(window);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(palette(window)).toBeHidden();

  // ⌘↵ opens a Document in a tab of its own, beside the Mind's in its group.
  await openPalette(window);
  await window.keyboard.type("aldermoor");
  await expect(group(window, "documents")).toContainText("Aldermoor MSA");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(palette(window)).toBeHidden();
  const groups = window.getByTestId("tab-group");
  await expect(groups).toHaveCount(1);
  await expect(groups.first().getByTestId("document-tab")).toHaveAttribute("aria-selected", "true");

  await openPalette(window);
  await window.keyboard.type("contract");
  await expect(group(window, "minds")).toContainText("Contract checklist");
  await expect(group(window, "documentText")).toContainText("Aldermoor MSA");
  await expect(group(window, "documentText").locator("b")).toHaveText("contract");
  // ↓ moves through every group in order, and wraps.
  const items = palette(window).getByTestId("palette-item");
  await expect(items.first()).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("ArrowUp");
  await expect(items.last()).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(palette(window)).toBeHidden();
  await expect(window.getByTestId("viewer-title")).toHaveText("Aldermoor MSA");

  // ">" for actions only, as in VS Code: a command from the registry, Settings at a page.
  await openPalette(window);
  await window.keyboard.type("> settings models");
  await expect(palette(window).getByTestId("palette-group")).toHaveCount(1);
  const action = group(window, "actions").getByTestId("palette-item").first();
  await expect(action).toContainText("Settings: Models");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("settings-page-title")).toHaveText("Models");
});

test("an empty Library offers its actions, and with nothing found it says so, in English and in Chinese, at a narrow and a wide window", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await openPalette(window);
  await expect(group(window, "recent")).toHaveCount(0);
  await expect(group(window, "actions").getByTestId("palette-item").first()).toBeVisible();
  await window.keyboard.type("tides");
  await expect(window.getByTestId("palette-empty")).toHaveText("No matches in names or text");
  await window.keyboard.press("Escape");

  await writeMind(window, ["Tides in Bergen"]);

  for (const width of [900, 1600]) {
    await setWindowSize(app, window, width, 660);
    await openPalette(window);
    await window.keyboard.type("zqxjv");
    await expect(window.getByTestId("palette-empty")).toHaveText("No matches in names or text");
    const box = await palette(window).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    await window.keyboard.press("Escape");
  }

  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await expect(window.getByTestId("sidebar-search")).toContainText("搜索");
  await openPalette(window);
  await window.keyboard.type("zqxjv");
  await expect(window.getByTestId("palette-empty")).toHaveText("名称和内容中都没有匹配项");
});

test("an action run from ⌘K is taken back with Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);
  await writeMind(window, ["Tides in Bergen"]);

  await openPalette(window);
  await window.keyboard.type("citation style");
  const action = group(window, "actions").getByTestId("palette-item").first();
  await expect(action).toContainText("Citation style…");
  await window.keyboard.press("Enter");
  const picker = window.getByTestId("citation-style-picker");
  await expect(picker.getByTestId("citation-style-search")).toBeFocused();
  await window.keyboard.type("ieee");
  await expect(picker.getByTestId("citation-style-option-label").first()).toHaveText("IEEE");
  await window.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(window.getByTestId("undo-message")).toContainText("IEEE");

  await pointAndClick(window, window.getByTestId("undo-action"));
  await openPalette(window);
  await window.keyboard.type("citation style");
  await window.keyboard.press("Enter");
  const current = window.locator('[data-testid="citation-style-option"][data-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current.getByTestId("citation-style-option-label")).not.toHaveText("IEEE");
});

/** Where the caret is: the text of the node it is in, and its offset there. */
const caret = (window: Page) =>
  window.evaluate(() => {
    const selection = document.getSelection();
    return {
      text: selection?.anchorNode?.textContent ?? "",
      offset: selection?.anchorOffset ?? -1,
      collapsed: selection?.isCollapsed ?? false,
    };
  });

test("⌘K in the note: with the caret it opens, and Esc puts the caret back; with text selected it edits the link", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 660);
  await dismissChatSetup(window);
  await writeMind(window, ["Harbour log", "Tides in Bergen at dawn"]);
  for (let step = 0; step < 8; step++) await window.keyboard.press("ArrowLeft");
  // ProseMirror takes in a caret the arrows moved on selectionchange, after the keys.
  await window.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const before = await caret(window);
  expect(before).toMatchObject({ text: "Tides in Bergen at dawn", collapsed: true });

  await window.keyboard.press("ControlOrMeta+k");
  await expect(palette(window)).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(palette(window)).toBeHidden();
  await expect.poll(() => focusInNote(window)).toBe(true);
  expect(await caret(window)).toEqual(before);
  await window.keyboard.type("X");
  const line = window.locator(".ProseMirror p").filter({ hasText: "Tides in" });
  await expect(line).toHaveText("Tides in BergenX at dawn");

  await slideSelect(window, line, "Bergen");
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("link-field")).toBeFocused();
  await expect(palette(window)).toBeHidden();
});

test("finds every kind by name, a Chinese name by its pinyin, a name with a typo, and the words in a conversation", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const sources = join(dataDir, "sources");
  await mkdir(sources);
  const files = [join(sources, "合同.txt"), join(sources, "Rate card.txt")];
  await writeFile(files[0] ?? "", "试用期结束后，合同的通知期为三十天。");
  await writeFile(files[1] ?? "", "Cold-chain rates by carrier.");
  await addDocuments(window, files);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.createLibraryGroup({ name: "财务", description: "" });
    await core.createTag({ name: "Logistics" });
  });
  await writeMind(window, ["Contract checklist"]);
  await askInAssistant(window, "Which carriers end in 2027?");

  const finds = async (query: string, id: string, name: string) => {
    await openPalette(window);
    await window.keyboard.type(query);
    await expect(group(window, id).getByTestId("palette-item").first()).toContainText(name);
    await window.keyboard.press("Escape");
    await expect(palette(window)).toBeHidden();
  };
  await finds("caiwu", "foldersAndTags", "财务");
  await finds("cw", "foldersAndTags", "财务");
  await finds("hetong", "documents", "合同");
  await finds("contarct", "minds", "Contract checklist");
  await finds("logist", "foldersAndTags", "Logistics");
  await finds("rate card", "documents", "Rate card");
  // Words only in the scripted Answer.
  await finds("streams", "conversationText", "Which carriers end in 2027");

  // A conversation found by its name opens in the assistant.
  await pointAndClick(window, window.getByTestId("assistant-new-chat"));
  await openPalette(window);
  await window.keyboard.type("carriers 2027");
  const found = group(window, "conversations").getByTestId("palette-item").first();
  // Named by its first Question, cut as a title.
  await expect(found).toContainText("Which carriers end in 2027");
  await window.keyboard.press("Enter");
  await expect(
    window.getByTestId("assistant").getByTestId("assistant-question").last(),
  ).toContainText("Which carriers end in 2027?");
});

test("runs a command on the Documents selected in the sidebar, taken back with Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);
  const sources = join(dataDir, "sources");
  await mkdir(sources);
  const files = ["Alpha.txt", "Beta.txt", "Gamma.txt"].map((name) => join(sources, name));
  for (const file of files) await writeFile(file, `Notes in ${file}.`);
  await addDocuments(window, files);
  const rows = window.getByTestId("sidebar").getByTestId("document-list-item");
  await expect(rows).toHaveCount(3);
  await pointAndClick(window, rows.nth(0).getByTestId("open-document"));
  await pointAndClick(window, rows.nth(2).getByTestId("open-document"), {
    modifiers: ["ControlOrMeta"],
  });
  await expect(rows.nth(2).getByRole("treeitem")).toHaveAttribute("aria-selected", "true");

  await openPalette(window);
  await window.keyboard.type("delete");
  const action = group(window, "actions").getByTestId("palette-item").first();
  await expect(action).toContainText("Delete 2 Documents");
  await window.keyboard.press("Enter");
  await expect(rows).toHaveCount(1);
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(rows).toHaveCount(3);
});

test("with nothing named so, “Ask …” asks in the assistant; the assistant's commands are in the list", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await writeMind(window, ["Supplier review"]);

  await openPalette(window);
  await window.keyboard.type("dock left");
  await expect(group(window, "actions")).toContainText("Assistant:");
  await window.keyboard.press("Escape");

  await openPalette(window);
  const question = "how long is the warranty on the chillers";
  await window.keyboard.type(question);
  await expect(window.getByTestId("palette-empty")).toHaveText("No matches in names or text");
  const ask = group(window, "ask").getByTestId("palette-item");
  await expect(ask).toContainText(`Ask “${question}”`);
  await expect(ask).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(palette(window)).toBeHidden();
  const assistant = window.getByTestId("assistant");
  await expect(assistant.getByTestId("assistant-question").last()).toContainText(question);
  await expect(assistant.getByTestId("assistant-answer").last()).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 15_000 },
  );
});

test("while the words inside are still being searched for, the Ask row is not lit; the match, once found, is the row lit", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await writeMind(window, ["Supplier review", "The pilot boarded near Rotterdam at dawn."]);
  await newMind(window);

  await openPalette(window);
  // Every kind of row that is lit from now on, in order: a lit row that Enter can't act on is seen even if it is gone a moment later.
  await window.evaluate(() => {
    const lit: string[] = [];
    (globalThis as unknown as { lit: string[] }).lit = lit;
    new MutationObserver(() => {
      for (const row of document.querySelectorAll(
        '[data-testid="palette-item"][aria-selected="true"]',
      )) {
        const kind = row.getAttribute("data-kind") ?? "";
        if (lit.at(-1) !== kind) lit.push(kind);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
  });
  await window.keyboard.type("Rotterdam");
  await expect(group(window, "ask")).toBeVisible();
  const note = group(window, "notes").getByTestId("palette-item");
  await expect(note).toHaveAttribute("aria-selected", "true");
  const lit = await window.evaluate(() => (globalThis as unknown as { lit: string[] }).lit);
  expect(lit).not.toContain("ask");
  await app.close();
});

/** What ⌘K lists for each kind in focus whatever else is in the registry: the rest is read from its ">" list. */
const OFFERED = {
  mind: ["mind.moveTo", "mind.rename", "mind.exportMenu"],
  document: ["document.moveTo", "document.tags", "document.rename"],
  folder: ["folder.open", "folder.organize", "folder.sort", "folder.rename"],
} as const;

/** Offered whatever is in focus, and found by name too (#1245, #1190). */
const EVERYWHERE = [
  "documents.add",
  "linkedFolder.add",
  "language.switch",
  "library.open",
] as const;

/** The name a command goes by in the open list, without what it acts on. */
const nameInList = (window: Page, id: string) =>
  palette(window).locator(`[data-key="command:${id}"] .truncate`).first();

test.describe("every command is found by its name, for the object in focus, and the empty state is short", () => {
  for (const language of ["en", "zh-CN"] as const) {
    test(`in ${language === "en" ? "English" : "Chinese"}`, async () => {
      test.setTimeout(300_000);
      const { app, window } = await launchApp(dataDir);
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      const sources = join(dataDir, "sources");
      await mkdir(sources);
      const inFolder = join(sources, "Tides.txt");
      const loose = join(sources, "Loose.txt");
      await writeFile(inFolder, "Neap tides are the smallest of the month.\n");
      await writeFile(loose, "Some loose words.\n");
      await addDocuments(window, [inFolder, loose]);
      const ids = await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
        const mind = await core.createMind({ title: "Shortlist" });
        const folder = await core.createLibraryGroup({ name: "Finance", description: "" });
        const documents = await core.listDocuments();
        const tides = documents.find((each) => each.name.startsWith("Tides"));
        const free = documents.find((each) => each.name.startsWith("Loose"));
        if (tides) await core.assignDocumentGroup(tides.id, folder.id);
        return { mind: mind.id, folder: folder.id, document: free?.id ?? "" };
      });
      await setLanguage(window, language);

      const row = (kind: keyof typeof OFFERED) =>
        window
          .locator(`[data-object-menu="${kind}:${ids[kind]}"]`)
          .first()
          .locator("xpath=ancestor::*[@data-object-row][1]")
          .locator("[data-row-main], [data-tree-row]")
          .first();

      for (const kind of ["mind", "document", "folder"] as const) {
        await row(kind).focus();
        await openPalette(window);
        // Nothing typed: Recent, then six actions at most, in the menus' order.
        await expect(group(window, "actions")).toBeVisible();
        const first = await group(window, "actions").getByTestId("palette-item").count();
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThanOrEqual(6);
        await window.keyboard.type(">");
        // Every action there is for it, each found by typing its own name.
        const offered = await palette(window)
          .locator('[data-key^="command:"]')
          .evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-key")?.slice(8) ?? ""),
          );
        expect(offered).toEqual(expect.arrayContaining([...OFFERED[kind], ...EVERYWHERE]));
        for (const id of offered) {
          const listed = nameInList(window, id);
          await expect(listed, `${id} is offered for a ${kind} in focus`).toBeVisible();
          const name = ((await listed.textContent()) ?? "").replace(/…$/, "");
          await window.keyboard.press("ControlOrMeta+a");
          await window.keyboard.type(name);
          await expect(
            group(window, "actions").locator(`[data-key="command:${id}"]`),
            `${name} finds ${id}`,
          ).toBeVisible();
          await window.keyboard.press("ControlOrMeta+a");
          await window.keyboard.type(">");
        }
        await window.keyboard.press("Escape");
        await expect(palette(window)).toBeHidden();
      }
    });
  }
});

test('with words typed, the last row is Ask “words”: Enter opens the first match, and Enter on the last row asks the assistant; ">" is for actions only', async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await writeMind(window, ["Supplier review"]);
  await newMind(window);

  await openPalette(window);
  await window.keyboard.type("supplier");
  await expect(group(window, "minds")).toContainText("Supplier review");
  const rows = palette(window).getByTestId("palette-item");
  await expect(rows.last()).toHaveAttribute("data-kind", "ask");
  await expect(rows.last()).toContainText("Ask “supplier”");
  await expect(group(window, "ask")).toBeVisible();
  // Enter takes the first match, not the question.
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("ArrowUp");
  await expect(rows.last()).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(palette(window)).toBeHidden();
  const assistant = window.getByTestId("assistant");
  await expect(assistant.getByTestId("assistant-question").last()).toContainText("supplier");

  // The command typed has the question after it too.
  await openPalette(window);
  await window.keyboard.type("new mind");
  await expect(group(window, "actions")).toContainText("New Mind");
  await expect(rows.last()).toContainText("Ask “new mind”");

  // ">" asks for actions only: no question to ask there.
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.type(">rename");
  await expect(group(window, "ask")).toHaveCount(0);
  await app.close();
});

test("Interface language: 中文 switches the interface at once, and the Chinese one switches back", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);

  await openPalette(window);
  await window.keyboard.type("interface language");
  await expect(group(window, "actions").getByTestId("palette-item").first()).toContainText(
    "Interface language: 中文",
  );
  await window.keyboard.press("Enter");
  await expect(palette(window)).toBeHidden();
  await expect(window.getByTestId("sidebar")).toContainText("设置");

  await openPalette(window);
  await expect(window.getByTestId("palette-search")).toHaveAttribute("placeholder", /^搜索/);
  await window.keyboard.type("yuyan");
  await expect(group(window, "actions").getByTestId("palette-item").first()).toContainText(
    "界面语言：English",
  );
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("sidebar")).toContainText("Settings");
  await app.close();
});

test("Add Documents… and Link a folder… are found by name, and an empty ⌘K shows Export… and the keys of Move to… and Rename", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 760);
  await dismissChatSetup(window);
  await writeMind(window, ["Supplier review"]);

  await openPalette(window);
  await window.keyboard.type("add documents");
  await expect(
    group(window, "actions").locator('[data-key="command:documents.add"]'),
  ).toBeVisible();
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.type("link a folder");
  await expect(
    group(window, "actions").locator('[data-key="command:linkedFolder.add"]'),
  ).toBeVisible();
  await window.keyboard.press("Escape");

  // With a Mind in front, the empty list leads with Export… after Check, and Rename shows F2.
  await openPalette(window);
  const keys = group(window, "actions").locator('[data-testid="palette-item"]');
  await expect(keys.locator("xpath=.").filter({ hasText: "Export…" })).toBeVisible();
  const rename = group(window, "actions").locator('[data-key="command:mind.rename"]');
  await expect(rename).toContainText("F2");
  await app.close();
});

test("Rename, Move to… and Tags… run from ⌘K on the Mind or Document in front, and on a row in focus", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const sources = join(dataDir, "sources");
  await mkdir(sources);
  const file = join(sources, "Tides.txt");
  await writeFile(file, "Neap tides are the smallest of the month.\n");
  await addDocuments(window, [file]);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.createLibraryGroup({ name: "Finance", description: "" });
  });
  await writeMind(window, ["Supplier review", "Pilots board near Rotterdam."]);

  // The Mind in front, with the caret in its text: Rename edits its tab.
  await openPalette(window);
  await window.keyboard.type("rename");
  await expect(group(window, "actions").locator('[data-key="command:mind.rename"]')).toBeVisible();
  await expect(group(window, "actions").locator('[data-key="command:tab.rename"]')).toHaveCount(0);
  await window.keyboard.press("Enter");
  const field = window.locator("input:focus");
  await expect(field).toBeFocused();
  await window.keyboard.type("Supplier shortlist");
  await window.keyboard.press("Enter");
  await expect(frontMindName(window)).toHaveText("Supplier shortlist");

  // Move to… opens the Folder picker; choosing Finance files the Mind there.
  await openPalette(window);
  await window.keyboard.type("move to");
  await expect(group(window, "actions").locator('[data-key="command:mind.moveTo"]')).toBeVisible();
  await window.keyboard.press("Enter");
  const picker = window.locator('[data-testid="move-to-picker"]:visible');
  await expect(picker).toBeVisible();
  await window.keyboard.type("finance");
  await window.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(window.getByTestId("undo-message")).toContainText("Finance");

  // A Document in front: Tags… opens its picker and Move to… the Folder picker.
  await pointAndClick(window, window.getByTestId("open-document").first());
  await expect(window.getByTestId("viewer-header")).toBeVisible();
  await openPalette(window);
  await window.keyboard.type("tags");
  await expect(
    group(window, "actions").locator('[data-key="command:document.tags"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("document-tags-popover").first()).toBeVisible();
  await window.keyboard.press("Escape");
  await openPalette(window);
  await window.keyboard.type("move to");
  await window.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await window.keyboard.press("Escape");
});
