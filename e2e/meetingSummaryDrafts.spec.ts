import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { Meeting } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  sidebarFolder,
} from "./app";

async function savedMeeting(dir: string) {
  const { app, window } = await launchApp(dir);
  let meeting: Meeting;
  try {
    await dismissChatSetup(window);
    meeting = await (await coreOf(window)).evaluate(async (core) => {
      const folder = await core.createLibraryGroup({ name: "Pier review", description: "" });
      return core.createMeeting({ folderId: folder.id });
    });
  } finally {
    await app.close();
  }
  const db = openDatabase(join(dir, "incarnamind.db"));
  try {
    const summary = {
      route: "fixture",
      count: 1,
      digest: "fixture",
      summary: { state: "ready", text: "The team approved the schedule.", throughMs: 2000 },
    };
    db.run("UPDATE meetings SET status='stopped',summary=? WHERE id=?", [
      JSON.stringify(summary),
      meeting.id,
    ]);
  } finally {
    db.close();
  }
  return meeting;
}

async function openMeeting(window: Page, mindId: string) {
  await dismissChatSetup(window);
  const folder = sidebarFolder(window, "Pier review").getByTestId("folder-row");
  if ((await folder.getAttribute("aria-expanded")) !== "true") await pointAndClick(window, folder);
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  const text = window.getByTestId("meeting-summary-text");
  await expect(text).toBeVisible();
  return text;
}

async function holdWrite(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const channel = "core:updateMeetingSummaryContent";
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get(channel);
    if (!original) throw new Error("The meeting summary write must be registered.");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = { requested: false, release };
    Object.assign(globalThis, { heldSummary: held });
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
      held.requested = true;
      await gate;
      return original(event, ...args);
    });
  });
}

async function answerClose(app: ElectronApplication, answer: number) {
  await app.evaluate(({ dialog }, response) => {
    const sheet = { asked: 0, message: "", response };
    Object.assign(globalThis, { summaryCloseSheet: sheet });
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxOptions;
      sheet.message = options.message;
      sheet.asked++;
      return { response: sheet.response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answer);
}

test("a conflict keeps my draft; an explicit discard closes the window without replacing the other saved version", async () => {
  const dir = await createDataFolder();
  let app: ElectronApplication | undefined;
  try {
    const { id, mindId } = await savedMeeting(dir);
    const opened = await launchApp(dir);
    app = opened.app;
    const window = opened.window;
    const editor = await openMeeting(window, mindId);
    const bridge = await coreOf(window);
    const remote = (text: string) =>
      bridge.evaluate(
        async (core, { id, text }) => {
          const summary = (await core.listMeetings()).find((m) => m.id === id)?.summary;
          return core.updateMeetingSummaryContent(id, summary?.editedContent ?? null, {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          });
        },
        { id, text },
      );
    await window.getByTestId("meeting-summary").getByRole("heading").focus();
    await remote("The pier opens on Tuesday.");
    await expect(editor).toHaveText("The pier opens on Tuesday.");
    await pointAndClick(window, editor);
    await remote("The pier opens on Friday.");
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.insertText("My draft names the person who will call.");
    const problem = window.getByTestId("meeting-summary-edit-problem");
    await expect(problem).toContainText("The summary changed elsewhere.");
    await answerClose(app, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.close());
    await expect
      .poll(() =>
        app?.evaluate(
          () =>
            (globalThis as unknown as { summaryCloseSheet: { asked: number } }).summaryCloseSheet
              .asked,
        ),
      )
      .toBe(1);
    await expect(editor).toHaveText("My draft names the person who will call.");
    await expect(problem.getByRole("button", { name: "Save my version" })).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as unknown as { summaryCloseSheet: { response: number } }
      ).summaryCloseSheet.response = 1;
    });
    const closed = window.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.close());
    await closed;
    await app.close();
    app = undefined;
    const reopened = await launchApp(dir);
    app = reopened.app;
    await expect(await openMeeting(reopened.window, mindId)).toHaveText(
      "The pier opens on Friday.",
    );
  } finally {
    await app?.close();
    await removeDataFolder(dir);
  }
});

for (const operation of ["close", "quit"] as const)
  test(`an outstanding meeting edit and the next keystroke finish before ${operation}`, async () => {
    const dir = await createDataFolder();
    let app: ElectronApplication | undefined;
    try {
      const { mindId } = await savedMeeting(dir);
      const opened = await launchApp(dir);
      app = opened.app;
      const window = opened.window;
      const editor = await openMeeting(window, mindId);
      await holdWrite(app);
      await pointAndClick(window, editor);
      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.insertText("First part");
      await expect
        .poll(() =>
          app?.evaluate(
            () =>
              (globalThis as unknown as { heldSummary: { requested: boolean } }).heldSummary
                .requested,
          ),
        )
        .toBe(true);
      await window.keyboard.insertText(" and last word.");
      await expect(editor).toHaveText("First part and last word.");
      const closed =
        operation === "quit" ? app.waitForEvent("close") : window.waitForEvent("close");
      await app.evaluate(({ app, BrowserWindow }, op) => {
        if (op === "quit") app.quit();
        else BrowserWindow.getFocusedWindow()?.close();
      }, operation);
      await expect(editor).toHaveText("First part and last word.");
      await app.evaluate(() =>
        (globalThis as unknown as { heldSummary: { release(): void } }).heldSummary.release(),
      );
      await closed;
      if (operation === "close") await app.close();
      app = undefined;
      const reopened = await launchApp(dir);
      app = reopened.app;
      await expect(await openMeeting(reopened.window, mindId)).toHaveText(
        "First part and last word.",
      );
    } finally {
      await app?.close();
      await removeDataFolder(dir);
    }
  });
