import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  catchCopies,
  closeSettings,
  copied,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  useLocalChatModel as selectLocalChatModel,
  setWindowSize,
  startRecording,
} from "./app";

// protects=a saved meeting hands a request to the chosen AI only after the User shares its folder and presses the action; fails_when=Stop sends the request, moving the Note leaves the action unavailable, or the request names the wrong transcript
for (const language of ["en", "zh-CN"] as const) {
  test(`after Stop, move the meeting into a shared folder and prepare notes in the chosen AI (${language})`, async () => {
    const dir = await createDataFolder();
    const home = await createDataFolder();
    const { app, window } = await launchApp(dir, { home, fakeChat: true });
    try {
      await window.emulateMedia({ reducedMotion: "reduce" });
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 850);
      await dismissChatSetup(window);
      await selectLocalChatModel(window);
      await acceptPlainTextKeys(window);
      await catchCopies(window);
      const ids = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const group = await bridge.createLibraryGroup({ name: "Shipping", description: "" });
        await bridge.setAgentsEnabled(true);
        const { pairing } = await bridge.connectAgent({
          name: "VS Code",
          client: "vscode",
          folderIds: [group.id],
        });
        return { group: group.id, agent: pairing.id };
      });
      const settings = await openSettings(window, "meetings");
      await settings.getByLabel("AI for meeting notes").selectOption(ids.agent);
      await closeSettings(window);
      const bar = await startRecording(window, await recordMeeting(window), { notice: true });
      await firstTranscriptLine(window);
      await window.evaluate(async (lang) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ user: { language: lang } });
      }, language);
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      const unavailable = window.getByTestId("meeting-agent-unavailable");
      await expect(unavailable).toContainText("VS Code", { timeout: 30000 });
      expect(await copied(window)).toBe("");
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          animations: "disabled",
          path: join(process.env.INCARNAMIND_SCREENSHOTS, `meeting-before-sharing-${language}.png`),
        });
      await unavailable.getByRole("button").click();
      await window.getByTestId("move-to-picker").getByRole("option", { name: "Shipping" }).click();
      await expect(window.getByTestId("move-to-picker")).toBeHidden();
      const action = window.getByTestId("meeting-agent-notes").getByRole("button");
      await expect(action).toHaveText(
        language === "en" ? "Prepare notes with VS Code" : "用 VS Code 整理会议笔记",
      );
      expect(await copied(window)).toBe("");
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          animations: "disabled",
          path: join(process.env.INCARNAMIND_SCREENSHOTS, `meeting-agent-${language}.png`),
        });
      await action.focus();
      await window.keyboard.press("Enter");
      await expect.poll(() => copied(window)).toContain("documentId");
      const meeting = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.listMeetings())[0];
      });
      expect(meeting?.fill).toMatchObject({ state: "own-ai", agentId: ids.agent });
      expect(await copied(window)).toContain(meeting?.mindId);
      expect(await copied(window)).toContain(meeting?.transcript?.documentId);
      const firstRequest = await copied(window);
      await window.evaluate(async ({ agent, group }) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.disconnectAgent(agent);
        await bridge.connectAgent({
          name: "Work AI",
          client: "vscode",
          folderIds: [group],
          propose: true,
        });
      }, ids);
      const reconnected = window
        .getByTestId("meeting-agent-unavailable")
        .getByRole("button", { name: /Work AI/ });
      await expect(reconnected).toBeVisible();
      expect(await copied(window)).toBe(firstRequest);
      await reconnected.click();
      await expect.poll(() => copied(window)).toContain("¶0+");
    } finally {
      await app.close();
      await removeDataFolder(dir);
      await removeDataFolder(home);
    }
  });
}
