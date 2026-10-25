import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { writeLockedPdf } from "../tests/helpers/lockedPdf";
import {
  acceptPlainTextKeys,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openDocumentMenu,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A password-protected PDF (#763): its row offers Unlock…, which opens it in
 * the viewer with the password asked for in place. A wrong password says so
 * under the field, its text kept and selected; the right one opens the pages
 * and reads the PDF. Its row then offers Forget password. Beside an Answer,
 * it says it is locked and offers Unlock… too. In English and Chinese.
 */

const PASSWORD = "tide-tables-7Q!";

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

test("a locked PDF is unlocked in place: a wrong password says so, the right one opens its pages and reads it, and Forget password lets it go, in English and Chinese", async () => {
  const path = await writeLockedPdf(
    sources,
    "Harbour accounts.pdf",
    ["Harbour accounts 2025", "The harbour office opens on Mondays at 8am."],
    PASSWORD,
  );
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await window.getByTestId("add-documents-input").setInputFiles([path]);
  const item = window.getByTestId("document-list-item");
  await expect(item).toHaveAttribute("data-status", "failed");

  // Its menu offers Unlock… instead of Retry, which would fail again.
  await openDocumentMenu(item);
  await expect(window.getByRole("menuitem", { name: "Retry" })).toHaveCount(0);
  await window.getByRole("menuitem", { name: "Unlock…" }).click();
  const locked = window.getByTestId("viewer").getByTestId("pdf-locked");
  await expect(locked).toContainText("This PDF is locked");
  const field = locked.getByTestId("pdf-password");
  await expect(field).toBeFocused();
  // With no keyring running (CI's Linux), the User first accepts keeping it without one.
  await acceptPlainTextKeys(window, locked);
  await expect(field).toBeFocused();

  // A wrong password: said under the field, which keeps its text, selected, to type over.
  const wrong = locked.getByTestId("pdf-password-wrong");
  const expectWrongUnderField = async (typed: number) => {
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("aria-describedby", (await wrong.getAttribute("id")) ?? "");
    const fieldBox = await field.boundingBox();
    const wrongBox = await wrong.boundingBox();
    expect(wrongBox?.y ?? 0).toBeGreaterThan((fieldBox?.y ?? 0) + (fieldBox?.height ?? 0) - 1);
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
        input.value.length,
      ]),
    ).toEqual([0, typed, typed]);
  };
  await window.keyboard.type("not-it");
  await window.keyboard.press("Enter");
  await expect(wrong).toHaveText("That password doesn’t open it.");
  await expectWrongUnderField(6);

  // Typing replaces it, and the line goes.
  await window.keyboard.type("n");
  await expect(field).toHaveValue("n");
  await expect(wrong).toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid");

  await setLanguage(window, "zh-CN");
  await expect(locked).toContainText("这个 PDF 已加密");
  await expect(locked.getByTestId("pdf-unlock")).toHaveText("解锁");
  await window.keyboard.type("ot-it-either");
  await window.keyboard.press("Enter");
  await expect(wrong).toHaveText("密码不正确，无法打开。");
  await expectWrongUnderField(13);

  // The right one, typed over the wrong: the pages open, and the PDF is read.
  await window.keyboard.type(PASSWORD);
  await locked.getByTestId("pdf-unlock").click();
  await expect(locked).toHaveCount(0);
  await expect(window.getByTestId("pdf-page-count")).toBeVisible();
  await expect(window.getByTestId("viewer").locator(".textLayer").first()).toContainText(
    "Harbour accounts 2025",
  );
  await expect(item).toHaveAttribute("data-status", "ready");

  // Forget password, from its menu: the viewer asks again next time.
  await setLanguage(window, "en");
  await openDocumentMenu(item);
  await window.getByRole("menuitem", { name: "Forget password" }).click();
  await expect
    .poll(() =>
      window.evaluate(() =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocumentPasswords(),
      ),
    )
    .toEqual([]);
  await openDocumentMenu(item);
  await expect(window.getByRole("menuitem", { name: "Forget password" })).toHaveCount(0);
  await window.keyboard.press("Escape");
  await app.close();
});

test("beside an Answer, a locked PDF says so and offers Unlock…, which opens it where its password is asked for, in English and Chinese", async () => {
  const path = await writeLockedPdf(
    sources,
    "Harbour accounts.pdf",
    ["Harbour accounts"],
    PASSWORD,
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await window.getByTestId("add-documents-input").setInputFiles([path]);
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "failed");
  await newMind(window);

  const answer = await askInAssistant(window, "When does the harbour office open?");
  const line = answer.getByTestId("unread-files");
  await line.getByTestId("unread-files-show").click();
  const row = line.getByTestId("unread-file");
  await expect(row).toHaveAttribute("data-reason", "password");
  await expect(row).toContainText("Harbour accounts.pdf: Locked with a password.");
  await expect(row).not.toContainText("Remove the password");
  await setLanguage(window, "zh-CN");
  await expect(row).toContainText("已加密。");
  await expect(row.getByTestId("unread-file-unlock")).toHaveText("解锁…");

  await row.getByTestId("unread-file-unlock").click();
  await expect(window.getByTestId("viewer").getByTestId("pdf-locked")).toContainText(
    "这个 PDF 已加密",
  );
  await app.close();
});
