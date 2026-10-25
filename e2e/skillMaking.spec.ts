import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  interceptShowItemInFolder,
  interceptSkillPicker,
  launchApp,
  newMind,
  openSettings,
  openSteps,
  pathsShown,
  removeDataFolder,
  savedLine,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/**
 * Skills the User makes (#152): "Make this a Skill" drafts one from a Mind
 * with the scripted chat model, the User edits it in place and saves it, and
 * "/" in the composer uses it. Settings → Skills writes, edits, exports and
 * imports them. Set INCARNAMIND_SCREENSHOTS to a folder to also save pictures.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let outputs: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  outputs = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(outputs);
});

/** A Mind with a note, and one Question asked from it in the window's one assistant. */
async function mindWithWork(window: Page) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Their supply agreement came in on Monday.");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Review the liability cap");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  return editor;
}

test("Make this a Skill: the model drafts it from the Mind, the User edits it in place and saves it, and the composer's / uses it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const editor = await mindWithWork(window);

  // From the Mind's ⋯ menu in the sidebar: a card in the Mind, with the draft to edit.
  const row = window.getByTestId("mind-row").first();
  await row.hover();
  await row.getByTestId("mind-menu").click();
  await row.getByTestId("skill.fromMind").click();
  const card = window.getByTestId("make-skill-editor");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("make-skill-editor-name")).toHaveValue("scripted-review");
  await expect(card.getByTestId("make-skill-editor-when")).toHaveValue(
    'Use when asked to do the same as "Review the liability cap".',
  );
  await expect(card.getByTestId("make-skill-editor-steps")).toHaveValue(
    /^1\. Do what the Question asks: Review the liability cap\n2\. .*\n3\. Cite each finding\.$/,
  );
  await shot(window, "make-skill-draft");
  // The Mind is as it was: nothing of the draft is in its text, and nothing is saved yet.
  await expect(editor).not.toContainText("scripted-review");
  await openSettings(window, "skills");
  await expect(window.getByTestId("skills-yours")).not.toContainText("scripted-review");
  await closeSettings(window);

  // Edited in place: the name is written in the format's characters, and the draft is saved.
  await card.getByTestId("make-skill-editor-name").fill("Liability Cap Review");
  await card.getByTestId("make-skill-editor-when").fill("When I ask to review a liability cap.");
  await card.getByTestId("make-skill-editor-save").click();
  const saved = window.getByTestId("make-skill-saved");
  await expect(saved).toContainText("liability-cap-review");

  // It is in Settings → Skills, under Yours, with what was typed.
  await saved.getByTestId("make-skill-open-settings").click();
  const yours = window.getByTestId("skills-yours");
  const item = yours.locator('[data-testid="skill-item"][data-skill-name="liability-cap-review"]');
  await expect(item).toContainText("When I ask to review a liability cap.");
  await expect(item.getByTestId("skill-enabled")).toBeChecked();
  await shot(window, "skills-page-en-wide");
  await closeSettings(window);

  // "/" in the composer: the Skill is a chip, and the next Question uses it.
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("/liab");
  const picker = window.getByTestId("composer-skill-picker");
  await expect(picker.getByTestId("slash-item-skill-liability-cap-review")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await shot(window, "skill-picker");
  await window.keyboard.press("Enter");
  const composer = window.getByTestId("composer");
  await expect(composer.getByTestId("composer-skill")).toHaveText("liability-cap-review");
  await window.keyboard.type("Check the cap in the Halvard draft");
  await shot(window, "skill-chip");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).nth(1);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect((await openSteps(window, answer)).getByTestId("answer-skill")).toHaveAttribute(
    "data-skill-name",
    "liability-cap-review",
  );
  await expect(answer).toContainText("Following the Skill liability-cap-review.");
  await app.close();
});

/** ⌘K, "Make this a Skill", Enter: as the User types it. */
async function makeSkillFromPalette(window: Page) {
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Make this a Skill");
  await window.keyboard.press("Enter");
}

test("Make this a Skill from ⌘K; an empty Mind says there is nothing to learn from", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);

  await newMind(window);
  await makeSkillFromPalette(window);
  const empty = window.getByTestId("make-skill-empty");
  await expect(empty).toContainText("nothing in this Mind to make a Skill from");
  await empty.getByRole("button", { name: "Close" }).click();
  await expect(window.getByTestId("make-skill")).toHaveCount(0);

  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Notes on the Halvard contract.");
  await makeSkillFromPalette(window);
  const editor = window.getByTestId("make-skill-editor");
  await expect(editor.getByTestId("make-skill-editor-name")).toHaveValue("scripted-review");

  // Esc cancels and leaves nothing behind.
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("make-skill")).toHaveCount(0);
  await app.close();
});

test("a Skill name that is taken, an empty field and a too-long description are said under the field; Settings makes, edits and exports a Skill", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, outputs);
  await interceptShowItemInFolder(app);

  const settings = await openSettings(window, "skills");
  const section = settings.getByTestId("skills-settings");
  await expect(section.getByTestId("skills-yours")).toContainText("No Skills yet.");
  await expect(section.getByTestId("skills-built-in").getByTestId("skill-item")).toHaveCount(3);

  // New Skill…: a Built-in Skill's name is taken, and each field says what is wrong.
  await section.getByTestId("skill-new").click();
  const editor = section.getByTestId("skill-editor");
  await editor.getByTestId("skill-editor-save").click();
  await expect(editor.getByTestId("skill-editor-problem")).toContainText("name with letters");
  await editor.getByTestId("skill-editor-name").fill("Summarise Document");
  await editor.getByTestId("skill-editor-when").fill("When I ask for a summary.");
  await editor.getByTestId("skill-editor-steps").fill("1. Summarise it.");
  await editor.getByTestId("skill-editor-save").click();
  await expect(editor.getByTestId("skill-editor-problem")).toContainText(
    "A Skill named “summarise-document” already exists",
  );
  await editor.getByTestId("skill-editor-name").fill("合同审查");
  await editor.getByTestId("skill-editor-save").click();
  await expect(editor.getByTestId("skill-editor-problem")).toContainText("name with letters");
  await editor.getByTestId("skill-editor-name").fill("Harbour Notes");
  await editor.getByTestId("skill-editor-when").fill("x".repeat(1100));
  await editor.getByTestId("skill-editor-save").click();
  await expect(editor.getByTestId("skill-editor-problem")).toContainText("too long");
  await editor.getByTestId("skill-editor-when").fill("When I ask about harbour notes.");
  await editor.getByTestId("skill-editor-save").click();
  await expect(section.getByTestId("skill-editor")).toHaveCount(0);
  const item = section.locator('[data-testid="skill-item"][data-skill-name="harbour-notes"]');
  await expect(section.getByTestId("skills-yours").getByTestId("skill-item")).toHaveCount(1);

  // Edit: in place, in the row; the name can change.
  await item.getByTestId("skill-menu").click();
  await item.getByTestId("skill-edit").click();
  const edit = section.getByTestId("skill-editor");
  await expect(edit.getByTestId("skill-editor-steps")).toHaveValue("1. Summarise it.");
  await edit.getByTestId("skill-editor-steps").fill("1. Read the notes.\n2. Say what they hold.");
  await edit.getByTestId("skill-editor-save").click();
  await expect(item).toBeVisible();
  await item.getByTestId("skill-menu").click();
  await item.getByTestId("skill-edit").click();
  await expect(section.getByTestId("skill-editor-steps")).toHaveValue(
    "1. Read the notes.\n2. Say what they hold.",
  );
  await window.keyboard.press("Escape");

  // Export as zip: saved in the Output location, with a way to show it.
  await item.getByTestId("skill-menu").click();
  await item.getByTestId("skill-export").click();
  const done = section.getByTestId("skill-export-done");
  await expect(done).toContainText(savedLine("harbour-notes.zip", outputs));
  await shot(window, "skill-export-saved");
  const zip = join(outputs, "harbour-notes.zip");
  expect((await readFile(zip)).subarray(0, 2).toString()).toBe("PK");
  await done.getByTestId("skill-export-show").click();
  await expect
    .poll(async () => (await pathsShown(app)).map((path) => path.split(/[\\/]/).at(-1)))
    .toEqual(["harbour-notes.zip"]);

  // The zip imports again with the same preview: its name, what it is for and its one file.
  await interceptSkillPicker(window, zip);
  await section.getByTestId("skill-import").click();
  await section.getByTestId("skill-import-zip").click();
  const preview = section.getByTestId("skill-preview");
  await expect(preview.getByTestId("skill-preview-name")).toHaveText("harbour-notes");
  await expect(preview.getByTestId("skill-preview-description")).toHaveText(
    "When I ask about harbour notes.",
  );
  await expect(preview.getByTestId("skill-preview-replaces")).toContainText("harbour-notes");
  await preview.getByText(/^1 file/).click();
  await expect(preview.getByTestId("skill-preview-file")).toHaveText([/SKILL\.md/]);
  await preview.getByTestId("skill-import-confirm").click();
  await expect(section.getByTestId("skills-yours").getByTestId("skill-item")).toHaveCount(1);
  await setWindowSize(app, window, 900, 700);
  await shot(window, "skills-page-en-narrow");
  await app.close();
});

test("a zip that isn't a Skill, or is broken, is refused with a reason, and nothing changes", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const settings = await openSettings(window, "skills");
  const section = settings.getByTestId("skills-settings");

  const broken = join(outputs, "broken.zip");
  await writeFile(broken, "not a zip");
  await interceptSkillPicker(window, broken);
  await section.getByTestId("skill-import").click();
  await section.getByTestId("skill-import-zip").click();
  await expect(section.getByTestId("skill-import-error")).toHaveAttribute(
    "data-kind",
    "invalid-zip",
  );
  await expect(section.getByTestId("skills-yours").getByTestId("skill-item")).toHaveCount(0);
  await app.close();
});

test("in Chinese and in a narrow window: the Skills page, the draft and the picker hold their layout", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, outputs);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: import("../src/core/api").CoreBridge })
      .incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await setWindowSize(app, window, 900, 700);
  const editor = await mindWithWork(window);

  const row = window.getByTestId("mind-row").first();
  await row.hover();
  await row.getByTestId("mind-menu").click();
  await row.getByTestId("skill.fromMind").click();
  const card = window.getByTestId("make-skill-editor");
  await expect(card).toBeVisible();
  await expect(card).toContainText("根据这个 Mind 生成的草稿");
  const box = await card.boundingBox();
  const mind = await editor.boundingBox();
  expect(box && mind && box.x + box.width <= mind.x + mind.width + 1).toBe(true);
  await shot(window, "make-skill-draft-zh-narrow");
  await card.getByTestId("make-skill-editor-save").click();

  await window.getByRole("button", { name: "设置" }).click();
  await window.getByTestId("settings-nav-skills").click();
  await expect(window.getByTestId("skills-yours")).toContainText("scripted-review");
  const saved = window.getByTestId("skills-yours").getByTestId("skill-item").first();
  await saved.getByTestId("skill-menu").click();
  await saved.getByTestId("skill-export").click();
  await expect(window.getByTestId("skill-export-done")).toContainText(
    savedLine("scripted-review.zip", outputs, "zh-CN"),
  );
  await shot(window, "skills-page-zh-narrow");
  await window.getByRole("button", { name: "关闭设置" }).click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("/");
  await expect(window.getByTestId("composer-skill-picker")).toContainText("管理技能…");
  await shot(window, "skill-picker-zh-narrow");
  await app.close();
});
