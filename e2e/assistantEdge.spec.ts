import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  moveAssistant,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startScriptedTask,
} from "./app";

/**
 * The assistant's one left edge (#612): its header's first icon, the empty
 * conversation's and an Answer's steps icon, an Answer's first letter, the
 * Task tray and the composer's box start at the same x docked on the right, on
 * the left, at the bottom and floating; the composer's text sits 12px inside
 * its box; a Question's bubble ends where the composer does. The checks are
 * relations; the 16px is what DESIGN.md fixes. Set INCARNAMIND_SCREENSHOTS to
 * a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let folder: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  folder = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(folder);
});

type Dock = "right" | "left" | "bottom" | "float";
const DOCKS: Dock[] = ["right", "left", "bottom", "float"];

async function dockAs(window: Page, dock: Dock) {
  await moveAssistant(window, dock);
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-dock", dock);
}

const leftOf = async (target: Locator) =>
  await target.evaluate((el) => el.getBoundingClientRect().left);

/**
 * The tray's approval buttons are in the card's order, Deny last, every one inside the tray;
 * a narrow tray or a wide system font may wrap them under the text (D304), and the shortcut
 * stays in the main button's name.
 */
async function expectApprovalButtons(window: Page, name: string) {
  const tray = window.getByTestId("task-tray");
  const buttons = tray.locator(".approval-actions button");
  const ids = await buttons.evaluateAll((each) =>
    each.map((button) => button.dataset.testid ?? ""),
  );
  expect(ids.length, `${name}: the approval's buttons`).toBeGreaterThan(1);
  expect(ids.at(-1), `${name}: Deny last`).toBe("approval-deny");
  const boxes = await buttons.evaluateAll((each) =>
    each.map((button) => {
      const { top, left, right, width } = button.getBoundingClientRect();
      return { top: Math.round(top), left, right, width };
    }),
  );
  expect(
    boxes.every((box) => box.width > 0),
    `${name}: every choice shows`,
  ).toBe(true);
  const edge = await tray.evaluate((el) => {
    const { left, right } = el.getBoundingClientRect();
    return { left, right };
  });
  expect((boxes[0]?.left ?? 0) - edge.left, `${name}: room at the left`).toBeGreaterThanOrEqual(16);
  expect((boxes.at(-1)?.right ?? 0) + 16, `${name}: room at the right`).toBeLessThanOrEqual(
    edge.right,
  );
  // The hint is dropped from the label, not from the button's name.
  await expect(tray.locator(".approval-keys").first()).toBeHidden();
  await expect(tray.getByTestId("approval-allow-once")).toHaveAccessibleName(/\(.+\)$/);
}

/** The x of each thing that should sit on the edge, with the panel's own. */
async function edges(window: Page) {
  const assistant = window.getByTestId("assistant");
  const answer = window.getByTestId("assistant-answer").first();
  return {
    panel: await leftOf(assistant),
    // The title's words: the header has no icon before them (#657).
    header: await leftOf(window.getByTestId("assistant-title").locator(".truncate")),
    steps: await leftOf(answer.locator(".answer-steps-icon").first()),
    letter: await answer.getByTestId("assistant-answer-text").evaluate((text) => {
      const first = text.querySelector("p") as HTMLElement;
      const range = document.createRange();
      range.setStart(first.firstChild?.firstChild ?? first, 0);
      range.setEnd(first.firstChild?.firstChild ?? first, 1);
      return range.getBoundingClientRect().left;
    }),
    composer: await leftOf(window.getByTestId("composer")),
    tray: await leftOf(window.getByTestId("task-tray")),
  };
}

test("the header, the thread, the Task tray and the composer share one left edge at every dock; the composer's text is 12px in; Questions end where it does", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    scriptedTasks: true,
    home: folder,
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await newMind(window);
  await nameMind(window, "Credit memo");
  const assistant = window.getByTestId("assistant");

  // The empty conversation's "Reads …" icon, before any Answer.
  await expect(window.getByTestId("assistant-reads")).toBeVisible();
  const reads = await leftOf(window.locator(".assistant-reads-icon"));
  const edge = await leftOf(window.getByTestId("composer"));
  expect(Math.abs(reads - edge)).toBeLessThanOrEqual(1);

  await askInAssistant(window, "Say something plain");
  const mind = await window.evaluate(
    async () =>
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).find(
        (each) => each.title === "Credit memo",
      )?.id ?? "",
  );
  await startScriptedTask(app, mind, { folder, files: ["a.txt"] });
  await expect(window.getByTestId("task-tray")).toBeVisible();

  for (const dock of DOCKS) {
    await dockAs(window, dock);
    // In the 320px assistant, docked on the right, the buttons of the ask don't wrap.
    if (dock === "right") await expectApprovalButtons(window, "English");
    const { panel, ...found } = await edges(window);
    for (const [name, x] of Object.entries(found)) {
      expect(Math.abs(x - found.composer), `${name} at ${dock}`).toBeLessThanOrEqual(1);
    }
    // Docked at a side or floating, it is 16px in from the panel's edge.
    if (dock !== "bottom") expect(Math.round(found.composer - panel)).toBe(16);

    // The text starts 12px inside its box, and a Question's bubble ends where the box does.
    const input = await window
      .getByTestId("composer-input")
      .evaluate((el) => el.getBoundingClientRect().left);
    const box = await window.getByTestId("composer").evaluate((el) => {
      const { left, right } = el.getBoundingClientRect();
      return { left, right };
    });
    expect(Math.round(input - box.left)).toBe(12);
    const bubbleRight = await window
      .locator(".assistant-question-bubble")
      .last()
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(Math.abs(bubbleRight - box.right)).toBeLessThanOrEqual(1);
    if (SCREENSHOTS) await assistant.screenshot({ path: join(SCREENSHOTS, `edge-en-${dock}.png`) });
  }

  // In Chinese the same.
  await dockAs(window, "right");
  await setLanguage(window, "zh-CN");
  await expectApprovalButtons(window, "Chinese");
  const { panel: _panel, ...chinese } = await edges(window);
  for (const [name, x] of Object.entries(chinese)) {
    expect(Math.abs(x - chinese.composer), `${name} in Chinese`).toBeLessThanOrEqual(1);
  }
  if (SCREENSHOTS) await assistant.screenshot({ path: join(SCREENSHOTS, "edge-zh-right.png") });
});
