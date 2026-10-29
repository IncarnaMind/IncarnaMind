import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addDocuments,
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
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

test("outside scope leaves a wall visible without letting it into the scope", async () => {
  await writeFile(join(sources, "Client A lease.txt"), "Termination notice: 90 days.\n");
  await writeFile(join(sources, "Client B lease.txt"), "Termination notice: 30 days.\n");
  await writeFile(join(sources, "Other lease.txt"), "Termination notice: 60 days.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 800);
  await addDocuments(window, [
    join(sources, "Client A lease.txt"),
    join(sources, "Client B lease.txt"),
    join(sources, "Other lease.txt"),
  ]);
  await (await coreOf(window)).evaluate(async (core) => {
    const documents = await core.listDocuments();
    const first = await core.createLibraryGroup({ name: "Client A", description: "" });
    const second = await core.createLibraryGroup({ name: "Client B", description: "" });
    const other = await core.createLibraryGroup({ name: "Other work", description: "" });
    for (const document of documents) {
      const folder = document.name.startsWith("Client A")
        ? first
        : document.name.startsWith("Client B")
          ? second
          : other;
      await core.assignDocumentGroup(document.id, folder.id);
    }
    for (const folder of [first, second]) {
      await core.updateLibraryGroup(folder.id, {
        name: folder.name,
        description: folder.description,
        keepInside: true,
      });
    }
  });
  await newMind(window, { title: true });
  await nameMind(window, "Outside note");
  const all = window.getByTestId("composer-scope-all");
  await expect(all).toHaveText("All Documents · 2 Folders left out");
  await all.click();
  await motionSettled(window);
  const locked = window.getByTestId("scope-choice").filter({ hasText: "Client A" }).first();
  await expect(locked).toHaveAttribute("data-walled", "true");
  await expect(locked.locator("[aria-disabled='true']")).toHaveCount(1);
  await locked.scrollIntoViewIfNeeded();
  await window.getByTestId("scope-open-note").click();
  await expect(window.getByTestId("scope-picker")).toHaveCount(0);
  await expect(window.getByTestId("composer-scope").getByTestId("scope-chip")).toHaveAttribute(
    "data-walled",
    "true",
  );
  await app.close();
});

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
    await expect(toggle).toHaveAttribute("role", "menuitemcheckbox");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(folder.getByTestId("folder-wall")).toBeVisible();
    const chip = window.getByTestId("composer-scope").getByTestId("scope-chip");
    await expect(chip).toHaveAttribute("data-walled", "true");
    await expect(chip).toContainText(folderName);
    await expect(chip.getByTestId("scope-chip-remove")).toHaveCount(0);
    await expect(window.getByTestId("composer-scope-all")).toHaveCount(0);
    await motionSettled(window);

    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 800);
      await expect(chip).toBeVisible();
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
