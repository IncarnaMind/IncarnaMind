import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { meetingSummaryModelRoute } from "../src/shared/meetingSummary";
import {
  closeSettings,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  focusSettled,
  launchApp,
  motionSettled,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  useLocalChatModel as selectLocalChatModel,
  setLanguage,
  setWindowSize,
  startRecording,
  transcriptSaved,
} from "./app";

const screenshots = process.env.INCARNAMIND_SCREENSHOTS;
const meetingWords = {
  en: {
    source:
      "The launch moves to 18 November. Dana will confirm the payment provider’s review on Friday.",
    reply: "Thanks for confirming the new date.",
    recap:
      "• The launch moves to 18 November.\n• Dana will confirm the payment provider’s review on Friday.",
  },
  "zh-CN": {
    source: "上线改到 11 月 18 日。Dana 周五确认支付服务方的审核进度。",
    reply: "好，谢谢你确认新的日期。",
    recap: "• 上线改到 11 月 18 日。\n• Dana 周五确认支付服务方的审核进度。",
  },
};

async function chooseSummaryModel(window: Page, route: Locator, modelId?: string): Promise<string> {
  await selectLocalChatModel(window, modelId);
  const ready = await (await coreOf(window)).evaluate((core) => core.getChatReadiness());
  if (!ready.ready) throw new Error("Expected the configured AI to be ready.");
  const value = meetingSummaryModelRoute(
    { modelId: ready.modelId, providerId: ready.provider.id },
    ready.provider.service?.id ?? null,
  );
  await route.selectOption(value);
  return value;
}

async function showMeetingView(window: Page, pane: Page | Locator, view: "notes" | "mine") {
  const menu = pane.getByTestId("meeting-view-menu");
  if (!(await menu.isVisible())) await pointAndClick(window, pane.getByTestId("meeting-view-chip"));
  await pointAndClick(window, menu.getByTestId(`meeting-view-${view}`));
}

// protects=the exact opt-in route and a separate Summary in the stopped meeting's existing views
// fails_when=a disconnected or unsupported client is offered, the route defaults on, or the summary replaces the User's notes
for (const language of ["en", "zh-CN"] as const) {
  test(`an opted-in summary appears after Stop across the meeting's views (${language})`, async () => {
    const dir = await createDataFolder();
    const words = meetingWords[language];
    const { app, window } = await launchApp(dir, {
      fakeChat: true,
      transcriber: { lines: [words.source], theirLines: [words.reply] },
    });
    try {
      if (screenshots) await window.emulateMedia({ reducedMotion: "reduce" });
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 660);
      await dismissChatSetup(window);
      const bridge = await coreOf(window);
      const afterShot = async (view: "notes" | "transcript") => {
        if (!screenshots) return;
        await expect
          .poll(
            () =>
              bridge.evaluate(async (core) => {
                const [meeting] = await core.listMeetings();
                return !!meeting?.fill && !["waiting", "filling"].includes(meeting.fill.state);
              }),
            { timeout: 30_000 },
          )
          .toBe(true);
        await motionSettled(window);
        const menu = window.getByTestId("meeting-view-menu");
        if (await menu.isVisible()) await window.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await motionSettled(window);
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-summary-${view}-${language}.png`),
        });
      };
      const agents = await bridge.evaluate(async (core) => {
        await core.setAgentsEnabled(true);
        const codex = await core.connectAgent({ name: "My Codex", client: "codex" });
        const claude = await core.connectAgent({ name: "My Claude Code", client: "claude-code" });
        const vscode = await core.connectAgent({ name: "My VS Code", client: "vscode" });
        return { codex: codex.pairing.id, claude: claude.pairing.id, vscode: vscode.pairing.id };
      });
      const settings = await openSettings(window, "meetings");
      const route = settings.getByTestId("meeting-summary-route");
      const notes = settings.getByLabel("AI for meeting notes");
      const readRoute = () =>
        bridge.evaluate(async (core) => (await core.getSettings()).device.meetingSummaryRoute);
      await expect(route).toHaveValue("");
      await expect(route.locator("option")).toHaveCount(1);
      await notes.selectOption(agents.vscode);
      await expect(route.locator("option")).toHaveCount(1);
      await notes.selectOption(agents.codex);
      await expect(route.locator(`option[value="${agents.codex}"]`)).toHaveText("My Codex");
      await expect(route.locator(`option[value="${agents.claude}"]`)).toHaveCount(0);
      await notes.selectOption(agents.claude);
      await expect(route.locator(`option[value="${agents.claude}"]`)).toHaveText("My Claude Code");
      await route.selectOption(agents.claude);
      await expect.poll(readRoute).toBe(agents.claude);
      await bridge.evaluate((core, pairingId) => core.disconnectAgent(pairingId), agents.claude);
      await expect(route.locator("option").filter({ hasText: "My Claude Code" })).toHaveCount(0);
      await expect(route.locator(`option[value="${agents.codex}"]`)).toHaveCount(0);
      await notes.selectOption("");
      const builtin = await chooseSummaryModel(window, route);
      await expect.poll(readRoute).toBe(builtin);
      if (language === "en") {
        await selectLocalChatModel(window, "replacement-model");
        await expect(route.locator("option").filter({ hasText: /replacement/i })).toHaveJSProperty(
          "selected",
          false,
        );
        await chooseSummaryModel(window, route);
      }
      await closeSettings(window);
      await setLanguage(window, language);

      const bar = await startRecording(window, await recordMeeting(window), { notice: true });
      const editor = window.getByTestId("mind-editor");
      const myText =
        language === "en" ? "A note I typed during the meeting." : "我在开会时写的笔记。";
      await pointAndClick(window, editor);
      await focusSettled(window, editor);
      await window.keyboard.insertText(myText);
      await expect(editor).toContainText(myText);
      await firstTranscriptLine(window);
      await expect(window.getByTestId("meeting-summary")).toHaveCount(0);
      await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
      const transcript = window.getByTestId("meeting-note-transcript");
      await expect(transcript).toBeVisible();
      if (screenshots)
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-summary-before-stop-${language}.png`),
        });
      await pointAndClick(window, transcript.getByTestId("meeting-stop"));

      const summary = transcript.getByTestId("meeting-summary");
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
      await expect(summary.getByRole("heading")).toHaveText(
        language === "en" ? "Quick AI summary" : "AI 快速摘要",
      );
      await expect(summary.getByRole("status")).toHaveText(
        language === "en"
          ? /Covers the transcript through \d+:\d\d/
          : /涵盖转写稿截至 \d+:\d\d 的内容/,
      );
      await expect(summary.getByTestId("meeting-summary-text")).toHaveText(words.recap);
      await expect(transcript.getByTestId("viewer-transcript")).toContainText(/\S/);
      await afterShot("transcript");

      await showMeetingView(window, window, "notes");
      await expect(transcript).toHaveCount(0);
      await expect(window.getByTestId("meeting-summary-text")).toHaveText(words.recap);
      await expect(editor).toContainText(myText);
      await expect(editor.getByTestId("meeting-summary-text")).toHaveCount(0);

      await afterShot("notes");
      await showMeetingView(window, window, "mine");
      await expect(window.getByTestId("meeting-summary")).toHaveCount(0);
      await expect(editor).toContainText(myText);
      if (language === "en") {
        await showMeetingView(window, window, "notes");
        await setWindowSize(app, window, 1600, 660);
        await runCommand(window, "tab.split", "Split to the Right");
        await expect(window.getByTestId("tab-group")).toHaveCount(2);
        await expect(window.getByTestId("meeting-summary")).toHaveCount(1);
        const focused = window.locator('[data-testid="tab-group"][data-focused="true"]');
        await showMeetingView(window, focused, "mine");
        await expect(focused.getByTestId("meeting-summary")).toHaveCount(0);
        await expect(window.getByTestId("meeting-summary")).toHaveCount(1);
      }
    } finally {
      await app.close();
      await removeDataFolder(dir);
    }
  });
}

// protects=a stopped meeting with a failed summary still shows its saved Transcript
// fails_when=a provider failure produces a blank result or hides the meeting's words
test("a failed automatic meeting summary shows a problem beside the transcript", async () => {
  const dir = await createDataFolder();
  const { app, window } = await launchApp(dir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    const settings = await openSettings(window, "meetings");
    await chooseSummaryModel(
      window,
      settings.getByTestId("meeting-summary-route"),
      "fake-model-claims-not-found",
    );
    await closeSettings(window);
    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await firstTranscriptLine(window);
    await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
    const transcript = window.getByTestId("meeting-note-transcript");
    await pointAndClick(window, transcript.getByTestId("meeting-stop"));
    await transcriptSaved(window);
    const summary = transcript.getByTestId("meeting-summary");
    await expect(summary).toHaveAttribute("data-state", "failed", { timeout: 45_000 });
    await expect(summary.getByRole("alert")).toContainText("Couldn’t prepare a summary.");
    const retry = summary.getByTestId("meeting-summary-retry");
    await expect(retry).toHaveText("Try again");
    await retry.focus();
    await window.keyboard.press("Enter");
    await expect(retry).toBeEnabled();
    await expect(summary.getByTestId("meeting-summary-text")).toHaveCount(0);
    await expect(transcript.getByTestId("viewer-transcript")).toContainText(/\S/);
  } finally {
    await app.close();
    await removeDataFolder(dir);
  }
});
