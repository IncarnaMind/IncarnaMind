import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { meetingSummaryModelRoute } from "../src/shared/meetingSummary";
import {
  acceptPlainTextKeys,
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
    opening: [
      "Keep the partner briefing on 26 November.",
      "The launch moves to 18 November.",
      "Dana will confirm the payment provider’s review on Friday.",
      "Dana will send the preview invitations.",
      "Riley will publish the release checklist.",
    ],
    correction: [
      "The launch moves to 20 November instead.",
      "Alex will confirm the payment provider’s review on Monday.",
      "Dana’s preview invitations are canceled.",
      "Riley has published the release checklist.",
    ],
    closing: "Thanks, that is everything for today.",
    overview: "The partner briefing stays on schedule. The launch and payment review have moved.",
    disclosure: "Decisions and action items (5)",
    decisions: "Decisions",
    actions: "Action items",
    status: { current: "Current", open: "To do", done: "Completed", cancelled: "Canceled" },
  },
  "zh-CN": {
    opening: [
      "合作伙伴说明会仍在11月26日举行。",
      "上线改到11月18日。",
      "Dana 周五确认支付服务方的审核进度。",
      "Dana 负责发送预览邀请。",
      "Riley 负责发布上线清单。",
    ],
    correction: [
      "上线改到11月20日。",
      "由 Alex 周一确认支付服务方的审核进度。",
      "取消 Dana 发送预览邀请的安排。",
      "Riley 已发布上线清单。",
    ],
    closing: "谢谢，今天就到这里。",
    overview: "合作伙伴说明会如期举行。上线和审核日期已调整。",
    disclosure: "决定和待办事项（5 项）",
    decisions: "决定",
    actions: "待办事项",
    status: { current: "当前", open: "待完成", done: "已完成", cancelled: "已取消" },
  },
};

async function expectSummaryItems(
  items: Locator,
  words: (typeof meetingWords)[keyof typeof meetingWords],
) {
  const decisions = items.getByRole("list", { name: words.decisions, exact: true });
  const actions = items.getByRole("list", { name: words.actions, exact: true });
  await expect(decisions.getByRole("listitem")).toHaveCount(2);
  await expect(actions.getByRole("listitem")).toHaveCount(3);
  await expect(decisions.getByRole("listitem").nth(0)).toHaveText(
    `${words.opening[0]}${words.status.current}`,
  );
  await expect(decisions.getByRole("listitem").nth(1)).toHaveText(
    `${words.correction[0]}${words.status.current}`,
  );
  await expect(actions.getByRole("listitem").nth(0)).toHaveText(
    `${words.correction[1]}${words.status.open}`,
  );
  await expect(actions.getByRole("listitem").nth(1)).toHaveText(
    `${words.correction[2]}${words.status.cancelled}`,
  );
  await expect(actions.getByRole("listitem").nth(2)).toHaveText(
    `${words.correction[3]}${words.status.done}`,
  );
  await expect(items).not.toContainText(words.opening[1] ?? "");
  await expect(items).not.toContainText(words.opening[2] ?? "");
  await expect
    .poll(() => items.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
}

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
      computerSound: "silent",
      transcriber: {
        live: true,
        lines: [
          words.opening.join(" "),
          [words.opening[0], ...words.correction].join(" "),
          words.closing,
        ],
      },
    });
    try {
      if (screenshots) await window.emulateMedia({ reducedMotion: "reduce" });
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 660);
      await dismissChatSetup(window);
      const bridge = await coreOf(window);
      const afterShot = async (view: "notes" | "transcript" | "transcript-collapsed") => {
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
      await acceptPlainTextKeys(window);
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
      await expect
        .poll(() =>
          bridge.evaluate(async (core) => (await core.listMeetings())[0]?.summary?.items?.length),
        )
        .toBe(5);
      await expect(transcript.getByTestId("viewer-transcript")).toContainText(
        words.correction.join(" "),
      );
      if (screenshots)
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-summary-before-stop-${language}.png`),
        });
      await pointAndClick(window, transcript.getByTestId("meeting-stop"));

      const summary = transcript.getByTestId("meeting-summary");
      await expect(summary).toBeVisible();
      const items = summary.getByTestId("meeting-summary-items");
      const disclosure = items.locator("summary");
      await expect(disclosure).toHaveText(words.disclosure);
      await expect(items).toHaveJSProperty("open", false);
      await expect(disclosure).toBeInViewport();
      if (screenshots && language === "en") {
        await expect(summary).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
        await afterShot("transcript-collapsed");
      }
      await disclosure.focus();
      await window.keyboard.press("Space");
      await expect(items).toHaveJSProperty("open", true);
      await expect(summary).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
      await expect(summary.getByRole("heading", { level: 2 })).toHaveText(
        language === "en" ? "Quick AI summary" : "AI 快速摘要",
      );
      await expect(summary.getByRole("status")).toHaveText(
        language === "en"
          ? /Covers the transcript through \d+:\d\d/
          : /涵盖转写稿截至 \d+:\d\d 的内容/,
      );
      await expect(summary.getByTestId("meeting-summary-text")).toHaveText(words.overview);
      await expectSummaryItems(items, words);
      const transcriptLines = transcript.getByTestId("viewer-transcript");
      await expect(transcriptLines).toBeVisible();
      await expect(transcriptLines).toContainText(/\S/);
      if (screenshots && language === "zh-CN")
        await pointAndClick(window, window.getByTestId("assistant-fold"));
      await afterShot("transcript");

      await showMeetingView(window, window, "notes");
      await expect(transcript).toHaveCount(0);
      await expect(window.getByTestId("meeting-summary-text")).toHaveText(words.overview);
      const noteItems = window.getByTestId("meeting-summary-items");
      await expect(noteItems).toHaveJSProperty("open", false);
      await pointAndClick(window, noteItems.locator("summary"));
      await expectSummaryItems(noteItems, words);
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
        const panes = window.getByTestId("tab-group");
        await expect(panes).toHaveCount(2);
        const original = panes.nth(0);
        const copy = panes.nth(1);
        await expect(copy).toHaveAttribute("data-focused", "true");
        await expect(copy.getByTestId("meeting-summary-text")).toHaveText(words.overview);
        await expect(original.getByTestId("meeting-summary")).toHaveCount(0);
        await showMeetingView(window, copy, "mine");
        await expect(copy.getByTestId("meeting-summary")).toHaveCount(0);
        await expect(original.getByTestId("meeting-summary-text")).toHaveText(words.overview);
      }
    } finally {
      await app.close();
      await removeDataFolder(dir);
    }
  });
}

// protects=the first note fill offers recording details in the focused copy of a split meeting
// fails_when=the background copy opens its popover and dismisses the focused copy's view menu
test("the first fill opens the recorded meeting menu in the focused split pane", async () => {
  const dir = await createDataFolder();
  const { app, window } = await launchApp(dir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1600, 660);
    await dismissChatSetup(window);
    await selectLocalChatModel(window);
    await startRecording(window, await recordMeeting(window), { notice: true });
    await firstTranscriptLine(window);
    await runCommand(window, "tab.split", "Split to the Right");
    const panes = window.getByTestId("tab-group");
    await expect(panes).toHaveCount(2);
    const original = panes.nth(0);
    const copy = panes.nth(1);
    await expect(copy).toHaveAttribute("data-focused", "true");
    await pointAndClick(window, copy.getByTestId("meeting-stop"));
    await expect(copy.getByTestId("meeting-view-menu")).toBeVisible({ timeout: 30_000 });
    await expect(original.getByTestId("meeting-view-menu")).toBeHidden();
    await pointAndClick(window, copy.getByTestId("meeting-view-mine"));
    await expect(copy.getByTestId("meeting-view-chip")).toHaveText("My notes");
    await expect(original.getByTestId("meeting-view-chip")).toContainText("Recorded");
  } finally {
    await app.close();
    await removeDataFolder(dir);
  }
});

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
