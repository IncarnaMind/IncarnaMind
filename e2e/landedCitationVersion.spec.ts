import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  focusSettled,
  launchApp,
  linkFolderFromSidebar,
  motionSettled,
  newMind,
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
    changedOn: "This Document changed on 21 Oct 2026.",
    words: "The cited words changed in the new version:",
    update: "Update the sentence…",
    updated: "Now citing the new version",
    keep: "Keep citing the old version",
    kept: "Kept citing the old version",
  },
  "zh-CN": {
    recheck: "需重新核对",
    changedOn: "此文档已于 2026年10月21日 更新。",
    words: "引文在新版本中有改动：",
    update: "更新这句话…",
    updated: "已改为引用新版本",
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

/** The text the Mind's editor has selected. */
const selectedText = (editor: Locator) =>
  editor.evaluate((dom) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    return state.doc.textBetween(state.selection.from, state.selection.to, " ", "[1]");
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
      await expect(card.getByTestId("citation-changed-date")).toHaveText(words.changedOn);
      await expect(card.getByTestId("citation-changed")).toContainText(words.words);
      const changed = card.getByTestId("citation-changed-words");
      await expect(changed.locator("del")).toHaveText("sixty (60)");
      await expect(changed.locator("ins")).toHaveText("forty-five (45)");
      await expect(card.getByTestId("citation-update")).toHaveText(words.update);
      await expect(card.getByTestId("citation-keep-old")).toHaveText(words.keep);
      await screenshot(window, `needs-recheck-card-${language}`);
      // The card holds at a narrow window.
      await setWindowSize(app, window, 900, 820);
      await showCard();
      await expect(card.getByTestId("citation-update")).toBeVisible();
      await expect(card.getByTestId("citation-keep-old")).toBeVisible();
      await screenshot(window, `needs-recheck-card-narrow-${language}`);
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
      await screenshot(window, `kept-old-${language}`);
      await undo();
      await expect(chip).toHaveAttribute("data-recheck", "true");
      expect((await storedCitation(editor)).keptOver).toBeNull();

      // Update the sentence…: it cites the new words, which open beside, and its sentence is selected.
      await showCard();
      await pointAndClick(window, card.getByTestId("citation-update"));
      await expect(card).toHaveCount(0);
      await expect(chip).not.toHaveAttribute("data-recheck", "true");
      await expect(chip).toHaveAttribute("data-check", "found");
      await expect(undoLine).toContainText(words.updated);
      expect(await storedCitation(editor)).toEqual({
        contentHash: current,
        quote: NEW,
        keptOver: null,
      });
      const viewer = window.getByTestId("viewer");
      await expect(viewer.locator("[data-quote-highlight]")).toHaveText(NEW);
      await expect.poll(() => selectedText(editor)).toContain("[1]");
      await screenshot(window, `updated-${language}`);
      await undo();
      await expect(chip).toHaveAttribute("data-recheck", "true");
      expect(await storedCitation(editor)).toEqual({
        contentHash: cited,
        quote: OLD,
        keptOver: null,
      });
    } finally {
      await app.close();
    }
  });
}
