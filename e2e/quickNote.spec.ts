import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import {
  closeFirstFillPopover,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  focusSettled,
  launchApp,
  panelOf,
  pointAndClick,
  pressHeldKeys,
  recordMeeting,
  removeDataFolder,
  setMeetingKeys,
  setWindowSize,
  startRecording,
} from "./app";

/**
 * The call-help panel's field, for quick notes (#2925). The panel takes the keyboard only while
 * the field is in use: a click in it, ⌃⌥N or ⌘K's Quick note take it, and Esc, collapsing, the
 * panel's close and Stop give it back. A window this spec opens stands in for the meeting app,
 * so where the keyboard is can be read before, during and after: no test can drive a real one.
 */
const BUYER = [
  "Can you do thirty-five dollars a seat for Enterprise?",
  "How much is the Enterprise plan per seat, and does it include single sign-on?",
];

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** A window of its own in front, standing in for the meeting app; returns its id. */
const openMeetingApp = (app: ElectronApplication) =>
  app.evaluate(async ({ BrowserWindow }) => {
    const stand = new BrowserWindow({ width: 480, height: 320, x: 40, y: 40, title: "Meeting" });
    await stand.loadURL("about:blank");
    stand.focus();
    return stand.id;
  });

const meetingAppFocused = (app: ElectronApplication, id: number) =>
  app.evaluate(({ BrowserWindow }, standId) => !!BrowserWindow.fromId(standId)?.isFocused(), id);

async function recording() {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await connectLocalChatModel(window);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await firstTranscriptLine(window);
  const panel = await panelOf(app);
  const meetingApp = await openMeetingApp(app);
  await expect.poll(() => meetingAppFocused(app, meetingApp)).toBe(true);
  return { app, window, bar, panel, meetingApp };
}

/** Where the keyboard is, as the system tells the windows: the panel's, and whether it may take it. */
async function keyboardOf(app: ElectronApplication, panel: Page, meetingApp: number) {
  const panelWindow = await app.browserWindow(panel);
  const [panelFocused, focusable, inMeetingApp] = await Promise.all([
    panelWindow.evaluate((win) => win.isFocused()),
    panelWindow.evaluate((win) => win.isFocusable()),
    meetingAppFocused(app, meetingApp),
  ]);
  return { panel: panelFocused, focusable, meetingApp: inMeetingApp };
}

const LEFT_ALONE = { panel: false, focusable: false, meetingApp: true };
const TAKEN = { panel: true, focusable: true, meetingApp: false };

const fieldOf = (panel: Page) => panel.getByTestId("quick-note-field");

/** Where a thing is below the top of the panel, which is what "does not move" means for a panel that grows. */
async function below(panel: Page, target: Locator): Promise<number> {
  const [box, frame] = await Promise.all([
    target.boundingBox(),
    panel.getByTestId("meeting-panel").boundingBox(),
  ]);
  if (!box || !frame) throw new Error("The panel isn't drawn.");
  return box.y - frame.y;
}

/** The Note's lines with the meeting time each was taken at, "" for none. */
const noteLines = (window: Page) =>
  window
    .getByTestId("mind-editor")
    .locator("p")
    .evaluateAll((all) =>
      all
        .filter((line) => (line.textContent ?? "").trim() !== "")
        .map((line) => [line.textContent ?? "", line.getAttribute("data-meeting-time") ?? ""]),
    );

test("quick note: a click in the field takes the keyboard from the meeting app, Enter adds the line to the Note with its time and keeps the cursor there, Undo takes it out, and Esc gives the keyboard back with unsent text kept", async () => {
  test.setTimeout(90_000);
  const { app, window, panel, meetingApp } = await recording();
  const field = fieldOf(panel);
  await expect(field).toHaveAttribute("placeholder", "Note for this meeting…");
  expect(await keyboardOf(app, panel, meetingApp)).toEqual(LEFT_ALONE);
  const fieldTop = await below(panel, field);

  await pointAndClick(panel, field);
  await expect.poll(() => keyboardOf(app, panel, meetingApp)).toEqual(TAKEN);
  await expect(field).toBeFocused();
  await panel.keyboard.type("Ask about single sign-on");
  await panel.keyboard.press("Enter");

  await expect
    .poll(() => noteLines(window))
    .toContainEqual(["Ask about single sign-on", expect.stringMatching(/^\d+:\d{2}$/)]);
  const [, time] =
    (await noteLines(window)).find(([text]) => text === "Ask about single sign-on") ?? [];
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("placeholder", `Added to notes at ${time}`);
  const undo = panel.getByTestId("quick-note-undo");
  await expect(undo).toBeVisible();
  expect(Math.abs((await below(panel, field)) - fieldTop)).toBeLessThan(1);
  expect(await keyboardOf(app, panel, meetingApp)).toEqual(TAKEN);

  await pointAndClick(panel, undo);
  await expect
    .poll(async () => (await noteLines(window)).map(([text]) => text))
    .not.toContain("Ask about single sign-on");
  await expect(undo).toHaveCount(0);

  // A note of two lines: one paragraph a line, the time on the first; then the confirmation goes by itself.
  await panel.keyboard.type("Budget is 40k");
  await panel.keyboard.press("Shift+Enter");
  await panel.keyboard.type("Owner is Dana");
  await panel.keyboard.press("Enter");
  await expect
    .poll(async () => (await noteLines(window)).slice(-2))
    .toEqual([
      ["Budget is 40k", expect.stringMatching(/^\d+:\d{2}$/)],
      ["Owner is Dana", ""],
    ]);
  await expect(field).toHaveAttribute("placeholder", "Note for this meeting…", { timeout: 5_000 });

  // Esc gives the keyboard back to the app that had it, the panel stays, and the unsent line with it.
  await panel.keyboard.type("Not sent yet");
  await panel.keyboard.press("Escape");
  await expect.poll(() => keyboardOf(app, panel, meetingApp)).toEqual(LEFT_ALONE);
  await expect(field).toHaveValue("Not sent yet");
  await expect(panel.getByTestId("ask-bar")).toBeVisible();

  // The meeting app taking the keyboard back by itself leaves the panel unable to take it.
  await pointAndClick(panel, field);
  await expect.poll(() => keyboardOf(app, panel, meetingApp)).toEqual(TAKEN);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.focus(), meetingApp);
  await expect.poll(() => keyboardOf(app, panel, meetingApp)).toEqual(LEFT_ALONE);
  await app.close();
});

test("quick note: the panel never takes the keyboard by itself: not as it appears, nor on a click on a prompt, More…, a row or a button, nor when an answer arrives", async () => {
  test.setTimeout(90_000);
  const { app, panel, meetingApp } = await recording();
  const leftAlone = async () =>
    expect(await keyboardOf(app, panel, meetingApp)).toEqual(LEFT_ALONE);
  await leftAlone();

  const bar = panel.getByTestId("ask-bar");
  await pointAndClick(
    panel,
    bar.getByTestId("help-prompt").filter({ hasText: "What should I say?" }),
  );
  await leftAlone();
  const suggestion = panel.getByTestId("help-suggestion");
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await leftAlone();

  await pointAndClick(panel, panel.getByTestId("help-more"));
  await leftAlone();
  await pointAndClick(
    panel,
    panel
      .getByTestId("help-more-list")
      .getByTestId("help-prompt")
      .filter({ hasText: "Sum up so far" }),
  );
  await expect(suggestion.last()).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await leftAlone();
  await pointAndClick(panel, panel.getByTestId("help-pin").last());
  await pointAndClick(panel, panel.getByTestId("quick-note-send"));
  await pointAndClick(panel, panel.getByTestId("panel-collapse"));
  await pointAndClick(panel, panel.getByTestId("panel-expand"));
  await leftAlone();
  await app.close();
});

test("quick note: ⌃⌥N opens a collapsed or closed panel with the cursor in the field, the meeting's keys still ask while the field has the keyboard, and collapsing gives it back", async () => {
  test.setTimeout(90_000);
  const { app, panel, meetingApp } = await recording();
  await pointAndClick(panel, panel.getByTestId("panel-collapse"));
  await expect(panel.getByTestId("panel-pill")).toBeVisible();

  await pressHeldKeys(app, "note");
  await expect(fieldOf(panel)).toBeFocused();
  await expect.poll(() => keyboardOf(app, panel, meetingApp)).toEqual(TAKEN);

  await pressHeldKeys(app, "say");
  const suggestion = panel.getByTestId("help-suggestion");
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(suggestion.getByTestId("help-heading")).toContainText("What should I say?");
  await expect(fieldOf(panel)).toBeFocused();
  expect(await keyboardOf(app, panel, meetingApp)).toEqual(TAKEN);

  await pointAndClick(panel, panel.getByTestId("panel-collapse"));
  await expect.poll(() => keyboardOf(app, panel, meetingApp)).toEqual(LEFT_ALONE);

  // Closed, it opens again for the field.
  await pointAndClick(panel, panel.getByTestId("panel-expand"));
  await pointAndClick(panel, panel.getByTestId("panel-close"));
  await expect.poll(() => panel.isClosed()).toBe(true);
  await pressHeldKeys(app, "note");
  const opened = await panelOf(app);
  await expect(fieldOf(opened)).toBeFocused();
  await expect.poll(() => keyboardOf(app, opened, meetingApp)).toEqual(TAKEN);
  await app.close();
});

test('quick note: "/su" lists Sum up so far first and Enter asks it; Esc closes the list and clears the "/"; a "/" later in a line opens nothing', async () => {
  test.setTimeout(90_000);
  const { app, window, panel } = await recording();
  const field = fieldOf(panel);
  await pointAndClick(panel, field);
  await panel.keyboard.type("/su");
  const list = panel.getByTestId("help-slash-list");
  await expect(list.getByTestId("help-prompt").first()).toHaveText(/^Sum up so far/);
  await expect(list.locator('[aria-selected="true"]')).toHaveText(/^Sum up so far/);
  // The list lies over what is under the field and is whole in the window.
  const box = await list.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
    await panel.evaluate(() => globalThis.innerHeight),
  );
  await panel.keyboard.press("Enter");
  const suggestion = panel.getByTestId("help-suggestion");
  await expect(suggestion.getByTestId("help-heading")).toContainText("Sum up so far");
  await expect(field).toHaveValue("");
  await expect(list).toHaveCount(0);

  await panel.keyboard.type("/what");
  await expect(list).toBeVisible();
  await panel.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();

  await panel.keyboard.type("Price / seat is 45");
  await expect(list).toHaveCount(0);
  await panel.keyboard.press("Enter");
  await expect
    .poll(async () => (await noteLines(window)).map(([text]) => text))
    .toContain("Price / seat is 45");
  await app.close();
});

test("quick note: while the meeting is paused, the line goes in with no time and the field says only that it went in", async () => {
  test.setTimeout(90_000);
  const { app, window, bar, panel } = await recording();
  await pointAndClick(window, bar.getByTestId("meeting-pause"));
  await expect(bar).toHaveAttribute("data-status", "paused");
  const field = fieldOf(panel);
  await pointAndClick(panel, field);
  await panel.keyboard.type("Side chat about the venue");
  await panel.keyboard.press("Enter");
  await expect(field).toHaveAttribute("placeholder", "Added to notes");
  await expect.poll(() => noteLines(window)).toContainEqual(["Side chat about the venue", ""]);
  await app.close();
});

test("quick note: with the Note open and typed in, a quick note lands at the end, neither is lost, ⌘Z in the Note takes back only what was typed there, and after Stop My notes lists the quick note", async () => {
  test.setTimeout(120_000);
  const { app, window, bar, panel } = await recording();
  const editor = window.getByTestId("mind-editor");
  await window.bringToFront();
  await pointAndClick(window, editor);
  await focusSettled(window, editor);
  await window.keyboard.type("Budget is");

  const field = fieldOf(panel);
  await field.fill("Quick from the panel");
  await field.press("Enter");
  await expect
    .poll(async () => (await noteLines(window)).map(([text]) => text))
    .toEqual(["Budget is", "Quick from the panel"]);

  // The User goes on typing where they were.
  await window.keyboard.type(" set");
  await expect
    .poll(async () => (await noteLines(window)).map(([text]) => text))
    .toEqual(["Budget is set", "Quick from the panel"]);

  for (let step = 0; step < 3; step++) {
    if (!(await noteLines(window)).some(([text]) => text?.startsWith("Budget"))) break;
    await window.keyboard.press("ControlOrMeta+KeyZ");
  }
  await expect
    .poll(async () => (await noteLines(window)).map(([text]) => text))
    .toEqual(["Quick from the panel"]);

  await pointAndClick(window, bar.getByTestId("meeting-stop"));
  await expect(window.getByTestId("meeting-fill-line")).toBeVisible({ timeout: 30_000 });
  await closeFirstFillPopover(window);
  const chip = window.getByTestId("meeting-view-chip");
  await pointAndClick(window, chip);
  await pointAndClick(window, window.getByTestId("meeting-view-mine"));
  await expect(editor.locator(":is(p, h1, h2, h3):visible")).toHaveText(["Quick from the panel"]);
  await app.close();
});
