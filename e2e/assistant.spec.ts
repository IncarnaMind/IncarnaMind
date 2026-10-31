import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { withoutTrailingMarks } from "../src/shared/naming";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  dragBy,
  launchApp,
  moveAssistant,
  nameMind,
  newMind,
  openMoveAssistant,
  pointAndClick,
  removeDataFolder,
  setGroupBeside,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  widthOf,
} from "./app";

/*
 * The window's one assistant (#253): docked on the right by default, outside
 * the tab groups; moved by dragging its header to an edge or anywhere to
 * float, or from its ⋯ menu and the keyboard; resized by mouse and keys;
 * folded to a rail or its header; at the bottom in a narrow window; and kept
 * with the window's layout. Driven with a sliding mouse and the keyboard, as
 * a person does. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

const assistantOf = (window: Page) => window.getByTestId("assistant");
const cardOf = (window: Page) => window.getByTestId("card");

/** Within a pixel: what the layout puts side by side meets there. */
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected), `${actual} is near ${expected}`).toBeLessThanOrEqual(1);

/** Opens a new Mind in the focused group, with a line in it. */
async function mindWithText(window: Page, title: string) {
  await newMind(window);
  // The new Mind's text has the focus, whatever other groups show.
  await expect(window.locator('[data-testid="mind-editor"]:focus')).toHaveCount(1);
  await nameMind(window, title);
  await window.keyboard.type(`Notes on ${title}.`);
}

/** Starts the app in a window of this size, with a Mind open. */
async function start(width = 1600, options: { fakeChat?: boolean } = {}) {
  const session = await launchApp(dataDir, options);
  await dismissChatSetup(session.window);
  await setWindowSize(session.app, session.window, width, 660);
  await mindWithText(session.window, "Tides");
  return session;
}

/** Where a press on the header moves it: the empty part between its title and its buttons. */
async function headerGrip(window: Page): Promise<{ x: number; y: number }> {
  const title = await boxOf(window.getByTestId("assistant-title"));
  return { x: title.x + title.width + 12, y: title.y + title.height / 2 };
}

/**
 * Drags the assistant's header as a person does: slides onto it, presses,
 * slides to (x, y) in small steps, then, once `whileHeld` has looked at what
 * the drag shows, lets go.
 */
async function dragHeaderTo(
  window: Page,
  to: { x: number; y: number },
  whileHeld?: () => Promise<void>,
): Promise<void> {
  const from = await headerGrip(window);
  await window.mouse.move(from.x - 20, from.y + 30);
  await window.mouse.move(from.x, from.y, { steps: 5 });
  await window.mouse.down();
  try {
    await window.mouse.move(to.x, to.y, { steps: 18 });
    await whileHeld?.();
  } finally {
    await window.mouse.up();
  }
}

/** Drags an element by (dx, dy), as a person grabs it: slides onto it first. */
async function dragByXY(window: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const box = await boxOf(handle);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x - 20, y - 20);
  await window.mouse.move(x, y, { steps: 6 });
  await window.mouse.down();
  await window.mouse.move(x + dx, y + dy, { steps: 8 });
  await window.mouse.up();
}

/** Opens the assistant's ⋯ › Move assistant and chooses a place. */
async function fromMenu(window: Page, item: "right" | "left" | "bottom" | "float") {
  await moveAssistant(window, item);
  await expect(assistantOf(window)).toHaveAttribute("data-chosen-dock", item);
}

const workbenchBox = (window: Page) => boxOf(window.getByTestId("workbench"));

test("a new window's assistant is docked on the right, outside the groups, the card beside it; it is one with one, two or three groups", async () => {
  const { window } = await start();
  const assistant = assistantOf(window);
  await expect(assistant).toHaveCount(1);
  await expect(assistant).toHaveAttribute("data-dock", "right");
  await expect(window.getByTestId("tab-groups").getByTestId("assistant")).toHaveCount(0);

  // Beside the card, as tall, at its default width.
  const card = await boxOf(cardOf(window));
  let box = await boxOf(assistant);
  expect(box.x).toBeGreaterThan(card.x + card.width);
  near(box.y, card.y);
  near(box.y + box.height, card.y + card.height);
  near(box.width, 320);
  // Its header ends level with the card's tab strip.
  const header = await boxOf(window.getByTestId("assistant-header"));
  const strip = await boxOf(window.getByTestId("tab-strip").first());
  near(header.y + header.height, strip.y + strip.height);

  // The header: the conversation's title with ▾ (History), New chat, ⋯ and fold; no clock.
  await expect(window.getByTestId("assistant-title")).toHaveText("New chat");
  await expect(window.getByTestId("assistant-header").getByRole("button")).toHaveCount(4);
  await expect(window.getByTestId("assistant-header").getByTestId("assistant-history")).toHaveCount(
    0,
  );
  await expect(window.getByTestId("assistant-new-chat")).toHaveAccessibleName(
    /^New chat \((⇧⌘O|Ctrl\+Shift\+O)\)$/,
  );
  await expect(window.getByTestId("assistant-more")).toHaveAccessibleName("More for the assistant");
  await expect(window.getByTestId("assistant-fold")).toHaveAccessibleName("Fold the assistant");
  await expect(window.getByTestId("assistant-reads")).toHaveText(
    "Reads “Tides” · searches All Documents",
  );
  // An empty panel is that one line; the composer's placeholder says the rest.
  await expect(window.getByTestId("assistant-empty").locator("p")).toHaveCount(1);
  await expect(assistant.getByText("Ask about this note")).toHaveCount(0);
  // The composer is the assistant's, the one in the window.
  await expect(window.getByTestId("composer")).toHaveCount(1);
  await expect(assistant.getByTestId("composer-input")).toBeVisible();
  await screenshot(window, "assistant-right");

  // A second and a third group: still one assistant, and it reads the Mind the User is in.
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await mindWithText(window, "Moon");
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(window.getByTestId("tab-group")).toHaveCount(3);
  await expect(assistant).toHaveCount(1);
  await expect(window.getByTestId("composer")).toHaveCount(1);
  await window.getByTestId("tab-group").nth(0).getByTestId("mind-editor").click();
  await expect(window.getByTestId("assistant-reads")).toHaveText(
    "Reads “Tides” · searches All Documents",
  );
  await window.getByTestId("tab-group").nth(1).getByTestId("mind-editor").click();
  await expect(window.getByTestId("assistant-reads")).toHaveText(
    "Reads “Moon” · searches All Documents",
  );
  box = await boxOf(assistant);
  const groups = await boxOf(window.getByTestId("tab-groups"));
  expect(box.x).toBeGreaterThan(groups.x + groups.width);
  await screenshot(window, "assistant-three-groups");
});

test("dragging the header shows the edges' zones; dropped on one it docks there, dropped elsewhere it floats inside the window, and Esc puts it back", async () => {
  const { window } = await start();
  const assistant = assistantOf(window);
  const zones = window.getByTestId("assistant-snap-zone");
  let area = await workbenchBox(window);

  // To the left edge: the zones show while it is held, the left one lit and named.
  await dragHeaderTo(window, { x: area.x + 40, y: area.y + area.height / 2 }, async () => {
    await expect(zones).toHaveCount(3);
    await expect(zones.and(window.locator('[data-zone="left"]'))).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(window.locator('[data-zone="left"][data-active]')).toHaveText("Dock on the left");
    await expect(window.locator("[data-zone][data-active]")).toHaveCount(1);
    await expect(window.getByTestId("assistant-stand-in")).toBeVisible();
    await screenshot(window, "assistant-dragging-left");
  });
  await expect(zones).toHaveCount(0);
  await expect(assistant).toHaveAttribute("data-dock", "left");
  let box = await boxOf(assistant);
  expect(box.x + box.width).toBeLessThan((await boxOf(cardOf(window))).x);

  // To the bottom edge.
  area = await workbenchBox(window);
  await dragHeaderTo(
    window,
    { x: area.x + area.width / 2, y: area.y + area.height - 30 },
    async () => {
      await expect(window.locator('[data-zone="bottom"]')).toHaveAttribute("data-active", "true");
    },
  );
  await expect(assistant).toHaveAttribute("data-dock", "bottom");
  box = await boxOf(assistant);
  const card = await boxOf(cardOf(window));
  expect(box.y).toBeGreaterThan(card.y + card.height);
  near(box.width, card.width);

  // Back to the right edge.
  area = await workbenchBox(window);
  await dragHeaderTo(window, { x: area.x + area.width - 30, y: area.y + 200 });
  await expect(assistant).toHaveAttribute("data-dock", "right");

  // Into the middle: it floats there, over the card, inside the window.
  area = await workbenchBox(window);
  const middle = { x: area.x + area.width / 2, y: area.y + 120 };
  await dragHeaderTo(window, middle, async () => {
    await expect(window.locator("[data-zone][data-active]")).toHaveCount(0);
    await expect(window.getByTestId("assistant-stand-in")).toContainText("Float here");
  });
  await expect(assistant).toHaveAttribute("data-dock", "float");
  box = await boxOf(assistant);
  // Where it was let go: the header under the pointer.
  const header = await boxOf(window.getByTestId("assistant-header"));
  expect(middle.x).toBeGreaterThan(header.x);
  expect(middle.x).toBeLessThan(header.x + header.width);
  expect(middle.y).toBeGreaterThanOrEqual(header.y - 1);
  expect(middle.y).toBeLessThanOrEqual(header.y + header.height + 1);
  const size = await window.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size[0] ?? 0);
  expect(box.y + box.height).toBeLessThanOrEqual(size[1] ?? 0);
  // The card has the window's width back: the assistant is over it.
  expect((await boxOf(cardOf(window))).x + (await boxOf(cardOf(window))).width).toBeGreaterThan(
    box.x + box.width,
  );
  await screenshot(window, "assistant-floating");

  // Dropped near the window's right edge it docks again, from floating.
  area = await workbenchBox(window);
  await dragHeaderTo(window, { x: area.x + area.width - 20, y: area.y + 300 });
  await expect(assistant).toHaveAttribute("data-dock", "right");

  // Esc while dragging: nothing moves.
  const grip = await headerGrip(window);
  await window.mouse.move(grip.x, grip.y, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(area.x + 40, area.y + 300, { steps: 12 });
  await expect(zones).toHaveCount(3);
  await window.keyboard.press("Escape");
  await expect(zones).toHaveCount(0);
  await window.mouse.up();
  await expect(assistant).toHaveAttribute("data-dock", "right");
});

test("it resizes by mouse and by keys docked on each side, at the bottom and floating, between its minimum and what leaves the card its room; a double-click restores it", async () => {
  const { window } = await start();
  const assistant = assistantOf(window);
  const rod = window.getByTestId("assistant-resize");
  await expect(rod).toHaveAccessibleName(/Resize the assistant/);

  // On the right: the line left of it.
  await dragBy(window, rod, -80);
  await expect.poll(() => widthOf(assistant)).toBeGreaterThan(390);
  const dragged = await widthOf(assistant);
  await rod.focus();
  await window.keyboard.press("ArrowLeft");
  await expect.poll(() => widthOf(assistant)).toBe(dragged + 10);
  await window.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => widthOf(assistant)).toBe(dragged + 60);
  // Never narrower than 280px, never so wide that the card has under 360px.
  await dragBy(window, rod, 1200);
  await expect.poll(() => widthOf(assistant)).toBe(280);
  await dragBy(window, rod, -2000);
  await expect.poll(async () => Math.round(await widthOf(cardOf(window)))).toBe(360);
  await rod.dblclick();
  await expect.poll(() => widthOf(assistant)).toBe(320);

  // On the left: the line right of it.
  await fromMenu(window, "left");
  await dragBy(window, rod, 60);
  await expect.poll(() => widthOf(assistant)).toBeGreaterThan(370);
  const left = await widthOf(assistant);
  await rod.focus();
  await window.keyboard.press("ArrowRight");
  await expect.poll(() => widthOf(assistant)).toBe(left + 10);
  await rod.dblclick();
  await expect.poll(() => widthOf(assistant)).toBe(320);

  // At the bottom: the line above it, with ↑ and ↓.
  await fromMenu(window, "bottom");
  const height = async () => (await boxOf(assistant)).height;
  await expect.poll(height).toBe(300);
  await dragByXY(window, rod, 0, -60);
  await expect.poll(height).toBeGreaterThan(350);
  const bottom = await height();
  await rod.focus();
  await window.keyboard.press("ArrowUp");
  await expect.poll(height).toBe(bottom + 10);
  await window.keyboard.press("ArrowDown");
  await expect.poll(height).toBe(bottom);
  await rod.dblclick();
  await expect.poll(height).toBe(300);
  await screenshot(window, "assistant-bottom");

  // Floating: from any edge or corner; its bottom-right corner takes the keys.
  await fromMenu(window, "float");
  await expect(rod).toHaveCount(0);
  const corner = window.getByTestId("assistant-resize-se");
  const before = await boxOf(assistant);
  await dragByXY(window, corner, -60, -40);
  await expect.poll(async () => (await boxOf(assistant)).width).toBe(before.width - 60);
  await expect.poll(async () => (await boxOf(assistant)).height).toBe(before.height - 40);
  await corner.focus();
  await window.keyboard.press("ArrowRight");
  await window.keyboard.press("ArrowDown");
  await expect.poll(async () => (await boxOf(assistant)).width).toBe(before.width - 50);
  await expect.poll(async () => (await boxOf(assistant)).height).toBe(before.height - 30);
  // From its left edge, as far as it goes: its minimum, 300 × 220.
  await dragByXY(window, window.getByTestId("assistant-resize-w"), 600, 0);
  await expect.poll(async () => (await boxOf(assistant)).width).toBe(300);
  await dragByXY(window, window.getByTestId("assistant-resize-n"), 0, 600);
  await expect.poll(async () => (await boxOf(assistant)).height).toBe(220);
  await corner.dblclick();
  await expect.poll(async () => (await boxOf(assistant)).width).toBe(380);
  await expect.poll(async () => (await boxOf(assistant)).height).toBe(520);
});

test("its ⋯ menu and the keyboard dock, float and fold it; ⌘J unfolds it into its composer; New chat and History", async () => {
  const { window } = await start();
  const assistant = assistantOf(window);

  // The ⋯ menu by keyboard: Move assistant first, and in it, the place it is in is checked.
  await window.getByTestId("assistant-more").focus();
  await window.keyboard.press("Enter");
  const menu = window.getByTestId("assistant-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  await expect(menu.getByTestId("assistant-menu-move")).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Clear this conversation" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await screenshot(window, "assistant-menu");
  await window.keyboard.press("ArrowRight");
  const docks = window.getByTestId("assistant-menu-docks");
  await expect(docks.getByRole("menuitemradio", { name: "Dock on the right" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(docks.getByRole("menuitemradio", { name: "Dock on the right" })).toBeFocused();
  await screenshot(window, "assistant-menu-move");
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("Enter");
  await expect(assistant).toHaveAttribute("data-dock", "left");
  await fromMenu(window, "bottom");
  await expect(assistant).toHaveAttribute("data-dock", "bottom");
  await fromMenu(window, "float");
  await expect(assistant).toHaveAttribute("data-dock", "float");
  await fromMenu(window, "right");
  await expect(assistant).toHaveAttribute("data-dock", "right");

  // Folded on a side: a 44px rail with show, New chat and History; the card takes the room.
  const cardWidth = await widthOf(cardOf(window));
  await window.getByTestId("assistant-fold").click();
  await expect(assistant).toHaveAttribute("data-folded", "true");
  await expect(window.getByTestId("assistant-rail")).toBeVisible();
  await expect.poll(() => widthOf(assistant)).toBe(44);
  expect(await widthOf(cardOf(window))).toBeGreaterThan(cardWidth + 260);
  const rail = window.getByTestId("assistant-rail");
  await expect(rail.getByRole("button")).toHaveCount(3);
  await expect(rail.getByTestId("assistant-fold")).toHaveAccessibleName(
    /^Show the assistant \((⌘J|Ctrl\+J)\)$/,
  );
  await expect(window.getByTestId("composer-input")).toBeHidden();
  await screenshot(window, "assistant-folded-rail");
  // The rail has no title, so History is its own button; Esc puts the focus back on it.
  await rail.getByTestId("assistant-history").click();
  await expect(window.getByTestId("assistant-history-popover")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("assistant-history-popover")).toBeHidden();
  await expect(rail.getByTestId("assistant-history")).toBeFocused();
  // ⌘J unfolds it, the cursor in its composer.
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(assistant).not.toHaveAttribute("data-folded");
  await expect(window.getByTestId("composer-input")).toBeFocused();

  // At the bottom and floating it folds to its header.
  for (const place of ["bottom", "float"] as const) {
    await fromMenu(window, place);
    await window.getByTestId("assistant-fold").click();
    await expect(assistant).toHaveAttribute("data-folded", "true");
    await expect(window.getByTestId("assistant-header")).toBeVisible();
    await expect(window.getByTestId("assistant-reads")).toBeHidden();
    expect((await boxOf(assistant)).height).toBeLessThan(40);
    await screenshot(window, `assistant-folded-${place}`);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await expect(assistant).not.toHaveAttribute("data-folded");
  }

  // New chat (⇧⌘O) unfolds it too, ready to ask.
  await fromMenu(window, "right");
  await window.getByTestId("assistant-fold").click();
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+Shift+O");
  await expect(window.getByTestId("composer-input")).toBeFocused();

  // History from the title's ▾: none kept yet. Esc closes it, and the focus is back on the title.
  const title = window.getByTestId("assistant-title");
  await title.click();
  const history = window.getByTestId("assistant-history-popover");
  await expect(history).toBeVisible();
  await expect(history.getByTestId("assistant-history-empty")).toHaveText(
    "No conversations yet. Ask a Question to start one.",
  );
  await setLanguage(window, "zh-CN");
  await expect(history.getByTestId("assistant-history-empty")).toHaveText(
    "还没有对话。提一个问题即可开始。",
  );
  await setLanguage(window, "en");
  await window.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(title).toBeFocused();
  // ⌘K reaches it too, and Esc there puts the focus back on the title as well.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Conversation history");
  await window.keyboard.press("Enter");
  await expect(history).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(title).toBeFocused();
});

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1100, 1440]) {
    test(`History opens at the title's left edge, inside the assistant, docked on the right (${language}, ${width}px)`, async () => {
      const { app, window } = await start(width);
      await setLanguage(window, language);
      const title = window.getByTestId("assistant-title");
      await title.click();
      const history = window.getByTestId("assistant-history-popover");
      await expect(history).toBeVisible();
      await expect(history.getByTestId("assistant-history-empty")).toBeVisible();
      const [anchor, panel, popover] = await Promise.all([
        boxOf(title),
        boxOf(assistantOf(window)),
        boxOf(history),
      ]);
      // Not hung from the title's right edge over the page: it starts in the assistant, at or before the title's left.
      expect(popover.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(popover.x).toBeLessThanOrEqual(anchor.x + 1);
      // Only as far left as the window's edge needs: the title sits a few px inside the panel.
      expect(anchor.x - popover.x).toBeLessThanOrEqual(12);
      expect(popover.x + popover.width).toBeLessThanOrEqual(width);
      await app.close();
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a chat in History is named by its first Question and opens by click or Enter after a relaunch (${language}) (#2310)`, async () => {
    const questions =
      language === "en"
        ? ["When do spring tides happen?", "Why are neap tides weaker?"]
        : ["大潮什么时候出现？", "小潮为什么更弱？"];
    // A name taken from a Question ends on its words, without its mark.
    const names = questions.map((question) => withoutTrailingMarks(question));
    let session = await start(1600, { fakeChat: true });
    let { window } = session;
    const rowsNow = () => window.getByTestId("assistant-history-row");
    const history = () => window.getByTestId("assistant-history-popover");
    await setLanguage(window, language);
    await useLocalChatModel(window);

    // With no conversation yet, History says so, and has no row to open.
    await pointAndClick(window, window.getByTestId("assistant-title"));
    await expect(history()).toBeVisible();
    await expect(history().getByTestId("assistant-history-empty")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(history()).toBeHidden();

    await window.evaluate(
      async (asked) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        for (const text of asked) await bridge.askInConversation({ text });
      },
      questions as [string, string],
    );
    await pointAndClick(window, window.getByTestId("assistant-title"));
    await expect(rowsNow()).toHaveCount(2);
    // Each row is named by its first Question, newest first.
    await expect(rowsNow().first()).toContainText(names[1] as string);
    await expect(rowsNow().last()).toContainText(names[0] as string);
    await window.keyboard.press("Escape");
    await session.app.close();

    // After a relaunch, a click on a row opens that conversation and closes History.
    session = await launchApp(dataDir, { fakeChat: true });
    ({ window } = session);
    await setWindowSize(session.app, window, 1600, 660);
    await pointAndClick(window, window.getByTestId("assistant-title"));
    await expect(rowsNow()).toHaveCount(2);
    await pointAndClick(window, rowsNow().filter({ hasText: names[0] as string }));
    await expect(history()).toBeHidden();
    await expect(
      window.getByTestId("assistant-question").filter({ hasText: questions[0] as string }),
    ).toHaveCount(1);
    await expect(
      window.getByTestId("assistant-question").filter({ hasText: questions[1] as string }),
    ).toHaveCount(0);

    // Enter on a focused row opens the newer conversation, and the composer takes the cursor.
    await pointAndClick(window, window.getByTestId("assistant-title"));
    await expect(
      history().getByRole("button", { name: translate(language, "assistant.history.close") }),
    ).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(rowsNow().first()).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(history()).toBeHidden();
    await expect(
      window.getByTestId("assistant-question").filter({ hasText: questions[1] as string }),
    ).toHaveCount(1);
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await session.app.close();
  });
}

test("under 1,000px a side dock sits at the bottom and goes back when wider; groups merge beside it and come back as it folds; its place, sizes and fold survive a closed tab and a restart", async () => {
  let session = await start();
  let { app, window } = session;
  let assistant = assistantOf(window);
  await fromMenu(window, "left");
  const rod = window.getByTestId("assistant-resize");
  await rod.focus();
  await window.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => widthOf(assistant)).toBe(370);

  // Narrow: at the bottom, the choice kept.
  await setWindowSize(app, window, 960, 660);
  await expect(assistant).toHaveAttribute("data-dock", "bottom");
  await expect(assistant).toHaveAttribute("data-chosen-dock", "left");
  await openMoveAssistant(window);
  await expect(window.getByTestId("assistant-menu-left")).toHaveAttribute("aria-checked", "true");
  // Choosing a side here says why it stays at the bottom.
  await window.getByTestId("assistant-menu-right").click();
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Narrow window: the assistant moved to the bottom.",
  );
  await expect(assistant).toHaveAttribute("data-dock", "bottom");
  await screenshot(window, "assistant-narrow-960");
  await setWindowSize(app, window, 1600, 660);
  await expect(assistant).toHaveAttribute("data-dock", "right");
  await expect.poll(() => widthOf(assistant)).toBe(370);

  // With a Document beside the Mind: at 1,280px the card beside the assistant is too narrow
  // for two groups, which share one strip; folding it, or the bottom, gives the room back.
  await setGroupBeside(window, true);
  await setWindowSize(app, window, 1280, 660);
  await expect(window.getByTestId("tab-group")).toHaveCount(1);
  await window.getByTestId("assistant-fold").click();
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await window.getByTestId("assistant-fold").click();
  await expect(window.getByTestId("tab-group")).toHaveCount(1);
  await fromMenu(window, "bottom");
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await fromMenu(window, "right");
  await setWindowSize(app, window, 1600, 660);
  await expect(window.getByTestId("tab-group")).toHaveCount(2);

  // Folded, then a tab closed: still folded on the right.
  await window.getByTestId("assistant-fold").click();
  await window.getByTestId("tab-group").nth(1).getByRole("tab").click();
  await window.keyboard.press("ControlOrMeta+w");
  await expect(window.getByTestId("tab-group")).toHaveCount(1);
  await expect(assistant).toHaveAttribute("data-folded", "true");
  await expect(assistant).toHaveAttribute("data-dock", "right");
  await app.close();

  // After a restart: where it was, as it was.
  session = await launchApp(dataDir);
  ({ app, window } = session);
  await setWindowSize(app, window, 1600, 660);
  assistant = assistantOf(window);
  await expect(assistant).toHaveAttribute("data-dock", "right");
  await expect(assistant).toHaveAttribute("data-folded", "true");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(assistant).not.toHaveAttribute("data-folded");
  await expect.poll(() => widthOf(assistant)).toBe(370);
  // Floating, it keeps its distance to its corner after a restart too.
  await fromMenu(window, "float");
  const floating = await boxOf(assistant);
  await app.close();
  session = await launchApp(dataDir);
  ({ app, window } = session);
  await setWindowSize(app, window, 1600, 660);
  await expect(assistantOf(window)).toHaveAttribute("data-dock", "float");
  const again = await boxOf(assistantOf(window));
  near(again.x, floating.x);
  near(again.y, floating.y);
  near(again.width, floating.width);
  await app.close();
});

test("moving, resizing and folding it keep the composer's draft, the Mind's scroll and an Answer that is streaming", async () => {
  const { app, window } = await start(1600, { fakeChat: true });
  await useLocalChatModel(window);
  const editor = window.getByTestId("mind-editor");
  // A Mind long enough to scroll.
  await editor.evaluate((dom) => {
    const { commands } = (dom as unknown as { editor: Editor }).editor;
    commands.insertContent(
      Array.from({ length: 60 }, (_, index) => `<p>Line ${index + 1} of the tide notes.</p>`).join(
        "",
      ),
    );
  });

  // Asked: the Answer streams into the assistant while it moves, resizes and folds.
  const input = window.getByTestId("composer-input");
  await input.click();
  await window.keyboard.type("When do spring tides happen?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window);
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await fromMenu(window, "left");
  await dragBy(window, window.getByTestId("assistant-resize"), 40);
  await window.getByTestId("assistant-fold").click();
  await window.getByTestId("assistant-fold").click();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer).toContainText("That is all.");
  await expect(answer).toHaveCount(1);
  await expect(editor.getByTestId("answer")).toHaveCount(0);

  // A draft stays as it was typed, wherever the assistant goes.
  await input.click();
  await window.keyboard.type("A draft not asked yet");
  for (const place of ["bottom", "float", "right"] as const) {
    await fromMenu(window, place);
    await expect(window.getByTestId("composer-input")).toHaveValue("A draft not asked yet");
  }
  await window.getByTestId("assistant-fold").click();
  await window.getByTestId("assistant-fold").click();
  await expect(window.getByTestId("composer-input")).toHaveValue("A draft not asked yet");

  // The Mind keeps its place as the assistant moves between the sides.
  const scroller = window.locator(".mind-scroller");
  await scroller.evaluate((element) => {
    element.scrollTop = 400;
  });
  const scrolled = await scroller.evaluate((element) => element.scrollTop);
  await fromMenu(window, "left");
  await fromMenu(window, "right");
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrolled);

  // History lists the assistant's conversations (#300), newest first: the one asked here, and
  // one asked through the core since.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.askInConversation({ text: "When do neap tides come?" });
  });
  await window.getByTestId("assistant-title").click();
  const rows = window.getByTestId("assistant-history-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("When do neap tides come");
  await expect(rows.last()).toContainText("When do spring tides happen");
  // Asked today, each shows its time alone, in the one date style.
  await expect(rows.locator("time")).toHaveText([
    /^\d{1,2}:\d{2}( [ap]m)?$/,
    /^\d{1,2}:\d{2}( [ap]m)?$/,
  ]);
  await window.keyboard.press("Escape");
  await app.close();
});

test("in Chinese: the header, the line, the menu and the zones", async () => {
  const { window } = await start();
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await expect(window.getByTestId("assistant-title")).toHaveText("新对话");
  await expect(assistantOf(window)).toHaveAccessibleName("助手");
  await expect(window.getByTestId("assistant-fold")).toHaveAccessibleName("收起助手");
  await expect(window.getByTestId("assistant-reads")).toHaveText("正在读“Tides” · 搜索全部文档");
  await openMoveAssistant(window);
  await expect(window.getByTestId("assistant-menu-docks").getByRole("menuitemradio")).toHaveText([
    "停靠在右侧",
    "停靠在左侧",
    "停靠在底部",
    "浮动",
  ]);
  await screenshot(window, "assistant-menu-zh");
  await window.keyboard.press("Escape");
  const area = await workbenchBox(window);
  await dragHeaderTo(window, { x: area.x + 40, y: area.y + 300 }, async () => {
    await expect(window.locator('[data-zone="left"][data-active]')).toHaveText("停靠在左侧");
    await screenshot(window, "assistant-dragging-zh");
  });
  await expect(assistantOf(window)).toHaveAttribute("data-dock", "left");
});
