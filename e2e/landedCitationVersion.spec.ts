import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { formatDate } from "../src/shared/dates";
import {
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  focusSettled,
  launchApp,
  linkFolderFromSidebar,
  menuCommands,
  motionSettled,
  newMind,
  openDocumentAt,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * An Answer added to the Mind open in the editor, after the Document it cites
 * changed (#1869): its Citation keeps the version it quotes and needs re-check.
 * Its marker carries ↻, its card shows the cited words as they changed, Keep
 * citing the old version quiets it and Update the sentence… moves it to the new
 * words, selecting its sentence, each one step of Undo. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const OLD = "For the Supplier, the notice period is sixty (60) days.";
const NEW = "For the Supplier, the notice period is forty-five (45) days.";
const amendment = (clause: string) =>
  ["# Notice", "", clause, "", "# Termination", "", "Either party may end it in writing.", ""].join(
    "\n",
  );
const CHANGED = new Date("2026-10-21T12:00:00Z");
const QUESTION = "What notice period does the Supplier give?";

const LANGUAGES = {
  en: {
    recheck: "Needs re-check",
    changedOn: (date: string) => `This Document changed on ${date}.`,
    words: "The cited words changed in the new version:",
    update: "Update the sentence…",
    keep: "Keep citing the old version",
    kept: "Kept citing the old version",
  },
  "zh-CN": {
    recheck: "需重新核对",
    changedOn: (date: string) => `此文档已于 ${date} 更新。`,
    words: "引文在新版本中有改动：",
    update: "更新这句话…",
    keep: "继续引用旧版本",
    kept: "已继续引用旧版本",
  },
} as const;

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** The version of the Document at `path` that is indexed, through the core's bridge. */
const contentHashOf = (window: Page, path: string) =>
  window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).find((each) => each.path === wanted)?.contentHash;
  }, path);

/** The Citation in the Mind as stored: the version it quotes, its quote, and the version it was kept over. */
const storedCitation = (editor: Locator) =>
  editor.evaluate((dom) => {
    let found: Record<string, unknown> | null = null;
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name === "citation" && !found) found = { ...node.attrs };
    });
    const { contentHash, quote, keptOver } = (found ?? {}) as Record<string, unknown>;
    return { contentHash, quote, keptOver: keptOver ?? null };
  });

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

  test(`an Answer added after its Document changed keeps the version it quotes, needs re-check, and the User chooses (${language})`, async () => {
    test.setTimeout(180_000);
    const library = join(sources, "Library");
    await mkdir(library, { recursive: true });
    const file = join(library, "Amendment.md");
    await writeFile(file, amendment(OLD));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    try {
      await linkFolderFromSidebar(app, window, library);
      await expectReadyDocuments(window, 1);
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await pointAndClick(window, editor);

      const answer = await askInAssistant(window, QUESTION);
      await expect(answer.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
      const cited = await contentHashOf(window, file);
      if (cited === undefined) throw new Error("The Document isn't indexed.");
      await screenshot(window, `1-answer-${language}`);

      // The file changes on disk before the Answer is added: the clause now says forty-five days.
      await writeFile(file, amendment(NEW));
      await utimes(file, CHANGED, CHANGED);
      await expect.poll(() => contentHashOf(window, file), { timeout: 15_000 }).not.toBe(cited);
      const current = await contentHashOf(window, file);

      await addToNote(window, answer);
      const chip = editor.getByTestId("citation-chip");
      await expect(chip).toHaveAttribute("data-check", "found");
      await expect(chip).toHaveAttribute("data-recheck", "true");
      expect(await storedCitation(editor)).toEqual({
        contentHash: cited,
        quote: OLD,
        keptOver: null,
      });
      await screenshot(window, `2-landed-${language}`);

      const card = window.getByTestId("citation-card");
      const showCard = async () => {
        if ((await card.count()) > 0) {
          await window.keyboard.press("Escape");
          await expect(card).toHaveCount(0);
        }
        await window.mouse.move(0, 0);
        await pointAt(window, chip);
        await expect(card).toBeVisible();
      };
      const undo = async () => {
        await focusSettled(window, editor);
        await window.keyboard.press("ControlOrMeta+z");
      };
      const undoLine = window.getByTestId("undo-line");

      // The card says it needs re-check, when the Document changed, and the cited words as they changed.
      await showCard();
      await expect(card.getByTestId("citation-badge")).toHaveText(words.recheck);
      // The day as this computer's time zone has it, as the app shows it.
      await expect(card.getByTestId("citation-changed-date")).toHaveText(
        words.changedOn(formatDate(CHANGED, language)),
      );
      await expect(card.getByTestId("citation-changed")).toContainText(words.words);
      const changed = card.getByTestId("citation-changed-words");
      await expect(changed.locator("del")).toHaveText("sixty (60)");
      await expect(changed.locator("ins")).toHaveText("forty-five (45)");
      await expect(card.getByTestId("citation-update")).toHaveText(words.update);
      await expect(card.getByTestId("citation-keep-old")).toHaveText(words.keep);
      await screenshot(window, `3-card-${language}`);
      // The card holds at a narrow window.
      await setWindowSize(app, window, 900, 820);
      await showCard();
      await expect(card.getByTestId("citation-update")).toBeVisible();
      await expect(card.getByTestId("citation-keep-old")).toBeVisible();
      await screenshot(window, `card-narrow-${language}`);
      await setWindowSize(app, window, 1440, 900);
      await showCard();

      // Keep citing the old version: quiet over this version, still citing the old one; Undo asks again.
      await pointAndClick(window, card.getByTestId("citation-keep-old"));
      await expect(card).toHaveCount(0);
      await expect(chip).not.toHaveAttribute("data-recheck", "true");
      await expect(undoLine).toContainText(words.kept);
      expect(await storedCitation(editor)).toEqual({
        contentHash: cited,
        quote: OLD,
        keptOver: current,
      });
      await screenshot(window, `4-kept-old-${language}`);
      await undo();
      await expect(chip).toHaveAttribute("data-recheck", "true");
      expect((await storedCitation(editor)).keptOver).toBeNull();
      await screenshot(window, `5-kept-undone-${language}`);

      // The Citation's right-click menu offers both choices too; Keep from it does the same.
      await window.mouse.move(0, 0);
      await pointAt(window, chip);
      await chip.click({ button: "right" });
      const menu = editor.getByTestId("citation").getByTestId("citation-actions");
      expect(await menuCommands(menu)).toEqual([
        "citation.open",
        "—",
        "citation.update",
        "citation.keepOld",
        "—",
        "citation.remove",
      ]);
      await expect(menu.getByTestId("citation.keepOld")).toHaveText(words.keep);
      await pointAndClick(window, menu.getByTestId("citation.keepOld"));
      await expect(chip).not.toHaveAttribute("data-recheck", "true");
      expect((await storedCitation(editor)).keptOver).toBe(current);
      await undo();
      await expect(chip).toHaveAttribute("data-recheck", "true");

      // Update the sentence…: it cites the new words, which open beside, and its sentence is selected.
      await showCard();
      await pointAndClick(window, card.getByTestId("citation-update"));
      await expect(card).toHaveCount(0);
      await expect(chip).not.toHaveAttribute("data-recheck", "true");
      await expect(chip).toHaveAttribute("data-check", "found");
      expect(await storedCitation(editor)).toEqual({
        contentHash: current,
        quote: NEW,
        keptOver: null,
      });
      const viewer = window.getByTestId("viewer");
      await expect(viewer.locator("[data-quote-highlight]")).toHaveText(NEW);
      // The sentence is asked to follow the new words (Edit with AI), and is one step of Undo of its own.
      await expect(editor).toContainText("forty-five (45)");
      await screenshot(window, `6-updated-${language}`);
      await undo();
      await expect(editor).not.toContainText("forty-five (45)");
      await expect(chip).not.toHaveAttribute("data-recheck", "true");
      await undo();
      await expect(chip).toHaveAttribute("data-recheck", "true");
      expect(await storedCitation(editor)).toEqual({
        contentHash: cited,
        quote: OLD,
        keptOver: null,
      });
      await screenshot(window, `7-updated-undone-${language}`);
    } finally {
      await app.close();
    }
  });

  test(`Update the sentence… keeps the Note in view beside the new words when the Document was open first (${language})`, async () => {
    test.setTimeout(180_000);
    const library = join(sources, "Library");
    await mkdir(library, { recursive: true });
    const file = join(library, "Amendment.md");
    await writeFile(file, amendment(OLD));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 2560, 1440);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    try {
      await linkFolderFromSidebar(app, window, library);
      await expectReadyDocuments(window, 1);
      const documentId = await window.evaluate(async (wanted) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.listDocuments()).find((each) => each.path === wanted)?.id;
      }, file);
      if (documentId === undefined) throw new Error("The Document isn't indexed.");
      await openDocumentAt(window, { documentId });
      await expect(window.getByTestId("viewer")).toBeVisible();
      const editor = window.getByTestId("mind-editor");
      const answer = await askInAssistant(window, QUESTION);
      await expect(answer.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
      const cited = await contentHashOf(window, file);
      await writeFile(file, amendment(NEW));
      await utimes(file, CHANGED, CHANGED);
      await expect.poll(() => contentHashOf(window, file), { timeout: 15_000 }).not.toBe(cited);
      await pointAt(window, answer.getByTestId("assistant-answer-text"));
      await pointAndClick(window, answer.getByTestId("answer-write-note"));
      await expect(editor).toBeVisible();
      const chip = editor.getByTestId("citation-chip");
      await expect(chip).toHaveAttribute("data-recheck", "true");

      const card = window.getByTestId("citation-card");
      await window.mouse.move(0, 0);
      await pointAt(window, chip);
      await expect(card).toBeVisible();
      await pointAndClick(window, card.getByTestId("citation-update"));
      await expect(chip).not.toHaveAttribute("data-recheck", "true");

      // The Note and the new words are both in view, side by side, and the sentence is selected.
      const viewer = window.getByTestId("viewer");
      await expect(viewer.locator("[data-quote-highlight]")).toHaveText(NEW);
      await expect(editor).toBeVisible();
      await expect(viewer).toBeVisible();
      const [note, source] = await Promise.all([editor.boundingBox(), viewer.boundingBox()]);
      expect(note && source && note.x + note.width <= source.x + 1).toBe(true);
      await expect(editor).toContainText("forty-five (45)");
    } finally {
      await app.close();
    }
  });
}
