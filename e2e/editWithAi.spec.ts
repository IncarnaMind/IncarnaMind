import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Edit with AI (#93): select text, ask for a change from the selection menu
 * or with ⌘J, and it applies at once (#880), with a line over it: Undo and
 * Review changes, which shows the changes again in the note, each with its
 * own bar, by mouse and keyboard, with Undo. The scripted model (see
 * src/main/fakeChat/edit.ts) shortens by dropping "very" and "really" (非常),
 * and does what "replace X with Y" (把 X 换成 Y) says. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 *
 * A change whose words the User edits goes out of date (#94): it can't be
 * accepted, and Regenerate makes it again from their words.
 *
 * Changes stream in paragraph by paragraph (#202), with "Writing…" on the
 * paragraph being written, and the line says why the change was made.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

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

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** Selects a line's `words` with the mouse, then `more` characters after them with the keyboard. */
async function selectWords(window: Page, line: Locator, words: string, more = 0) {
  await slideSelect(window, line, words);
  for (let index = 0; index < more; index++) await window.keyboard.press("Shift+ArrowRight");
}

test("Shorten applies at once; Review changes shows its two changes over the applied text: one restored by mouse, the other by keyboard, ⌘Z; the Citation is still checked", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();

  // An Answer with a checked Citation, added to the note under a line of the User's.
  await window.keyboard.type("Tides at the harbour.");
  await window.keyboard.press("Enter");
  const answer = await askInAssistant(window, "When do spring tides happen?");
  await addToNote(window, answer);
  const note = editor.locator(":scope > p").nth(1);
  await expect(note.getByTestId("citation")).toHaveAttribute("data-check", "found");
  await slideSelect(window, note, "Your Documents answer this");
  await window.keyboard.type("The tides here are very strong and really regular");
  await expect(note).toContainText("The tides here are very strong and really regular");

  // The Answer's last line, under it, taken out as a person would: then nothing follows the line.
  const last = editor.locator(":scope > p").last();
  await expect(last).toHaveText("That is all.");
  await slideSelect(window, last, "That is all.");
  await window.keyboard.press("Backspace");
  await window.keyboard.press("Backspace");
  await expect(editor.locator(":scope > p")).toHaveCount(2);

  // Selected, the menu offers the AI's actions; Shorten applies at once.
  // The words, then the space, the Citation and the full stop after them.
  await selectWords(window, note, "The tides here are very strong and really regular", 3);
  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId("selection-action-shorten")).toBeVisible();
  await expect(menu.getByTestId("selection-edit-field")).toHaveAttribute(
    "placeholder",
    "Edit with AI…",
  );
  await screenshot(window, "edit-menu-en");
  await pointAndClick(window, menu.getByTestId("selection-action-shorten"));
  await expect(note).toContainText("The tides here are strong and regular");
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await expect(window.getByTestId("proposal-spoken")).toHaveText("Changed 1 paragraph");

  // Review changes: what it removed, struck, over the text as it now is, and the cursor in the first change.
  await pointAndClick(window, line.getByTestId("applied-review"));
  const removed = note.locator("del.applied-old");
  await expect(removed).toHaveText(["very ", "really "]);
  await expect(removed.first()).toHaveCSS("text-decoration-line", "line-through");
  const restores = note.getByTestId("change-restore");
  await expect(restores).toHaveCount(2);
  await screenshot(window, "edit-changes-en");

  await pointAndClick(window, restores.first());
  await expect(removed).toHaveText(["really "]);
  await expect(note).toContainText("The tides here are very strong and");
  await expect(line.getByTestId("applied-count")).toHaveText("1 paragraph changed by Edit with AI");
  await expect(window.getByTestId("undo-message")).toHaveText("Restored the original");

  // Restore by keyboard, with the cursor at the other change: then none is left to show.
  await pointAndClick(window, removed.first());
  await expect(restores).toHaveCount(1);
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(removed).toHaveCount(0);
  await expect(line).toHaveCount(0);
  await expect(note).toContainText("The tides here are very strong and really regular");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(note).toContainText("The tides here are very strong and regular");
  // The Citation in the sentence is kept, and its quote still found.
  await expect(note.getByTestId("citation")).toHaveCount(1);
  await expect(note.getByTestId("citation")).toHaveAttribute("data-check", "found");
});

test("a whole Mind restructured with ⌘A and ⌘J keeps its headings, lists and Citation, applied at once, and Undo takes it back in one step (#703)", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  const tides = await window.evaluate(async () => {
    const documents = await (
      globalThis as unknown as { incarnamind: CoreBridge }
    ).incarnamind.listDocuments();
    const found = documents.find((each) => each.name.startsWith("Tides"));
    return found && { id: found.id, name: found.name, contentHash: found.contentHash };
  });
  if (!tides) throw new Error("Tides.pdf wasn't added.");
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();

  // Findings as bullets, one with a Citation; Decisions as numbered items; a closing line.
  const paragraphOf = (...content: object[]) => ({ type: "paragraph", content });
  const words = (text: string) => ({ type: "text", text });
  const items = (...lines: object[][]) =>
    lines.map((content) => ({ type: "listItem", content: [paragraphOf(...content)] }));
  await editor.evaluate(
    (dom, blocks) => {
      const { editor: tiptap } = dom as unknown as { editor: Editor };
      tiptap.commands.setContent(blocks);
    },
    [
      { type: "heading", attrs: { level: 2 }, content: [words("Findings")] },
      {
        type: "bulletList",
        content: items(
          [
            words("Spring tides happen at new moon. "),
            {
              type: "citation",
              attrs: {
                passageId: `passage-${tides.id}`,
                documentId: tides.id,
                documentName: tides.name,
                contentHash: tides.contentHash,
                pageFrom: 2,
                pageTo: 2,
                quote: "Spring tides happen at new moon and at full moon",
                check: "found",
              },
            },
          ],
          [words("Neap tides are the weakest.")],
        ),
      },
      { type: "heading", attrs: { level: 2 }, content: [words("Decisions")] },
      {
        type: "orderedList",
        content: items(
          [words("Publish the tide tables in March.")],
          [words("Check the harbour gauges weekly.")],
        ),
      },
      paragraphOf(words("Harbours publish the times of high water every year.")),
    ],
  );
  const headings = editor.locator(":scope > h2");
  const bullets = editor.locator(":scope > ul > li");
  const numbered = editor.locator(":scope > ol > li");
  await expect(headings).toHaveText(["Findings", "Decisions"]);

  // The whole Mind, then what to change.
  await editor.click();
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Restructure so the decisions come first. Cut the last paragraph.");
  await window.keyboard.press("Enter");

  // Decisions first, each Block still the kind it was, the Citation still found.
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toContainText("Changed");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(headings).toHaveText(["Decisions", "Findings"]);
  await expect(numbered).toHaveText([
    "Publish the tide tables in March.",
    "Check the harbour gauges weekly.",
  ]);
  await expect(bullets).toHaveCount(2);
  await expect(bullets.first()).toContainText("Spring tides happen at new moon.");
  await expect(bullets.first().getByTestId("citation")).toHaveAttribute("data-check", "found");
  await expect(bullets.last()).toHaveText("Neap tides are the weakest.");
  await expect(editor.locator(":scope > p")).not.toContainText(["Harbours publish"]);
  const order = await editor.evaluate((dom) =>
    [...dom.querySelectorAll(":scope > :is(h2, ol, ul, p)")].map(
      (child) => `${child.tagName}:${child.textContent?.slice(0, 12)}`,
    ),
  );
  // An empty paragraph the editor keeps at the end doesn't count.
  expect(order.filter((each) => each !== "P:")).toEqual([
    "H2:Decisions",
    "OL:Publish the ",
    "H2:Findings",
    "UL:Spring tides",
  ]);
  await screenshot(window, "edit-restructure-applied-en");

  // One Undo takes it all back: the Mind as it was.
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(line).toHaveCount(0);
  await expect(headings).toHaveText(["Findings", "Decisions"]);
  await expect(bullets).toHaveCount(2);
  await expect(bullets.first().getByTestId("citation")).toHaveAttribute("data-check", "found");
  await expect(editor.locator(":scope > p").last()).toHaveText(
    "Harbours publish the times of high water every year.",
  );
});

test("⌘J with text selected says what to change in the selection menu's field, in Chinese; the change applies at once, ⌘Z takes it back, and the line fits a narrow window", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 660);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("潮水每天非常规律地涨落两次。");
  const note = editor.locator(":scope > p").first();

  // ⌘J with the line selected: the menu's field takes the cursor, and the selection stays drawn.
  await selectWords(window, note, "潮水每天非常规律地涨落两次。");
  await window.keyboard.press("ControlOrMeta+j");
  const input = window.getByTestId("selection-menu").getByTestId("selection-edit-field");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "用 AI 编辑…");
  await expect(note.locator(".held-selection")).toHaveText("潮水每天非常规律地涨落两次。");
  await expect(window.getByTestId("composer-edit-quote")).toHaveCount(0);
  await window.keyboard.type("把规律换成准时");
  await screenshot(window, "edit-field-zh");
  await window.keyboard.press("Enter");

  await expect(note).toHaveText("潮水每天非常准时地涨落两次。");
  await expect(note.locator(".generated-text")).toHaveText("准时");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 1 个段落");
  await expect(line).toHaveAttribute("title", "原因：已按你的要求修改。");
  await expect(window.getByTestId("proposal-spoken")).toHaveText("修改了 1 个段落");
  await screenshot(window, "edit-applied-zh");
  // The line fits in the narrow window.
  const box = await line.getByTestId("applied-review").boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(900);

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(note).toHaveText("潮水每天非常规律地涨落两次。");
  await expect(line).toHaveCount(0);

  // Shorten from the menu, in Chinese: 非常 goes.
  await selectWords(window, note, "潮水每天非常规律地涨落两次。");
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText("潮水每天规律地涨落两次。");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 1 个段落");

  // Translate… asks for the language beside it. A text the model gives back as it was (the
  // scripted model only capitalises) says so in the composer, and changes nothing.
  await selectWords(window, note, "潮水每天规律地涨落两次。");
  await pointAndClick(window, window.getByTestId("selection-action-translate"));
  const languages = window.getByTestId("selection-choices-translate");
  await expect(languages).toBeVisible();
  await pointAndClick(window, languages.getByTestId("selection-choice-en"));
  const problem = window.getByTestId("edit-problem");
  await expect(problem).toContainText("没有要修改的地方");
  await expect(line).toHaveCount(0);
  await pointAndClick(window, problem.getByTestId("edit-problem-close"));
  await expect(problem).toHaveCount(0);
});

test("⌘J's change streams in and applies paragraph by paragraph, with Writing… on the next; the line says why; Stop keeps what is finished (#202)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1280, 820);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const line of [
    "The tides here are very strong and really regular.",
    "The moon is really bright over the harbour tonight.",
    "Harbours are very busy in the spring and really quiet in winter.",
  ]) {
    await window.keyboard.type(line);
    await window.keyboard.press("Enter");
  }
  const paragraphs = editor.locator(":scope > p");
  const writing = editor.getByTestId("mind-writing");
  const line = editor.getByTestId("applied-line");
  const shown = { useInnerText: true };

  const ask = async (instruction: string) => {
    await editor.click();
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type(instruction);
    await window.keyboard.press("Enter");
  };

  // The first paragraph reads as changed before the last has come; Writing… is on the one being written.
  await ask("Shorten this slowly");
  await expect(paragraphs.first()).toHaveText("The tides here are strong and regular.", shown);
  await expect(paragraphs.first().locator("del.proposal-delete").first()).toBeHidden();
  await expect(writing).toHaveText("Writing…");
  await expect(editor.getByTestId("mind-rewriting")).toHaveCount(1);
  await expect(paragraphs.nth(2)).toHaveText(
    "Harbours are very busy in the spring and really quiet in winter.",
    shown,
  );
  await expect(window.getByTestId("edit-pending")).toBeVisible();
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await screenshot(window, "edit-streaming-en");

  // Once done, Writing… goes, every change is in, and the line says why on hover.
  // Asked "slowly", the scripted model takes a few seconds over the rest.
  await expect(writing).toHaveCount(0, { timeout: 30_000 });
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 3 paragraphs");
  await expect(line).toHaveAttribute("title", "Why: Changed as you asked.");
  await expect(paragraphs).toHaveText([
    "The tides here are strong and regular.",
    "The moon is bright over the harbour tonight.",
    "Harbours are busy in the spring and quiet in winter.",
    "",
  ]);
  await screenshot(window, "edit-reason-en");
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs.first()).toHaveText("The tides here are very strong and really regular.");
  await expect(paragraphs.nth(2)).toHaveText(
    "Harbours are very busy in the spring and really quiet in winter.",
  );

  // Stop halfway keeps the finished paragraph's changes; the rest stays as it was.
  await ask("Shorten this slowly");
  await expect(paragraphs.first()).toHaveText("The tides here are strong and regular.", shown);
  await pointAndClick(window, window.getByTestId("edit-stop"));
  await expect(writing).toHaveCount(0);
  await expect(window.getByTestId("edit-pending")).toHaveCount(0);
  await expect(paragraphs.first()).toHaveText("The tides here are strong and regular.");
  await expect(paragraphs.nth(2)).toHaveText(
    "Harbours are very busy in the spring and really quiet in winter.",
  );
  await expect(line.getByTestId("applied-count")).toHaveText(/^Changed \d+ paragraphs?$/);

  // The next edit, asked right after Stop, has its own Undo: the stopped one's stays its own.
  await ask("replace tides with waves");
  await expect(paragraphs.first()).toHaveText("The waves here are strong and regular.");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs.first()).toHaveText("The tides here are strong and regular.");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs.first()).toHaveText("The tides here are very strong and really regular.");
});
