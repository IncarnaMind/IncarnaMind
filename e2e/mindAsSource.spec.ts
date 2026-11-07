import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { formatShortDate } from "../src/shared/dates";
import {
  addDocuments,
  capture,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  film,
  frontMind,
  launchApp,
  motionSettled,
  newMind,
  openMoreMenu,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * #335: a Mind used as a source. Its snapshot is a Document marked "Your note",
 * a Citation reads "Your note: Field visit, …" and says it is the User's own
 * record, a check labels support from it apart, the same Mind never supports
 * itself, and Remove as a source goes to Recently deleted with Undo.
 */

// The interface's language changes; the app's scripted check model reads English words only,
// so the content stays English in both, as the other check specs do.
const CLAIM = "Harbours publish the times of high water every week.";
const OTHER = "Penguins nest on the harbour cliffs every spring.";
const CONTROL = "Spring tides come at the new moon and the full moon.";

type Language = "en" | "zh-CN";

const strings = (language: Language) =>
  language === "zh-CN"
    ? {
        yourNote: "你的笔记",
        supported: "依据来自你自己的笔记",
        ownRecord: "你自己的记录",
        ownSource: "你自己的记录，不是外部来源",
        removed: "来源已移除。",
        yourNotePrefix: "你的笔记",
        update: "更新快照",
        remove: "不再作为来源",
      }
    : {
        yourNote: "Your note",
        supported: "Supported by your own note",
        ownRecord: "Your own record",
        ownSource: "Your own record, not an outside source",
        removed: "The source was removed.",
        yourNotePrefix: "Your note",
        update: "Update the snapshot",
        remove: "Remove as a source",
      };

let dataDirs: string[];
let sources: string;

test.beforeEach(async () => {
  dataDirs = [];
  sources = await createDataFolder();
});
test.afterEach(async () => {
  for (const dataDir of dataDirs) await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function snapshotOf(window: Page, name: string) {
  return (await coreOf(window)).evaluate(async (core, wanted) => {
    const documents = await core.listDocuments();
    const document = documents.find((each) => each.yourNote && each.name === wanted);
    return document
      ? {
          id: document.id,
          name: document.name,
          contentHash: document.contentHash,
          status: document.status,
          snapshotAt: document.yourNote?.snapshotAt ?? null,
        }
      : null;
  }, name);
}

async function snapshotText(window: Page, documentId: string): Promise<string> {
  return (await coreOf(window)).evaluate(
    async (core, id) => (await core.readDocumentText(id)).pages.map((page) => page.text).join("\n"),
    documentId,
  );
}

/** A Mind with a heading title and one paragraph, its cursor nowhere in particular. */
async function mindWith(window: Page, title: string, text: string): Promise<void> {
  await newMind(window, { title: true });
  await window.keyboard.insertText(title);
  await window.keyboard.press("Enter");
  await window.keyboard.insertText(text);
}

async function showMind(window: Page, title: string): Promise<void> {
  const tab = window
    .getByTestId("mind-tab")
    .filter({ has: window.locator(`[data-testid="tab-title"]`, { hasText: title }) })
    .first();
  await pointAndClick(window, tab);
  await expect(frontMind(window)).toBeVisible();
}

/** Selects a sentence in the front Mind's last paragraph, as a person does. */
async function selectSentence(window: Page, sentence: string): Promise<void> {
  const editor = frontMind(window).getByTestId("mind-editor");
  const line = editor.locator(":scope > p").last();
  const words = sentence.split(" ");
  await slideSelect(window, line, words.slice(0, 2).join(" "), {
    line,
    words: words.slice(-2).join(" "),
  });
}

async function checkAgainstDocuments(window: Page): Promise<void> {
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Mind is a source, cited and checked, removed and undone (${language})`, async () => {
    test.setTimeout(300_000);
    const words = strings(language);
    await writeFile(join(sources, "Tides.txt"), `${CONTROL}\n`);
    const dataDir = await createDataFolder();
    dataDirs.push(dataDir);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.txt")]);

    // Mind A: the record, before and after it becomes a source.
    await mindWith(window, "Field visit", CLAIM);
    await motionSettled(window);
    await capture(window, `before-source-${language}-1440`);
    // The menu before it is a source: Use as a source, and no source foot.
    const beforeMenu = await openPageMenu(window);
    await expect(beforeMenu.getByTestId("mind-source-foot")).toBeHidden();
    const beforeMore = await openMoreMenu(window, beforeMenu);
    await expect(beforeMore.getByTestId("mind.useAsSource")).toBeVisible();
    await capture(window, `menu-before-source-${language}-1440`);
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    await expect(beforeMenu).toBeHidden();

    // The recorded flow: use it as a source, cite it, and read its Citation.
    const citeFlow = async () => {
      const menu = await openPageMenu(window);
      await pointAndClick(
        window,
        (await openMoreMenu(window, menu)).getByTestId("mind.useAsSource"),
      );
      await expect
        .poll(async () => (await snapshotOf(window, "Field visit"))?.status, { timeout: 60_000 })
        .toBe("ready");
      const source = await snapshotOf(window, "Field visit");
      if (!source?.snapshotAt) throw new Error("The snapshot has no date.");
      expect(source.name).toBe("Field visit");
      const date = formatShortDate(source.snapshotAt, language);
      // The clock follows the machine: 24 hours here, 12 hours on some runners.
      const footText =
        language === "zh-CN"
          ? new RegExp(`^已作为来源 · 快照于 ${date} (上午|下午)?\\d{1,2}:\\d{2}$`)
          : new RegExp(`^Used as a source · snapshot of ${date}, \\d{1,2}:\\d{2}( [ap]m)?$`);
      const label =
        language === "zh-CN" ? `你的笔记：Field visit，${date}` : `Your note: Field visit, ${date}`;
      // The menu's foot says when the snapshot was taken; its own items act.
      const foot = await openPageMenu(window);
      await expect(foot.getByTestId("mind-source-foot")).toHaveText(footText);
      // Only the items act: the foot's words are a paragraph, not a button.
      await expect(foot.getByTestId("mind-source-foot")).toHaveJSProperty("tagName", "P");
      const footMore = await openMoreMenu(window, foot);
      await expect(footMore.getByTestId("mind.updateSourceSnapshot")).toHaveText(words.update);
      await expect(footMore.getByTestId("mind.removeAsSource")).toHaveText(words.remove);
      await capture(window, `menu-source-${language}-1440`);
      await window.keyboard.press("Escape");
      await window.keyboard.press("Escape");
      await capture(window, `after-source-${language}-1440`);

      // The Library row carries "Your note", and the snapshot has the Mind's words.
      await pointAndClick(window, window.getByTestId("open-library"));
      const library = window.getByTestId("library");
      await expect(library).toBeVisible();
      const row = library.getByTestId("library-document").filter({ hasText: "Field visit" });
      await expect(row.getByTestId("document-your-note")).toHaveText(words.yourNote);
      await capture(window, `library-${language}-1440`);
      await window.keyboard.press("ControlOrMeta+w");
      await expect(library).toBeHidden();
      await showMind(window, "Field visit");

      // Mind B cites the snapshot: support is marked as the User's own note.
      await mindWith(window, "Draft", CLAIM);
      await selectSentence(window, CLAIM);
      await checkAgainstDocuments(window);
      const mark = window.getByTestId("claim-mark");
      await expect(mark).toHaveAttribute("data-check", "supported", { timeout: 60_000 });
      // A ticked box, not the green tick: this support is the User's own note alone.
      await expect(mark).toHaveAttribute("data-own-note", "true");
      await expect(mark).toHaveAttribute("aria-label", words.supported);
      await pointAndClick(window, mark);
      const claim = window.getByTestId("claim-card");
      await expect(claim.getByTestId("claim-badge")).toContainText(words.supported);
      await expect(claim.getByTestId("claim-source")).toContainText(label);
      await expect(claim.getByTestId("claim-own-note")).toHaveText(words.ownSource);
      await capture(window, `supported-${language}-1440`);
      await pointAndClick(window, claim.getByTestId("claim-add-citation"));
      const citation = window.getByTestId("citation").first();
      await expect(citation).toBeVisible();
      await pointAndClick(window, citation);
      const card = window.getByTestId("citation-card");
      await expect(card.getByTestId("citation-source")).toHaveText(label);
      await expect(card.getByTestId("citation-own-record")).toHaveText(words.ownRecord);
      await capture(window, `citation-${language}-1440`);
      await setWindowSize(app, window, 900, 900);
      await expect(card.getByTestId("citation-source")).toBeVisible();
      await capture(window, `citation-${language}-900`);
      await setWindowSize(app, window, 1440, 900);
      return { source, label };
    };
    const { source, label } = language === "en" ? await film(window, citeFlow) : await citeFlow();

    // The Mind edited: the snapshot keeps what it had, then Update takes the new words.
    await showMind(window, "Field visit");
    const editor = frontMind(window).getByTestId("mind-editor");
    await editor.locator(":scope > p").last().click();
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.insertText(" Edited.");
    await expect
      .poll(() => snapshotText(window, source.id), { timeout: 60_000 })
      .not.toContain("Edited");
    const updateMenu = await openPageMenu(window);
    await pointAndClick(
      window,
      (await openMoreMenu(window, updateMenu)).getByTestId("mind.updateSourceSnapshot"),
    );
    await expect
      .poll(() => snapshotText(window, source.id), { timeout: 60_000 })
      .toContain("Edited");
    await expect
      .poll(async () => (await snapshotOf(window, "Field visit"))?.contentHash, {
        timeout: 60_000,
      })
      .not.toBe(source.contentHash);
    await capture(window, `updated-${language}-1440`);

    // The Citation still quotes the version it was made from.
    await showMind(window, "Draft");
    await pointAndClick(window, window.getByTestId("citation").first());
    const updatedCard = window.getByTestId("citation-card");
    await expect(updatedCard.getByTestId("citation-source")).toHaveText(label);
    const quoted = updatedCard
      .locator(".citation-card-quote")
      .or(updatedCard.getByTestId("citation-changed"));
    await expect(quoted.first()).toContainText(CLAIM);
    await window.keyboard.press("Escape");
    await showMind(window, "Field visit");

    // Undo of Update brings the version before it back.
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect
      .poll(() => snapshotText(window, source.id), { timeout: 60_000 })
      .not.toContain("Edited");

    // The same Mind never supports itself: its sentence checked against its own snapshot.
    await mindWith(window, "Own record", OTHER);
    const ownMenu = await openPageMenu(window);
    await pointAndClick(
      window,
      (await openMoreMenu(window, ownMenu)).getByTestId("mind.useAsSource"),
    );
    await expect
      .poll(async () => (await snapshotOf(window, "Own record"))?.status, { timeout: 60_000 })
      .toBe("ready");
    const ownFoot = await openPageMenu(window);
    await expect(ownFoot.getByTestId("mind-source-foot")).toBeVisible();
    await window.keyboard.press("Escape");
    await selectSentence(window, OTHER);
    await checkAgainstDocuments(window);
    const ownMark = window.getByTestId("claim-mark");
    await expect
      .poll(async () => ownMark.getAttribute("data-check"), { timeout: 60_000 })
      .toMatch(/unsupported|not-checked/);
    await pointAndClick(window, ownMark);
    const ownCard = window.getByTestId("claim-card");
    await expect(ownCard.getByTestId("claim-own-note-excluded")).toContainText(
      language === "zh-CN" ? "这篇笔记自己的快照" : "your own snapshot of this note",
    );
    await capture(window, `own-note-${language}-1440`);

    // Remove as a source: the snapshot waits in Recently deleted, and its Citation says so.
    await showMind(window, "Field visit");
    const removeMenu = await openPageMenu(window);
    await pointAndClick(
      window,
      (await openMoreMenu(window, removeMenu)).getByTestId("mind.removeAsSource"),
    );
    const afterRemove = await openPageMenu(window);
    await expect(afterRemove.getByTestId("mind-source-foot")).toBeHidden();
    await expect(
      (await openMoreMenu(window, afterRemove)).getByTestId("mind.useAsSource"),
    ).toBeVisible();
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    await showMind(window, "Draft");
    await pointAndClick(window, window.getByTestId("citation").first());
    await expect(window.getByTestId("citation-card").getByTestId("citation-reason")).toHaveText(
      words.removed,
    );
    await capture(window, `removed-${language}-1440`);

    // Undo: the snapshot is a source again, and the Citation reads as its own note once more.
    await window.keyboard.press("Escape");
    await pointAndClick(window, window.getByTestId("undo-action"));
    await showMind(window, "Field visit");
    const undone = await openPageMenu(window);
    await expect(undone.getByTestId("mind-source-foot")).toBeVisible();
    await window.keyboard.press("Escape");

    // Redo of Use as a source brings the same Document back, so its Citations read as they did.
    await mindWith(window, "Loop", OTHER);
    const loopMenu = await openPageMenu(window);
    await pointAndClick(
      window,
      (await openMoreMenu(window, loopMenu)).getByTestId("mind.useAsSource"),
    );
    await expect
      .poll(async () => (await snapshotOf(window, "Loop"))?.status, { timeout: 60_000 })
      .toBe("ready");
    const beforeUndo = await snapshotOf(window, "Loop");
    if (!beforeUndo) throw new Error("No snapshot to undo.");
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect
      .poll(async () => (await snapshotOf(window, "Loop")) ?? null, { timeout: 60_000 })
      .toBeNull();
    // The line's Redo goes after 10 s; the keyboard reaches the same redo at any time.
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect
      .poll(async () => (await snapshotOf(window, "Loop"))?.id ?? null, { timeout: 60_000 })
      .toBe(beforeUndo.id);
  });
}
