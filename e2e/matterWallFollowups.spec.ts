import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A walled Conversation's composer shows its lock once the core has said which wall the turn is
 * behind, and a long paste saved after its Conversation was deleted says why, where it was pasted,
 * and keeps the paste (#2243). Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const LONG_PASTE = Array.from(
  { length: 40 },
  (_, line) => `${line + 1}. The settlement offer for Client A is set out in clause ${line + 1}.`,
).join("\n");

const WORDS = {
  en: {
    folder: "Client A",
    gone: "The pasted text wasn’t saved: this conversation has been deleted.",
  },
  "zh-CN": { folder: "客户甲", gone: "粘贴的文本未保存：这个对话已删除。" },
} as const;

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

for (const language of ["en", "zh-CN"] as const) {
  test(`a walled Conversation's lock, and a paste after it was deleted (${language})`, async () => {
    const w = WORDS[language];
    await writeFile(join(sources, "Client A lease.txt"), "Termination notice: 90 days.\n");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 800);
    await addDocuments(window, [join(sources, "Client A lease.txt")]);
    await (await coreOf(window)).evaluate(async (core, name) => {
      const [lease] = await core.listDocuments();
      const folder = await core.createLibraryGroup({ name, description: "" });
      if (lease) await core.assignDocumentGroup(lease.id, folder.id);
      await core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
    }, w.folder);
    await newMind(window, { title: true });
    await nameMind(window, "Client A note");
    await (await coreOf(window)).evaluate(async (core, name) => {
      const mind = (await core.listMinds()).find((each) => each.title === "Client A note");
      const folder = (await core.getLibrary()).groups.find((each) => each.name === name);
      if (mind && folder) await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });
    }, w.folder);
    await motionSettled(window);
    await askInAssistant(window, "What is the notice?");
    // The Note closes; the Conversation, filed in the walled Folder, stays open in the assistant.
    await window.getByTestId("mind-editor").first().click();
    await window.keyboard.press("ControlOrMeta+w");
    await expect(window.getByTestId("mind-editor")).toHaveCount(0);

    const composer = window.getByTestId("composer");
    const chip = composer.getByTestId("composer-scope").getByTestId("scope-chip");
    await expect(chip).toHaveAttribute("data-walled", "true");
    await expect(chip).toContainText(w.folder);
    await expect(composer.getByTestId("composer-scope-all")).toHaveCount(0);
    await motionSettled(window);
    if (SCREENSHOTS)
      await window.screenshot({ path: join(SCREENSHOTS, `wall-chip-${language}-900.png`) });

    // A long paste, as the system pastes it, without touching the computer's clipboard.
    await composer.getByTestId("composer-input").evaluate((input, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    }, LONG_PASTE);
    const pasted = composer.getByTestId("composer-paste");
    await expect(pasted).toHaveCount(1);
    await composer.getByTestId("composer-paste-menu-button").click();
    await expect(window.getByTestId("paste-save")).toBeVisible();

    // Deleted in another window just before Save: this window hasn't heard yet.
    await (await coreOf(window)).evaluate(async (core) => {
      const [open] = await core.listConversations();
      if (!open) throw new Error("No conversation is open.");
      await core.deleteConversation(open.id);
      document.querySelector<HTMLElement>('[data-testid="paste-save"]')?.click();
    });

    const problem = composer.getByTestId("composer-paste-save-failed");
    await expect(problem).toBeVisible();
    await motionSettled(window);
    if (SCREENSHOTS)
      await window.screenshot({ path: join(SCREENSHOTS, `paste-deleted-${language}-900.png`) });
    await expect(problem).toContainText(w.gone);
    await expect(pasted).toHaveCount(1);
    const saved = await (await coreOf(window)).evaluate(async (core) =>
      (await core.listDocuments()).map((each) => each.name),
    );
    expect(saved).toEqual(["Client A lease"]);
    await app.close();
  });
}
