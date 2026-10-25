import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  mindWrittenBefore,
  moveAssistant,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";
import { endFeel, startFeel } from "./feel";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LONG = Array.from({ length: 60 }, (_, index) => ({
  note: `Paragraph ${index + 1}: the harbour log for the week lists arrivals, tides, cargo and the weather at the pier, in the order they came.`,
}));

const tabNamed = (window: Page, title: string) =>
  window.locator(`[data-testid="mind-tab"][title=${JSON.stringify(title)}]`);

async function openMind(window: Page, title: string) {
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
  await expect(tabNamed(window, title)).toHaveAttribute("aria-selected", "true");
}

test("switching tabs back and forth", async () => {
  const run = await startFeel(dataDir, "tabs");
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  for (const title of ["Harbour log", "Cargo", "Weather"]) {
    await mindWrittenBefore(window, title, LONG);
  }
  await openMind(window, "Harbour log");
  await openMind(window, "Cargo");
  await openMind(window, "Weather");

  await feel.step("scroll the Mind", async () => {
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    const box = await editor.boundingBox();
    if (!box) throw new Error("The Mind isn't showing.");
    await window.mouse.move(box.x + box.width / 2, box.y + 200);
    await window.mouse.wheel(0, 1500);
    await expect(editor.getByText("Paragraph 30:")).toBeInViewport();
  });

  for (const [step, title] of [
    ["to the first tab", "Harbour log"],
    ["to the second tab", "Cargo"],
    ["back to the third tab", "Weather"],
  ] as const) {
    await feel.step(step, async () => {
      await pointAndClick(window, tabNamed(window, title));
      await expect(tabNamed(window, title)).toHaveAttribute("aria-selected", "true");
    });
  }

  await feel.step("next tab by keyboard", async () => {
    await window.keyboard.press("Control+Tab");
    await expect(tabNamed(window, "Harbour log")).toHaveAttribute("aria-selected", "true");
  });
  await feel.step("back by keyboard", async () => {
    await window.keyboard.press("Control+Shift+Tab");
    await expect(tabNamed(window, "Weather")).toHaveAttribute("aria-selected", "true");
  });

  await endFeel(run);
});

test("the assistant folding and docking", async () => {
  const run = await startFeel(dataDir, "assistant-place");
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await mindWrittenBefore(window, "Harbour log", LONG);
  await openMind(window, "Harbour log");
  const assistant = window.getByTestId("assistant");

  await feel.step("fold", async () => {
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(assistant).toHaveAttribute("data-folded", "true");
  });
  await feel.step("unfold with ⌘J", async () => {
    await window.keyboard.press("ControlOrMeta+j");
    await expect(assistant).not.toHaveAttribute("data-folded");
  });
  await feel.expectFocus("unfold with ⌘J", window.getByTestId("composer-input"));

  for (const place of ["bottom", "float", "left", "right"] as const) {
    await feel.step(`dock ${place}`, async () => {
      await moveAssistant(window, place);
      await expect(assistant).toHaveAttribute("data-chosen-dock", place);
    });
    await feel.expectFocus(`dock ${place}`, window.getByTestId("assistant-more"));
  }

  await feel.step("fold at the bottom", async () => {
    await moveAssistant(window, "bottom");
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(assistant).toHaveAttribute("data-folded", "true");
  });

  await endFeel(run);
});
