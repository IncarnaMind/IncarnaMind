import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  askInAssistant,
  assistantAnswers,
  confirmLink,
  createDataFolder,
  dismissChatSetup,
  useLocalChatModel as enableLocalModel,
  expectReadyDocuments,
  gettingStarted,
  interceptOpenDialog,
  launchApp,
  nameMind,
  newMind,
  openPageMenu,
  paletteFound,
  pointAndClick,
  previewLink,
  removeDataFolder,
  setLanguage,
  setSidebarWidth,
  setWindowSize,
  slideSelect,
  welcomeStep as step,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function markSteps(window: Page, done: Record<string, boolean>): Promise<void> {
  await window.evaluate(async (patch) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { device } = await bridge.getSettings();
    await bridge.updateSettings({
      device: { gettingStarted: { ...device.gettingStarted, ...patch } },
    });
  }, done);
}

const NONE = {
  citationChecked: false,
  mistakeSeen: false,
  askedOwn: false,
  askedReady: false,
  indexed: false,
};

const STATES = [
  { name: "Welcome", done: NONE, steps: ["open", "later", "later"] },
  {
    name: "first step done",
    done: { ...NONE, indexed: true },
    steps: ["done", "open", "later"],
  },
  {
    name: "second step done",
    done: { ...NONE, indexed: true, askedReady: true },
    steps: ["done", "done", "open"],
  },
  {
    name: "all done, no model",
    done: { ...NONE, indexed: true, askedReady: true, citationChecked: true },
    steps: ["done", "done", "done"],
  },
];

async function measure(window: Page) {
  const card = await window.getByTestId("first-open-steps").boundingBox();
  const title = await window.getByTestId("mind-editor").locator("h1").boundingBox();
  if (!card || !title) throw new Error("The first screen isn't laid out.");
  return { card: Math.round(card.height), title: Math.round(title.y) };
}

async function showState(window: Page, { done, steps }: (typeof STATES)[number]): Promise<void> {
  await markSteps(window, done);
  for (const [index, state] of steps.entries()) {
    await expect(window.getByTestId("first-open-step").nth(index)).toHaveAttribute(
      "data-state",
      state,
    );
  }
  if (steps.every((state) => state === "done")) {
    await expect(window.getByTestId("first-open-choose-model")).toBeVisible();
  }
}

async function expectOneHeight(window: Page, where: string) {
  const first = STATES[0];
  if (!first) throw new Error("No states.");
  await showState(window, first);
  const reference = await measure(window);
  for (const state of STATES.slice(1)) {
    await showState(window, state);
    expect(await measure(window), `${where}, ${state.name}`).toEqual(reference);
  }
  return reference;
}

const HARBOURS = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const OWN_QUESTION = "When do harbours publish the times of high water?";

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1600]) {
    test(`a fresh profile adds its own file, asks and checks a Citation in the card's order, at ${width} px in ${language} (#1944)`, async () => {
      const sources = await createDataFolder();
      const harbours = join(sources, "Harbours.pdf");
      await writeFile(harbours, HARBOURS);
      const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
      try {
        await setWindowSize(app, window, width, 900);
        await setLanguage(window, language);
        await enableLocalModel(window);
        const card = window.getByTestId("first-open-steps");
        const sidebar = window.getByTestId("sidebar");
        const height = async () => Math.round((await card.boundingBox())?.height ?? 0);
        const expectOne = (heights: readonly number[], where: string) => {
          for (const each of heights) {
            expect(Math.abs(each - (heights[0] ?? 0)), where).toBeLessThanOrEqual(1);
          }
        };

        // 1 Add your files, from the card's title with the keyboard.
        await expect(step(window, "files")).toHaveAttribute("data-state", "open");
        await expect(step(window, "question")).toHaveAttribute("data-state", "later");
        await expect(step(window, "citation")).toHaveAttribute("data-state", "later");
        const before = [await height()];
        await interceptOpenDialog(app, harbours);
        const addTitle = step(window, "files").getByTestId("first-open-step-do");
        await addTitle.focus();
        await window.keyboard.press("Enter");
        await expect(step(window, "files")).toHaveAttribute("data-state", "done", {
          timeout: 30_000,
        });
        await expect(step(window, "question")).toHaveAttribute("data-state", "open");
        before.push(await height());
        expectOne(before, `${language} ${width} px, up to step 2`);

        // The example folds to one row, and Undo takes that back.
        await expect(window.getByTestId("example-open")).toBeVisible();
        await expect(sidebar.getByTestId("document-list-item")).toHaveCount(1);
        await window.keyboard.press("ControlOrMeta+z");
        await expect(window.getByTestId("example-open")).toHaveCount(0);
        await expect(sidebar.getByTestId("document-list-item")).toHaveCount(0);

        // Back in, then 2 Ask, from the card's title with the keyboard.
        await window.getByTestId("add-documents-input").setInputFiles([harbours]);
        await expect(step(window, "question")).toHaveAttribute("data-state", "open");
        await expect(window.getByTestId("example-open")).toBeVisible();
        const askTitle = step(window, "question").getByTestId("first-open-step-do");
        await askTitle.focus();
        await window.keyboard.press("Enter");
        await expect(window.getByTestId("composer-input")).toBeFocused();
        await window.keyboard.type(OWN_QUESTION);
        await window.keyboard.press("Enter");
        await expect(step(window, "question")).toHaveAttribute("data-state", "done", {
          timeout: 30_000,
        });
        await expect(step(window, "citation")).toHaveAttribute("data-state", "open");
        // The assistant opens beside the page: at its narrower width the card sets its height again (#1277).
        const beside = [await height()];
        const answer = assistantAnswers(window).last();
        await expect(answer).toHaveAttribute("data-status", "done");
        const citation = answer.getByTestId("citation").first();
        await expect(citation).toHaveAttribute("data-check", "found", { timeout: 30_000 });
        await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
          "aria-label",
          /Harbours/,
        );

        // 3 Check a Citation, from the card's title with the keyboard.
        const checkTitle = step(window, "citation").getByTestId("first-open-step-do");
        await checkTitle.focus();
        await window.keyboard.press("Enter");
        const chip = answer.getByTestId("citation-chip").first();
        await expect(chip).toBeFocused();
        await window.keyboard.press("Enter");
        await expect(window.getByTestId("citation-card")).toBeVisible();
        await expect(step(window, "citation")).toHaveAttribute("data-state", "done");
        // Opening the cited page narrows the page, which sets the card's height again (#1277).
        if ((await window.getByTestId("viewer-title").count()) === 0) {
          beside.push(await height());
        }
        expectOne(beside, `${language} ${width} px, step 3`);
        await expect(card).toContainText(language === "en" ? "You’re set up." : "准备好了。");
        await window.keyboard.press("Escape");

        // ⌘K reaches what the steps teach.
        await window.keyboard.press("ControlOrMeta+k");
        await expect(window.getByTestId("palette-search")).toBeFocused();
        await window.keyboard.type("Add Documents");
        await expect(paletteFound(window).first()).toHaveAttribute(
          "data-key",
          "command:documents.add",
        );
        await expect(paletteFound(window).first()).toContainText(
          language === "en" ? "Add Documents" : "添加文档",
        );
        await window.keyboard.press("Escape");
        await window.keyboard.press("ControlOrMeta+k");
        await window.keyboard.type("Ask a Question");
        await expect(paletteFound(window).first()).toHaveAttribute(
          "data-key",
          "command:composer.focus",
        );
        await expect(paletteFound(window).first()).toContainText(
          language === "en" ? "Ask a Question" : "提问",
        );
        await window.keyboard.press("Escape");
      } finally {
        await app.close();
        await removeDataFolder(sources);
      }
    });
  }
}

test("the Welcome card keeps one height through every step, so the page's text never moves (#1195)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await expect(window.getByTestId("first-open-steps")).toBeVisible();

  const heights = new Map<string, Awaited<ReturnType<typeof measure>>>();
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const width of [900, 1100, 1440, 1600]) {
      await setWindowSize(app, window, width, 900);
      heights.set(
        `${language} ${width}`,
        await expectOneHeight(window, `${language} at ${width} px`),
      );
    }
  }

  await enableLocalModel(window);
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const width of [900, 1100, 1440, 1600]) {
      await setWindowSize(app, window, width, 900);
      await expect(window.getByTestId("first-open-next").first()).toBeVisible();
      expect(await measure(window), `${language} at ${width} px, all done, set up`).toEqual(
        heights.get(`${language} ${width}`),
      );
    }
  }
  await app.close();
});

test("a file that couldn't be read says so in step 1 without changing the card's height or moving its buttons, at every width in English and Chinese (#1457)", async () => {
  const sources = await createDataFolder();
  const damaged = join(sources, "damaged.pdf");
  await writeFile(damaged, "%PDF-1.4 this is not a PDF");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    const files = window.locator('[data-testid="first-open-step"][data-step="files"]');
    await expect(files).toHaveAttribute("data-state", "open");
    const add = files.getByTestId("first-open-add-files");
    const places = async () => ({
      ...(await measure(window)),
      buttons: Math.round((await add.boundingBox())?.y ?? -1),
    });
    const views = (["en", "zh-CN"] as const).flatMap((language) =>
      [900, 1100, 1440].map((width) => ({ language, width, name: `${language} ${width}` })),
    );
    const before: Record<string, Awaited<ReturnType<typeof places>>> = {};
    for (const { language, width, name } of views) {
      await setLanguage(window, language);
      await setWindowSize(app, window, width, 900);
      before[name] = await places();
    }

    await interceptOpenDialog(app, damaged);
    await pointAndClick(window, add);
    const unread = files.getByTestId("first-open-unread");
    await expect(unread).toBeVisible({ timeout: 30_000 });
    for (const { language, width, name } of views) {
      await setLanguage(window, language);
      await setWindowSize(app, window, width, 900);
      await expect(unread).toBeVisible();
      expect(await places(), `${name}, the line shown`).toEqual(before[name]);
    }
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});

test("the card keeps one height through every step with the sidebar dragged to its widest, in English and Chinese (#1195)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 900, 900);
  const card = window.getByTestId("first-open-steps");
  await expect(card).toBeVisible();
  const widthOf = async () => {
    const box = await card.boundingBox();
    if (!box) throw new Error("The card isn't laid out.");
    return box.width;
  };
  const usual = await widthOf();

  await setSidebarWidth(window, 480);
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    expect(await widthOf()).toBeLessThan(usual);
    await expectOneHeight(window, `${language} with the sidebar at 480 px`);
  }
  await app.close();
});

test("asking the ready Question opens the assistant, and the page stays still as the steps tick before and after, at the narrowest window and at 1,100 px (#1195)", async () => {
  for (const width of [900, 1100]) {
    const folder = await createDataFolder();
    const { app, window } = await launchApp(folder, { examples: true, fakeChat: true });
    await setWindowSize(app, window, width, 900);
    await expect(window.getByTestId("first-open-steps")).toBeVisible();
    const before = await measure(window);
    // The ready Question waits for the example's Documents to be read.
    await expect(
      window
        .getByTestId("mind-pane")
        .getByTestId("mind-editor")
        .getByTestId("citation-chip")
        .nth(1),
    ).toHaveAttribute("data-check", "found", { timeout: 30_000 });
    await markSteps(window, { indexed: true });
    await expect(window.getByTestId("first-open-ready")).toBeVisible();
    expect(await measure(window), `${width} px, step 1 done`).toEqual(before);

    await pointAndClick(window, window.getByTestId("first-open-ready"));
    await expect(window.getByTestId("assistant")).toBeVisible();
    await expect(window.getByTestId("first-open-example")).toBeVisible();
    // The page is narrower now, so the card is as tall as its tallest state at this width.
    const beside = await measure(window);

    await markSteps(window, { citationChecked: true });
    await expect(window.getByTestId("first-open-choose-model")).toBeVisible();
    expect(await measure(window), `${width} px, assistant open, all done`).toEqual(beside);
    await app.close();
    await removeDataFolder(folder);
  }
});

test("the Welcome card has no subtitle and no footer; its Examples row's ⋯ offers the other examples and removing them, which Undo takes back (#1195)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);
  const card = window.getByTestId("first-open-steps");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("example-more")).toHaveCount(0);
  await expect(card.getByTestId("first-open-remove")).toHaveCount(0);

  const row = window.getByTestId("sidebar").getByTestId("not-in-a-folder");
  await row.hover();
  await pointAndClick(window, row.getByTestId("examples-menu"));
  const menu = row.getByTestId("examples-actions");
  await expect(menu).toBeVisible();
  const groups = menu.getByTestId("example-more-link");
  await expect(groups).toHaveCount(3);
  await pointAndClick(window, groups.first());
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);

  await row.hover();
  await pointAndClick(window, row.getByTestId("examples-menu"));
  await pointAndClick(window, menu.getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "Removed the examples",
  );
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await app.close();
});

const WORDS = {
  en: { more: "Try an example closer to your work:", remove: "Remove the examples" },
  "zh-CN": { more: "换一个和你工作更相关的示例：", remove: "移除示例" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`an example Mind's page ⋯ offers the other examples and removing them, after an own Mind has been made, with Undo (${language}) (#1195)`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    await setWindowSize(app, window, 900, 900);
    await setLanguage(window, language);
    await dismissChatSetup(window);
    const examples = window
      .getByTestId("mind-list-item")
      .filter({ has: window.getByTestId("example-chip") });

    await newMind(window);
    const own = await openPageMenu(window);
    await expect(own.getByTestId("examples-remove")).toHaveCount(0);
    await expect(own.getByTestId("example-more-link")).toHaveCount(0);
    await window.keyboard.press("Escape");

    await pointAndClick(window, examples);
    const menu = await openPageMenu(window);
    await expect(menu.getByTestId("example-more-link")).toHaveCount(3);
    await expect(menu).toContainText(WORDS[language].more);
    const remove = menu.getByTestId("examples-remove");
    await expect(remove).toHaveText(WORDS[language].remove);
    const rule = remove.locator("xpath=preceding-sibling::*[1]");
    await expect(rule).toBeEmpty();
    await expect(rule.locator("xpath=preceding-sibling::*[1]")).toHaveAttribute(
      "data-testid",
      "example-more-link",
    );
    const [groupsAt, removeAt, deleteAt] = await Promise.all([
      menu.getByTestId("example-more-link").last().boundingBox(),
      remove.boundingBox(),
      menu.getByTestId("mind.delete").boundingBox(),
    ]);
    expect(groupsAt && removeAt && deleteAt && groupsAt.y < removeAt.y).toBe(true);
    expect(removeAt && deleteAt && removeAt.y < deleteAt.y).toBe(true);

    await pointAndClick(window, menu.getByTestId("example-more-link").first());
    await expect(examples).toHaveCount(2);
    const again = await openPageMenu(window);
    await pointAndClick(window, again.getByTestId("examples-remove"));
    await expect(examples).toHaveCount(0);
    await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
      language === "en" ? "Removed the examples" : "已移除示例",
    );
    await window.keyboard.press("ControlOrMeta+z");
    await expect(examples).toHaveCount(2);
    await app.close();
  });
}

/** The system's file picker, closed without a file; `pickersShown` counts how often it was opened. */
async function cancelFilePicker(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const shown = { count: 0 };
    (globalThis as { pickersShown?: { count: number } }).pickersShown = shown;
    dialog.showOpenDialog = (async () => {
      shown.count += 1;
      return { canceled: true, filePaths: [] };
    }) as unknown as typeof dialog.showOpenDialog;
  });
}

const pickersShown = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { pickersShown?: { count: number } }).pickersShown?.count ?? 0);

const TITLES = {
  en: {
    citation: "Check a Citation",
    question: "Ask",
    files: "Add your files",
  },
  "zh-CN": { citation: "核对一条引用", question: "提问", files: "添加你的文件" },
} as const;

test("Ask a question and Add your files do their step on a click, Enter or Space at any time, and doing it alone ticks nothing (#1489)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 900, 900);
  await cancelFilePicker(app);
  await expect(window.getByTestId("first-open-steps")).toBeVisible();

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    const question = step(window, "question");
    const files = step(window, "files");
    await expect(question).toHaveAttribute("data-state", "later");
    await expect(files).toHaveAttribute("data-state", "open");
    const ask = question.getByTestId("first-open-step-do");
    const add = files.getByTestId("first-open-step-do");
    await expect(ask).toHaveAccessibleName(TITLES[language].question);
    await expect(add).toHaveAccessibleName(TITLES[language].files);

    const shown = await pickersShown(app);
    await pointAndClick(window, add);
    await expect.poll(() => pickersShown(app)).toBe(shown + 1);
    await add.focus();
    await window.keyboard.press("Enter");
    await expect.poll(() => pickersShown(app)).toBe(shown + 2);
    await window.keyboard.press("Space");
    await expect.poll(() => pickersShown(app)).toBe(shown + 3);

    await ask.focus();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("assistant")).toBeVisible();
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await ask.focus();
    await expect(window.getByTestId("composer-input")).not.toBeFocused();
    await window.keyboard.press("Space");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await pointAndClick(window, ask);
    await expect(window.getByTestId("composer-input")).toBeFocused();

    await expect(window.locator('[data-testid="first-open-step"][data-state="done"]')).toHaveCount(
      0,
    );
    expect(await gettingStarted(window)).toMatchObject({
      mistakeSeen: false,
      askedOwn: false,
      askedReady: false,
      indexed: false,
    });
  }
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`Add files… and Link a folder… are under step 1 from the start, and what is added ticks step 1 alone, in ${language} (#1574)`, async () => {
    const sources = await createDataFolder();
    const notes = join(sources, "Harbour notes.md");
    await writeFile(notes, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 900);
      await setLanguage(window, language);
      const card = window.getByTestId("first-open-steps");
      const files = step(window, "files");
      await expect(files).toHaveAttribute("data-state", "open");
      await expect(step(window, "question")).toHaveAttribute("data-state", "later");

      const add = files.getByTestId("first-open-add-files");
      const link = files.getByTestId("first-open-link-folder");
      await expect(add).toHaveText(language === "en" ? "Add files…" : "添加文件…");
      await expect(link).toHaveText(language === "en" ? "Link a folder…" : "添加同步文件夹…");
      await expect(files).toContainText(
        language === "en"
          ? "Your files stay where they are. IncarnaMind reads them on this computer."
          : "你的文件留在原处，IncarnaMind 在这台电脑上读取它们。",
      );
      const [cardBox, title, addBox, linkBox] = await Promise.all([
        card.boundingBox(),
        files.getByTestId("first-open-step-do").boundingBox(),
        add.boundingBox(),
        link.boundingBox(),
      ]);
      if (!cardBox || !title || !addBox || !linkBox) throw new Error("Step 1 isn't laid out.");
      expect(addBox.y, "the buttons sit under the title").toBeGreaterThan(title.y + title.height);
      expect(linkBox.x + linkBox.width, "and inside the card").toBeLessThanOrEqual(
        cardBox.x + cardBox.width,
      );
      expect(linkBox.y + linkBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);

      const dialog = await previewLink(app, window, sources, link);
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(await gettingStarted(window)).toMatchObject({ indexed: false });

      await interceptOpenDialog(app, notes);
      await pointAndClick(window, add);
      await expect(files).toHaveAttribute("data-state", "done", { timeout: 20_000 });
      await expect(step(window, "question")).toHaveAttribute("data-state", "open");
      await expect(step(window, "citation")).toHaveAttribute("data-state", "later");
      expect(await gettingStarted(window)).toMatchObject({
        citationChecked: false,
        askedOwn: false,
        askedReady: false,
        indexed: true,
      });
    } finally {
      await app.close();
      await removeDataFolder(sources);
    }
  });
}

test("a folder linked on the first step ticks step 1 alone (#1574)", async () => {
  const sources = await createDataFolder();
  await writeFile(
    join(sources, "Harbour notes.md"),
    "# Harbour notes\n\nThe harbour master publishes the tide tables.\n",
  );
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    const files = step(window, "files");
    await expect(files).toHaveAttribute("data-state", "open");
    await confirmLink(
      await previewLink(app, window, sources, files.getByTestId("first-open-link-folder")),
    );
    await expect(files).toHaveAttribute("data-state", "done", { timeout: 20_000 });
    await expect(step(window, "question")).toHaveAttribute("data-state", "open");
    await expect(step(window, "citation")).toHaveAttribute("data-state", "later");
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});

test("a file dropped on the window, or added from the + menu or ⌘O, ticks step 1 and leaves the others open (#1574)", async () => {
  const sources = await createDataFolder();
  const dropped = join(sources, "Dropped notes.md");
  const opened = join(sources, "Opened notes.md");
  await writeFile(dropped, "# Dropped notes\n\nThe harbour master publishes the tide tables.\n");
  await writeFile(opened, "# Opened notes\n\nThe pilot station answers on channel 12.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await window.getByTestId("add-documents-input").setInputFiles([dropped]);
    await expect(step(window, "files")).toHaveAttribute("data-state", "done", {
      timeout: 20_000,
    });
    expect(await gettingStarted(window)).toMatchObject({ citationChecked: false, askedOwn: false });
    await expect(step(window, "question")).toHaveAttribute("data-state", "open");
    await expect(step(window, "citation")).toHaveAttribute("data-state", "later");

    await markSteps(window, NONE);
    await expect(step(window, "files")).toHaveAttribute("data-state", "open");
    await interceptOpenDialog(app, opened);
    await window.keyboard.press("ControlOrMeta+o");
    await expect
      .poll(async () => (await gettingStarted(window)).indexed, { timeout: 20_000 })
      .toBe(true);
    await expect(step(window, "question")).toHaveAttribute("data-state", "open");
    await expect(step(window, "citation")).toHaveAttribute("data-state", "later");
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});

const BUTTON_STATES = [
  { name: "start", done: NONE, citation: "later", question: "later", files: "open" },
  {
    name: "first step done",
    done: { ...NONE, indexed: true },
    citation: "later",
    question: "open",
    files: "done",
  },
  {
    name: "second step done",
    done: { ...NONE, indexed: true, askedReady: true },
    citation: "open",
    question: "done",
    files: "done",
  },
  {
    name: "all done",
    done: { ...NONE, indexed: true, askedReady: true, citationChecked: true },
    citation: "done",
    question: "done",
    files: "done",
  },
] as const;

test("a step's title looks like a button in every state, open, later and done: an icon, a name that says the action, a hover state and a focus ring, in English and Chinese (#1489)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await cancelFilePicker(app);
  const look = (button: Locator) =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        ring: style.outlineStyle,
        ringWidth: Number.parseFloat(style.outlineWidth),
      };
    });

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const state of BUTTON_STATES) {
      await markSteps(window, state.done);
      for (const key of ["citation", "question", "files"] as const) {
        const where = `${language}, ${state.name}, ${key} is ${state[key]}`;
        await expect(step(window, key), where).toHaveAttribute("data-state", state[key]);
        const button = step(window, key).getByTestId("first-open-step-do");
        await expect(button, where).toBeVisible();
        await expect(button, where).toHaveAccessibleName(TITLES[language][key]);

        const icon = button.getByTestId("first-open-step-icon");
        await expect(icon, where).toHaveCount(1);
        const [box, iconBox, labelBox] = await Promise.all([
          button.boundingBox(),
          icon.boundingBox(),
          button.locator("span").last().boundingBox(),
        ]);
        if (!box || !iconBox || !labelBox) throw new Error(`${where}: not laid out`);
        expect(iconBox.x, `${where}: the icon follows the title`).toBeGreaterThanOrEqual(
          labelBox.x + labelBox.width - 1,
        );
        expect(iconBox.x + iconBox.width, `${where}: the icon is inside it`).toBeLessThanOrEqual(
          box.x + box.width + 1,
        );

        await window.mouse.move(5, 5);
        const rest = await look(button);
        expect(rest.ring, `${where}: no ring at rest`).toBe("none");
        await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
        await expect
          .poll(async () => (await look(button)).background, { message: `${where}: hover` })
          .not.toBe(rest.background);
        await window.mouse.move(5, 5);

        await window.getByTestId("first-open-hide").focus();
        for (
          let tabs = 0;
          tabs < 10 && !(await button.evaluate((el) => el === document.activeElement));
          tabs++
        ) {
          await window.keyboard.press("Tab");
        }
        await expect(button, `${where}: reached by Tab`).toBeFocused();
        const focused = await look(button);
        expect(focused.ring, `${where}: focus ring`).not.toBe("none");
        expect(focused.ringWidth, `${where}: focus ring`).toBeGreaterThan(0);
      }
    }

    const shown = await pickersShown(app);
    await pointAndClick(window, step(window, "files").getByTestId("first-open-step-do"));
    await expect
      .poll(() => pickersShown(app), { message: `${language}: done, still adds` })
      .toBe(shown + 1);
    await pointAndClick(window, step(window, "question").getByTestId("first-open-step-do"));
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await markSteps(window, NONE);
  }
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`or see it on the example goes to the red ≠ and focuses it without opening its card or ticking, and checking a Citation ticks step 3, in ${language} (#1489)`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 600);
    await setLanguage(window, language);
    await markSteps(window, { ...NONE, indexed: true, askedReady: true });
    const mark = window.getByTestId("mind-pane").getByTestId("claim-mark");
    await expect(mark).toHaveAttribute("data-check", "contradicted");
    const card = window.getByTestId("first-open-steps");
    const citation = step(window, "citation");
    await expect(citation).toHaveAttribute("data-state", "open");
    const link = citation.getByTestId("first-open-example");
    await expect(link).toHaveText(
      language === "en" ? "or see it on the example" : "或在示例里看看",
    );
    const height = async () => Math.round((await card.boundingBox())?.height ?? 0);
    const before = await height();
    const inView = () =>
      mark.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= globalThis.innerHeight;
      });

    await window.getByTestId("mind-pane").evaluate((element) => {
      element.closest(".mind-scroller")?.scrollTo({ top: 0 });
    });
    expect(await inView()).toBe(false);
    await pointAndClick(window, link);
    await expect.poll(inView).toBe(true);
    await expect(mark).toBeFocused();
    expect(await mark.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    // The card opens a moment after a focus; waiting that out is the only way to see it never does.
    await window.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
    await expect(mark).toHaveAttribute("aria-expanded", "false");
    await expect(window.getByTestId("claim-card")).toHaveCount(0);
    await expect(citation).toHaveAttribute("data-state", "open");
    expect(await gettingStarted(window)).toMatchObject({ mistakeSeen: false });
    expect(await height()).toBe(before);

    // The example's red ≠ is a claim the check caught; a Citation checked is what ticks step 3.
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("claim-card")).toBeVisible();
    expect(await gettingStarted(window)).toMatchObject({ mistakeSeen: true });
    await expect(citation).toHaveAttribute("data-state", "open");
    await window.keyboard.press("Escape");

    const chip = window.getByTestId("mind-pane").getByTestId("citation-chip").first();
    await expect(chip).toHaveAttribute("data-check", "found", { timeout: 20_000 });
    await pointAndClick(window, chip);
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await expect(citation).toHaveAttribute("data-state", "done");
    expect(await gettingStarted(window)).toMatchObject({ citationChecked: true });
    await app.close();
  });
}

test("or see it on the example leaves the page where it is when the red ≠ is already in view (#1489)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await markSteps(window, { ...NONE, indexed: true, askedReady: true });
  const mark = window.getByTestId("mind-pane").getByTestId("claim-mark");
  await expect(mark).toHaveAttribute("data-check", "contradicted");
  const scroller = window
    .getByTestId("mind-pane")
    .locator("xpath=ancestor::*[contains(@class,'mind-scroller')]");
  expect(
    await mark.evaluate(
      (element) => element.getBoundingClientRect().bottom <= globalThis.innerHeight,
    ),
  ).toBe(true);
  await pointAndClick(window, step(window, "citation").getByTestId("first-open-example"));
  await expect(mark).toBeFocused();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`Check a Citation goes to the page's first Citation and focuses it without opening its card; Enter opens it and ticks, in ${language} (#1489)`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await markSteps(window, { ...NONE, indexed: true, askedReady: true });
    const citation = step(window, "citation");
    await expect(citation).toHaveAttribute("data-state", "open");
    const chip = window
      .getByTestId("mind-pane")
      .getByTestId("mind-editor")
      .getByTestId("citation-chip")
      .first();
    await expect(chip).toHaveAttribute("data-check", "found", { timeout: 20_000 });

    await pointAndClick(window, citation.getByTestId("first-open-step-do"));
    await expect(chip).toBeFocused();
    expect(await chip.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    // The card opens a moment after a focus; waiting that out is the only way to see it never does.
    await window.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
    await expect(window.getByTestId("citation-card")).toHaveCount(0);
    await expect(citation).toHaveAttribute("data-state", "open");
    expect(await gettingStarted(window)).toMatchObject({ citationChecked: false });

    await window.keyboard.press("Enter");
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await expect(citation).toHaveAttribute("data-state", "done");
    await expect(citation).toContainText(
      language === "en" ? "Checked a Citation" : "已核对一条引用",
    );
    expect(await gettingStarted(window)).toMatchObject({ citationChecked: true });
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Ask ticks when the Answer arrives, never when the Question is only asked or its Answer fails, in ${language} (#1489)`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await enableLocalModel(window);
    await markSteps(window, { indexed: true });
    const question = step(window, "question");
    await expect(question).toHaveAttribute("data-state", "open");

    await pointAndClick(window, question.getByTestId("first-open-step-do"));
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await expect(question).toHaveAttribute("data-state", "open");
    await window.keyboard.type("Send a blank reply");
    await window.keyboard.press("Enter");
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "failed", {
      timeout: 15_000,
    });
    await expect(question).toHaveAttribute("data-state", "open");
    expect(await gettingStarted(window)).toMatchObject({ askedOwn: false, askedReady: false });

    await askInAssistant(window, "When are the tide tables published?");
    await expect(question).toHaveAttribute("data-state", "done");
    await expect(question).toContainText(language === "en" ? "Asked a question" : "已提过问题");
    expect(await gettingStarted(window)).toMatchObject({ askedOwn: true });
    await app.close();
  });
}

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

for (const language of ["en", "zh-CN"] as const) {
  test(`Check a Citation ticks when a Citation's card opens, not when the example's red ≠ does, in ${language} (#1489)`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await markSteps(window, { ...NONE, indexed: true, askedReady: true });
    const mind = window.getByTestId("mind-pane");
    const chip = mind.getByTestId("mind-editor").getByTestId("citation-chip").first();
    await expect(chip).toHaveAttribute("data-check", "found", { timeout: 20_000 });
    const mark = mind.getByTestId("claim-mark");
    await expect(mark).toHaveAttribute("data-check", "contradicted");
    await expect(mark).toHaveAttribute("data-guided");
    await expect(step(window, "citation")).toHaveAttribute("data-state", "open");

    await pointAndClick(window, mark);
    await expect(window.getByTestId("claim-card")).toBeVisible();
    await window.keyboard.press("Escape");
    expect(await gettingStarted(window)).toMatchObject({
      mistakeSeen: true,
      citationChecked: false,
    });
    await expect(step(window, "citation")).toHaveAttribute("data-state", "open");

    await pointAndClick(window, chip);
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await expect(step(window, "citation")).toHaveAttribute("data-state", "done");
    expect(await gettingStarted(window)).toMatchObject({ citationChecked: true });
    await app.close();
  });
}

test("a red ≠ opened in a Mind of the User's own still records it (#1489)", async () => {
  test.setTimeout(150_000);
  const sources = await createDataFolder();
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, {
    examples: true,
    fakeChat: true,
    home: sources,
  });
  await setWindowSize(app, window, 1440, 900);
  await enableLocalModel(window);
  await window.getByTestId("add-documents-input").setInputFiles([join(sources, "Tides.pdf")]);
  await expectReadyDocuments(window, 3);
  await newMind(window);
  await nameMind(window, "Memo");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Harbours publish the times of high water every 6 months.");
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Harbours", { line, words: "months." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const own = window.getByTestId("claim-mark");
  await expect(own).toHaveAttribute("data-check", "contradicted");
  expect(await gettingStarted(window)).toMatchObject({ mistakeSeen: false });
  await pointAndClick(window, own);
  await expect(window.getByTestId("claim-card")).toBeVisible();
  await expect.poll(() => gettingStarted(window)).toMatchObject({ mistakeSeen: true });
  await app.close();
  await removeDataFolder(sources);
});
