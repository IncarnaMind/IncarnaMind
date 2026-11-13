import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  panelOf,
  pointAndClick,
  pressHeldKeys as pressKeys,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
} from "./app";

/**
 * The floating panel's ask bar: three prompts and More…, which lists the rest over the answers.
 * The bar never moves, the list pushes nothing, and a click is all it takes: the panel never takes
 * the keyboard from the meeting app.
 */
const LINUX = process.platform === "linux";
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

async function openPanel() {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: BUYER },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await connectLocalChatModel(window);
  await startRecording(window, await recordMeeting(window), { notice: true });
  await firstTranscriptLine(window);
  return { app, window, panel: await panelOf(app) };
}

/** Where a thing is below the top of the panel, which is what "does not move" means for a panel that grows. */
async function below(panel: Page, target: Locator): Promise<number> {
  const [box, frame] = await Promise.all([
    target.boundingBox(),
    panel.getByTestId("meeting-panel").boundingBox(),
  ]);
  if (!box || !frame) throw new Error("The panel isn't drawn.");
  return box.y - frame.y;
}

const sameAs = (found: number, expected: number) =>
  expect(Math.abs(found - expected)).toBeLessThan(1);

async function pressPrompt(panel: Page, name: string): Promise<void> {
  await pointAndClick(
    panel,
    panel.getByTestId("ask-bar").getByTestId("help-prompt").filter({ hasText: name }),
  );
}

const windowHeight = (panel: Page) => panel.evaluate(() => window.innerHeight);

test("ask bar: from the first frame to a panel holding three answers the prompts, More… and the field keep their place, and the list lies over the answers without pushing them", async () => {
  test.setTimeout(90_000);
  const { app, panel } = await openPanel();
  const bar = panel.getByTestId("ask-bar");
  const firstPrompt = bar.getByTestId("help-prompt").first();
  const more = panel.getByTestId("help-more");
  // On Linux the panel has no field (#2925).
  const kept = [firstPrompt, more, ...(LINUX ? [] : [panel.getByTestId("quick-note-field")])];
  const tops = await Promise.all(kept.map((each) => below(panel, each)));
  const startHeight = await windowHeight(panel);
  const stays = async () => {
    for (const [index, each] of kept.entries()) sameAs(await below(panel, each), tops[index] ?? 0);
  };

  for (const [name, pins] of [
    ["What should I say?", true],
    ["Answer their question", true],
    ["What do they want?", false],
  ] as const) {
    await pressPrompt(panel, name);
    await expect(panel.getByTestId("help-outline").first()).toBeVisible();
    await stays();
    const suggestion = panel.getByTestId("help-suggestion").last();
    await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await stays();
    if (pins) await pointAndClick(panel, panel.getByTestId("help-pin").last());
  }
  const suggestions = panel.getByTestId("help-suggestion");
  await expect(suggestions).toHaveCount(3);
  await stays();
  await expect.poll(() => windowHeight(panel)).toBeGreaterThan(startHeight);

  // The list lies over the answers: nothing under the bar moves, and it is drawn over the first one.
  const answerTop = await below(panel, suggestions.first());
  await pointAndClick(panel, more);
  const list = panel.getByTestId("help-more-list");
  await expect(list).toBeVisible();
  await stays();
  sameAs(await below(panel, suggestions.first()), answerTop);
  const [listBox, answerBox] = await Promise.all([
    list.boundingBox(),
    suggestions.first().boundingBox(),
  ]);
  if (!listBox || !answerBox) throw new Error("The list or the answer isn't drawn.");
  expect(listBox.y + listBox.height).toBeGreaterThan(answerBox.y + 1);
  expect(
    await panel.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[role=menu]")),
      { x: listBox.x + listBox.width / 2, y: listBox.y + listBox.height / 2 },
    ),
  ).toBe(true);
  await app.close();
});

test("ask bar: with no answer yet, the window grows downward for the list and shrinks back, and a click on a prompt, More… or a row never takes the focus", async () => {
  test.setTimeout(60_000);
  const { app, panel } = await openPanel();
  const panelWindow = await app.browserWindow(panel);
  const focused = () => panelWindow.evaluate((win) => win.isFocused());
  const firstPrompt = panel.getByTestId("ask-bar").getByTestId("help-prompt").first();
  const more = panel.getByTestId("help-more");
  const firstTop = await below(panel, firstPrompt);
  const moreTop = await below(panel, more);
  const startHeight = await windowHeight(panel);

  await pointAndClick(panel, more);
  const list = panel.getByTestId("help-more-list");
  await expect(list).toBeVisible();
  // The whole list is in the window, which grew for it.
  await expect
    .poll(async () => {
      const box = await list.boundingBox();
      return box !== null && box.y + box.height <= (await windowHeight(panel));
    })
    .toBe(true);
  expect(await windowHeight(panel)).toBeGreaterThan(startHeight);
  sameAs(await below(panel, firstPrompt), firstTop);
  sameAs(await below(panel, more), moreTop);
  expect(await focused()).toBe(false);

  await pointAndClick(panel, more);
  await expect(list).toHaveCount(0);
  await expect.poll(() => windowHeight(panel)).toBe(startHeight);

  // A click outside the bar closes it too, and asks nothing.
  await pointAndClick(panel, more);
  await expect(list).toBeVisible();
  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await expect(list).toHaveCount(0);
  await expect(panel.getByTestId("help-outline")).toHaveCount(0);
  await pointAndClick(panel, panel.getByTestId("panel-template"));

  // A row asks its prompt below the bar and closes the list.
  await pointAndClick(panel, more);
  await pointAndClick(
    panel,
    list.getByTestId("help-prompt").filter({ hasText: "What to ask next" }),
  );
  await expect(list).toHaveCount(0);
  const suggestion = panel.getByTestId("help-suggestion");
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(suggestion.getByTestId("help-heading")).toContainText("What to ask next");
  expect(await below(panel, suggestion)).toBeGreaterThan(await below(panel, more));
  expect(await focused()).toBe(false);

  // Collapsed and expanded again with the list open, the bar comes back closed.
  await pointAndClick(panel, more);
  await expect(list).toBeVisible();
  await pointAndClick(panel, panel.getByTestId("panel-collapse"));
  await expect(panel.getByTestId("panel-pill")).toBeVisible();
  await pointAndClick(panel, panel.getByTestId("panel-expand"));
  await expect(panel.getByTestId("ask-bar")).toBeVisible();
  await expect(list).toHaveCount(0);
  await app.close();
});

test("ask bar: the shortcuts run their prompts while the list is open, and a template's prompts come first under More…, whole at the panel's width in English and Chinese", async () => {
  test.setTimeout(90_000);
  const { app, window, panel } = await openPanel();
  const more = panel.getByTestId("help-more");
  const list = panel.getByTestId("help-more-list");

  await pointAndClick(panel, more);
  await expect(list).toBeVisible();
  await pressKeys(app, "sum");
  const suggestion = panel.getByTestId("help-suggestion");
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(suggestion.getByTestId("help-heading")).toContainText("Sum up so far");
  await expect(list).toHaveCount(0);

  await pointAndClick(panel, panel.getByTestId("panel-template"));
  await pointAndClick(
    panel,
    panel.locator('[data-testid="panel-template-option"][data-template="interview"]'),
  );
  const rows = list.getByTestId("help-prompt");
  const fits = () =>
    panel.evaluate(() => {
      const frame = document.querySelector<HTMLElement>("[data-testid=meeting-panel]");
      if (!frame) throw new Error("The panel isn't drawn.");
      return [...document.querySelectorAll<HTMLElement>(".ask-label")].map((label) => ({
        text: label.textContent,
        cut: label.scrollWidth > label.clientWidth,
        outside: label.getBoundingClientRect().right > frame.getBoundingClientRect().right,
      }));
    });
  await pointAndClick(panel, more);
  await expect(rows).toHaveText([
    "A follow-up question",
    "Am I leading them?",
    "Not covered yet",
    /^Sum up so far/,
    /^Say no politely/,
    /^What to ask next/,
    /^Check what was said/,
  ]);
  for (const each of await fits())
    expect(each, each.text ?? "").toMatchObject({ cut: false, outside: false });
  await expect(panel.locator("[data-testid=help-prompt][title]")).toHaveCount(0);

  await setLanguage(window, "zh-CN");
  await expect(more).toHaveText(LINUX ? "更多…" : "更多…/");
  await expect(rows.first()).toHaveText("追问一个问题");
  for (const each of await fits())
    expect(each, each.text ?? "").toMatchObject({ cut: false, outside: false });
  await expect(panel.locator("[data-testid=help-prompt][title]")).toHaveCount(0);
  await app.close();
});

test("ask bar: a row's tooltip is its whole label and key, and shows only while the label is cut short", async () => {
  test.setTimeout(60_000);
  const { app, panel } = await openPanel();
  const first = panel.getByTestId("ask-bar").getByTestId("help-prompt").first();
  await expect(first).toHaveText(/^What should I say\?/);
  await expect(first).not.toHaveAttribute("title");

  const narrow = await panel.addStyleTag({ content: ".ask-label { max-width: 48px; }" });
  await expect(first).toHaveAttribute("title", /^What should I say\? \(.*1\)$/);
  await narrow.evaluate((style) => style.parentNode?.removeChild(style));
  await expect(first).not.toHaveAttribute("title");
  await app.close();
});

test("ask bar: a prompt pressed twice quickly leaves one answer, finished, with no outline left behind", async () => {
  test.setTimeout(60_000);
  const { app, panel } = await openPanel();
  const prompt = panel
    .getByTestId("ask-bar")
    .getByTestId("help-prompt")
    .filter({ hasText: "What should I say?" });
  await pointAndClick(panel, prompt);
  await prompt.click({ clickCount: 2, delay: 40 });
  const suggestion = panel.getByTestId("help-suggestion");
  await expect(suggestion).toHaveCount(1);
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(panel.getByTestId("help-outline")).toHaveCount(0);
  await app.close();
});
