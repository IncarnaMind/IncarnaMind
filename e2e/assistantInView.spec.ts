import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  moveAssistant,
  nameMind,
  newMind,
  removeDataFolder,
  setWindowSize,
  startScriptedTask,
} from "./app";

/**
 * The latest Answer stays in view in the assistant (#612): a conversation
 * read to its end is still read to its end after the assistant docks at the
 * bottom, floats, folds and unfolds, and after the window narrows to 900px,
 * so the latest Answer's last lines and its Copy · Add to note are never left
 * under the composer; a Task starting, its progress at the thread's end and
 * its ask in the tray shortening the thread (#657), is kept up with too. A
 * conversation
 * scrolled up keeps the turn at its top where it was. The checks are
 * relations to the thread's box. Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots.
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

type Place = "bottom" | "float" | "right";

async function placeAs(window: Page, place: Place) {
  await moveAssistant(window, place);
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-dock", place);
}

/** Whether a box lies inside the thread's own, with a pixel to spare. */
const inThread = (window: Page, target: Locator) =>
  target.evaluate((el, thread) => {
    const box = el.getBoundingClientRect();
    const view = (
      document.querySelector(`[data-testid="${thread}"]`) as HTMLElement
    ).getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  }, "assistant-thread");

/** How far a turn's top is below the thread's top. */
const offsetIn = (target: Locator) =>
  target.evaluate((el) => {
    const thread = document.querySelector('[data-testid="assistant-thread"]') as HTMLElement;
    return el.getBoundingClientRect().top - thread.getBoundingClientRect().top;
  });

async function start({ task }: { task: boolean }) {
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
  for (const question of ["First", "Second", "Third", "Fourth", "Fifth"])
    await askInAssistant(window, question);
  if (task) {
    const mind = await window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).find(
          (each) => each.title === "Credit memo",
        )?.id ?? "",
    );
    await startScriptedTask(app, mind, { folder, files: ["a.txt"] });
    await expect(window.getByTestId("task-tray")).toBeVisible();
  }
  return { app, window };
}

test("at the end of a conversation, docking at the bottom, floating, folding and unfolding it and narrowing the window leave the latest Answer's actions in view", async () => {
  test.setTimeout(150_000);
  const { app, window } = await start({ task: false });
  const latest = assistantAnswers(window).last();
  const actions = latest.getByTestId("answer-copy");
  await expect.poll(() => inThread(window, actions)).toBe(true);

  for (const place of ["bottom", "float", "right"] as const) {
    await placeAs(window, place);
    await expect.poll(() => inThread(window, actions), { message: `at ${place}` }).toBe(true);
    if (SCREENSHOTS) {
      await window
        .getByTestId("assistant")
        .screenshot({ path: join(SCREENSHOTS, `inview-${place}.png`) });
    }
  }

  // Folded and unfolded, on the right.
  await window.getByTestId("assistant-fold").click();
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-folded", "true");
  await window.getByTestId("assistant-fold").click();
  await expect(window.getByTestId("assistant")).not.toHaveAttribute("data-folded");
  await expect.poll(() => inThread(window, actions), { message: "unfolded" }).toBe(true);

  // The window narrowed to 900px, where a side dock goes to the bottom.
  await setWindowSize(app, window, 900, 700);
  await expect.poll(() => inThread(window, actions), { message: "at 900px" }).toBe(true);
  await app.close();
});

test("scrolled up to an older turn, the same turn stays in view after the same changes", async () => {
  test.setTimeout(150_000);
  const { app, window } = await start({ task: false });
  const thread = window.getByTestId("assistant-thread");
  const first = window.locator(".assistant-question").first();
  // Scrolled up until the first Question is at the thread's top.
  await thread.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => offsetIn(first)).toBeLessThan(40);
  await thread.evaluate((el) => {
    el.dispatchEvent(new Event("scroll"));
  });
  const before = await offsetIn(first);

  for (const place of ["bottom", "float", "right"] as const) {
    await placeAs(window, place);
    await expect.poll(() => inThread(window, first), { message: `at ${place}` }).toBe(true);
    expect(Math.abs((await offsetIn(first)) - before), `at ${place}`).toBeLessThanOrEqual(2);
  }
  await setWindowSize(app, window, 900, 700);
  await expect.poll(() => inThread(window, first), { message: "at 900px" }).toBe(true);
  expect(Math.abs((await offsetIn(first)) - before), "at 900px").toBeLessThanOrEqual(2);
  await app.close();
});

test("whichever of the scroll and the resize arrives first, a thread at its end stays at its end as the room under it changes", async () => {
  test.setTimeout(150_000);
  const { app, window } = await start({ task: false });
  const thread = window.getByTestId("assistant-thread");
  const actions = assistantAnswers(window).last().getByTestId("answer-copy");
  await expect.poll(() => inThread(window, actions)).toBe(true);

  // A busy frame delivers the scroll event of the thread's last move after the room under the
  // thread changed (the Task tray) and before the resize observer reports it.
  const giveRoom = (px: number, scrollFirst: boolean) =>
    thread.evaluate(
      (el, [room, first]) => {
        const slot = document.querySelector('[data-testid="assistant-composer"]') as HTMLElement;
        if (first) el.dispatchEvent(new Event("scroll"));
        slot.style.paddingTop = `${room}px`;
        if (!first) el.dispatchEvent(new Event("scroll"));
      },
      [px, scrollFirst] as const,
    );
  for (const scrollFirst of [false, true]) {
    const order = scrollFirst ? "scroll, then resize" : "resize, then scroll";
    await giveRoom(160, scrollFirst);
    await expect
      .poll(() => inThread(window, actions), { message: `a tray taking room: ${order}` })
      .toBe(true);
    await giveRoom(0, scrollFirst);
    await expect
      .poll(() => inThread(window, actions), { message: `a tray giving it back: ${order}` })
      .toBe(true);
  }
  await app.close();
});

test("a Task starting, its progress at the thread's end and its ask in the tray, leaves that end in view, on the right and floating", async () => {
  test.setTimeout(150_000);
  const { window } = await start({ task: true });
  // The thread's end is now the Task's progress, after the latest Answer.
  const end = window.getByTestId("assistant-thread").getByTestId("task-progress-actions");
  await expect.poll(() => inThread(window, end), { message: "the tray shown" }).toBe(true);
  for (const place of ["float", "right"] as const) {
    await placeAs(window, place);
    await expect.poll(() => inThread(window, end), { message: `at ${place}` }).toBe(true);
  }
  if (SCREENSHOTS) {
    await window
      .getByTestId("assistant")
      .screenshot({ path: join(SCREENSHOTS, "inview-task.png") });
  }
});
