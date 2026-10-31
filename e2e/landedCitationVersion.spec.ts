import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { formatDate } from "../src/shared/dates";
import {
  addToNote,
  askInAssistant,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
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
  openDocumentMenu,
  placeAssistant,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
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
const page = (clause: string) =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Amendment</title></head><body><article>',
    "<h1>Amendment No. 2</h1>",
    "<p>This amendment changes the supply agreement between the Supplier and the Customer, and it takes effect on the first day of the month after both parties have signed it. Every other clause of the agreement stays as it was.</p>",
    "<h2>Notice</h2>",
    `<p>${clause}</p>`,
    "<p>The Customer may give notice in writing to the Supplier at its registered address, and a notice sent by post is treated as received two working days after it was posted.</p>",
    "<h2>Termination</h2>",
    "<p>Either party may end it in writing. The parties will settle any amounts due within thirty days of the end of the agreement, and the clauses on confidentiality and liability continue after it has ended.</p>",
    "</article></body></html>",
  ].join("");
const QUESTION = "What notice period does the Supplier give?";

const LANGUAGES = {
  en: {
    recheck: "Needs re-check",
    changedOn: (date: string) => `This Document changed on ${date}.`,
    words: "The cited words changed in the new version:",
    update: "Update the sentence…",
    updated: "Now citing the new version",
    keep: "Keep citing the old version",
    kept: "Kept citing the old version",
    changedNotice: "The Document changed after this was cited.",
    fetchedAgain: "This page was fetched again on",
  },
  "zh-CN": {
    recheck: "需重新核对",
    changedOn: (date: string) => `此文档已于 ${date} 更新。`,
    words: "引文在新版本中有改动：",
    update: "更新这句话…",
    updated: "已改为引用新版本",
    keep: "继续引用旧版本",
    kept: "已继续引用旧版本",
    changedNotice: "此文档在被引用后有改动。",
    fetchedAgain: "此网页在你引用后于",
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
    const found = (await bridge.listDocuments()).find((each) => each.path === wanted);
    // A version is the Document's once it is read: until then a Citation can't be looked for in it.
    return found?.status === "ready" ? found.contentHash : undefined;
  }, path);

/**
 * Waits until the core reads the Document's current version, so a Citation's quote can be looked
 * for in it: the version is the Document's before its text is.
 */
const untilRead = (window: Page, path: string) =>
  expect
    .poll(
      () =>
        window.evaluate(async (wanted) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const found = (await bridge.listDocuments()).find((each) => each.path === wanted);
          if (found?.status !== "ready") return false;
          const read = await bridge.readDocumentText(found.id);
          return read.contentHash === found.contentHash;
        }, path),
      { timeout: 15_000 },
    )
    .toBe(true);

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

/** Shows the Citation's card by pointing at it, as a person does; it is put away first if it is already up. */
async function showCitationCard(window: Page, chip: Locator): Promise<Locator> {
  const card = window.getByTestId("citation-card");
  await expect(async () => {
    if ((await card.count()) > 0) {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0, { timeout: 1000 });
    }
    await window.mouse.move(0, 0);
    await pointAt(window, chip);
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  return card;
}

/** A Note holding a Citation of a Document that changed before the Answer was added: needs re-check. */
async function noteWithChangedSource(
  language: "en" | "zh-CN",
  size: [number, number],
  files: { library: string; file: string; make?: (clause: string) => string },
) {
  const make = files.make ?? amendment;
  await mkdir(files.library, { recursive: true });
  await writeFile(files.file, make(OLD));
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, size[0], size[1]);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setLanguage(window, language);
  await linkFolderFromSidebar(app, window, files.library);
  await expectReadyDocuments(window, 1);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  const answer = await askInAssistant(window, QUESTION);
  await expect(answer.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
  const cited = await contentHashOf(window, files.file);
  const change = async () => {
    await writeFile(files.file, make(NEW));
    await utimes(files.file, CHANGED, CHANGED);
    await expect.poll(() => contentHashOf(window, files.file), { timeout: 15_000 }).not.toBe(cited);
    await untilRead(window, files.file);
  };
  await change();
  await addToNote(window, answer);
  const chip = editor.getByTestId("citation-chip");
  await expect(chip).toHaveAttribute("data-recheck", "true");
  return { app, window, editor, chip };
}

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
    await connectLocalChatModel(window);
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
      await untilRead(window, file);
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
        "citation.signOff",
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
      // Its Citation stays on the rewritten sentence, found in the new version.
      await expect(chip).toHaveCount(1);
      await expect(chip).toHaveAttribute("data-check", "found");
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

  test(`the check card counts a sentence whose Citation changed once, and the sentence's card shows the change (${language})`, async () => {
    test.setTimeout(180_000);
    const library = join(sources, "Library");
    const { app, window, editor, chip } = await noteWithChangedSource(language, [1440, 900], {
      library,
      file: join(library, "Amendment.md"),
    });
    try {
      // The Answer's two sentences, the one under the changed Citation among them, are each counted once,
      // in the part that has the claims to check; there is no row of its own for the Citation.
      const card = await checkCard(window);
      const row = card.getByTestId("health-toCheck");
      await expect(row).toHaveAttribute("data-count", "2");
      await expect(card.getByTestId("health-changedSource")).toHaveCount(0);
      await pointAndClick(window, row);
      await expect(editor).toBeFocused();
      await window.keyboard.press("Escape");

      // Checked, the sentence's own card says the Document changed after it was cited.
      await pointAndClick(window, (await checkCard(window)).getByTestId("badge-check-mind"));
      await pointAndClick(
        window,
        card.getByTestId("mind-check-ask").getByTestId("mind-check-check"),
      );
      const mark = window.getByTestId("claim-mark").first();
      await expect(mark).toBeVisible();
      await window.mouse.move(0, 0);
      await pointAt(window, mark);
      const claimCard = window.getByTestId("claim-card");
      await expect(claimCard).toBeVisible();
      await expect(claimCard.getByTestId("citation-changed-notice")).toContainText(
        words.changedNotice,
      );
      await window.keyboard.press("Escape");

      // Update the sentence, then take the rewrite back: the sentence that had a check shows its state.
      const citationCard = await showCitationCard(window, chip);
      await pointAndClick(window, citationCard.getByTestId("citation-update"));
      await expect(editor).toContainText("forty-five (45)");
      await focusSettled(window, editor);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(editor).not.toContainText("forty-five (45)");
      // Checked against the new version already, its verdict stands over the old words: Unsupported.
      await expect(window.getByTestId("claim-mark").first()).toHaveAttribute(
        "data-check",
        "unsupported",
      );
    } finally {
      await app.close();
    }
  });

  test(`Update the sentence… on a quote that only moved switches the Citation and asks no model (${language})`, async () => {
    test.setTimeout(120_000);
    const library = join(sources, "Library");
    const file = join(library, "Amendment.txt");
    const make = (clause: string) =>
      ["Amendment No. 2", "", clause, "", "Either party may end it in writing.", ""].join("\n");
    const { app, window, editor, chip } = await noteWithChangedSource(language, [1440, 900], {
      library,
      file,
      make,
    });
    try {
      // The clause is back as it was, two lines further down: the quote moved and its words did not change.
      const current = await contentHashOf(window, file);
      await writeFile(file, ["Added above.", "", make(OLD)].join("\n"));
      await utimes(file, CHANGED, CHANGED);
      await expect.poll(() => contentHashOf(window, file), { timeout: 15_000 }).not.toBe(current);
      await untilRead(window, file);
      const before = await editor.textContent();
      const card = await showCitationCard(window, chip);
      await expect(card.getByTestId("citation-changed-words")).toHaveCount(0);
      await pointAndClick(window, card.getByTestId("citation-update"));
      await expect(chip).not.toHaveAttribute("data-recheck", "true");
      // No rewrite was asked: the text is as it was, and the line that stays is the switch's own.
      expect(await editor.textContent()).toBe(before);
      await expect(window.getByTestId("undo-line")).toContainText(words.updated);
    } finally {
      await app.close();
    }
  });

  test(`Update the sentence… in a window of one group keeps the Note in front, the new words one tab away (${language})`, async () => {
    test.setTimeout(180_000);
    const library = join(sources, "Library");
    const { app, window, editor, chip } = await noteWithChangedSource(language, [1100, 760], {
      library,
      file: join(library, "Amendment.md"),
    });
    try {
      await placeAssistant(window, { dock: "right" });
      await expect(window.getByTestId("tab-groups")).toHaveAttribute("data-merged", "true");
      const card = await showCitationCard(window, chip);
      await pointAndClick(window, card.getByTestId("citation-update"));
      await expect(chip).not.toHaveAttribute("data-recheck", "true");

      // The Note stays in front, its sentence follows the new words, and the page is a tab away.
      await expect(editor).toBeVisible();
      await expect(editor).toContainText("forty-five (45)");
      await expect(window.getByTestId("viewer")).toHaveCount(0);
      const tabs = window.getByRole("tab");
      await expect(tabs).toHaveCount(2);
      await pointAndClick(window, tabs.filter({ hasText: "Amendment" }));
      await expect(window.getByTestId("viewer").locator("[data-quote-highlight]")).toHaveText(NEW);
    } finally {
      await app.close();
    }
  });

  test(`a saved web page fetched again after it was cited says so, on the card and in the viewer, and the copy cited is kept (${language})`, async () => {
    test.setTimeout(180_000);
    let body = page(OLD);
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const home = await createDataFolder();
    const { app, window } = await launchApp(dataDir, { home, web: port, fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await window.getByTestId("plus-menu").click();
      await window.getByTestId("plus-more").click();
      await window.getByTestId("plus-add-web-page").click();
      const dialog = window.getByTestId("add-web-page-dialog");
      await dialog.getByTestId("add-web-page-addresses").fill(`http://127.0.0.1:${port}/notice`);
      await dialog.getByTestId("add-web-page-confirm").click();
      await expect(dialog).toBeHidden();
      const row = window.getByTestId("document-list-item").filter({ hasText: "Amendment" });
      await expect(row).toHaveAttribute("data-status", "ready");

      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await pointAndClick(window, editor);
      const answer = await askInAssistant(window, QUESTION);
      await expect(answer.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
      await addToNote(window, answer);
      const chip = editor.getByTestId("citation-chip");

      body = page(NEW);
      await openDocumentMenu(row);
      await pointAndClick(window, window.getByTestId("document.fetchAgain"));
      await expect(chip).toHaveAttribute("data-recheck", "true");

      const card = await showCitationCard(window, chip);
      await expect(card.getByTestId("citation-changed-date")).toContainText(words.fetchedAgain);
      await screenshot(window, `web-card-${language}`);
      await window.keyboard.press("Escape");

      // The card offers Update and Keep in place of Open; a click on the Citation opens the page
      // as it was cited, and one action there shows the copy fetched since (#2159).
      await pointAndClick(window, chip);
      const viewer = window.getByTestId("viewer");
      await expect(viewer.getByTestId("viewer-as-cited")).toContainText(
        language === "zh-CN" ? "引用时，" : "As cited,",
      );
      await expect(viewer.getByTestId("viewer-cited")).toContainText(OLD);
      await expect(viewer.getByTestId("viewer-cited")).not.toContainText(NEW);
      await screenshot(window, `web-viewer-${language}`);
      await pointAndClick(window, viewer.getByTestId("viewer-open-current"));
      await expect(viewer.getByTestId("viewer-as-cited")).toHaveCount(0);
      await expect(viewer.getByTestId("viewer-web-article")).toContainText(NEW);
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await removeDataFolder(home);
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
    await connectLocalChatModel(window);
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
      await untilRead(window, file);
      await pointAt(window, answer.getByTestId("assistant-answer-text"));
      await pointAndClick(window, answer.getByTestId("answer-write-note"));
      await expect(editor).toBeVisible();
      const chip = editor.getByTestId("citation-chip");
      await expect(chip).toHaveAttribute("data-recheck", "true");

      const card = await showCitationCard(window, chip);
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
      await expect(editor.getByTestId("citation-chip")).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
}
