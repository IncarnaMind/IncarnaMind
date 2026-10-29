import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
  paletteOffers,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  useLocalChatModel,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** "· Undo" ends the undo line's last line of words, never alone on a line of its own. */
async function undoStaysWithItsWord(window: Page): Promise<void> {
  const message = await window.getByTestId("undo-message").boundingBox();
  const undo = await window.getByTestId("undo-action").boundingBox();
  if (!message || !undo) throw new Error("The undo line isn't shown.");
  const middle = undo.y + undo.height / 2;
  expect(middle).toBeGreaterThan(message.y + message.height - 16);
  expect(middle).toBeLessThan(message.y + message.height);
}

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

const OUTSIDE = {
  en: {
    a: "Client A",
    b: "Client B",
    other: "Other work",
    note: "Outside note",
    left: "All Documents · 2 Folders left out",
  },
  "zh-CN": {
    a: "客户甲",
    b: "客户乙",
    other: "其他工作",
    note: "外部笔记",
    left: "全部文档 · 已排除 2 个文件夹",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`outside scope leaves a wall visible without letting it into the scope (${language})`, async () => {
    const w = OUTSIDE[language];
    for (const name of [w.a, w.b, w.other]) {
      await writeFile(join(sources, `${name} lease.txt`), "Termination notice: 90 days.\n");
    }
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 800);
    await addDocuments(
      window,
      [w.a, w.b, w.other].map((name) => join(sources, `${name} lease.txt`)),
    );
    await (await coreOf(window)).evaluate(async (core, names) => {
      const documents = await core.listDocuments();
      const groups = [];
      for (const name of [names.a, names.b, names.other]) {
        const group = await core.createLibraryGroup({ name, description: "" });
        const document = documents.find((each) => each.name.startsWith(name));
        if (document) await core.assignDocumentGroup(document.id, group.id);
        groups.push(group);
      }
      for (const group of groups.slice(0, 2)) {
        await core.updateLibraryGroup(group.id, {
          name: group.name,
          description: group.description,
          keepInside: true,
        });
      }
    }, w);
    await newMind(window, { title: true });
    await nameMind(window, w.note);
    const all = window.getByTestId("composer-scope-all");
    await expect(all).toHaveText(w.left);
    await motionSettled(window);
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 800);
      if (SCREENSHOTS)
        await window.screenshot({
          path: join(SCREENSHOTS, `matter-wall-outside-${language}-${width}.png`),
        });
    }
    await setWindowSize(app, window, 900, 800);
    await all.click();
    // Named, the locked Folder comes first and is chosen: its row offers a Note there.
    await window.keyboard.type(w.a.split(" ")[0] ?? w.a);
    await motionSettled(window);
    const locked = window.getByTestId("scope-choice").filter({ hasText: w.a }).first();
    await expect(locked).toHaveAttribute("data-walled", "true");
    await expect(locked.locator("[aria-disabled='true']")).toHaveCount(1);
    await expect(locked.getByTestId("scope-open-note")).toBeVisible();
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 800);
      await expect(locked.getByTestId("scope-open-note")).toBeVisible();
      await motionSettled(window);
      if (SCREENSHOTS)
        await window.screenshot({
          path: join(SCREENSHOTS, `matter-wall-outside-picker-${language}-${width}.png`),
        });
    }
    await motionSettled(window);
    await locked.getByTestId("scope-open-note").click();
    await expect(window.getByTestId("scope-picker")).toHaveCount(0);
    await expect(window.getByTestId("composer-scope").getByTestId("scope-chip")).toHaveAttribute(
      "data-walled",
      "true",
    );
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Folder wall is visible and reversible (${language})`, async () => {
    const ownName = language === "en" ? "Client A lease.txt" : "客户甲租约.txt";
    const otherName = language === "en" ? "Client B lease.txt" : "客户乙租约.txt";
    await writeFile(join(sources, ownName), "Termination notice: 90 days.\n");
    await writeFile(join(sources, otherName), "Termination notice: 30 days.\n");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 800);
    await addDocuments(window, [join(sources, ownName), join(sources, otherName)]);
    const folderName = language === "en" ? "Client A" : "客户甲";
    const otherFolder = language === "en" ? "Client B" : "客户乙";
    const noteName = language === "en" ? "Client A note" : "客户甲笔记";
    await (await coreOf(window)).evaluate(
      async (core, names) => {
        const documents = await core.listDocuments();
        const own = documents.find((document) => document.name === names.own.replace(/\.txt$/, ""));
        const other = documents.find(
          (document) => document.name === names.other.replace(/\.txt$/, ""),
        );
        if (!own || !other) throw new Error("The leases weren't added.");
        const first = await core.createLibraryGroup({ name: names.folder, description: "" });
        const second = await core.createLibraryGroup({ name: names.otherFolder, description: "" });
        await core.assignDocumentGroup(own.id, first.id);
        await core.assignDocumentGroup(other.id, second.id);
      },
      { own: ownName, other: otherName, folder: folderName, otherFolder },
    );
    await newMind(window, { title: true });
    await nameMind(window, noteName);
    const mindId = await (await coreOf(window)).evaluate(
      async (core, names) => {
        const mind = (await core.listMinds()).find((each) => each.title === names.title);
        if (!mind) throw new Error("The Note wasn't made.");
        const folder = (await core.getLibrary()).groups.find((each) => each.name === names.folder);
        return { id: mind.id, folderId: folder?.id ?? null };
      },
      { title: noteName, folder: folderName },
    );
    await (await coreOf(window)).evaluate(async (core, moved) => {
      if (!moved.folderId) throw new Error("The Folder wasn't found.");
      await core.moveToFolder({ mindIds: [moved.id], folderId: moved.folderId });
    }, mindId);

    const folder = sidebarFolder(window, folderName);
    await motionSettled(window);
    if (SCREENSHOTS)
      await window.screenshot({
        path: join(SCREENSHOTS, `matter-wall-before-${language}-900.png`),
      });
    await folder.getByTestId("folder-row").hover();
    await folder.getByTestId("folder-menu").click();
    const toggle = folder.getByTestId("folder.keepInside");
    await expect(toggle).toHaveAttribute(
      "title",
      language === "en"
        ? "Its notes use only its Documents, and other notes don’t search them"
        : "其中的笔记只使用本文件夹的文档，其他笔记也不会搜索这些文档",
    );
    await expect(toggle).toHaveAttribute("role", "menuitemcheckbox");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(folder.getByTestId("folder-wall")).toBeVisible();
    await expect(window.getByTestId("undo-message")).toHaveText(
      language === "en"
        ? "“Client A” now keeps its work inside it"
        : "已开启“客户甲”只在本文件夹内工作",
    );
    // The lock says what the menu says, and the switch's own line is its tooltip.
    await expect(folder.getByTestId("folder-wall")).toHaveAttribute(
      "title",
      language === "en" ? "This Folder keeps its work inside it" : "只在本文件夹内工作",
    );
    const chip = window.getByTestId("composer-scope").getByTestId("scope-chip");
    await expect(chip).toHaveAttribute("data-walled", "true");
    await expect(chip).toContainText(folderName);
    await expect(chip.getByTestId("scope-chip-remove")).toHaveCount(0);
    await expect(window.getByTestId("composer-scope-all")).toHaveCount(0);
    await motionSettled(window);

    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 800);
      await expect(chip).toBeVisible();
      await undoStaysWithItsWord(window);
      if (SCREENSHOTS)
        await window.screenshot({
          path: join(SCREENSHOTS, `matter-wall-${language}-${width}.png`),
        });
    }

    await window.keyboard.press("Escape");
    await folder.getByTestId("folder-row").click({ modifiers: ["ControlOrMeta"] });
    await folder.getByTestId("folder-row").focus();
    expect(
      await paletteOffers(
        window,
        "folder.keepInside",
        language === "en" ? "Keep this Folder" : "只在本文件夹",
      ),
    ).toBe(1);
    await folder.getByTestId("folder-row").hover();
    await folder.getByTestId("folder-menu").click();
    await expect(folder.getByTestId("folder.keepInside")).toHaveAttribute("aria-checked", "true");
    await folder.getByTestId("folder.keepInside").click();
    await expect(folder.getByTestId("folder-wall")).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(folder.getByTestId("folder-wall")).toBeVisible();
    await app.close();
  });
}

test("a walled Conversation with no Note open keeps its composer behind the wall", async () => {
  await writeFile(join(sources, "Client A lease.txt"), "Termination notice: 90 days.\n");
  await writeFile(join(sources, "Other lease.txt"), "Termination notice: 60 days.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1200, 800);
  await addDocuments(window, [
    join(sources, "Client A lease.txt"),
    join(sources, "Other lease.txt"),
  ]);
  await (await coreOf(window)).evaluate(async (core) => {
    const documents = await core.listDocuments();
    const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
    const own = documents.find((document) => document.name === "Client A lease");
    if (own) await core.assignDocumentGroup(own.id, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
  });
  await newMind(window, { title: true });
  await nameMind(window, "Client A note");
  await (await coreOf(window)).evaluate(async (core) => {
    const mind = (await core.listMinds()).find((each) => each.title === "Client A note");
    const folder = (await core.getLibrary()).groups.find((each) => each.name === "Client A");
    if (mind && folder) await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });
  });
  await motionSettled(window);
  await askInAssistant(window, "What is the notice?");
  // The Note closes; the Conversation, filed in Client A, stays open in the assistant.
  await window.getByTestId("mind-editor").first().click();
  await window.keyboard.press("ControlOrMeta+w");
  await expect(window.getByTestId("mind-editor")).toHaveCount(0);
  const chip = window.getByTestId("composer-scope").getByTestId("scope-chip");
  await expect(chip).toHaveAttribute("data-walled", "true");
  await expect(chip).toContainText("Client A");
  await expect(window.getByTestId("composer-scope-all")).toHaveCount(0);

  // An outside Note opened on the same Conversation is outside every wall: the open Note decides.
  await newMind(window, { title: true });
  await nameMind(window, "Outside note");
  await expect(window.getByTestId("composer-scope-all")).toHaveText(
    "All Documents · 1 Folder left out",
  );
  await app.close();
});
