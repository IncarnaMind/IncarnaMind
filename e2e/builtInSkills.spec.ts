import { expect, test } from "@playwright/test";
import {
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  openSteps,
  removeDataFolder,
  useLocalChatModel,
} from "./app";

/** The Skills the app ships (resources/skills/), in name order. */
const BUILT_IN = [
  "chronology",
  "cim-red-flags",
  "covenant-summary",
  "credit-memo-outline",
  "deposition-summary",
  "earnings-review",
  "literature-review",
  "mind-to-report",
  "summarise-document",
];

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a fresh data folder has the built-in Skills: labelled in Settings, and offered in a Question's slash menu", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);

  // Settings → Skills: installed on first run, turned on, and labelled built-in.
  await openSettings(window, "skills");
  const section = window.getByTestId("skills-settings");
  const items = section.getByTestId("skill-item");
  await expect(section.getByTestId("skills-built-in").getByTestId("skill-item")).toHaveCount(9);
  await expect(items).toHaveCount(9);
  for (const [index, name] of BUILT_IN.entries()) {
    const item = items.nth(index);
    await expect(item).toHaveAttribute("data-skill-name", name);
    await expect(item).toHaveAttribute("data-built-in", "true");
    await expect(item.getByTestId("skill-enabled")).toBeChecked();
    await expect(item).toContainText("License: Apache-2.0");
  }
  const restore = section.getByTestId("skill-restore-built-ins");
  await expect(restore).toHaveCount(0);

  // Removed, a built-in Skill can be restored.
  const itemNamed = (name: string) =>
    section.locator(`[data-testid="skill-item"][data-skill-name="${name}"]`);
  const itemAction = async (name: string, action: string) => {
    await itemNamed(name).getByTestId("skill-menu").click();
    await itemNamed(name).getByTestId(action).click();
  };
  await itemAction("summarise-document", "skill-remove");
  await expect(items).toHaveCount(8);
  await expect(restore).toHaveText("Restore built-in Skills");
  await restore.click();
  await expect(itemNamed("summarise-document")).toHaveAttribute("data-built-in", "true");
  await expect(items).toHaveCount(9);
  await expect(restore).toHaveCount(0);

  // Duplicated as the User's own: a copy that isn't built-in.
  await itemAction("mind-to-report", "skill-duplicate");
  const copy = itemNamed("mind-to-report-copy");
  await expect(copy).toHaveAttribute("data-built-in", "false");
  await expect(section.getByTestId("skills-yours").getByTestId("skill-item")).toHaveCount(1);
  await copy.getByTestId("skill-menu").click();
  await expect(copy.getByTestId("skill-duplicate")).toHaveCount(0);
  await expect(copy.getByTestId("skill-edit")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(items).toHaveCount(10);
  await closeSettings(window);

  // In the composer, "/" offers them like any other Skill.
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("/");
  const menu = window.getByTestId("composer-skill-picker");
  for (const name of BUILT_IN) {
    await expect(menu.getByTestId(`slash-item-skill-${name}`)).toBeVisible();
  }
  await window.keyboard.type("lit");
  await expect(menu.getByTestId("slash-item-skill-literature-review")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await window.keyboard.press("Enter");
  const composerChip = window.getByTestId("composer").getByTestId("composer-skill");
  await expect(composerChip).toHaveText("Literature review");
  await expect(composerChip).toHaveAttribute("data-state", "enabled");

  // Asked, the Question carries it and the Answer follows it, as with any forced Skill.
  await window.keyboard.type("What do my Documents say about tides?");
  await window.keyboard.press("Enter");
  const chip = window.getByTestId("assistant-question").getByTestId("assistant-question-skill");
  await expect(chip).toHaveText("Literature review");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  const card = (await openSteps(window, answer)).getByTestId("answer-skill");
  await expect(card).toHaveAttribute("data-skill-name", "literature-review");
  await expect(card).toHaveAttribute("data-forced", "true");
  await expect(answer).toContainText("Following the Skill literature-review.");
  await app.close();
});
