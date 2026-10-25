import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  exportFromMenu,
  interceptOpenDialog,
  interceptShowItemInFolder,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openDocumentAt,
  openSteps,
  pathsShown,
  removeDataFolder,
  savedLine,
  useOutputLocation,
} from "./app";

/**
 * Problems show where they happen (DESIGN.md, Problems): one line in the meta
 * tone with one action, never a modal and never a toast that goes away by
 * itself. Each test makes one kind of problem happen as a person would, then
 * checks its line is in place and that its action does what it says. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of the lines.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await chmod(join(sources, "readonly"), 0o755).catch(() => undefined);
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const bridge = (window: Page) => ({
  settings: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
});

/** A model server that refuses every request with `status`, counting the requests. */
async function refusingServer() {
  const state = { status: 401, requests: 0 };
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      state.requests++;
      response.writeHead(state.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "refused for the test" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { state, server, url: `http://127.0.0.1:${port}` };
}

test("a failed Answer says so under itself with one action: the key's page in Settings, or trying again; and says it in Chinese", async () => {
  const model = await refusingServer();
  try {
    // Ollama is looked for at the test's server, not at one this computer may run.
    const { app, window } = await launchApp(dataDir, { ollama: model.url, ollamaApp: "missing" });
    await dismissChatSetup(window);
    await window.evaluate(async (baseUrl) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "ollama",
        baseUrl,
        modelId: "test-model",
      });
    }, model.url);

    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is in my Documents?");
    await window.keyboard.press("Enter");

    // The key was refused: the line names the model, in place under the Answer, in the assistant.
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
    const error = answer.getByTestId("answer-error");
    await expect(error).toContainText("The key for test-model was refused");
    // One line, one action; a line that screen readers hear as an alert, in the meta tone.
    const line = error.getByRole("alert");
    await expect(line).toHaveCSS("color", "rgb(101, 107, 116)");
    await expect(line.getByRole("button")).toHaveCount(1);
    await expect(line.getByRole("button")).toHaveText("Check the key");
    // It sits under the Answer's text, in the assistant, with no dialog or toast about it.
    expect(
      await answer.evaluate((node) => {
        const text =
          node.querySelector('[data-testid="assistant-answer-text"]')?.getBoundingClientRect()
            .bottom ?? 0;
        const line = node.querySelector('[data-testid="answer-error"]')?.getBoundingClientRect();
        return (line?.top ?? 0) >= text - 1;
      }),
    ).toBe(true);
    await expect(window.locator("dialog[open]")).toHaveCount(0);
    expect((await line.boundingBox())?.height).toBeLessThan(24);
    await screenshot(window, "answer-key-refused-en");

    // Its action opens the Models page, where the key is.
    await error.getByTestId("answer-error-action").click();
    await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings")).toBeHidden();

    // The provider has a problem now: Regenerate, at the end of its steps, and the line offers to
    // try again, which asks again.
    model.state.status = 500;
    await openSteps(window, answer);
    await answer.getByTestId("answer-regenerate").click();
    await expect(error).toContainText("Ollama ran into a problem", { timeout: 60_000 });
    await expect(error.getByTestId("answer-error-action")).toHaveText("Try again");
    const asked = model.state.requests;
    // By keyboard: the focus ring shows on the action, and Enter asks again.
    await error.getByTestId("answer-error-action").focus();
    await window.keyboard.press("Tab");
    await window.keyboard.press("Shift+Tab");
    await expect(error.getByTestId("answer-error-action")).toBeFocused();
    await expect(error.getByTestId("answer-error-action")).toHaveCSS("outline-style", "solid");
    await window.keyboard.press("Enter");
    await expect.poll(() => model.state.requests).toBeGreaterThan(asked);
    await expect(error).toContainText("Ollama ran into a problem", { timeout: 60_000 });

    // The same line in Chinese.
    await bridge(window).settings("zh-CN");
    await expect(error).toContainText("Ollama 出错了");
    await expect(error.getByTestId("answer-error-action")).toHaveText("重试");
    await screenshot(window, "answer-provider-problem-zh");

    // Ollama stopped: it isn't running on this computer, which no connection can fix (#843).
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
    await error.getByTestId("answer-error-action").click();
    await expect(error).toHaveAttribute("data-error-kind", "ollama-not-running", {
      timeout: 60_000,
    });
    await expect(error).toContainText("Ollama 没有在这台电脑上运行");
    await expect(error.getByTestId("answer-error-action")).toHaveText("下载 Ollama ↗");
    await bridge(window).settings("en");
    await expect(error).toContainText("Ollama isn’t running on this computer");
    await expect(error.getByTestId("answer-error-action")).toHaveText("Get Ollama ↗");
    await app.close();
  } finally {
    model.server.close();
  }
});

test("asking without a chat model says what to set up at the top of the Mind, and the first Question waits for the setup card, which takes that line's place", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);

  // At the top of the Mind: one line and one action, read as a status.
  const top = window.getByTestId("chat-readiness");
  await expect(top).toContainText("Asking needs an AI model");
  await expect(top.getByRole("button")).toHaveText("Set up");
  await expect(window.getByRole("status").filter({ has: top })).toHaveCount(0);
  await screenshot(window, "needs-chat-model-en");

  // The notice's action opens Settings on Models, by keyboard too.
  await nameMind(window, "Tides");
  await window.keyboard.press("End");
  await top.getByRole("button").focus();
  await expect(top.getByRole("button")).toHaveCSS("outline-style", "solid");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
  await window.keyboard.press("Escape");

  // In Chinese.
  await bridge(window).settings("zh-CN");
  await expect(top).toContainText("提问需要 AI 模型");
  await expect(top.getByRole("button")).toHaveText("去设置");
  await screenshot(window, "needs-chat-model-zh");
  await bridge(window).settings("en");

  // Asked from the composer, the Question waits in the conversation and the composer becomes the
  // setup card, not a line; nothing is written into the note, and the line above steps aside.
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Is anyone there?");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("model-setup")).toBeVisible();
  await expect(window.getByTestId("mind-editor").getByTestId("question")).toHaveCount(0);
  await expect(window.locator("dialog[open]")).toHaveCount(0);
  await expect(top).toHaveCount(0);
  await screenshot(window, "needs-chat-model-composer-en");
  await app.close();
});

test("a Document whose file moved says so in the viewer with Locate file…, which brings it back; a different file does not", async () => {
  const original = join(sources, "Amendment No. 2.md");
  const text = "# Amendment No. 2\n\nThe fee is due on 31 October 2026.\n";
  await writeFile(original, text);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [original]);
  const item = window.getByTestId("document-list-item");
  const documentId = await documentIdOf(window, "Amendment No. 2");
  await item.getByTestId("open-document").click();
  await expect(window.getByTestId("viewer-text")).toContainText("The fee is due");

  // The file is moved away: opened again, the viewer says so, in place.
  await mkdir(join(sources, "Archive"));
  const moved = join(sources, "Archive", "Amendment 2 (signed).md");
  await rename(original, moved);
  await expect(item).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });
  await window.getByTestId("document-tab").getByTestId("tab-close").click();
  await item.getByTestId("open-document").click();
  const gone = window.getByTestId("viewer-removed");
  await expect(gone).toHaveAttribute("data-reason", "missing");
  const line = gone.getByTestId("viewer-problem");
  await expect(line).toContainText("The file for Amendment No. 2 is missing from its folder");
  await expect(line).toHaveCSS("color", "rgb(101, 107, 116)");
  await expect(line.getByRole("button")).toHaveCount(1);
  await expect(line.getByRole("button")).toHaveText("Locate file…");
  await expect(window.locator("dialog[open]")).toHaveCount(0);
  await screenshot(window, "viewer-file-moved-en");

  // A file that isn't the Document's: told so, still offering to locate; the other file is a Document of its own.
  const other = join(sources, "Something else.md");
  await writeFile(other, "# Something else\n\nNothing to do with the amendment.\n");
  await interceptOpenDialog(app, other);
  await gone.getByTestId("viewer-locate-file").focus();
  await window.keyboard.press("Enter");
  const result = gone.getByTestId("viewer-locate-result");
  await expect(result).toContainText("Not the file for “Amendment No. 2”");
  await expect(item).toHaveCount(2);
  await expect(gone.getByTestId("viewer-locate-file")).toBeVisible();
  await screenshot(window, "viewer-file-not-this-en");

  // The right file, in its new place: the Document finds it again, and the viewer shows it.
  await interceptOpenDialog(app, moved);
  await gone.getByTestId("viewer-locate-file").click();
  await expect(window.getByTestId("viewer-removed")).toHaveCount(0);
  await expect(window.getByTestId("viewer-text")).toContainText("The fee is due");
  await expect(window.locator(`[data-document-id="${documentId}"]`).first()).toHaveAttribute(
    "data-file-status",
    "available",
  );
  // The same Document, not a new one: Citations to it still open.
  await expect(item).toHaveCount(2);
  await app.close();
});

test("a Document that is gone says so in the viewer and in Chinese; one that can't be reached offers nothing to do", async () => {
  const original = join(sources, "Lease.md");
  await writeFile(original, "# Lease\n\nRent is due monthly.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [original]);
  const item = window.getByTestId("document-list-item");
  const documentId = await documentIdOf(window, "Lease");
  await bridge(window).settings("zh-CN");

  await rm(original);
  await expect(item).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });
  await item.getByTestId("open-document").click();
  const line = window.getByTestId("viewer-removed").getByTestId("viewer-problem");
  await expect(line).toContainText("“Lease”的文件已不在原文件夹中");
  await expect(line.getByRole("button")).toHaveText("定位文件…");
  await screenshot(window, "viewer-file-moved-zh");

  // Deleted from IncarnaMind: a line and the quote it kept, with no action to take.
  await window.getByTestId("document-tab").getByTestId("tab-close").click();
  await openDocumentAt(window, {
    documentId: `${documentId}-deleted`,
    pageFrom: 1,
    quote: "Rent is due monthly.",
  });
  const removed = window.getByTestId("viewer-removed");
  await expect(removed).toHaveAttribute("data-reason", "deleted");
  await expect(removed.getByTestId("viewer-problem")).toContainText("已从 IncarnaMind 中删除");
  await expect(removed.getByRole("button")).toHaveCount(0);
  await expect(removed).toContainText("Rent is due monthly.");
  await motionSettled(window);
  await screenshot(window, "viewer-deleted-zh");
  await app.close();
});

test("an export that can't be saved says why in the Mind, and Change output location… saves it elsewhere; then Saved … shows it in the file manager", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Tides");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");

  const readOnly = join(sources, "readonly");
  await mkdir(readOnly);
  await chmod(readOnly, 0o555);
  await useOutputLocation(window, readOnly);
  await interceptShowItemInFolder(app);
  await exportFromMenu(window);
  const result = window.getByTestId("export-result");

  // The folder is read-only: the line says so, in the Mind, with its one action, and nothing pops up.
  const problem = result.getByTestId("export-problem");
  await expect(problem).toHaveText(
    "Couldn’t save: the folder is read-only · Change output location…",
  );
  await expect(problem).toHaveAttribute("role", "alert");
  await expect(problem.getByRole("button")).toHaveCount(1);
  await expect(problem).toHaveCSS("color", "rgb(101, 107, 116)");
  await expect(window.getByRole("alert")).toHaveCount(1);
  await screenshot(result, "export-cant-save-en");

  // Change output location…, by keyboard: the folder picker, then saved there.
  await interceptOpenDialog(app, sources);
  await result.getByTestId("export-dismiss").focus();
  await window.keyboard.press("Shift+Tab");
  await expect(result.getByTestId("export-change-location")).toBeFocused();
  await expect(result.getByTestId("export-change-location")).toHaveCSS("outline-style", "solid");
  await window.keyboard.press("Enter");
  const done = result.getByTestId("export-done");
  await expect(done).toHaveText(savedLine("Tides.docx", sources));
  await expect(done).toHaveAttribute("role", "status");
  await expect(result.getByTestId("export-show")).toHaveText(/^Show in (Finder|folder)$/);
  await expect(problem).toHaveCount(0);
  await screenshot(result, "export-saved-en");

  // Show in Finder is one of the line's actions.
  await result.getByTestId("export-show").click();
  await expect.poll(() => pathsShown(app)).toEqual([join(await realpath(sources), "Tides.docx")]);

  // The same two lines in Chinese; the file saved before stays, and this one takes the next name.
  await bridge(window).settings("zh-CN");
  await useOutputLocation(window, readOnly);
  await exportFromMenu(window);
  await expect(problem).toHaveText("无法保存：这个文件夹是只读的 · 更改保存位置…");
  await screenshot(result, "export-cant-save-zh");
  await result.getByTestId("export-change-location").click();
  await expect(result.getByTestId("export-done")).toHaveText(
    savedLine("Tides 2.docx", sources, "zh-CN"),
  );
  await screenshot(result, "export-saved-zh");
  await app.close();
});
