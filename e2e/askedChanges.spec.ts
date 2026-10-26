import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  focusSettled,
  forceQuit,
  frontMindName,
  launchApp,
  nameMind,
  newMind,
  openPageMenu,
  openSteps,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * What the assistant writes or changes applies at once (#880, #1559): the
 * owner's own two requests, "write a summary page", then "make it longer". The scripted model (src/main/fakeChat/minds.ts) makes a page with
 * a short summary, then has Edit with AI add a sentence to each paragraph;
 * asked to rewrite the User's notes "to be clearer", it writes two new
 * paragraphs in place of them, which wait.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const SPRING = "Spring tides come at new and full moon, when the Sun and the Moon pull together.";
const NEAP = "Neap tides come in between, at the quarter moons.";

test("“write a summary page” makes the page with the summary applied, “make it longer” changes it applied too, each Answer's line says so with Undo, and each request is one step of Undo", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);

  const first = await askInAssistant(window, "write a summary page");
  await expect(window.getByTestId("mind-tab").filter({ hasText: "Summary" })).toBeVisible();
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText([SPRING, NEAP]);
  await expect(editor.locator("ins.proposal-insert, [data-proposal]")).toHaveCount(0);
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("Wrote 2 paragraphs");
  await expect(first.getByTestId("mind-changes-title")).toHaveText("Wrote “Summary”");
  await expect(first.getByTestId("mind-changes-open")).toBeVisible();
  await expect(first.getByTestId("mind-changes-undo")).toBeVisible();
  await expect(first.getByTestId("mind-changes-review")).toHaveText("Review changes");
  await screenshot(window, "asked-write-en");
  await setLanguage(window, "zh-CN");
  await expect(first.getByTestId("mind-changes-title")).toHaveText("已写入“Summary”");
  await setLanguage(window, "en");

  const second = await askInAssistant(window, "make it longer");
  await expect(paragraphs).toHaveText([`${SPRING} It says more.`, `${NEAP} It says more.`]);
  await expect(editor.locator("ins.proposal-insert, del.proposal-delete")).toHaveCount(0);
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 2 paragraphs");
  await expect(second.getByTestId("mind-changes-title")).toHaveText(
    "Changed 2 paragraphs in “Summary”",
  );
  await screenshot(window, "asked-edit-en");
  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 2 个段落");
  await expect(second.getByTestId("mind-changes-title")).toHaveText("已修改“Summary”中的 2 段");
  await setLanguage(window, "en");

  // Review changes is the Mind's own line's: it shows what was added, the text still applied.
  await pointAndClick(window, line.getByTestId("applied-review"));
  await expect(line.getByTestId("applied-count")).toHaveText(
    "2 paragraphs changed by the assistant",
  );
  await expect(editor.locator(".applied-new")).toHaveText([" It says more.", " It says more."]);
  await pointAndClick(window, line.getByTestId("applied-done"));
  await expect(paragraphs).toHaveText([`${SPRING} It says more.`, `${NEAP} It says more.`]);

  const longer = [`${SPRING} It says more.`, `${NEAP} It says more.`];
  // The Answer `askInAssistant` gave is the last one, whichever that is now.
  const summary = assistantAnswers(window).first();
  const firstUndo = summary.getByTestId("mind-changes-undo");
  const secondUndo = second.getByTestId("mind-changes-undo");
  // The summary's isn't the last edit applied, so Review changes is the longer text's, and its line doesn't point there.
  const changedSince = "“Summary” changed since, so this can’t be undone here.";
  await expect(summary.getByTestId("mind-changes-review")).toHaveCount(0);
  await expect(second.getByTestId("mind-changes-review")).toBeVisible();

  // Each line undoes its own request: the summary's can't while the longer text is on top of it.
  await expect(firstUndo).toHaveAttribute("aria-disabled", "true");
  await expect(firstUndo).toHaveAttribute("title", changedSince);
  await expect(secondUndo).not.toHaveAttribute("aria-disabled");
  await screenshot(window, "asked-undo-since-en");
  await pointAndClick(window, firstUndo);
  await expect(paragraphs).toHaveText(longer);
  await pointAndClick(window, secondUndo);
  await expect(paragraphs).toHaveText([SPRING, NEAP]);
  await expect(second.getByTestId("mind-changes-undone")).toHaveText("Undone");
  await expect(firstUndo).not.toHaveAttribute("aria-disabled");

  // The line's Undo follows the step created by Redo in the Mind.
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(paragraphs).toHaveText(longer);
  await expect(secondUndo).not.toHaveAttribute("aria-disabled");
  await expect(firstUndo).toHaveAttribute("aria-disabled", "true");
  await pointAndClick(window, secondUndo);
  await expect(paragraphs).toHaveText([SPRING, NEAP]);
  await expect(second.getByTestId("mind-changes-undone")).toBeVisible();

  // Typed after the summary, its line says why it can't undo it, until the typing is taken back.
  await paragraphs.last().click();
  await window.keyboard.press("End");
  await window.keyboard.type(" Typed.");
  await expect(paragraphs.last()).toHaveText(`${NEAP} Typed.`);
  await expect(firstUndo).toHaveAttribute("aria-disabled", "true");
  await expect(async () => {
    if ((await paragraphs.last().textContent())?.includes("Typed")) {
      await window.keyboard.press("ControlOrMeta+z");
    }
    await expect(paragraphs).toHaveText([SPRING, NEAP]);
  }).toPass();
  await expect(firstUndo).not.toHaveAttribute("aria-disabled");
  await pointAndClick(window, firstUndo);
  await expect(editor).not.toContainText("Spring tides");
  await expect(summary.getByTestId("mind-changes-undone")).toHaveText("Undone");
});

test("typed elsewhere after “make it longer”, the line goes but Review changes stays in ⌘K, the Mind's ⋯ and the Answer's card: a change the User edited says so with no Restore, the other restores and leaves their writing, ⌘Z takes the Restore back, and with none left the entries and the hint's pointer go, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await askInAssistant(window, "write a summary page");
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText([SPRING, NEAP]);
  const answer = await askInAssistant(window, "make it longer");
  const longer = [`${SPRING} It says more.`, `${NEAP} It says more.`];
  await expect(paragraphs).toHaveText(longer);
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 2 paragraphs");

  const OWN = "My own note on the harbour.";
  // At its end: in a paragraph that long, its middle is inside the words, and End doesn't move a Mac's caret.
  const box = await paragraphs.last().boundingBox();
  const end = { x: (box?.width ?? 2) - 2, y: (box?.height ?? 8) - 4 };
  await paragraphs.last().click({ position: end });
  await focusSettled(window, editor);
  await window.keyboard.press("Enter");
  await window.keyboard.type(OWN);
  await expect(paragraphs).toHaveText([...longer, OWN]);
  await expect(line).toHaveCount(0);

  const undo = answer.getByTestId("mind-changes-undo");
  const review = answer.getByTestId("mind-changes-review");
  await expect(undo).toHaveAttribute("aria-disabled", "true");
  await expect(undo).toHaveAttribute(
    "title",
    /^“Summary” changed since\. Review changes is in ⋯ and (⌘K|Ctrl\+K)\.$/,
  );
  await expect(review).toHaveText("Review changes");
  await screenshot(window, "asked-review-after-typing-en");
  await setLanguage(window, "zh-CN");
  await expect(undo).toHaveAttribute(
    "title",
    /^“Summary”之后又改过了。“查看改动”在 ⋯ 和 (⌘K|Ctrl\+K) 里。$/,
  );
  await expect(review).toHaveText("查看改动");
  await setLanguage(window, "en");

  // The Mind's ⋯ offers it, and opens the same Review as ⌘K and the card.
  const menu = await openPageMenu(window);
  await pointAndClick(window, menu.getByTestId("page-review-changes"));
  const count = line.getByTestId("applied-count");
  await expect(count).toHaveText("2 paragraphs changed by the assistant");
  await expect(editor.getByTestId("change-restore")).toHaveCount(2);
  await pointAndClick(window, line.getByTestId("applied-done"));
  await runCommand(window, "edit.reviewApplied", "Review changes");
  await expect(count).toHaveText("2 paragraphs changed by the assistant");
  // Changed since, the edit can't be taken back whole: ⌘K doesn't offer it.
  expect(await paletteOffers(window, "edit.undoApplied", "Undo the AI edit")).toBe(0);
  await expect(count).toBeVisible();
  await pointAndClick(window, line.getByTestId("applied-done"));
  await pointAndClick(window, review);
  await expect(count).toHaveText("2 paragraphs changed by the assistant");
  await expect(editor.locator(".applied-new")).toHaveText([" It says more.", " It says more."]);
  await pointAndClick(window, line.getByTestId("applied-done"));

  // Typed inside the first change's words: it says so, has no Restore, and ⌘⌫ there replaces nothing.
  await slideSelect(window, paragraphs.first(), "more");
  await window.keyboard.type("plenty");
  const edited = `${SPRING} It says plenty.`;
  await expect(paragraphs.first()).toHaveText(edited);
  await pointAndClick(window, review);
  await expect(paragraphs.first().getByTestId("change-changed-since")).toHaveText(
    "You changed this since",
  );
  await expect(paragraphs.first().getByTestId("change-restore")).toHaveCount(0);
  await expect(paragraphs.nth(1).getByTestId("change-restore")).toHaveText("Restore original");
  await screenshot(window, "asked-review-changed-since-en");
  await setLanguage(window, "zh-CN");
  await expect(paragraphs.first().getByTestId("change-changed-since")).toHaveText("你之后改过这里");
  await expect(paragraphs.nth(1).getByTestId("change-restore")).toHaveText("恢复原文");
  await screenshot(window, "asked-review-changed-since-zh");
  await setLanguage(window, "en");
  await pointAndClick(window, paragraphs.first().locator(".applied-new").first());
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(paragraphs.first()).toContainText(edited);
  await expect(paragraphs.first().getByTestId("change-changed-since")).toBeVisible();

  // The other restores alone: the User's own paragraph and their edit stay, and ⌘Z takes the Restore back.
  await pointAndClick(window, paragraphs.nth(1).getByTestId("change-restore"));
  await expect(window.getByTestId("undo-message")).toHaveText("Restored the original");
  await expect(paragraphs.nth(1)).not.toContainText("It says more.");
  await expect(paragraphs.last()).toHaveText(OWN);
  await expect(paragraphs.first()).toContainText(edited);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs.nth(1)).toContainText(`${NEAP} It says more.`);
  await expect(paragraphs.nth(1).getByTestId("change-restore")).toBeVisible();
  await expect(paragraphs.last()).toHaveText(OWN);
  await pointAndClick(window, paragraphs.nth(1).getByTestId("change-restore"));
  await expect(paragraphs.nth(1)).not.toContainText("It says more.");
  await pointAndClick(window, line.getByTestId("applied-done"));
  await expect(paragraphs).toHaveText([edited, NEAP, OWN]);

  // Nothing left to restore: no entries, and the hint no longer points to one.
  expect(await paletteOffers(window, "edit.reviewApplied", "Review changes")).toBe(0);
  const after = await openPageMenu(window);
  await expect(after.getByTestId("page-style")).toBeVisible();
  await expect(after.getByTestId("page-review-changes")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(undo).toHaveAttribute(
    "title",
    "“Summary” changed since, so this can’t be undone here.",
  );
  await setLanguage(window, "zh-CN");
  await expect(undo).toHaveAttribute("title", "“Summary”之后又改过了，无法在这里撤销。");
});

test("an Answer written again replaces what it applied with what it writes now, and its card can undo it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await askInAssistant(window, "write a summary page");
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText([SPRING, NEAP]);

  const answer = await askInAssistant(window, "make it longer");
  await expect(paragraphs).toHaveText([`${SPRING} It says more.`, `${NEAP} It says more.`]);
  const firstWrite = await changeRequestOf(window);
  await openSteps(window, answer);
  await pointAndClick(window, answer.getByTestId("answer-regenerate"));
  await expect
    .poll(async () => {
      const now = await changeRequestOf(window);
      return now !== null && now !== firstWrite;
    })
    .toBe(true);
  await expect(answer.getByTestId("mind-changes-undo")).not.toHaveAttribute("aria-disabled");
  await expect(paragraphs).toHaveText([`${SPRING} It says more.`, `${NEAP} It says more.`]);
  await expect(editor.locator("ins.proposal-insert, del.proposal-delete")).toHaveCount(0);
  await pointAndClick(window, answer.getByTestId("mind-changes-undo"));
  await expect(paragraphs).toHaveText([SPRING, NEAP]);
  await expect(answer.getByTestId("mind-changes-undone")).toHaveText("Undone");

  // Written again after the Mind changed, the new change comes on top, and the card says so.
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(paragraphs).toHaveText([`${SPRING} It says more.`, `${NEAP} It says more.`]);
  await paragraphs.last().click();
  await window.keyboard.press("End");
  await window.keyboard.type(" Typed.");
  await expect(paragraphs.last()).toHaveText(`${NEAP} It says more. Typed.`);
  const secondWrite = await changeRequestOf(window);
  await openSteps(window, answer);
  await pointAndClick(window, answer.getByTestId("answer-regenerate"));
  await expect
    .poll(async () => {
      const now = await changeRequestOf(window);
      return now !== null && now !== secondWrite;
    })
    .toBe(true);
  await expect(answer.getByTestId("mind-changes-on-top")).toHaveText(
    "· on top of the earlier version, which stays",
  );
  await expect(paragraphs.first()).toHaveText(`${SPRING} It says more. It says more.`);
  await screenshot(window, "asked-on-top-en");
});

const NOTES = [
  "Tides rise twice a day along this coast.",
  "The harbour office posts the times each week.",
];

test("a rewrite that would take out most of the User's own text waits, in English and Chinese: Apply applies it as one step of Undo, and Discard leaves the text", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1100, 860);
  await newMind(window);
  await nameMind(window, "Harbour notes");
  await enterContent(window);
  await window.keyboard.type(NOTES[0] ?? "");
  await window.keyboard.press("Enter");
  await window.keyboard.type(NOTES[1] ?? "");
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText(NOTES);

  const answer = await askInAssistant(window, "Rewrite the intro to be clearer");
  await expect(answer.getByTestId("mind-changes-left")).toHaveText("· 2 changes waiting");
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "Waiting for you: this rewrites most of your text",
  );
  // Each paragraph written anew reads whole, its old text one line above it, struck on a click (#1028).
  const was = editor.getByTestId("change-was-line").first();
  await expect(was).toBeVisible();
  await expect(editor.locator("del.proposal-delete").first()).toBeHidden();
  await pointAndClick(window, was.getByTestId("change-was"));
  await expect(editor.locator("del.proposal-delete").first()).toBeVisible();
  await screenshot(window, "asked-held-en");
  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "等你确认：这会改写你自己写的大部分内容",
  );
  await setLanguage(window, "en");

  await pointAndClick(window, line.getByTestId("applied-discard"));
  await expect(paragraphs).toHaveText(NOTES);
  await expect(answer.getByTestId("mind-changes-left")).toHaveText("· none waiting");
  // The text keeps the focus, a frame later: ⌘J before that would lose the composer's.
  await expect(editor).toBeFocused();

  await askInAssistant(window, "Rewrite the intro to be clearer");
  const spoken = window.getByTestId("proposal-spoken");
  await pointAndClick(window, editor.locator("ins.proposal-insert", { hasText: "Gulls" }));
  await expect(spoken).toContainText("Suggested change");
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(paragraphs).toHaveText([
    "Gulls wheel over the quay at dawn.",
    "Boats rest on the mud at low water.",
  ]);
  await expect(line.getByTestId("applied-count")).toHaveText(/^Changed \d+ paragraphs?$/);
  await expect(spoken).not.toContainText("Suggested change");
  await expect(spoken).toHaveText(/^Changed \d+ paragraphs?$/);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText(NOTES);

  await setLanguage(window, "zh-CN");
  await askInAssistant(window, "Rewrite the intro to be clearer");
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(spoken).toHaveText(/^修改了 \d+ 个段落$/);
  await setLanguage(window, "en");
});

/** The request the newest Answer's change made, once that Answer is done; null before. */
function changeRequestOf(window: Page): Promise<string | null> {
  return window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [conversation] = await core.listConversations();
    if (!conversation) return null;
    const { messages } = await core.getConversation(conversation.id);
    const answer = messages.filter((message) => message.kind === "answer").at(-1);
    if (answer?.kind !== "answer" || answer.status !== "done") return null;
    return answer.toolCalls.find((call) => call.mindChange)?.mindChange?.request ?? null;
  });
}

/** A new Mind, named, and its Notes typed as a person types them. */
async function writeMind(window: Page, title: string, notes: readonly string[]): Promise<void> {
  await newMind(window);
  await nameMind(window, title);
  await enterContent(window);
  for (const [index, note] of notes.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(note);
  }
}

async function askClosingTarget(window: Page, question: string, other: string) {
  const before = await window.getByTestId("assistant-question").count();
  const pending = askInAssistant(window, question);
  await expect(window.getByTestId("assistant-question")).toHaveCount(before + 1);
  await expect(window.getByTestId("assistant-question").last()).toContainText(question);
  await window.keyboard.press("ControlOrMeta+w");
  await pointAndClick(window, window.getByTestId("sidebar").getByText(other, { exact: true }));
  return pending;
}

interface Presentation {
  applied: boolean;
  open: boolean;
}

async function watchApplication(window: Page, title: string): Promise<void> {
  await window.evaluate(async (name) => {
    const root = globalThis as unknown as {
      incarnamind: CoreBridge;
      applyPresentation?: Presentation[];
    };
    root.applyPresentation = [];
    const minds = await root.incarnamind.listMinds();
    const mindId = minds.find((mind) => mind.title === name)?.id;
    if (!mindId) throw new Error(`No Mind named ${name}`);
    root.incarnamind.on("mind.update", ({ mindId: changed }) => {
      if (changed !== mindId) return;
      root.applyPresentation?.push({
        applied: document.querySelector('[data-testid="mind-changes-title"]') !== null,
        open: [...document.querySelectorAll('[data-testid="mind-tab"]')].some((tab) =>
          tab.textContent?.includes(name),
        ),
      });
    });
  }, title);
}

const applicationPresentations = (window: Page): Promise<Presentation[]> =>
  window.evaluate(
    () => (globalThis as unknown as { applyPresentation?: Presentation[] }).applyPresentation ?? [],
  );

test("a section added and a rewrite of the User's text beside it both apply, in one line", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Harbour notes", NOTES);
  const editor = window.getByTestId("mind-editor");

  const answer = await askInAssistant(window, "Add a section on the risks");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Changed 3 paragraphs in “Harbour notes”",
  );
  await expect(answer.getByTestId("mind-changes-left")).toHaveCount(0);
  await expect(editor.locator("del.proposal-delete, ins.proposal-insert")).toHaveCount(0);
  await expect(editor).toContainText("The supplier is late.");
  await pointAndClick(window, answer.getByTestId("mind-changes-undo"));
  await expect(editor.locator(":scope > p")).toHaveText(NOTES);
});

test("asked to write in a Mind not in view, the assistant opens it in a tab beside the one in view and writes there, applied", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Project plan", ["Hire a designer."]);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  const tabs = window.getByTestId("mind-tab");
  await expect(tabs).toHaveCount(2);

  const answer = await askInAssistant(window, "Add a note about the meeting to Project plan");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Wrote 1 paragraph in “Project plan”",
  );
  await expect(tabs.filter({ hasText: "Q3 review" })).toHaveCount(1);
  await expect(tabs.filter({ hasText: "Project plan" })).toHaveCount(1);
  await expect(frontMindName(window)).toHaveText("Project plan");
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator(":scope > p")).toHaveText([
    "Hire a designer.",
    "a note about the meeting",
  ]);
  await expect(editor.getByTestId("applied-count")).toHaveText("Wrote 1 paragraph");
  await expect(answer.getByTestId("mind-changes-review")).toHaveText("Review changes");
  await pointAndClick(window, answer.getByTestId("mind-changes-review"));
  await expect(editor.locator(".applied-new")).toHaveText("a note about the meeting");
  await pointAndClick(window, editor.getByTestId("applied-done"));
  await pointAndClick(window, answer.getByTestId("mind-changes-undo"));
  await expect(editor.locator(":scope > p")).toHaveText(["Hire a designer."]);
});

// Value: protects=unopened destructive rewrites wait for the User; fails_when=core accepts early or Apply/Discard breaks; why_new=held e2e used an open editor; seam=none; no_claim=real-model rewrite quality (scripted model)
test("an unopened destructive rewrite waits, then Discard and Apply each keep their one-step behavior", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Harbour notes", NOTES);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "Harbour notes" }));
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");

  const answer = await askClosingTarget(
    window,
    "Rewrite the intro to be clearer slowly",
    "Q3 review",
  );
  await expect(answer.getByTestId("mind-changes-left")).toHaveText("· 2 changes waiting");
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "Waiting for you: this rewrites most of your text",
  );
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(paragraphs).toHaveText([
    "Gulls wheel over the quay at dawn.",
    "Boats rest on the mud at low water.",
  ]);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText(NOTES);

  await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "Harbour notes" }));
  const discarded = await askClosingTarget(
    window,
    "Rewrite the intro to be clearer slowly",
    "Q3 review",
  );
  await expect(discarded.getByTestId("mind-changes-left")).toHaveText("· 2 changes waiting");
  await pointAndClick(window, line.getByTestId("applied-discard"));
  await expect(paragraphs).toHaveText(NOTES);
  await expect(discarded.getByTestId("mind-changes-left")).toHaveText("· none waiting");
});

// Value: protects=rich Review and safe core Undo after later typing; fails_when=restore misanchors or stale Undo overwrites writing; why_new=core e2e reviewed only appended text; seam=none; no_claim=real-model content (scripted model)
test("an unopened section and rewrite reviews and restores, and later typing disables core Undo", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Harbour notes", NOTES);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "Harbour notes" }));
  await watchApplication(window, "Harbour notes");

  const answer = await askClosingTarget(window, "Add a section on the risks slowly", "Q3 review");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Changed 3 paragraphs in “Harbour notes”",
  );
  await expect
    .poll(async () => (await applicationPresentations(window)).some((each) => each.applied))
    .toBe(true);
  const presentations = await applicationPresentations(window);
  expect(presentations.length).toBeGreaterThan(0);
  expect(presentations[0]).toEqual({ applied: false, open: false });
  expect(presentations.every((each) => !each.open)).toBe(true);
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(editor).toContainText("The supplier is late.");
  const box = await paragraphs.last().boundingBox();
  await paragraphs.last().click({
    position: { x: (box?.width ?? 2) - 2, y: (box?.height ?? 8) - 4 },
  });
  await focusSettled(window, editor);
  await window.keyboard.press("Enter");
  await window.keyboard.type("My later note.");
  await expect(paragraphs.last()).toHaveText("My later note.");
  await expect(answer.getByTestId("mind-changes-undo")).toHaveAttribute("aria-disabled", "true");

  await pointAndClick(window, answer.getByTestId("mind-changes-review"));
  await expect(editor.getByTestId("change-restore").first()).toBeVisible();
  await pointAndClick(window, editor.getByTestId("change-restore").first());
  await expect(paragraphs.first()).toHaveText(NOTES[0] ?? "");
  await expect(paragraphs.last()).toHaveText("My later note.");
  await expect(answer.getByTestId("mind-changes-undone")).toHaveCount(0);
  await pointAndClick(window, editor.getByTestId("applied-done"));
});

// Value: protects=core-applied re-ask replaces exactly once; fails_when=stale Undo races new writing or duplicates text; why_new=regeneration used editor-owned steps; seam=none; no_claim=real-model regeneration (scripted model)
test("a core-applied Answer can be written again without losing or duplicating text", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Project plan", ["Hire a designer."]);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  await pointAndClick(window, window.getByTestId("mind-tab").filter({ hasText: "Project plan" }));

  const answer = await askClosingTarget(
    window,
    "Add a note about the meeting to Project plan slowly",
    "Q3 review",
  );
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Wrote 1 paragraph in “Project plan”",
  );
  const firstRequest = await changeRequestOf(window);
  await openSteps(window, answer);
  await pointAndClick(window, answer.getByTestId("answer-regenerate"));
  await expect
    .poll(
      async () => {
        const now = await changeRequestOf(window);
        return now !== null && now !== firstRequest;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator(":scope > p")).toHaveText([
    "Hire a designer.",
    "a note about the meeting",
  ]);
  await expect(editor.locator("ins.proposal-insert, del.proposal-delete")).toHaveCount(0);
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Wrote 1 paragraph in “Project plan”",
  );
  await pointAndClick(window, answer.getByTestId("mind-changes-undo"));
  await expect(editor.locator(":scope > p")).toHaveText(["Hire a designer."]);
  await expect(answer.getByTestId("mind-changes-undone")).toHaveText("Undone");
  await expect(window.getByTestId("undo-message")).toHaveCount(0);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor.locator(":scope > p")).toHaveText([
    "Hire a designer.",
    "a note about the meeting",
  ]);
  await expect(answer.getByTestId("mind-changes-undo")).not.toHaveAttribute("aria-disabled");
  await pointAndClick(window, answer.getByTestId("mind-changes-undo"));
  await expect(editor.locator(":scope > p")).toHaveText(["Hire a designer."]);
});

test("a change in a Mind that isn't open applies in the core and survives a restart", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Project plan", ["Hire a designer."]);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  const answer = await askInAssistant(window, "Add a note about the meeting to Project plan");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Wrote 1 paragraph in “Project plan”",
  );
  await window.keyboard.press("ControlOrMeta+w");
  await forceQuit(app);

  const restarted = await launchApp(dataDir, { fakeChat: true });
  await pointAndClick(
    restarted.window,
    restarted.window.getByTestId("sidebar").getByText("Project plan", { exact: true }),
  );
  await expect(restarted.window.getByTestId("mind-editor").locator(":scope > p")).toHaveText([
    "Hire a designer.",
    "a note about the meeting",
  ]);
  await expect(
    restarted.window.getByTestId("mind-editor").locator("ins.proposal-insert, del.proposal-delete"),
  ).toHaveCount(0);
  await restarted.window.keyboard.press("ControlOrMeta+k");
  const palette = restarted.window.getByTestId("palette");
  await expect(palette).toBeVisible();
  await restarted.window.keyboard.type("Add a note about the meeting to Project plan");
  const found = palette
    .locator('[data-testid="palette-group"][data-group="conversations"]')
    .getByTestId("palette-item")
    .first();
  await expect(found).toBeVisible();
  await pointAndClick(restarted.window, found);
  const restoredAnswer = assistantAnswers(restarted.window).last();
  await expect(restoredAnswer).toBeVisible();
  await expect(restoredAnswer.getByTestId("mind-changes-undo")).toHaveCount(0);
  await expect(restoredAnswer.getByTestId("mind-changes-review")).toHaveCount(0);
  await expect(restarted.window.getByTestId("applied-review")).toHaveCount(0);
  await restarted.app.close();
});

test("a reply that claims a write no call made is asked for once more, then stays with a line under it saying nothing was written, with Try again, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1100, 860);
  await writeMind(window, "Q3 review", ["The quarter was good."]);
  const editor = window.getByTestId("mind-editor");

  const answer = await askInAssistant(window, "Say you added the risks");
  const line = answer.getByTestId("answer-unbacked-claim");
  await expect(line).toHaveText(
    "Nothing was written: the assistant didn’t run the write · Try again",
  );
  await expect(answer.getByTestId("assistant-answer-text")).toHaveText(
    "I've added a risks section to “Q3 review”.",
  );
  await expect(answer.getByTestId("mind-changes")).toHaveCount(0);
  await expect(editor.locator(":scope > p")).toHaveText(["The quarter was good."]);
  await screenshot(window, "not-written-en");
  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("未写入任何内容：助手没有执行写入 · 重试");
  await setLanguage(window, "en");

  await pointAndClick(window, line.getByTestId("answer-unbacked-retry"));
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(line).toBeVisible();
});
