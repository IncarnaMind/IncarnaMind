import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  pageMenuButton,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stopMeeting,
} from "./app";

for (const language of ["en", "zh-CN"] as const) {
  test(`a stopped meeting saves just its headings as an editable template in ${language}`, async () => {
    const dataDir = await createDataFolder();
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, language === "en" ? 1100 : 900, 740);
      const control = await recordMeeting(window);
      const editor = window.getByTestId("mind-editor");
      await pointAndClick(window, editor);
      await window.keyboard.type("## Decisions ");
      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await window.keyboard.type("The supplier quoted 528 dollars.");
      await window.keyboard.press("Enter");
      await window.keyboard.type("## Open questions ");
      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await expect(editor.locator("h2")).toHaveText(["Decisions", "Open questions"]);
      const buttonRect = await pageMenuButton(window).boundingBox();
      const controlRect = await control.boundingBox();
      if (!buttonRect || !controlRect) throw new Error("The live controls must be visible.");
      expect(
        buttonRect.x >= controlRect.x + controlRect.width ||
          buttonRect.y + buttonRect.height <= controlRect.y,
      ).toBe(true);
      await pageMenuButton(window).click();
      const liveMenu = window.getByTestId("page-actions");
      await expect(liveMenu).toBeVisible();
      await expect(liveMenu.getByTestId("meeting.saveTemplate")).toHaveCount(0);
      await window.keyboard.press("Escape");
      await stopMeeting(window);
      if (language === "zh-CN") await setLanguage(window, language);
      const openDraft = async () => {
        await pageMenuButton(window).click();
        const menu = window.getByTestId("page-actions");
        await menu.getByTestId("meeting.saveTemplate").click();
        await expect(menu).toBeHidden();
        return window.getByTestId("make-skill-editor");
      };
      const card = await openDraft();
      const steps = card.getByTestId("make-skill-editor-steps");
      await expect(steps).toHaveValue(/- \*\*Decisions\*\*\n- \*\*Open questions\*\*$/);
      await expect(steps).not.toHaveValue(/supplier|528/);
      const expectedSteps = await steps.inputValue();
      await card.getByTestId("make-skill-editor-name").fill("Work in progress");
      await pageMenuButton(window).click();
      await expect(
        window.getByTestId("page-actions").getByTestId("meeting.saveTemplate"),
      ).toHaveCount(0);
      await window.keyboard.press("Escape");
      await expect(card.getByTestId("make-skill-editor-name")).toHaveValue("work-in-progress");
      await card.getByTestId("make-skill-editor-cancel").click();
      await expect(card).toHaveCount(0);
      await openDraft();
      await card.getByTestId("make-skill-editor-name").fill("Team handover");
      const pictures = process.env.INCARNAMIND_SCREENSHOTS;
      if (pictures) {
        await card.getByTestId("make-skill-editor-save").scrollIntoViewIfNeeded();
        await expect(window.locator('[role="menu"]:visible')).toHaveCount(0);
        await motionSettled(window);
        await window.screenshot({
          path: join(pictures, `template-${language}.png`),
          animations: "disabled",
        });
      }
      await card.getByTestId("make-skill-editor-save").click();
      await window.getByTestId("make-skill-open-settings").click();
      const row = window
        .getByTestId("skills-meetings")
        .locator('[data-skill-name="team-handover"]');
      await expect(row).toBeVisible();
      await row.getByTestId("skill-menu").click();
      await row.getByTestId("skill-edit").click();
      await expect(window.getByTestId("skill-editor-steps")).toHaveValue(expectedSteps);
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
    }
  });
}
