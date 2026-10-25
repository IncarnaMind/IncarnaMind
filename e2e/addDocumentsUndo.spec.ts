import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  leaveText,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  undoMenuItem,
} from "./app";

/*
 * Adding Documents is a step of its own on the undo stack (#1390): Undo takes out the Documents
 * this add brought in, and nothing else; Redo brings the same ones back.
 */

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

async function textFiles(...names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const path = join(sources, `${name}.txt`);
      await writeFile(path, `${name} notes.\n`);
      return path;
    }),
  );
}

/** The Library as the core has it: each live Document's name and id. */
const library = async (window: Page) =>
  (await coreOf(window)).evaluate(async (core) =>
    (await core.listDocuments())
      .map((each) => ({ name: each.name, id: each.id }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

/** An older change that stays on the stack by design: a new Folder. */
async function makeFolder(window: Page): Promise<void> {
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-folder").click();
  const field = window.getByTestId("folder-rename-field");
  await field.fill("Finance");
  await field.press("Enter");
  await expect(field).toHaveCount(0);
}

const pick = (window: Page, paths: string[]) =>
  window.getByTestId("add-documents-input").setInputFiles(paths);

/** A drop of files from the disk on the sidebar, as Finder or Explorer makes one. */
async function drop(window: Page, paths: string[]): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.dataset.testid = "drop-source";
    input.hidden = true;
    document.body.append(input);
  });
  await window.getByTestId("drop-source").setInputFiles(paths);
  await window.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="drop-source"]');
    const target = document.querySelector('[data-testid="sidebar"]');
    if (!input?.files || !target) throw new Error("No files or no sidebar to drop on.");
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files)) transfer.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    }
    input.remove();
  });
}

test("adding Documents offers Undo, ⌘Z takes out what was added, the change before it is next, and Redo brings the same Documents back", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await makeFolder(window);

    await pick(window, await textFiles("Tides", "Moons", "Winds"));
    await expect(window.getByTestId("undo-line")).toContainText("Added 3 Documents");
    await expect.poll(async () => (await library(window)).length).toBe(3);
    const added = await library(window);

    await leaveText(window);
    await expect
      .poll(() => undoMenuItem(app))
      .toEqual({ label: "Undo Add Documents", enabled: true });
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => library(window)).toEqual([]);
    await expect(window.getByTestId("document-list-item")).toHaveCount(0);
    await expect.poll(() => undoMenuItem(app)).toEqual({ label: "Undo New Folder", enabled: true });

    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => library(window)).toEqual(added);
    await expect(window.getByTestId("document-list-item")).toHaveCount(3);
    await expect(window.getByTestId("undo-line")).toContainText("Added 3 Documents");
  } finally {
    await app.close();
  }
});

test("a file that was in the Library before the add stays after Undo, and an add of files all in already makes no step", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const [tides, moons] = await textFiles("Tides", "Moons");
    await pick(window, [tides as string]);
    await expect(window.getByTestId("undo-line")).toContainText("Added 1 Document");
    await expect.poll(async () => (await library(window)).length).toBe(1);
    const [first] = await library(window);
    await makeFolder(window);

    // Everything in already: no step, so the Folder's is still the one to undo.
    await pick(window, [tides as string]);
    await expect(window.getByTestId("undo-line")).not.toContainText("Added");
    await leaveText(window);
    await expect.poll(() => undoMenuItem(app)).toEqual({ label: "Undo New Folder", enabled: true });

    await pick(window, [tides as string, moons as string]);
    await expect(window.getByTestId("undo-line")).toContainText("Added 1 Document");
    await expect.poll(async () => (await library(window)).length).toBe(2);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => library(window)).toEqual([first]);
  } finally {
    await app.close();
  }
});

test("dropped files behave the same", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await makeFolder(window);

    await drop(window, await textFiles("Tides", "Moons"));
    await expect(window.getByTestId("undo-line")).toContainText("Added 2 Documents");
    await expect.poll(async () => (await library(window)).length).toBe(2);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => library(window)).toEqual([]);
    await expect.poll(() => undoMenuItem(app)).toEqual({ label: "Undo New Folder", enabled: true });
  } finally {
    await app.close();
  }
});

test("Undo leaves a Document the User deleted or added another way since, and Redo brings back only what Undo took: each step finds its Documents by id", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const [tides, moons] = await textFiles("Tides", "Moons");
    await pick(window, [tides as string, moons as string]);
    await expect.poll(async () => (await library(window)).length).toBe(2);
    const [moonsFirst, tidesFirst] = await library(window);

    // Moons is deleted by the User, then added again another way: not by this step.
    await (await coreOf(window)).evaluate(
      async (core, id) => core.deleteDocument(id),
      moonsFirst?.id ?? "",
    );
    await (await coreOf(window)).evaluate(
      async (core, path) => core.addDocuments([path]),
      moons as string,
    );
    await expect.poll(async () => (await library(window)).length).toBe(2);
    const moonsAgain = (await library(window)).find((each) => each.name === "Moons");
    expect(moonsAgain?.id).not.toBe(moonsFirst?.id);

    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => library(window)).toEqual([moonsAgain]);

    // Redo brings Tides back with its own id, and never the Moons the User had deleted.
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => library(window)).toEqual([moonsAgain, tidesFirst]);
    await expect(window.getByTestId("undo-line")).not.toContainText("Couldn’t do it again");
  } finally {
    await app.close();
  }
});

test("Undo leaves a Document a Linked folder has taken over since: it is no longer only this add's", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const folder = join(await realpath(sources), "Notes");
    await mkdir(folder, { recursive: true });
    const inside = join(folder, "Inside.txt");
    await writeFile(inside, "Inside notes.\n");
    const [outside] = await textFiles("Outside");
    await pick(window, [inside, outside as string]);
    await expect.poll(async () => (await library(window)).length).toBe(2);
    const before = await library(window);

    await (await coreOf(window)).evaluate(async (core, path) => core.addLinkedFolder(path), folder);
    await expect
      .poll(
        async () =>
          (await (await coreOf(window)).evaluate((core) => core.listDocuments())).filter(
            (each) => each.linkedFolderId !== null,
          ).length,
      )
      .toBe(1);

    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await library(window)).map((each) => each.name))
      .toEqual(["Inside"]);
    expect((await library(window))[0]?.id).toBe(before.find((each) => each.name === "Inside")?.id);
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`the line is at most two lines at the narrowest window (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 900, 700);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await pick(window, await textFiles("Tides", "Moons", "Winds"));
      const line = window.getByTestId("undo-line");
      await expect(line).toContainText(language === "en" ? "Added 3 Documents" : "已添加 3 个文档");
      const lines = await line.evaluate((element) => {
        const style = getComputedStyle(element);
        return element.getBoundingClientRect().height / (Number.parseFloat(style.lineHeight) || 20);
      });
      expect(lines).toBeLessThanOrEqual(2.5);
    } finally {
      await app.close();
    }
  });
}
