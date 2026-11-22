import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { readVtt, writeVtt } from "../src/core/documents/formats/vtt";
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
  slideSelect,
  startRecording,
  transcriptSaved,
  turnOf,
} from "./app";
import { encode, film } from "./feel";

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
    addition: "I will confirm the revised dates.",
    corrected: "Keep the preview invitations on hold until the next review.",
    discarded: "Send the preview invitations today.",
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
    addition: "我会确认调整后的日期。",
    corrected: "预览邀请暂缓发送，等下次审核后再决定。",
    discarded: "今天发送预览邀请。",
    disclosure: "决定和待办事项（5 项）",
    decisions: "决定",
    actions: "待办事项",
    status: { current: "当前", open: "待完成", done: "已完成", cancelled: "已取消" },
  },
} as const;

async function expectItem(row: Locator, text: string, status: string) {
  await expect(row.getByTestId("meeting-summary-item-text")).toHaveText(text);
  await expect(row.getByTestId("meeting-summary-item-status")).toHaveText(status);
}

async function expectSummaryItems(
  items: Locator,
  words: (typeof meetingWords)[keyof typeof meetingWords],
) {
  const decisions = items.getByRole("list", { name: words.decisions, exact: true });
  const actions = items.getByRole("list", { name: words.actions, exact: true });
  await expect(decisions.getByRole("listitem")).toHaveCount(2);
  await expect(actions.getByRole("listitem")).toHaveCount(3);
  const decisionRows = decisions.getByTestId("meeting-summary-item");
  const actionRows = actions.getByTestId("meeting-summary-item");
  const [briefing] = words.opening;
  const [launch, review, invitations, checklist] = words.correction;
  await expectItem(decisionRows.nth(0), briefing, words.status.current);
  await expectItem(decisionRows.nth(1), launch, words.status.current);
  await expectItem(actionRows.nth(0), review, words.status.open);
  await expectItem(actionRows.nth(1), invitations, words.status.cancelled);
  await expectItem(actionRows.nth(2), checklist, words.status.done);
  await expect(items).not.toContainText(words.opening[1]);
  await expect(items).not.toContainText(words.opening[2]);
  await expect
    .poll(() => items.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
}

function summaryItem(items: Locator, id: string) {
  return items.locator(`[data-testid="meeting-summary-item"][data-item-id="${id}"]`);
}

async function showSpeech(window: Page, row: Locator, quote: string) {
  await pointAndClick(window, row.getByTestId("meeting-summary-item-original"));
  const sources = row.getByTestId("meeting-summary-item-sources");
  await expect(sources).toBeVisible();
  return sources.getByRole("listitem").filter({ hasText: quote });
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

async function settleFirstFill(window: Page) {
  const bridge = await coreOf(window);
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
    let running: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      running = await launchApp(dir, {
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
      const { app, window } = running;
      if (screenshots) await window.emulateMedia({ reducedMotion: "reduce" });
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 660);
      await dismissChatSetup(window);
      const bridge = await coreOf(window);
      const afterShot = async (
        view:
          | "notes"
          | "transcript"
          | "transcript-collapsed"
          | "original"
          | "source"
          | "editing"
          | "corrected"
          | "overview-before"
          | "overview-after",
      ) => {
        if (!screenshots) return;
        await settleFirstFill(window);
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
      const help = settings.getByTestId("call-help-agent-route");
      await expect(help).toHaveValue("");
      await expect(help.locator(`option[value="${agents.vscode}"]`)).toHaveCount(0);
      await help.selectOption(agents.claude);
      await expect(notes).toHaveValue("");
      await expect(route).toHaveValue("");
      await help.selectOption("");
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

      const [launchQuote, , invitationsQuote] = words.correction;
      const launchItem = items.getByTestId("meeting-summary-item").filter({ hasText: launchQuote });
      const originalLaunch = await showSpeech(window, launchItem, launchQuote);
      const timestamp = originalLaunch.getByTestId("meeting-summary-item-source");
      await expect(timestamp).toBeVisible();
      const originalText = await originalLaunch.locator("blockquote").innerText();
      if (screenshots) await timestamp.scrollIntoViewIfNeeded();
      await afterShot("original");
      await timestamp.focus();
      await window.keyboard.press("Enter");
      const marked = window.locator(
        '[data-testid="viewer-transcript"] [data-cue-start] mark[data-quote-highlight]',
      );
      await expect
        .poll(async () => (await marked.allTextContents()).join("").replace(/\s+/g, ""))
        .toBe(originalText.replace(/\s+/g, ""));
      await expect(marked.first()).toBeInViewport();
      await afterShot("source");
      const sourceTab = window.getByTestId("document-tab");
      await expect(sourceTab).toHaveCount(1);
      await pointAndClick(window, sourceTab.getByTestId("tab-close"));
      await expect(sourceTab).toHaveCount(0);

      // The first Note fill opens a menu that takes Escape before the inline editor.
      await settleFirstFill(window);
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
      const invitations = noteItems
        .getByTestId("meeting-summary-item")
        .filter({ hasText: invitationsQuote });
      const itemId = await invitations.getAttribute("data-item-id");
      if (!itemId) throw new Error("The preview invitations item needs its saved ID.");
      const row = summaryItem(noteItems, itemId);
      const edit = row.getByTestId("meeting-summary-item-edit");
      await edit.focus();
      await window.keyboard.press("Enter");
      const editForm = noteItems.getByTestId("meeting-summary-item-editor");
      const text = editForm.getByRole("textbox");
      const kind = editForm.getByRole("combobox").nth(0);
      const status = editForm.getByRole("combobox").nth(1);
      await expect(text).toHaveValue(invitationsQuote);
      await expect(kind).toHaveValue("action");
      await expect(status).toHaveValue("cancelled");
      await text.fill(words.discarded);
      await status.selectOption("done");
      await expect(editForm.getByTestId("meeting-summary-item-cancel")).toBeVisible();
      await text.focus();
      await window.keyboard.press("Escape");
      await expect(editForm).toHaveCount(0);
      await expectItem(row, invitationsQuote, words.status.cancelled);
      await expect(edit).toBeFocused();

      await pointAndClick(window, edit);
      await text.fill(words.corrected);
      await kind.selectOption("decision");
      await status.selectOption("active");
      const save = editForm.getByTestId("meeting-summary-item-save");
      if (screenshots) await save.evaluate((button) => button.scrollIntoView({ block: "center" }));
      await afterShot("editing");
      await pointAndClick(window, save);
      await expect(editForm).toHaveCount(0);
      const decisionList = noteItems.getByRole("list", { name: words.decisions, exact: true });
      await expectItem(summaryItem(decisionList, itemId), words.corrected, words.status.current);
      await expect(decisionList.getByTestId("meeting-summary-item")).toHaveCount(3);
      await expect(
        noteItems
          .getByRole("list", { name: words.actions, exact: true })
          .getByTestId("meeting-summary-item"),
      ).toHaveCount(2);
      await expect(noteItems).not.toContainText(words.discarded);
      const preservedQuote = await showSpeech(window, row, invitationsQuote);
      await expect(preservedQuote).toBeVisible();
      await expect(preservedQuote).not.toContainText(words.corrected);
      if (screenshots) await preservedQuote.scrollIntoViewIfNeeded();
      await afterShot("corrected");
      const overview = window.getByTestId("meeting-summary-text");
      if (screenshots) {
        await noteItems.locator("summary").click();
        await window.getByTestId("meeting-summary").scrollIntoViewIfNeeded();
        await afterShot("overview-before");
      }
      await pointAndClick(window, overview);
      await expect(overview).toBeFocused();
      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("Enter");
      await expect(overview.locator(":scope > p")).toHaveText([words.overview, ""]);
      await window.keyboard.press("ControlOrMeta+b");
      if (language === "zh-CN") {
        const cdp = await window.context().newCDPSession(window);
        await cdp.send("Input.imeSetComposition", {
          text: "我会",
          selectionStart: 2,
          selectionEnd: 2,
        });
        await cdp.send("Input.insertText", { text: words.addition });
        await cdp.detach();
      } else {
        await window.keyboard.insertText(words.addition);
      }
      await expect(overview.locator(":scope > p")).toHaveText([words.overview, words.addition]);
      await expect(overview.locator("p strong")).toHaveText(words.addition);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(overview).not.toContainText(words.addition);
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect(overview.locator("p strong")).toHaveText(words.addition);
      await expect
        .poll(async () => ({
          saved: await bridge.evaluate(
            async (core) => (await core.listMeetings())[0]?.summary?.text,
          ),
          problem: await window.getByTestId("meeting-summary-edit-problem").allTextContents(),
        }))
        .toMatchObject({ saved: expect.stringContaining(words.addition), problem: [] });
      if (screenshots) await afterShot("overview-after");
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
        await expect(copy.getByTestId("meeting-summary-text").locator("strong")).toHaveText(
          words.addition,
        );
        await expect(original.getByTestId("meeting-summary")).toHaveCount(0);
        await showMeetingView(window, copy, "mine");
        await expect(copy.getByTestId("meeting-summary")).toHaveCount(0);
        await expect(original.getByTestId("meeting-summary-text").locator("strong")).toHaveText(
          words.addition,
        );
      }

      await app.close();
      running = null;
      const reopened = await launchApp(dir, { fakeChat: true });
      running = reopened;
      await setWindowSize(reopened.app, reopened.window, language === "en" ? 1280 : 900, 660);
      const persisted = await (await coreOf(reopened.window)).evaluate(async (core, id) => {
        const [meeting] = await core.listMeetings();
        return meeting?.summary?.items?.find((item) => item.id === id);
      }, Number(itemId));
      expect(persisted).toMatchObject({
        id: Number(itemId),
        kind: "decision",
        status: "active",
        text: words.corrected,
        corrected: true,
      });
      await pointAndClick(reopened.window, reopened.window.getByTestId("mind-tab").first());
      const focused = reopened.window.locator('[data-testid="tab-group"][data-focused="true"]');
      await showMeetingView(reopened.window, focused, "notes");
      await expect(focused.getByTestId("meeting-summary-text").locator("p strong")).toHaveText(
        words.addition,
      );
      const restartedItems = focused.getByTestId("meeting-summary-items");
      await expect(restartedItems).toBeVisible();
      if ((await restartedItems.getAttribute("open")) === null)
        await pointAndClick(reopened.window, restartedItems.locator("summary"));
      const savedRow = summaryItem(restartedItems, itemId);
      await expectItem(savedRow, words.corrected, words.status.current);
      await expect(await showSpeech(reopened.window, savedRow, invitationsQuote)).toBeVisible();
      const savedOverview = focused.getByTestId("meeting-summary-text");
      const quoteReview = focused.getByTestId("meeting-summary-candidates");
      await expect(quoteReview).toBeVisible();
      await pointAndClick(reopened.window, savedOverview);
      await reopened.window.keyboard.press("ControlOrMeta+a");
      await reopened.window.keyboard.press("Backspace");
      await expect(savedOverview).toHaveText("");
      await expect
        .poll(async () =>
          (await coreOf(reopened.window)).evaluate(
            async (core) => (await core.listMeetings())[0]?.summary?.text,
          ),
        )
        .toBe("");
      await expect(quoteReview).toBeVisible();
      await reopened.window.keyboard.insertText(words.addition);
      await expect(savedOverview).toHaveText(words.addition);
    } finally {
      await running?.app.close();
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

// protects=reviewing a literal exchange and explicitly adding it to a stopped Meeting's action items
// fails_when=review text is automatically filed, only one turn is saved, or a confirmed quote is offered again after restart
for (const [language, request, reply] of [
  [
    "en",
    "Could each department report how many packing crates it needs?",
    "We would have to count them first.",
  ],
  ["zh-CN", "各部门能报一下需要多少个周转箱吗？", "这个要先回去统计一下。"],
] as const) {
  test(`a stopped meeting offers original quotes to add as an action (${language})`, async () => {
    const dir = await createDataFolder();
    let running: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      running = await launchApp(dir, {
        fakeChat: true,
        computerSound: "silent",
        transcriber: {
          live: true,
          lines: [
            meetingWords[language].opening[0],
            request,
            reply,
            meetingWords[language].closing,
          ],
        },
      });
      const { app, window } = running;
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 660);
      await dismissChatSetup(window);
      const settings = await openSettings(window, "meetings");
      await chooseSummaryModel(window, settings.getByTestId("meeting-summary-route"));
      await closeSettings(window);
      await setLanguage(window, language);
      const bar = await startRecording(window, await recordMeeting(window), { notice: true });
      await firstTranscriptLine(window);
      await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
      const transcript = window.getByTestId("meeting-note-transcript");
      await expect(transcript.getByTestId("viewer-transcript")).toContainText(reply);
      await pointAndClick(window, transcript.getByTestId("meeting-stop"));
      await transcriptSaved(window);
      const summary = transcript.getByTestId("meeting-summary");
      await expect(summary).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
      const candidates = summary.getByTestId("meeting-summary-candidates");
      const disclosure = candidates.locator("button[aria-expanded]");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(summary.getByTestId("meeting-summary-items")).not.toContainText(request);
      const before = await (await coreOf(window)).evaluate(async (core) => {
        const [meeting] = await core.listMeetings();
        return meeting?.summary?.candidatesReviewed;
      });
      expect(before).toBeUndefined();
      await settleFirstFill(window);
      if (screenshots) {
        const fold = window.getByTestId("assistant-fold");
        if (await fold.isVisible()) await pointAndClick(window, fold);
        await motionSettled(window);
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-review-collapsed-${language}.png`),
        });
      }
      await disclosure.press("Enter");
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      const row = candidates.getByTestId("meeting-summary-candidate");
      await expect(row).toHaveCount(1);
      await pointAndClick(window, disclosure);
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await pointAndClick(window, disclosure);
      await expect(row).toHaveCount(1);
      const quotes = row.locator("blockquote p");
      await expect(quotes).toHaveCount(2);
      await expect(quotes.nth(0)).toContainText(request);
      await expect(quotes.nth(1)).toContainText(reply);
      await expect(quotes.getByRole("button")).toHaveCount(2);
      expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (screenshots) {
        await row.scrollIntoViewIfNeeded();
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-review-quotes-${language}.png`),
        });
      }
      await pointAndClick(window, quotes.nth(1).getByRole("button"));
      const mark = window.locator(
        '[data-testid="viewer-transcript"] [data-cue-start] mark[data-quote-highlight]',
      );
      await expect
        .poll(async () => (await mark.allTextContents()).join("").replace(/\s/g, ""))
        .toBe(reply.replace(/\s/g, ""));
      const sourceTab = window.getByTestId("document-tab");
      await pointAndClick(window, sourceTab.getByTestId("tab-close"));
      await expect(sourceTab).toHaveCount(0);
      if ((await disclosure.getAttribute("aria-expanded")) !== "true")
        await pointAndClick(window, disclosure);
      const add = row.getByRole("button", {
        name: language === "en" ? "Add to action items" : "加入待办",
      });
      await add.focus();
      await window.keyboard.press("Enter");
      await expect(candidates.getByTestId("meeting-summary-candidate")).toHaveCount(0);
      const items = summary.getByTestId("meeting-summary-items");
      await pointAndClick(window, items.locator("summary"));
      const action = items
        .getByRole("list", { name: meetingWords[language].actions, exact: true })
        .getByTestId("meeting-summary-item");
      await expect(action).toHaveCount(1);
      await expectItem(action, `${request}\n${reply}`, meetingWords[language].status.open);

      await window.keyboard.press("ControlOrMeta+z");
      await expect(action).toHaveCount(0);
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await pointAndClick(window, candidates.getByTestId("meeting-summary-add-candidate"));
      await expect(action).toHaveCount(1);
      await expect(candidates.getByTestId("meeting-summary-candidate")).toHaveCount(0);

      await running.app.close();
      running = null;
      running = await launchApp(dir, { fakeChat: true });
      const snapshot = await (await coreOf(running.window)).evaluate(async (core) => {
        const [meeting] = await core.listMeetings();
        if (!meeting) throw new Error("Missing stopped meeting.");
        return {
          actions: meeting.summary?.items?.filter((item) => item.kind === "action"),
          candidates: await core.getMeetingSummaryCandidates(meeting.id),
          checked: meeting.summary?.candidatesReviewed,
        };
      });
      expect(snapshot.actions).toHaveLength(1);
      expect(snapshot.actions?.[0]?.text).toBe(`${request}\n${reply}`);
      expect(snapshot.candidates).toEqual([]);
      expect(snapshot.checked).toBe(true);
    } finally {
      await running?.app.close();
      await removeDataFolder(dir);
    }
  });
}

// protects=local cue-to-action items in both Transcript views, with one Undo step per actual addition
// fails_when=the action requires a model, a duplicate creates another Undo, or a source opens at the wrong cue
for (const language of ["en", "zh-CN"] as const) {
  test(`a saved transcript line becomes a local action item (${language})`, async () => {
    const dir = await createDataFolder();
    let running: Awaited<ReturnType<typeof launchApp>> | null = null;
    let stopFilm: Awaited<ReturnType<typeof film>> | undefined;
    const [, , firstQuote, secondQuote] = meetingWords[language].opening;
    const words =
      language === "en"
        ? {
            add: "Add to action items",
            added: "Added to action items.",
            already: "Already in action items",
            empty: "No summary was generated.",
          }
        : {
            add: "加入待办事项",
            added: "已加入待办。",
            already: "待办事项中已有这句",
            empty: "未生成摘要。",
          };
    try {
      running = await launchApp(dir, {
        computerSound: "silent",
        transcriber: { live: true, lines: [firstQuote, secondQuote] },
      });
      const { app, window } = running;
      const bridge = await coreOf(window);
      const width = language === "en" ? 1440 : 900;
      await setWindowSize(app, window, width, 720);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const bar = await startRecording(window, await recordMeeting(window), { notice: true });
      await firstTranscriptLine(window);
      await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
      const inline = window.getByTestId("meeting-note-transcript");
      const cue = (scope: Locator, text: string) =>
        scope.getByTestId("transcript-line").filter({ hasText: text }).first();
      await expect(cue(inline, secondQuote)).toBeVisible();
      await expect(inline.getByTestId("transcript-line-actions")).toHaveCount(0);
      await pointAndClick(window, inline.getByTestId("meeting-stop"));
      await transcriptSaved(window);
      await settleFirstFill(window);
      const first = cue(inline, firstQuote);
      await expect(first).toBeVisible();
      const source = {
        startMs: Number(await first.getAttribute("data-cue-start")),
        endMs: Number(await first.getAttribute("data-cue-end")),
        text: firstQuote,
      };
      expect(source.endMs).toBeGreaterThan(source.startMs);
      const readMeeting = () =>
        bridge.evaluate(async (core) => {
          const [meeting] = await core.listMeetings();
          const settings = await core.getSettings();
          return {
            route: settings.device.meetingSummaryRoute,
            text: meeting?.summary?.text,
            items: meeting?.summary?.items ?? [],
          };
        });
      expect((await readMeeting()).route).toBeFalsy();

      const frames = screenshots ? join(screenshots, "meeting-cue-action-frames") : undefined;
      if (frames && language === "en") stopFilm = await film(window, frames);

      await first.focus();
      await window.keyboard.press("Tab");
      const trigger = turnOf(first).getByTestId("transcript-line-actions");
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-label", new RegExp(firstQuote));
      await window.keyboard.press("Space");
      const menu = turnOf(first).getByTestId("transcript-line-menu");
      await expect(menu).toBeVisible();
      if (screenshots) {
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-cue-actions-${language}-${width}.png`),
        });
      }
      await window.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: words.add })).toBeFocused();
      if (stopFilm) await pause(1100);
      await window.keyboard.press("Enter");
      await expect(menu).toBeHidden();
      await expect(first).toBeFocused();
      await expect(window.getByTestId("undo-message")).toHaveText(words.added);
      const summary = inline.getByTestId("meeting-summary");
      await expect(summary).not.toContainText(words.empty);
      await expect(summary.getByTestId("meeting-summary-text")).toHaveCount(0);
      const items = summary.getByTestId("meeting-summary-items");
      if (stopFilm) await pause(1000);
      await pointAndClick(window, items.locator("summary"));
      await expectItem(
        items.getByTestId("meeting-summary-item"),
        firstQuote,
        meetingWords[language].status.open,
      );
      if (stopFilm && frames && screenshots) {
        await stopFilm();
        stopFilm = undefined;
        await encode(frames, join(screenshots, "meeting-cue-action.mp4"));
      }
      const [original] = (await readMeeting()).items;
      expect(original?.corrected).toBe(true);

      const originalSpeech = await showSpeech(
        window,
        items.getByTestId("meeting-summary-item"),
        firstQuote,
      );
      await pointAndClick(window, originalSpeech.getByTestId("meeting-summary-item-source"));
      const standalone = window.getByTestId("viewer-transcript").filter({
        has: window.locator(
          `[data-cue-start="${source.startMs}"][data-cue-end="${source.endMs}"] [data-quote-highlight]`,
        ),
      });
      await expect(standalone).toBeVisible();
      const inViewer = cue(standalone, firstQuote);
      await inViewer.hover();
      await pointAndClick(window, turnOf(inViewer).getByTestId("transcript-line-actions"));
      await pointAndClick(
        window,
        turnOf(inViewer)
          .getByTestId("transcript-line-menu")
          .getByRole("menuitem", { name: words.add }),
      );
      await expect(
        window.getByTestId("transcript-added").filter({ hasText: words.already }),
      ).toBeVisible();
      await expect(window.getByTestId("undo-message")).toHaveText(words.added);
      await pointAndClick(window, window.getByTestId("undo-action"));
      await expect.poll(async () => (await readMeeting()).items).toHaveLength(0);

      await window.keyboard.press("ControlOrMeta+Shift+KeyZ");
      await expect.poll(async () => (await readMeeting()).items).toHaveLength(1);
      expect((await readMeeting()).items[0]?.id).not.toBe(original?.id);

      const second = cue(standalone, secondQuote);
      const wholeStart = Number(await second.getAttribute("data-cue-start"));
      const wholeEnd = Number(await second.getAttribute("data-cue-end"));
      await second.focus();
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("Enter");
      const speakers = window.locator('[data-testid="speaker-menu"]:popover-open');
      await pointAndClick(window, speakers.getByTestId("speaker-new"));
      await window.keyboard.insertText(language === "en" ? "Taylor" : "李然");
      await window.keyboard.press("Enter");
      await expect(speakers).toHaveCount(0);
      const cueBounds = `[data-cue-start="${wholeStart}"][data-cue-end="${wholeEnd}"]`;
      const part = standalone.locator(`${cueBounds}:not([data-start="${wholeStart}"])`);
      await expect(part).toBeVisible();
      const partText = (await part.innerText()).trim();
      const partStart = Number(await part.getAttribute("data-start"));
      const partEnd = Number(await part.getAttribute("data-end"));
      expect(partText).not.toBe(secondQuote);
      expect(partStart).toBeGreaterThan(wholeStart);
      expect(partEnd).toBe(wholeEnd);

      await part.focus();
      await runCommand(window, "meeting.addTranscriptAction", words.add);
      await expect
        .poll(async () => (await readMeeting()).items.map((item) => item.text))
        .toEqual([firstQuote, partText]);
      expect((await readMeeting()).text ?? "").toBe("");

      await pointAndClick(
        window,
        window.getByTestId("mind-tab").filter({ hasText: /Meeting|会议/ }),
      );
      const allItems = window.getByTestId("meeting-summary-items");
      if ((await allItems.getAttribute("open")) === null)
        await pointAndClick(window, allItems.locator("summary"));
      const partItem = allItems.getByTestId("meeting-summary-item").filter({ hasText: partText });
      const partSpeech = await showSpeech(window, partItem, partText);
      await pointAndClick(window, partSpeech.getByTestId("meeting-summary-item-source"));
      const highlight = window.locator(
        `[data-testid="viewer-transcript"] [data-start="${partStart}"][data-end="${partEnd}"] [data-quote-highlight]`,
      );
      await expect
        .poll(async () => (await highlight.allTextContents()).join("").replace(/\s/g, ""))
        .toBe(partText.replace(/\s/g, ""));
      await expect(
        window.locator(
          `[data-testid="viewer-transcript"] ${cueBounds}[data-start="${wholeStart}"] [data-quote-highlight]`,
        ),
      ).toHaveCount(0);
      await pointAndClick(window, window.getByTestId("undo-action"));
      await expect
        .poll(async () => (await readMeeting()).items.map((item) => item.text))
        .toEqual([firstQuote]);
      if (screenshots) {
        const otherWidth = width === 1440 ? 900 : 1440;
        await setWindowSize(app, window, otherWidth, 720);
        await pointAndClick(window, window.getByTestId("document-tab"));
        const viewer = window.getByTestId("viewer").getByTestId("viewer-transcript");
        const line = cue(viewer, firstQuote);
        await line.hover();
        const turn = turnOf(line);
        await pointAndClick(window, turn.getByTestId("transcript-line-actions"));
        await expect(turn.getByRole("menuitem", { name: words.add })).toBeVisible();
        await window.screenshot({
          animations: "disabled",
          path: join(screenshots, `meeting-cue-actions-${language}-${otherWidth}.png`),
        });
      }
    } finally {
      await stopFilm?.();
      await running?.app.close();
      await removeDataFolder(dir);
    }
  });
}

// protects=two work assignments spoken in a single turn can be kept or undone independently
// fails_when=adding selected words saves the full turn or opens the wrong occurrence
for (const language of ["en", "zh-CN"] as const) {
  test(`two selected excerpts from one saved transcript line keep their own tasks (${language})`, async () => {
    const first =
      language === "en"
        ? "as the industrial designer , you're gonna be working on you know the actual working design of it"
        : "工业设计负责人研究实际设计";
    const second =
      language === "en" ? "for user interface , technical functions" : "界面负责人确定技术功能";
    const text =
      language === "en"
        ? `Um ${first} so y you know what you're doing there . Um ${second} , I guess that's you know like what we've been talking about .`
        : `先说分工，${first}，${second}，下一次再讨论。`;
    const dir = await createDataFolder();
    const app = await launchApp(dir, {
      computerSound: "silent",
      transcriber: { live: true, lines: [text] },
    });
    try {
      const { window } = app;
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const bar = await startRecording(window, await recordMeeting(window), { notice: true });
      await firstTranscriptLine(window);
      await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
      const inline = window.getByTestId("meeting-note-transcript");
      await pointAndClick(window, inline.getByTestId("meeting-stop"));
      await transcriptSaved(window);
      await settleFirstFill(window);
      const bridge = await coreOf(window);
      const decoy = `${text} Extra words from another speaker.`;
      if (language === "en") {
        const id = await bridge.evaluate(async (core) => (await core.listMeetings())[0]?.id);
        if (!id) throw new Error("Missing saved meeting.");
        const file = join(dir, "Transcripts", `${id}.vtt`);
        const recorded = readVtt(await readFile(file, "utf8"));
        const cue = recorded.cues.find((row) => row.text === text);
        if (!cue) throw new Error("Missing original cue.");
        await writeFile(
          file,
          writeVtt({
            ...recorded,
            cues: [
              { ...cue, speaker: "Morgan", text: decoy },
              { ...cue, speaker: "Riley" },
            ],
          }),
        );
        await expect(
          inline.getByTestId("transcript-line").filter({ hasText: decoy }),
        ).toBeVisible();
      }
      const line = inline
        .getByTestId("transcript-line")
        .filter({ hasText: text, hasNotText: "Extra words from another speaker" })
        .first();
      const addWords = async (quote: string) => {
        const ends = quote === first ? ["as the", "it"] : ["for user", "functions"];
        if (language === "en")
          await slideSelect(window, line, ends[0] ?? quote, { line, words: ends[1] ?? quote });
        else await slideSelect(window, line, quote);
        await expect
          .poll(() => window.evaluate(() => document.getSelection()?.toString()))
          .toBe(quote);
        await pointAndClick(
          window,
          inline.getByRole("button", {
            name: language === "en" ? "Add selected words to action items" : "将选中的原话加入待办",
          }),
        );
      };
      const read = () =>
        bridge.evaluate(async (core) => {
          const [meeting] = await core.listMeetings();
          if (!meeting) throw new Error("The stopped meeting is missing.");
          const items = meeting.summary?.items ?? [];
          return Promise.all(
            items.map(async (item) => ({
              text: item.text,
              sources: (await core.getMeetingSummaryItemSources(meeting.id, item.id))?.sources,
            })),
          );
        });
      await addWords(first);
      await expect.poll(async () => (await read()).map((item) => item.text)).toEqual([first]);
      await addWords(second);
      await expect
        .poll(async () => (await read()).map((item) => item.text))
        .toEqual([first, second]);
      const bounds = {
        startMs: Number(await line.getAttribute("data-start")),
        endMs: Number(await line.getAttribute("data-end")),
      };
      expect(await read()).toMatchObject(
        [first, second].map((text) => ({ text, sources: [{ ...bounds, text }] })),
      );
      const items = inline.getByTestId("meeting-summary-items");
      if ((await items.getAttribute("open")) === null)
        await pointAndClick(window, items.locator("summary"));
      const item = items.getByTestId("meeting-summary-item").filter({ hasText: second });
      const speech = await showSpeech(window, item, second);
      await pointAndClick(window, speech.getByTestId("meeting-summary-item-source"));
      const highlight = window.locator(
        `[data-testid="viewer-transcript"] [data-start="${bounds.startMs}"][data-end="${bounds.endMs}"] [data-quote-highlight]`,
      );
      await expect.poll(async () => (await highlight.allTextContents()).join("")).toBe(second);
      if (language === "en")
        await expect(
          window
            .getByTestId("viewer-transcript")
            .getByTestId("transcript-line")
            .filter({ hasText: decoy })
            .locator("[data-quote-highlight]"),
        ).toHaveCount(0);

      await pointAndClick(window, window.getByTestId("undo-action"));
      await expect.poll(async () => (await read()).map((row) => row.text)).toEqual([first]);
    } finally {
      await app.app.close();
      await removeDataFolder(dir);
    }
  });
}
