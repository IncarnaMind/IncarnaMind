import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  expectBarOneRow,
  heldGlobalKeys as held,
  launchApp,
  openSettings,
  paletteFound,
  panelOf,
  panelOpen,
  pointAndClick,
  pressHeldKeys as pressKeys,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
  useLocalChatModel,
} from "./app";

/**
 * One-click help during a call, on the scripted chat model and the fake capture and
 * transcriber every smoke test gets: the floating panel above the meeting with the buttons and
 * the latest suggestion, the buttons at the top of the assistant, the shortcuts held only while
 * a meeting records, and the level bars. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(page: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";
/** The other side of a sales call, as the fake transcriber hears them. */
const BUYER = [
  "Can you do thirty-five dollars a seat for Enterprise?",
  "How much is the Enterprise plan per seat, and does it include single sign-on?",
];
const mac = process.platform === "darwin";
/** The first button's and Call help's shortcuts: macOS's defaults, which `setMeetingKeys` gives the other systems. */
const FIRST_KEYS = "Ctrl+Alt+1";
const PANEL_KEYS = "Ctrl+Alt+H";
const PANEL_LABEL = mac ? "⌃⌥H" : "Ctrl+Alt+H";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const core = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/** A meeting recording from both sides, its first lines in. */
async function recordingMeeting(window: Page) {
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
  return bar;
}

async function pressIn(page: Page, name: string): Promise<Locator> {
  const button = page.getByTestId("help-button").filter({ hasText: name });
  await pointAndClick(page, button);
  const suggestion = page.getByTestId("help-suggestion").last();
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(suggestion.getByTestId("help-heading")).toContainText(name);
  return suggestion;
}

/** Up to three short lines, none starred and none with an arrow. */
async function expectLines(suggestion: Locator): Promise<void> {
  const lines = suggestion.getByTestId("help-option");
  await expect(lines.first()).toBeVisible();
  expect(await lines.count()).toBeLessThanOrEqual(3);
  await expect(suggestion.getByTestId("help-option-effect")).toHaveCount(0);
  await expect(suggestion.locator('[data-recommended="true"]')).toHaveCount(0);
}

/** Runs a command from ⌘K by its full name. */
async function fromPalette(window: Page, name: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(name);
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("palette-search")).toBeHidden();
}

/** One or two options, the first recommended and starred, each with what it leads to. */
async function expectOptions(suggestion: Locator): Promise<void> {
  const options = suggestion.getByTestId("help-option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toHaveAttribute("data-recommended", "true");
  await expect(options.first()).toContainText("★");
  await expect(options.nth(1)).toHaveAttribute("data-recommended", "false");
  for (const option of await options.all()) {
    await expect(option.getByTestId("help-option-say")).toHaveText(/^“.+”/);
    await expect(option.getByTestId("help-option-effect")).toHaveText(/^→ \S/);
  }
}

test("help during the call: the floating panel above the meeting gives one or two options per button in English and Chinese, never takes the focus, and changes with the template", async () => {
  // Nineteen presses, each one streaming a scripted Answer.
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await recordingMeeting(window);

  // With no AI model yet, the assistant and the panel each say so in one line, with Set up.
  await window.getByTestId("mind-editor").click();
  await expect(window.getByTestId("meeting-set-up")).toHaveText(
    "Choose an AI model to get help during the call · Set up",
  );
  const panel = await panelOf(app);
  await pointAndClick(
    panel,
    panel.getByTestId("help-button").filter({ hasText: "Say no politely" }),
  );
  await expect(panel.getByTestId("help-set-up")).toHaveText(
    "Choose an AI model to get help during the call · Set up",
  );
  await useLocalChatModel(window);
  await expect(window.getByTestId("meeting-starter")).toHaveText([
    "Recap the last 5 minutes",
    "What should I ask next?",
    "Action items so far",
  ]);

  // The panel opened with the recording: above other windows, never focused, kept out of
  // capture where the system can.
  const panelWindow = await app.browserWindow(panel);
  const state = () =>
    panelWindow.evaluate((win) => ({
      onTop: win.isAlwaysOnTop(),
      focusable: win.isFocusable(),
      focused: win.isFocused(),
      hidden: process.platform === "linux" ? null : win.isContentProtected(),
    }));
  expect(await state()).toEqual({
    onTop: true,
    focusable: false,
    focused: false,
    hidden: process.platform === "linux" ? null : true,
  });
  // It doesn't say so until real screen shares confirm it.
  await expect(panel.getByTestId("panel-hidden")).toHaveCount(0);
  const buttons = panel.getByTestId("help-button");
  await expect(buttons).toHaveText([
    /^What should I say\?/,
    /^Answer their question/,
    /^What do they want\?/,
    /^Sum up so far/,
    /^Say no politely/,
    /^What to ask next/,
    /^Check what was said/,
  ]);
  await expect(buttons.first().getByTestId("help-button-keys")).toHaveText(
    mac ? "⌃⌥1" : "Ctrl+Alt+1",
  );

  // A press shows the outline at once, then the options; the panel still isn't focused.
  await pointAndClick(panel, buttons.filter({ hasText: "Say no politely" }));
  await expect(panel.getByTestId("help-outline").first()).toBeVisible();
  const sayNo = panel.getByTestId("help-suggestion");
  await expect(sayNo).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(sayNo.getByTestId("help-heading")).toHaveText(/^Say no politely · They said: “.+”$/);
  await expectOptions(sayNo);
  expect((await state()).focused).toBe(false);
  await shot(panel, "help-panel-say-no-en");

  // "What do they want?": readings, each resting on a moment of the transcript it cites.
  const want = await pressIn(panel, "What do they want?");

  await expect(want.getByTestId("help-heading")).toHaveText(
    "What do they want? · Read from what they said",
  );
  await expect(
    want.getByTestId("help-option-note").first().getByTestId("help-citation"),
  ).toHaveAttribute("data-check", "found");

  // What to ask next writes options; Check what was said, up to three lines.
  await expectOptions(await pressIn(panel, "What to ask next"));
  await expectLines(await pressIn(panel, "Check what was said"));

  // While the panel shows, the assistant has no second row of the same buttons.
  await expect(window.getByTestId("help-strip")).toHaveCount(0);

  // The template adds its buttons, and takes them back.
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pointAndClick(
    panel,
    panel.locator('[data-testid="panel-template-option"][data-template="sales"]'),
  );
  await expect(buttons).toHaveCount(10);
  await expect(buttons.nth(7)).toHaveText("Handle the objection");
  await expect(panel.getByTestId("panel-template")).toHaveText("Sales call");
  await expectOptions(await pressIn(panel, "Handle the objection"));
  await expectOptions(await pressIn(panel, "Propose the next step"));
  await expectLines(await pressIn(panel, "Facts from my documents"));
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pointAndClick(
    panel,
    panel.locator('[data-testid="panel-template-option"][data-template="interview"]'),
  );
  await expect(buttons.nth(8)).toHaveText("Am I leading them?");
  const leading = await pressIn(panel, "Am I leading them?");
  await expect(leading.getByTestId("help-heading")).toHaveText(
    /^Am I leading them\? · You said: “.+”$/,
  );
  await expectOptions(await pressIn(panel, "A follow-up question"));
  await expectLines(await pressIn(panel, "Not covered yet"));
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pointAndClick(
    panel,
    panel.locator('[data-testid="panel-template-option"][data-template="team"]'),
  );
  await expect(buttons).toHaveCount(9);
  await expect(buttons.nth(8)).toHaveText("Where we disagree");
  await expectLines(await pressIn(panel, "Decisions and owners so far"));
  await expectLines(await pressIn(panel, "Where we disagree"));
  await shot(panel, "help-panel-team-en");

  // In a Chinese interface the buttons and headings are Chinese; the options keep the call's
  // language, here English.
  await (await core(window)).evaluate((bridge) =>
    bridge.updateSettings({ user: { language: "zh-CN" } }),
  );
  await expect(buttons.first()).toContainText("我该怎么说？");
  const sayNoZh = await pressIn(panel, "礼貌地拒绝");
  await expect(sayNoZh.getByTestId("help-heading")).toHaveText(/^礼貌地拒绝 · 对方说：“.+”$/);
  await expectOptions(sayNoZh);
  await expect(sayNoZh.getByTestId("help-option-say").first()).toContainText("Friday");
  await expectOptions(await pressIn(panel, "接下来问什么"));
  await expectLines(await pressIn(panel, "核对刚才说的话"));
  await expectLines(await pressIn(panel, "分歧在哪里"));
  await shot(panel, "help-panel-say-no-zh");
  await app.close();
});

test("help during the call: the panel folds to level bars that become Stop, ⌘K folds it, pins and adds its suggestion, and closed, the buttons move to the assistant until ⌘K shows it again", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await useLocalChatModel(window);
  const bar = await recordingMeeting(window);
  const panel = await panelOf(app);
  await expectLines(await pressIn(panel, "Sum up so far"));

  // Folded to a pill: the level bars move with the voices, and pointed at or focused, are Stop.
  await pointAndClick(panel, panel.getByTestId("panel-collapse"));
  const pill = panel.getByTestId("panel-pill");
  await expect(pill).toBeVisible();
  await expect(pill.getByTestId("panel-keys")).toHaveText(mac ? "⌃⌥1–7" : "Ctrl+Alt+1–7");
  const stop = pill.getByTestId("level-stop");
  await expect(stop.getByTestId("level-bar")).toHaveCount(5);
  await shot(panel, "help-panel-pill-en");
  await stop.hover();
  await expect(stop.getByTestId("level-stop-icon")).toBeVisible();
  await pill.getByTestId("panel-expand").hover();
  await expect(stop.getByTestId("level-bars")).toBeVisible();
  await stop.focus();
  await expect(stop.getByTestId("level-stop-icon")).toBeVisible();
  await stop.blur();
  await pointAndClick(panel, pill.getByTestId("panel-expand"));
  await expect(panel.getByTestId("help-buttons")).toBeVisible();

  // ⌘K in the app's window folds and unfolds the panel, pins its suggestion and adds it to notes.
  await fromPalette(window, "Collapse the call help panel");
  await expect(pill).toBeVisible();
  await fromPalette(window, "Expand the call help panel");
  await expect(panel.getByTestId("help-buttons")).toBeVisible();
  await fromPalette(window, "Pin the latest suggestion");
  await expect(panel.getByTestId("help-pin").last()).toHaveAttribute("aria-pressed", "true");
  await fromPalette(window, "Add the latest suggestion to notes");
  await expect(window.getByTestId("mind-editor")).toContainText("partner preview");
  await expect(window.getByTestId("undo-message")).toHaveText("Added to notes");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(window.getByTestId("mind-editor")).not.toContainText("partner preview");

  // Closed, it stays closed for this meeting, and the buttons sit at the top of the assistant,
  // which shows the help asked there; ⌘K shows the panel again.
  // The window goes as the click lands, which a click Playwright waits on would call a failure.
  const close = panel.getByTestId("panel-close");
  await close.hover();
  await close.evaluate((button) => setTimeout(() => (button as HTMLElement).click(), 0));
  await expect.poll(() => panelOpen(app)).toBe(false);
  const strip = window.getByTestId("help-strip");
  await expect(strip.getByTestId("help-button")).toHaveCount(7);
  await pointAndClick(
    window,
    strip.getByTestId("help-button").filter({ hasText: "Sum up so far" }),
  );
  await expect(window.getByTestId("assistant-question").last()).toContainText("Sum up so far");
  await expect(window.getByTestId("assistant-answer").last()).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 20_000 },
  );
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Show the call help panel");
  await window.keyboard.press("Enter");
  const shown = await panelOf(app);
  await expect(shown.getByTestId("help-heading")).toContainText("Sum up so far");
  await expect(strip).toHaveCount(0);

  // Stop ends the meeting, and the panel goes with it.
  await bar.getByTestId("meeting-stop").click();
  await expect.poll(() => panelOpen(app)).toBe(false);
  await app.close();
});

test("help during the call: Call help in the meeting bar shows and hides the panel for the meeting, its tooltip, ⌘K and Settings name its shortcut, held only while recording, and the bar stays one row when narrow, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  const bar = await recordingMeeting(window);
  await panelOf(app);

  // The panel opened with the recording: Call help is pressed, and hides it.
  const callHelp = bar.getByTestId("meeting-call-help");
  await expect(callHelp).toHaveText("Call help");
  await expect(callHelp).toHaveAttribute("aria-pressed", "true");
  await expect(callHelp).toHaveAttribute("title", "Hide the call help panel");
  await expect.poll(() => held(app, PANEL_KEYS)).toBe(true);
  await pointAndClick(window, callHelp);
  await expect.poll(() => panelOpen(app)).toBe(false);
  await expect(callHelp).toHaveAttribute("aria-pressed", "false");
  await expect(callHelp).toHaveAttribute("title", `Show the call help panel (${PANEL_LABEL})`);

  // Paused, its keys go back to other apps; resumed, they are held again and the panel stays
  // hidden, the User's choice for this meeting. The shortcut shows it, and hides it again.
  await bar.getByTestId("meeting-pause").click();
  await expect.poll(() => held(app, PANEL_KEYS)).toBe(false);
  await bar.getByTestId("meeting-resume").click();
  await expect.poll(() => held(app, PANEL_KEYS)).toBe(true);
  await pressKeys(app, "panel");
  await panelOf(app);
  await expect(callHelp).toHaveAttribute("aria-pressed", "true");
  await pressKeys(app, "panel");
  await expect.poll(() => panelOpen(app)).toBe(false);
  await expect(callHelp).toHaveAttribute("aria-pressed", "false");

  // ⌘K has the same words and keys.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Show the call help panel");
  await expect(paletteFound(window).filter({ hasText: "Show the call help panel" })).toContainText(
    PANEL_LABEL,
  );
  if (SCREENSHOTS) {
    await window.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
  }
  await shot(window, "call-help-palette-en");
  await window.keyboard.press("Enter");
  await panelOf(app);
  await expect(callHelp).toHaveAttribute("aria-pressed", "true");

  // Changed in Settings › Meetings with the others, held at once, and the tooltip says so.
  const settings = await openSettings(window, "meetings");
  const keys = settings.locator('[data-testid="help-keys"][data-kind="panel"]');
  await expect(settings.getByTestId("help-keys-row").first()).toContainText("Call help");
  await expect(keys).toHaveText(PANEL_LABEL);
  await shot(settings.getByTestId("help-settings"), "call-help-settings-en");
  await keys.click();
  await window.keyboard.press("Control+Alt+J");
  await expect(keys).toHaveText(mac ? "⌃⌥J" : "Ctrl+Alt+J");
  await expect.poll(() => held(app, "Ctrl+Alt+J")).toBe(true);
  await expect.poll(() => held(app, PANEL_KEYS)).toBe(false);
  await closeSettings(window);
  await pointAndClick(window, callHelp);
  await expect(callHelp).toHaveAttribute(
    "title",
    `Show the call help panel (${mac ? "⌃⌥J" : "Ctrl+Alt+J"})`,
  );

  await window.mouse.move(1, 1);
  await expectBarOneRow(bar);
  await shot(bar, "call-help-bar-en-1600");
  await setWindowSize(app, window, 1100, 800);
  await expectBarOneRow(bar);
  await shot(bar, "call-help-bar-en-1100");
  await (await core(window)).evaluate((bridge) =>
    bridge.updateSettings({ user: { language: "zh-CN" } }),
  );
  await expect(callHelp).toHaveText("通话助手");
  await expect(callHelp).toHaveAttribute(
    "title",
    `显示通话助手浮窗（${mac ? "⌃⌥J" : "Ctrl+Alt+J"}）`,
  );
  await pointAndClick(window, callHelp);
  await panelOf(app);
  await expect(callHelp).toHaveAttribute("title", "隐藏通话助手浮窗");
  await window.mouse.move(1, 1);
  await expectBarOneRow(bar);
  await shot(bar, "call-help-bar-zh-1100");
  await setWindowSize(app, window, 1600, 900);
  await expectBarOneRow(bar);
  await shot(bar, "call-help-bar-zh-1600");

  // Stopped, nothing is held.
  await bar.getByTestId("meeting-stop").click();
  await expect.poll(() => held(app, "Ctrl+Alt+J")).toBe(false);
  await app.close();
});

test("help during the call: Answer their question cites the price sheet, checked; the shortcuts are held only while recording, work with another app in front and can be changed; the level bars hold still with reduced motion", async () => {
  const sources = await createDataFolder();
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await useLocalChatModel(window);
  // Documents wait while a meeting records: the price sheet is added first.
  const sheet = join(sources, "Price sheet.txt");
  await writeFile(
    sheet,
    `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}\nPilot: 30 days, free.\n`,
  );
  await (await core(window)).evaluate((bridge, path) => bridge.addDocuments([path]), sheet);
  await expect
    .poll(async () =>
      (await core(window)).evaluate(async (bridge) =>
        (await bridge.listDocuments()).map((document) => document.status),
      ),
    )
    .toEqual(["ready"]);
  const bar = await recordingMeeting(window);
  const panel = await panelOf(app);

  const answer = await pressIn(panel, "Answer their question");
  await expect(answer.getByTestId("help-option-say").first()).toContainText("$45 per seat");
  await expect(answer.getByTestId("help-citation").first()).toHaveAttribute("data-check", "found");
  await expect(answer.getByTestId("help-source")).toHaveText([/^1 · Price sheet · /]);
  await shot(panel, "help-panel-answer-en");

  // Held while recording; a press with another app in front writes that button's options.
  await expect.poll(() => held(app, FIRST_KEYS)).toBe(true);
  await pressKeys(app, "say");
  const said = panel.getByTestId("help-suggestion");
  await expect(said.getByTestId("help-heading")).toContainText("What should I say?", {
    timeout: 20_000,
  });
  await expect(said).toHaveAttribute("data-status", "done", { timeout: 20_000 });

  // Paused, the keys go back to other apps; resumed, they are held again.
  await bar.getByTestId("meeting-pause").click();
  await expect.poll(() => held(app, FIRST_KEYS)).toBe(false);
  await bar.getByTestId("meeting-resume").click();
  await expect.poll(() => held(app, FIRST_KEYS)).toBe(true);

  // The level bars beside the timer; with reduced motion they hold still and only change height.
  const meter = bar.getByTestId("level-bars");
  await expect(meter).toHaveAttribute("data-motion", "on");
  await (await core(window)).evaluate((bridge) =>
    bridge.updateSettings({ device: { motion: "reduced" } }),
  );
  await expect(meter).toHaveAttribute("data-motion", "reduced");
  await expect
    .poll(async () => {
      const heights = await meter
        .getByTestId("level-bar")
        .evaluateAll((bars) => bars.map((each) => (each as HTMLElement).offsetHeight));
      return (
        heights[0] === heights[4] &&
        heights[1] === heights[3] &&
        (heights[2] ?? 0) >= (heights[1] ?? 0)
      );
    })
    .toBe(true);

  // Changed in Settings › Meetings, held at once; keys another app holds say so and stay unchosen.
  const settings = await openSettings(window, "meetings");
  const first = settings.locator('[data-testid="help-keys"][data-kind="say"]');
  await first.click();
  await expect(first).toHaveText("Press the new keys…");
  await window.keyboard.press("Control+Alt+9");
  await expect(first).toHaveText(mac ? "⌃⌥9" : "Ctrl+Alt+9");
  await expect.poll(() => held(app, "Ctrl+Alt+9")).toBe(true);
  await expect.poll(() => held(app, FIRST_KEYS)).toBe(false);
  await app.evaluate(({ globalShortcut }) =>
    globalShortcut.register("Ctrl+Alt+8", () => undefined),
  );
  await first.click();
  await window.keyboard.press("Control+Alt+8");
  await expect(settings.getByTestId("help-keys-problem")).toHaveText(
    "In use by another app · Choose another",
  );
  await expect(first).toHaveText(mac ? "⌃⌥9" : "Ctrl+Alt+9");
  await closeSettings(window);

  // Stopped, nothing is held.
  await bar.getByTestId("meeting-stop").click();
  await expect.poll(() => held(app, "Ctrl+Alt+9")).toBe(false);
  await app.close();
  await removeDataFolder(sources);
});

test("help during the call with the live text behind and no line yet: the panel says so in one line, not options, in English and Chinese (#1366)", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    // No line is decoded in time: the audio piles up until the live text falls behind.
    transcriber: { decodeMs: 600_000 },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await startRecording(window, await recordMeeting(window), { notice: true });
  await expect
    .poll(
      async () =>
        (await (await core(window)).evaluate((bridge) => bridge.listMeetings()))[0]?.transcript
          ?.state,
      { timeout: 60_000 },
    )
    .toBe("behind");
  const panel = await panelOf(app);

  const english = await pressIn(panel, "Answer their question");
  const line = english.getByTestId("help-option");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("The live text is behind, so none of the call is written yet");
  await expect(english.getByTestId("help-option-effect")).toHaveCount(0);
  await shot(panel, "help-panel-behind-en");

  await setLanguage(window, "zh-CN");
  const chinese = await pressIn(panel, "回答对方的问题");
  await expect(chinese.getByTestId("help-option")).toHaveCount(1);
  await expect(chinese.getByTestId("help-option")).toContainText(
    "实时转写跟不上，通话内容还没有转写出来",
  );
  await shot(panel, "help-panel-behind-zh");
  await app.close();
});

test("help during the call follows the call's language: a Chinese call gets Chinese help in an English interface, for Sum up, What to ask next, Check what was said and a template's button", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: {
      lines: ["我们先看一下报价。", "团队版每个席位每月二十五美元。"],
      theirLines: ["企业版能便宜一点吗？", "四十个席位一共多少钱？"],
    },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await recordingMeeting(window);
  const panel = await panelOf(app);
  const han = /\p{Script=Han}/u;

  const sum = await pressIn(panel, "Sum up so far");
  await expectLines(sum);
  await expect(sum.getByTestId("help-option-say").first()).toHaveText(han);
  const ask = await pressIn(panel, "What to ask next");
  await expectOptions(ask);
  await expect(ask.getByTestId("help-option-say").first()).toHaveText(han);
  await expect(ask.getByTestId("help-option-effect").first()).toHaveText(han);
  await expect(ask.getByTestId("help-heading")).toHaveText(/^What to ask next · They said: “.+”$/);
  const check = await pressIn(panel, "Check what was said");
  await expectLines(check);
  await expect(check.getByTestId("help-option-say").first()).toHaveText(han);

  await (await core(window)).evaluate((bridge) =>
    bridge.updateSettings({ user: { language: "zh-CN" } }),
  );
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pointAndClick(
    panel,
    panel.locator('[data-testid="panel-template-option"][data-template="sales"]'),
  );
  const objection = await pressIn(panel, "处理异议");
  await expectOptions(objection);
  await expect(objection.getByTestId("help-option-say").first()).toHaveText(han);
  await expect(objection.getByTestId("help-heading")).toHaveText(/^处理异议 · 对方说：“.+”$/);
  await app.close();
});

test("help during the call on Windows and Linux: no shortcut is held until the User sets one in Settings › Meetings, which says so at 900 px in English and Chinese, and a key another app holds is refused", async () => {
  test.skip(mac, "macOS keeps its ⌃⌥ defaults, which the tests above cover.");
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 900, 800);
  await dismissChatSetup(window);
  const bar = await recordingMeeting(window);
  const panel = await panelOf(app);

  for (const keys of [
    ...Array.from({ length: 9 }, (_, index) => `Ctrl+Shift+${index + 1}`),
    ...["1", "7", "H", "M"].map((key) => `Ctrl+Alt+${key}`),
  ]) {
    expect(await held(app, keys), keys).toBe(false);
  }
  await expect(panel.getByTestId("help-button").first()).toBeVisible();
  await expect(panel.getByTestId("help-button-keys")).toHaveCount(0);
  const mic = panel.getByTestId("panel-mic");
  await expect(mic).toHaveAttribute("title", "Pause my mic. The other side is still recorded");
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Hide the call help panel");
  const hide = paletteFound(window).filter({ hasText: "Hide the call help panel" });
  await expect(hide).toHaveCount(1);
  await expect(hide).not.toContainText("Ctrl");
  await window.keyboard.press("Escape");

  const settings = await openSettings(window, "meetings");
  const rows = settings.getByTestId("help-keys-row");
  await expect(rows).toHaveCount(9);
  const field = (kind: string) =>
    settings.locator(`[data-testid="help-keys"][data-kind="${kind}"]`);
  const remove = settings.getByTestId("help-keys-remove");
  const problem = settings.getByTestId("help-keys-problem");
  const hint = settings
    .getByTestId("help-settings")
    .getByText(
      "No keys are set to start with. A key you set works over the meeting app, only while recording.",
    );
  const hintZh = settings.getByText("默认没有快捷键。设置后，可在会议应用中使用，仅在录制时有效。");
  await expect(hint).toBeVisible();
  for (const row of await rows.all()) {
    await expect(row.getByTestId("help-keys")).toHaveText("No key set");
  }
  await expect(remove).toHaveCount(0);
  await expectRowsFit(settings, rows);
  await shot(settings, "meeting-keys-none-en-900");

  await field("mic").click();
  await expect(field("mic")).toHaveText("Press the new keys…");
  await window.keyboard.press("Control+Alt+F8");
  await expect(field("mic")).toHaveText("Ctrl+Alt+F8");
  await expect.poll(() => held(app, "Ctrl+Alt+F8")).toBe(true);
  await expect(remove).toHaveCount(1);
  await expect(mic).toHaveAttribute(
    "title",
    "Pause my mic. The other side is still recorded (Ctrl+Alt+F8)",
  );
  await expectRowsFit(settings, rows);
  await field("mic").scrollIntoViewIfNeeded();
  await shot(settings, "meeting-keys-set-en-900");

  await field("say").click();
  await window.keyboard.press("Control+Alt+F8");
  await expect(problem).toHaveText("Already the shortcut for “Pause my mic”");
  await expect(field("say")).toHaveText("No key set");

  await app.evaluate(({ globalShortcut }) =>
    globalShortcut.register("Ctrl+Alt+F9", () => undefined),
  );
  await field("say").click();
  await window.keyboard.press("Control+Alt+F9");
  await expect(problem).toHaveText("In use by another app · Choose another");
  await expect(field("say")).toHaveText("No key set");
  await expect.poll(() => held(app, "Ctrl+Alt+F9")).toBe(true);

  await setLanguage(window, "zh-CN");
  await expect(hint).toBeHidden();
  await expect(hintZh).toBeVisible();
  await expect(field("say")).toHaveText("未设置快捷键");
  await expect(field("panel")).toHaveText("未设置快捷键");
  await expect(field("mic")).toHaveText("Ctrl+Alt+F8");
  await expect(remove).toHaveText("移除");
  await expectRowsFit(settings, rows);
  await field("mic").scrollIntoViewIfNeeded();
  await shot(settings, "meeting-keys-set-zh-900");

  await remove.click();
  await expect(field("mic")).toHaveText("未设置快捷键");
  await expect(remove).toHaveCount(0);
  await hintZh.scrollIntoViewIfNeeded();
  await shot(settings, "meeting-keys-none-zh-900");
  await expect.poll(() => held(app, "Ctrl+Alt+F8")).toBe(false);
  await setLanguage(window, "en");
  await expect(field("mic")).toHaveText("No key set");
  await expect(mic).toHaveAttribute("title", "Pause my mic. The other side is still recorded");
  await closeSettings(window);
  await bar.getByTestId("meeting-stop").click();
  await app.close();
});

test("help during the call: a model that can't answer says why in the panel, in English and Chinese, with Try again, instead of the provider's own words", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await useLocalChatModel(window, "fake-not-found");
  const bar = await recordingMeeting(window);
  const panel = await panelOf(app);
  await pointAndClick(panel, panel.getByTestId("help-button").filter({ hasText: "Sum up so far" }));
  const failed = panel.getByTestId("help-failed");
  await expect(failed).toHaveText(
    "No help this time: Ollama doesn’t know fake-not-found · Try again",
    {
      timeout: 20_000,
    },
  );
  await setLanguage(window, "zh-CN");
  await expect(failed).toHaveText("这次没能给出建议：Ollama 找不到 fake-not-found · 重试");
  await setLanguage(window, "en");
  await expect(failed.getByRole("button")).toHaveText("Try again");
  await bar.getByTestId("meeting-stop").click();
  await app.close();
});

async function expectRowsFit(settings: Locator, rows: Locator): Promise<void> {
  const page = await settings.getByTestId("help-settings").boundingBox();
  if (!page) throw new Error("Settings › Meetings isn't drawn.");
  for (const row of await rows.all()) {
    const [box, controls] = await Promise.all([
      row.boundingBox(),
      row.getByTestId("help-keys").boundingBox(),
    ]);
    if (!box || !controls) throw new Error("A shortcut row isn't drawn.");
    expect(box.x).toBeGreaterThanOrEqual(page.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(page.x + page.width + 1);
    expect(controls.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(controls.x + controls.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
}
