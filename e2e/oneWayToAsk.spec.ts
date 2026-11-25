import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  boxesOverlap,
  boxOf,
  catchCopies,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  openDocumentAt,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  slideSelect,
  urlsOpened,
  writeNote,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * One way to ask (#3764): with no model set up, a Note is asked from one place, its foot. With
 * Claude Code on this computer that is the Note's own input: the bar over a selection only formats
 * and comments, the words wait in the input as its quote, ⌘J puts the caret there, ⌘K only finds,
 * no pill floats over a Document, and nothing says an AI or a model is missing. Disconnected, the
 * Note's foot says what asking needs, once, and the assistant stays away. With their AI only in its
 * own app, the Ask pill stands at the Note's foot. The app opens nothing here: each link it would
 * open is recorded.
 */

let dataDir: string;
let sources: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  for (const folder of [dataDir, sources, home, bin]) await removeDataFolder(folder);
});

const TITLE = "Ferry delays";
const FIRST = "The 07:40 crossing leaves late most weekdays because of the single ramp.";
const SECOND = "The harbour plan adds a second ramp in 2027.";

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

/**
 * "Kestrel Bay" with its report, a Tag the User put on it, and `client` connected to the Folder;
 * the Folder's and the report's ids and the connection's.
 */
async function connected(
  window: Page,
  client: "claude-code" | "claude-desktop",
): Promise<{ folderId: string; documentId: string; pairingId: string }> {
  const report = join(sources, "Annual report 2025.md");
  await writeFile(
    report,
    "# Annual report 2025\n\nThe second ramp at Kestrel Bay is planned for 2027.\n",
  );
  const made = await window.evaluate(
    async ([path, each]) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
      await bridge.addDocuments([path], { groupId: folder.id });
      const [document] = await bridge.listDocuments();
      if (!document) throw new Error("The report wasn't added.");
      const tag = await bridge.createTag({ name: "Harbour" });
      await bridge.addTagToDocuments([document.id], tag.id);
      await bridge.setAgentsEnabled(true);
      const agent = await bridge.connectAgent({
        name: each === "claude-code" ? "Claude Code" : "Claude",
        client: each,
        folderIds: [folder.id],
        propose: true,
      });
      return { folderId: folder.id, documentId: document.id, pairingId: agent.pairing.id };
    },
    [report, client] as const,
  );
  await expectReadyDocuments(window, 1);
  return made;
}

async function open(window: Page, mindId: string) {
  const folderRow = sidebarFolder(window, "Kestrel Bay").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
    await pointAndClick(window, folderRow);
  }
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
}

const paragraph = (window: Page, text: string) =>
  frontMind(window).getByTestId("mind-editor").locator(":scope > p").filter({ hasText: text });

/** Selects words with the mouse and gives back the bar over them. */
async function select(window: Page, text: string, words: string) {
  await slideSelect(window, paragraph(window, text), words);
  const menu = window.getByTestId("selection-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("with Claude Code on this computer, a Note is asked from its own input alone; disconnected, its foot says what asking needs", async () => {
  test.skip(
    process.platform === "win32",
    "The stand-in for Claude Code starts from a shell script.",
  );
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const { folderId, documentId } = await connected(window, "claude-code");
    const mindId = await writeNote(window, TITLE, [{ text: FIRST }, { text: SECOND }], {
      folderId,
    });
    await open(window, mindId);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    const input = group.getByTestId("note-ask-input");
    const quote = group.getByTestId("note-ask-quote");

    // The bar over the words formats and comments, as in the User's AI app's own page: no AI
    // group and no field. The words wait in the Note's input as its quote.
    const menu = await select(window, FIRST, "the single ramp");
    await expect(menu.getByTestId("format-bold")).toBeVisible();
    await expect(menu.getByTestId("selection-comment")).toBeVisible();
    await expect(menu.locator('[data-testid^="selection-action-"]')).toHaveCount(0);
    await expect(menu.getByTestId("selection-edit-field")).toHaveCount(0);
    await expect(quote).toContainText("the single ramp");
    await shot(window, "one-way-selection-en");

    // ⌘J puts the caret in that input, the words still its quote, and opens nothing.
    await window.keyboard.press("ControlOrMeta+j");
    await expect(input).toBeFocused();
    await expect(quote).toContainText("the single ramp");
    expect(await urlsOpened(app)).toEqual([]);

    // ⌘K only finds: the Note, and no row or group that asks.
    await pointAndClick(window, paragraph(window, SECOND));
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("ramp");
    const items = window.getByTestId("palette-item");
    await expect(items.filter({ hasText: TITLE }).first()).toBeVisible();
    await expect(items.filter({ hasText: "Ask “ramp”" })).toHaveCount(0);
    await expect(window.locator('[data-testid="palette-group"][data-group="ask"]')).toHaveCount(0);
    await shot(window, "one-way-palette-en");
    await window.keyboard.press("Escape");

    // Its Tag waits for a model to tag by itself, and the sidebar's foot says nothing of it.
    await expect
      .poll(() =>
        window.evaluate(async () =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
          ).map((each) => each.tagging),
        ),
      )
      .toEqual(["waiting-for-provider"]);
    await expect(window.getByTestId("sidebar-footer").getByTestId("tagging-waiting")).toHaveCount(
      0,
    );

    // The Library with the report open beside it: no pill floats over either.
    await pointAndClick(window, window.getByTestId("open-library").first());
    await openDocumentAt(window, { documentId });
    await expect(window.getByTestId("viewer").first()).toContainText("second ramp");
    await expect(window.locator("[data-ask-pill]")).toHaveCount(0);
    await shot(window, "one-way-document-en");

    // Settings › AI names what Organize uses, their AI, rather than a model it lacks.
    const settings = await openSettings(window, "ai");
    await expect(settings.getByTestId("models-sorting").locator("option:checked")).toHaveText(
      "Your AI",
    );
    await expect(settings).not.toContainText("No model yet");

    // Disconnected, the assistant doesn't come back: the Note's foot says what asking needs.
    const pairing = settings.locator('[data-testid="agent-pairing"][data-name="Claude Code"]');
    await pointAndClick(window, pairing.getByTestId("agent-disconnect"));
    await expect(pairing).toHaveCount(0);
    await closeSettings(window);
    await open(window, mindId);
    const line = group.getByTestId("note-ask-no-ai");
    await expect(line).toHaveText("Asking needs your AI · Connect your AI");
    await expect(group.getByTestId("note-ask")).toHaveCount(0);
    await expect(window.getByTestId("chat-readiness")).toHaveCount(0);
    await expect(window.getByTestId("assistant")).toBeHidden();
    await expect(window.locator("[data-ask-pill]")).toHaveCount(0);
    // One line, under the page, never over its text.
    const page = await boxOf(group.getByTestId("mind-scroller"));
    expect((await boxOf(line)).y).toBeGreaterThanOrEqual(page.y + page.height - 1);
    await shot(window, "one-way-disconnected-en");

    // The bar over a selection asks nothing either; ⌘J goes to Connect your AI, which opens
    // Settings › AI.
    const after = await select(window, SECOND, "second ramp");
    await expect(after.locator('[data-testid^="selection-action-"]')).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(group.getByTestId("note-ask-connect")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
    await closeSettings(window);
    await expect(window.getByTestId("assistant")).toBeHidden();

    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(line).toHaveText("提问需要你的 AI · 连接你的 AI");
    await shot(window, "one-way-disconnected-zh-CN");
  } finally {
    await app.close();
  }
});

test("with their AI only in its own app, the Ask pill stands at the Note's foot, under its text, beside a Document and never over it", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    await setWindowSize(app, window, 1440, 900);
    const { folderId, documentId } = await connected(window, "claude-desktop");
    const mindId = await writeNote(window, TITLE, [{ text: FIRST }, { text: SECOND }], {
      folderId,
    });
    await open(window, mindId);
    await openDocumentAt(window, { documentId });
    const viewer = window.getByTestId("viewer").first();
    await expect(viewer).toContainText("second ramp");

    const note = window.locator(`[data-testid="mind-pane"][data-mind-id="${mindId}"]`);
    const noteGroup = window.locator('[data-testid="tab-group"]').filter({ has: note });
    const pill = noteGroup.getByTestId("own-ai-pill");
    await expect(pill.getByTestId("own-ai-pill-ask")).toContainText("Ask Claude");
    // Under 1,100px the two share one group, so only the widths where both show.
    for (const width of [1440, 1200]) {
      await setWindowSize(app, window, width, 900);
      const [box, group, page, document] = await Promise.all([
        boxOf(pill),
        boxOf(noteGroup),
        boxOf(noteGroup.getByTestId("mind-scroller")),
        boxOf(viewer),
      ]);
      expect(boxesOverlap(box, document), `at ${width}`).toBe(false);
      expect(box.x, `at ${width}`).toBeGreaterThanOrEqual(group.x);
      expect(box.x + box.width, `at ${width}`).toBeLessThanOrEqual(group.x + group.width);
      expect(box.y, `at ${width}`).toBeGreaterThanOrEqual(page.y + page.height - 1);
    }
    await shot(window, "one-way-desktop-pill-en");

    // The bar over a selection only formats and comments here too; the pill asks about the Note.
    await slideSelect(
      window,
      note.getByTestId("mind-editor").locator(":scope > p").filter({ hasText: FIRST }),
      "the single ramp",
    );
    const menu = window.getByTestId("selection-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid^="selection-action-"]')).toHaveCount(0);
    await expect(menu.getByTestId("selection-edit-field")).toHaveCount(0);
    await pointAndClick(window, pill.getByTestId("own-ai-pill-ask"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [opened] = await urlsOpened(app);
    expect(opened?.startsWith("claude://claude.ai/new?q=")).toBe(true);

    await setLanguage(window, "zh-CN");
    await expect(pill.getByTestId("own-ai-pill-ask")).toContainText("问 Claude");
  } finally {
    await app.close();
  }
});
