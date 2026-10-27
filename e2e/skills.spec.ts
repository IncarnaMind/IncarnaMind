import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  interceptSkillPicker,
  launchApp,
  newMind,
  openSettings,
  openSteps,
  removeDataFolder,
  useLocalChatModel,
} from "./app";

const DESCRIPTION = "Reads tide tables. Use for questions about high and low water.";

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

/** A small Skill folder: instructions, a reference and a script. */
async function writeTideSkill(): Promise<string> {
  const folder = join(sources, "tide-tables");
  await mkdir(join(folder, "references"), { recursive: true });
  await mkdir(join(folder, "scripts"), { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: tide-tables\ndescription: ${DESCRIPTION}\nlicense: MIT\n---\n\n# Tide tables\n\nRead references/ports.md first.\n`,
  );
  await writeFile(join(folder, "references", "ports.md"), "Brest, Plymouth and Saint-Malo.\n");
  await writeFile(join(folder, "scripts", "convert.py"), "print('metres to feet')\n");
  return folder;
}

test("a Skill imported from a folder in Settings is forced from the slash menu in a Question, shown as a chip, and the Answer shows it as a Skill card", async () => {
  const folder = await writeTideSkill();
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);

  // Settings → Skills: the folder (picked through the test hook) is shown first, then imported.
  await openSettings(window, "skills");
  const section = window.getByTestId("skills-settings");
  // Only the built-in Skills so far (e2e/builtInSkills.spec.ts covers them).
  const item = section.locator('[data-testid="skill-item"][data-skill-name="tide-tables"]');
  await expect(section.getByTestId("skill-item")).toHaveCount(9);
  await expect(item).toHaveCount(0);
  await interceptSkillPicker(window, folder);
  await section.getByTestId("skill-import").click();
  await section.getByTestId("skill-import-folder").click();
  const preview = section.getByTestId("skill-preview");
  await expect(preview.getByTestId("skill-preview-name")).toHaveText("tide-tables");
  await expect(preview.getByTestId("skill-preview-description")).toHaveText(DESCRIPTION);
  await expect(preview).toContainText("License: MIT");
  await preview.getByText(/^3 files/).click();
  const files = preview.getByTestId("skill-preview-file");
  await expect(files).toHaveCount(3);
  await expect(files.nth(0)).toContainText("SKILL.md");
  await expect(files.nth(1)).toContainText("references/ports.md");
  await expect(files.nth(2)).toContainText("scripts/convert.py");
  await expect(files.nth(2)).toContainText("script: runs only with your approval");
  await preview.getByTestId("skill-import-confirm").click();

  await expect(section.getByTestId("skill-item")).toHaveCount(10);
  await expect(item).toHaveAttribute("data-built-in", "false");
  await expect(section.getByTestId("skills-yours").getByTestId("skill-item")).toHaveCount(1);
  await expect(item.getByTestId("skill-enabled")).toBeChecked();
  await expect(item).toContainText(DESCRIPTION);
  await expect(item).toContainText("License: MIT · 1 script");
  await expect(section.getByTestId("skill-preview")).toHaveCount(0);
  await closeSettings(window);

  // In the composer, "/" offers the Skills only; choosing one shows it as a chip.
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("/tide");
  const menu = window.getByTestId("composer-skill-picker");
  await expect(menu.getByTestId("slash-item-skill-tide-tables")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(menu.getByTestId("slash-item-heading-1")).toHaveCount(0);
  await window.keyboard.press("Enter");
  const composer = window.getByTestId("composer");
  await expect(composer.getByTestId("composer-skill")).toHaveText("tide-tables");
  await expect(composer.getByTestId("composer-skill")).toHaveAttribute("data-state", "enabled");
  await expect(composer.getByTestId("composer-input")).toHaveValue("");

  // Asked in the assistant, the Question carries the Skill on its bubble, and the Answer
  // follows it, saying so on a Skill card in its steps.
  await window.keyboard.type("When is high water in Brest?");
  await window.keyboard.press("Enter");
  const questions = window.getByTestId("assistant").getByTestId("assistant-question");
  await expect(questions.last()).toContainText("When is high water in Brest?");
  await expect(questions.last().getByTestId("assistant-question-skill")).toHaveText("tide-tables");
  await expect(composer.getByTestId("composer-skill")).toHaveCount(0);
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  const card = (await openSteps(window, answer)).getByTestId("answer-skill");
  await expect(card).toHaveAttribute("data-skill-name", "tide-tables");
  await expect(card).toHaveAttribute("data-forced", "true");
  await expect(card).toContainText("Used the Skill “tide-tables” · chosen for this Question");
  await expect(answer).toContainText("Following the Skill tide-tables.");

  // A Skill chosen in the composer for the next Question, before it was turned off.
  await composer.getByTestId("composer-input").click();
  await window.keyboard.type("/tide");
  await window.keyboard.press("Enter");
  await window.keyboard.type("And in Calais?");

  // Turned off, the Skill can't be used: writing the Answer again says so under it, its text
  // kept as it was.
  await openSettings(window, "skills");
  await item.getByTestId("skill-enabled").uncheck();
  await expect(item).toHaveAttribute("data-enabled", "false");
  await closeSettings(window);
  await answer.hover();
  await answer.getByTestId("answer-regenerate").click();
  await expect(answer.getByTestId("answer-skill-unavailable")).toContainText("which is turned off");
  await expect(answer).toContainText("Following the Skill tide-tables.");

  // So does asking from the composer, in its row: the Question waits there until it goes
  // ahead without it.
  await expect(composer.getByTestId("composer-skill")).toHaveAttribute("data-state", "disabled");
  await composer.getByTestId("composer-input").click();
  await window.keyboard.press("Enter");
  const composerNotice = composer.getByTestId("composer-skill-unavailable");
  await expect(composerNotice).toContainText("which is turned off");
  await expect(questions).toHaveCount(1);
  await composerNotice.getByRole("button", { name: "Ask without it" }).click();
  await expect(composerNotice).toHaveCount(0);
  await expect(composer.getByTestId("composer-skill")).toHaveCount(0);
  const second = assistantAnswers(window).nth(1);
  await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(questions.nth(1)).toContainText("And in Calais?");
  await expect(questions.nth(1).getByTestId("assistant-question-skill")).toHaveCount(0);
  await expect(second).not.toContainText("Following the Skill");
  await expect((await openSteps(window, second)).getByTestId("answer-skill")).toHaveCount(0);
  // The Mind it was asked beside is as it was.
  await expect(editor.getByTestId("question")).toHaveCount(0);
  await app.close();
});

test("a Question can force a Skill and limit its Search scope at once: both chips show, and both apply", async () => {
  const folder = await writeTideSkill();
  await writeFile(join(sources, "Harbour.txt"), "High water in Brest comes twice a day.\n");
  await writeFile(join(sources, "Recipes.txt"), "Cook mussels at low water, with garlic.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Harbour.txt"), join(sources, "Recipes.txt")]);
  // Imported through the core's bridge: the first test covers Settings.
  await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const check = await bridge.previewSkillImport(path);
    if (!check.ok) throw new Error(check.error.message);
    await bridge.importSkill(check.preview.importId);
  }, folder);

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("/tide");
  await expect(window.getByTestId("slash-item-skill-tide-tables")).toBeVisible();
  await window.keyboard.press("Enter");
  await window.keyboard.type("@harb");
  const choices = window.getByTestId("scope-picker").getByTestId("scope-choice");
  await expect(choices).toHaveCount(1);
  await window.keyboard.press("Enter");
  await window.keyboard.type("When is high water in Brest?");

  const composer = window.getByTestId("composer");
  await expect(composer.getByTestId("composer-skill")).toHaveText("tide-tables");
  await expect(composer.getByTestId("scope-chip")).toContainText("Harbour");
  await expect(composer.getByTestId("composer-input")).toHaveValue("When is high water in Brest?");

  // Asked: the Question carries both, the Skill on its bubble and the scope on its Answer's
  // steps; the Skill was loaded up front, and the search found only the Document in scope.
  await window.keyboard.press("Enter");
  const question = window.getByTestId("assistant").getByTestId("assistant-question");
  await expect(question.getByTestId("assistant-question-skill")).toHaveText("tide-tables");
  await expect(question).toContainText("When is high water in Brest?");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("answer-steps")).toContainText("Searched Harbour ·");
  let steps = await openSteps(window, answer);
  await expect(steps.getByTestId("answer-skill")).toHaveAttribute("data-forced", "true");
  await expect(answer).toContainText("Following the Skill tide-tables.");
  await expect(answer.getByTestId("citation-chip")).toHaveAttribute("aria-label", /Harbour/);
  // Without the scope, both Documents would match.
  await expect(steps.getByTestId("answer-step-found")).toContainText("1 passage found");

  // Regenerated: both still apply.
  await answer.getByTestId("answer-regenerate").click();
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  steps = await openSteps(window, answer);
  await expect(steps.getByTestId("answer-skill")).toHaveAttribute("data-forced", "true");
  await expect(answer).toContainText("Following the Skill tide-tables.");
  await expect(answer.getByTestId("citation-chip")).toHaveAttribute("aria-label", /Harbour/);
  await expect(steps.getByTestId("answer-step-found")).toContainText("1 passage found");
  await app.close();
});
