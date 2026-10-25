import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  splitFromTabMenu,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const tabsOf = (window: Page) => window.getByTestId("mind-tab");
const activeTab = (window: Page) => window.locator('[role="tab"][aria-selected="true"]');

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function makeMinds(window: Page) {
  for (const name of ["Alpha 资料", "Beta 笔记", "Gamma 🙂"]) {
    await newMind(window);
    await nameMind(window, name);
  }
}

async function holdNextMindOpening(app: ElectronApplication, mindId: string) {
  await app.evaluate(({ ipcMain }, id) => {
    // Electron has no public getter for an installed handler; hold the actual IPC reply, not a fake editor.
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get("core:openMind");
    if (!original) throw new Error("The openMind handler is missing.");
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = { requested: false, release };
    Object.assign(globalThis, { heldMindOpening: held });
    ipcMain.removeHandler("core:openMind");
    ipcMain.handle("core:openMind", async (event, requested) => {
      if (requested === id) {
        ipcMain.removeHandler("core:openMind");
        ipcMain.handle("core:openMind", original);
        held.requested = true;
        await ready;
      }
      return original(event, requested);
    });
  }, mindId);
  return {
    waiting: () =>
      app.evaluate(
        () =>
          (globalThis as unknown as { heldMindOpening: { requested: boolean } }).heldMindOpening
            .requested,
      ),
    release: () =>
      app.evaluate(() =>
        (
          globalThis as unknown as { heldMindOpening: { release(): void } }
        ).heldMindOpening.release(),
      ),
  };
}

for (const language of ["en", "zh-CN"] as const) {
  test(`closing a tab keeps the keyboard in its replacement, keeps other controls focused and reaches the empty state (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 660);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await makeMinds(window);
      await activeTab(window).focus();
      await window.keyboard.press("ControlOrMeta+w");
      await expect(tabsOf(window)).toHaveCount(2);
      await expect(activeTab(window)).toBeFocused();
      await expect(activeTab(window)).toHaveAccessibleName("Beta 笔记");
      if (SCREENSHOTS) {
        await motionSettled(window);
        await window.screenshot({ path: join(SCREENSHOTS, `tab-after-${language}.png`) });
      }
      await window.keyboard.press("ArrowLeft");
      await expect(activeTab(window)).toHaveAccessibleName("Alpha 资料");
      await expect(activeTab(window)).toBeFocused();

      await window.keyboard.press("ControlOrMeta+Shift+t");
      await expect(tabsOf(window)).toHaveCount(3);
      const editor = window.getByTestId("mind-editor");
      await pointAndClick(window, editor);
      await focusSettled(window, editor);
      await window.keyboard.press("ControlOrMeta+w");
      await expect(tabsOf(window)).toHaveCount(2);
      await expect(editor).toBeFocused();
      await focusSettled(window, editor);
      await window.keyboard.insertText("继续 writing");
      await expect(editor).toContainText("继续 writing");
      await window.keyboard.press("ControlOrMeta+,");
      await expect(window.getByTestId("settings")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("settings")).toBeHidden();
      await expect(editor).toBeFocused();

      await window.keyboard.press("ControlOrMeta+Shift+t");
      await expect(tabsOf(window)).toHaveCount(3);
      const newTab = window.getByTestId("new-tab");
      await newTab.focus();
      await window.keyboard.press("ControlOrMeta+w");
      await expect(tabsOf(window)).toHaveCount(2);
      await expect(newTab).toBeFocused();
      await pointAndClick(
        window,
        window.getByRole("tab", { name: "Alpha 资料", exact: true }).getByTestId("tab-close"),
      );
      await expect(tabsOf(window)).toHaveCount(1);
      await expect(activeTab(window)).toHaveAccessibleName("Beta 笔记");
      await expect(activeTab(window)).toBeFocused();
      await window.keyboard.press("ControlOrMeta+w");
      await expect(tabsOf(window)).toHaveCount(0);
      await expect(window.getByTestId("mind-none-open")).toBeVisible();
      await expect(newTab).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(tabsOf(window)).toHaveCount(1);
      await expect(editor).toBeFocused();
      await window.keyboard.press("ControlOrMeta+w");
      await expect(tabsOf(window)).toHaveCount(0);
      await expect(newTab).toBeFocused();
    } finally {
      await app.close();
    }
  });
}

test("closing a focused group's last tab hands focus to the surviving group's tab", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await makeMinds(window);
    await splitFromTabMenu(window);
    const groups = window.getByTestId("tab-group");
    await expect(groups).toHaveCount(2);
    await groups.nth(1).getByRole("tab", { name: "Gamma 🙂", exact: true }).focus();
    await window.keyboard.press("ControlOrMeta+w");
    await expect(groups).toHaveCount(1);
    await expect(activeTab(window)).toBeFocused();
    await expect(activeTab(window)).toHaveAccessibleName("Gamma 🙂");
  } finally {
    await app.close();
  }
});

test("a delayed close focus handoff keeps a control the User has since focused", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1280, 660);
    await dismissChatSetup(window);
    await makeMinds(window);
    await activeTab(window).focus();
    await window.evaluate(() => {
      const frame = globalThis.requestAnimationFrame.bind(globalThis);
      const held: FrameRequestCallback[] = [];
      globalThis.requestAnimationFrame = (callback) => held.push(callback);
      Object.assign(globalThis, {
        releaseCloseFrames: () => {
          globalThis.requestAnimationFrame = frame;
          for (const callback of held) frame(callback);
        },
      });
    });
    await window.keyboard.press("ControlOrMeta+w");
    await expect(tabsOf(window)).toHaveCount(2);
    const newTab = window.getByTestId("new-tab");
    await newTab.focus();
    await window.evaluate(() =>
      (globalThis as unknown as { releaseCloseFrames(): void }).releaseCloseFrames(),
    );
    await motionSettled(window);
    await expect(newTab).toBeFocused();
  } finally {
    await app.close();
  }
});

for (const whileLoading of ["wait", "focus another editor", "close the loading tab"] as const) {
  test(`closing from an editor waits for its replacement in the same pane: ${whileLoading}`, async () => {
    const { app, window } = await launchApp(dataDir);
    let held: Awaited<ReturnType<typeof holdNextMindOpening>> | undefined;
    try {
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await makeMinds(window);
      await splitFromTabMenu(window);
      await newMind(window);
      await nameMind(window, "Delta");
      const groups = window.getByTestId("tab-group");
      const firstEditor = groups.nth(0).getByTestId("mind-editor");
      const secondEditor = groups.nth(1).getByTestId("mind-editor");
      await expect(firstEditor).toBeVisible();
      const mindId = await (await coreOf(window)).evaluate(
        async (core) => (await core.listMinds()).find((mind) => mind.title === "Gamma 🙂")?.id,
      );
      if (!mindId) throw new Error("The replacement Mind is missing.");
      held = await holdNextMindOpening(app, mindId);
      await pointAndClick(window, secondEditor);
      await focusSettled(window, secondEditor);
      await window.keyboard.press("ControlOrMeta+w");
      await expect.poll(held.waiting).toBe(true);
      await expect(secondEditor).toHaveCount(0);
      await expect(firstEditor).not.toBeFocused();
      if (whileLoading === "focus another editor") await firstEditor.focus();
      if (whileLoading === "close the loading tab") {
        await pointAndClick(window, groups.nth(1).getByTestId("tab-close"));
        await expect(groups).toHaveCount(1);
      }
      await held.release();
      if (whileLoading === "close the loading tab") {
        await expect(activeTab(window)).toBeFocused();
      } else {
        await expect(secondEditor).toBeVisible();
        await expect(whileLoading === "wait" ? secondEditor : firstEditor).toBeFocused();
        await window.keyboard.insertText("still here");
        await expect(whileLoading === "wait" ? secondEditor : firstEditor).toContainText(
          "still here",
        );
      }
    } finally {
      await held?.release();
      await app.close();
    }
  });
}
