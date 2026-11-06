import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Question asked with no model set waits where it was typed, and the app still does what it
 * can first (#763): the line says it waits for an AI model and offers Choose, the setup card it
 * opens takes the cursor, and a local search shows what the Documents say meanwhile. English and
 * Chinese, at 900 and 1,600 px.
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

const TIDE = "The tide tables are read every spring.";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function shot(window: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}

/** The first own Question with no model set: the setup card comes up and the Question waits. */
async function askWithNoModel(window: Page, question: string, scope?: string) {
  await newMind(window);
  await window.getByTestId("mind-editor").focus();
  await window.keyboard.press("ControlOrMeta+j");
  if (scope !== undefined) {
    await window.keyboard.type(`@${scope}`);
    await expect(window.getByTestId("scope-picker")).toBeVisible();
    await window.keyboard.press("Enter");
  }
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await expect(card).toBeVisible();
  return card;
}

/** Puts a Document in a Folder, walled or not, through the core as the Library does; returns the Folder's id. */
async function groupDocument(
  window: Page,
  document: string,
  name: string,
  keepInside: boolean,
): Promise<string> {
  const groupId = await window.evaluate(
    async (wanted) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const found = (await core.listDocuments()).find((each) => each.name === wanted.document);
      const group = await core.createLibraryGroup({
        name: wanted.name,
        description: "",
        keepInside: wanted.keepInside,
      });
      if (found) await core.assignDocumentGroup(found.id, group.id);
      return group.id;
    },
    { document, name, keepInside },
  );
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const library = await core.getLibrary();
          return library.assignments.filter((each) => each.groupId !== null).length;
        }),
      { timeout: 15_000 },
    )
    .toBe(1);
  await expect(window.getByTestId("folder-row").filter({ hasText: name })).toBeVisible();
  return groupId;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`with no model, the Question waits with Choose and the passages local search found (${language})`, async () => {
    test.setTimeout(120_000);
    const path = join(sources, "Tide.txt");
    await writeFile(path, TIDE);
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      home: sources,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 900, 700);
      await setLanguage(window, language);
      await addDocuments(window, [path]);
      const card = await askWithNoModel(window, "What do the tide tables say?");

      const waiting = window.getByTestId("assistant-waiting-model");
      await expect(waiting).toHaveText(
        language === "en" ? "No AI model chosen yet · Choose…" : "还没有选 AI 模型 · 选择…",
      );
      await expect(window.getByTestId("found-passages")).toContainText(
        language === "en" ? "Matches in your Documents:" : "文档中匹配的内容：",
      );
      const passage = window.getByTestId("found-passage").first();
      await expect(passage.getByTestId("found-passage-document")).toContainText("Tide");
      await expect(passage.getByTestId("found-passage-where")).toHaveText(
        language === "en" ? " · p. 1" : " · 第 1 页",
      );
      await expect(passage.getByTestId("found-passage-text")).toContainText("tide tables");
      await shot(window, `waiting-${language}-900`);

      // Choose brings the setup card's field the cursor, where the User already is.
      await window.getByTestId("mind-editor").click();
      await pointAndClick(window, window.getByTestId("assistant-waiting-choose"));
      await expect(card.getByTestId("setup-key")).toBeFocused();

      // The same words and passages hold in a wide window, and the line stays inside it.
      await setWindowSize(app, window, 1600, 900);
      await expect(waiting).toBeVisible();
      await expect(window.getByTestId("found-passage").first()).toBeVisible();
      const [lineBox, size] = await Promise.all([
        waiting.boundingBox(),
        window.evaluate(() => ({ width: innerWidth })),
      ]);
      expect((lineBox?.x ?? 0) + (lineBox?.width ?? 0)).toBeLessThanOrEqual(size.width);
      await shot(window, `waiting-${language}-1600`);

      // A found passage opens its Document at the Passage, as a Citation does.
      await pointAndClick(window, window.getByTestId("found-passage").first());
      await expect(window.getByTestId("viewer-title")).toContainText("Tide");
    } finally {
      await app.close();
    }
  });
}

test("a Question whose words nothing matches still waits, with the way to choose a model", async () => {
  test.setTimeout(120_000);
  const path = join(sources, "Tide.txt");
  await writeFile(path, TIDE);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    home: sources,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, "en");
    await addDocuments(window, [path]);
    await askWithNoModel(window, "What is the capital of Finland?");
    await expect(window.getByTestId("assistant-waiting-model")).toBeVisible();
    await expect(window.getByTestId("assistant-waiting-choose")).toBeVisible();
    // Nothing matched: no empty list is drawn under the Question.
    await expect(window.getByTestId("found-passages")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a Folder scope narrows the waiting passages to what it holds (#763)", async () => {
  test.setTimeout(120_000);
  const tide = join(sources, "Tide.txt");
  const recipe = join(sources, "Recipe.txt");
  await writeFile(tide, TIDE);
  await writeFile(recipe, "The tide tables recipe says to read them every spring.");
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    home: sources,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, "en");
    await addDocuments(window, [tide, recipe]);
    await groupDocument(window, "Tide", "Work", false);
    await askWithNoModel(window, "What do the tide tables say?", "Work");
    const passages = window.getByTestId("found-passage");
    await expect(passages).toHaveCount(1);
    await expect(passages.first().getByTestId("found-passage-document")).toContainText("Tide");
  } finally {
    await app.close();
  }
});

test("a walled Folder's work stays out of the waiting passages (#763, #1934)", async () => {
  test.setTimeout(120_000);
  const tide = join(sources, "Tide.txt");
  const lease = join(sources, "Lease.txt");
  await writeFile(tide, TIDE);
  await writeFile(lease, "The lease tables are read every spring.");
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    home: sources,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, "en");
    await addDocuments(window, [tide, lease]);
    await groupDocument(window, "Lease", "Client work", true);
    await askWithNoModel(window, "What do the tide tables and the lease say?");
    // The Note is in no Folder, so the lease, kept inside its wall, is not shown.
    const passages = window.getByTestId("found-passage");
    await expect(passages).toHaveCount(1);
    await expect(passages.first().getByTestId("found-passage-document")).toContainText("Tide");
  } finally {
    await app.close();
  }
});

test("a Note inside the wall reads the work kept inside it, and not the outside (#763, #1934)", async () => {
  test.setTimeout(120_000);
  const tide = join(sources, "Tide.txt");
  const lease = join(sources, "Lease.txt");
  await writeFile(tide, TIDE);
  await writeFile(lease, "The lease tables are read every spring.");
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    home: sources,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, "en");
    await addDocuments(window, [tide, lease]);
    const groupId = await groupDocument(window, "Lease", "Client work", true);
    await window.evaluate(async (folderId) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createMind({ title: "Inside work", folderId });
    }, groupId);
    // A Folder made through the core starts folded: unfold it to reach the Note inside.
    const folder = window.getByTestId("library-folder").filter({ hasText: "Client work" });
    await folder.click();
    await expect(folder).toHaveAttribute("data-expanded", "true");
    await window.getByTestId("mind-list-item").filter({ hasText: "Inside work" }).click();
    await expect(window.getByTestId("mind-editor")).toBeVisible();
    await window.getByTestId("mind-editor").focus();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What do the tide tables and the lease say?");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("model-setup")).toBeVisible();
    // The Note is in the walled Folder: only the lease is read, not the tide outside it.
    const passages = window.getByTestId("found-passage");
    await expect(passages).toHaveCount(1);
    await expect(passages.first().getByTestId("found-passage-document")).toContainText("Lease");
  } finally {
    await app.close();
  }
});

const NORTHWIND_LEASE = "Northwind's lease for the Harbour Road flat ends on 30 June 2027.";
const NORTHWIND_QUESTION = "Where does the Northwind lease for the Harbour Road flat say it ends?";

/** The Question typed in the Note that is open, with no model set: the setup card comes up. */
async function askInOpenNote(window: Page, question: string): Promise<void> {
  await window.getByTestId("mind-editor").focus();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("model-setup")).toBeVisible();
}

/** The example's Documents, read, and the User's one added beside them. */
async function addOwnBesideExamples(window: Page, path: string): Promise<void> {
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const { linkedFolderId } = await core.getExamples();
          const read = await core.listDocuments({ linkedFolderId: linkedFolderId ?? "" });
          return read.filter((each) => each.status === "ready").length;
        }),
      { timeout: 60_000 },
    )
    .toBe(2);
  await addDocuments(window, [path]);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`with no model, the passages found from the example's Note name its Documents as examples (${language})`, async () => {
    test.setTimeout(180_000);
    const path = join(sources, "Harbour lease.txt");
    await writeFile(path, NORTHWIND_LEASE);
    const { app, window } = await launchApp(dataDir, {
      examples: true,
      fakeChat: true,
      home: sources,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 900, 700);
      await setLanguage(window, language);
      await expect(window.getByTestId("mind-editor")).toContainText(
        language === "en" ? "Draft: credit committee paper" : "授信委员会报告（草稿）",
      );
      await addOwnBesideExamples(window, path);

      await askInOpenNote(window, NORTHWIND_QUESTION);
      const passages = window.getByTestId("found-passage");
      const mine = passages.filter({ hasText: "Harbour lease" });
      await expect(mine.first()).toBeVisible();
      await expect(mine.getByTestId("found-passage-example")).toHaveCount(0);
      const examples = passages.filter({ hasText: "Northwind Retail" });
      await expect(examples.first()).toBeVisible();
      await expect(examples.first().getByTestId("found-passage-example")).toHaveText(
        language === "en" ? " · Example" : " · 示例",
      );
      await shot(window, `waiting-example-${language}-900`);
    } finally {
      await app.close();
    }
  });

  test(`with no model, the passages found from the User's own Note leave the example's Documents out (${language})`, async () => {
    test.setTimeout(180_000);
    const path = join(sources, "Harbour lease.txt");
    await writeFile(path, NORTHWIND_LEASE);
    const { app, window } = await launchApp(dataDir, {
      examples: true,
      fakeChat: true,
      home: sources,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 900, 700);
      await setLanguage(window, language);
      await addOwnBesideExamples(window, path);
      await newMind(window);

      await askInOpenNote(window, NORTHWIND_QUESTION);
      const passages = window.getByTestId("found-passage");
      await expect(passages.filter({ hasText: "Harbour lease" }).first()).toBeVisible();
      await expect(passages.filter({ hasText: "Northwind Retail" })).toHaveCount(0);
      await expect(window.getByTestId("found-passage-example")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
