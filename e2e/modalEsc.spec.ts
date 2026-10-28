import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  frontMind,
  launchApp,
  newMind,
  newMindAndType,
  openExportOptions,
  openSettings,
  pointAndClick,
  removeDataFolder,
  saveProviderUnasked,
  setLanguage,
  showSettingsPage,
} from "./app";

/*
 * A native <dialog> closes itself on Esc and reports it through a `close` event a task later. An
 * ask to show the same dialog again can arrive before that, writing the `open` the store already
 * holds: nothing re-renders, `showModal()` never runs, and the late close then clears the store.
 * Every dialog `useModal` drives must survive that (#2121). Settings held its own copy of the rule
 * first; this holds the shared one to the way a User meets it, in English and Chinese.
 */

type Language = "en" | "zh-CN";
const LANGUAGES: readonly Language[] = ["en", "zh-CN"];

interface DialogCase {
  name: string;
  testId: string;
  /** Opens the dialog as a User does, in `language`. */
  open(window: Page, app: ElectronApplication, language: Language): Promise<void>;
  /** Asks for the same dialog again as a User does, at once. */
  ask(window: Page, app: ElectronApplication, language: Language): Promise<void>;
  /** After an ask shows the dialog again: whatever the ask itself sets. */
  afterAsk?(window: Page): Promise<void>;
  /** Before the case runs: what it needs, such as a Note in front or a Document. */
  prepare?(window: Page, sources: string): Promise<void>;
}

const settingsButton = (language: Language) => (language === "en" ? "Settings" : "设置");

/** A Document's Tags menu names the Tags dialog. */
async function openTagsDialog(window: Page): Promise<void> {
  const row = window.getByTestId("document-list-item").first();
  await row.hover();
  await pointAndClick(window, row.getByTestId("document-tags-menu"));
  await pointAndClick(
    window,
    row.getByTestId("document-tags-popover").getByTestId("open-tags-dialog"),
  );
}

/** The sidebar's + menu, then More, then Add a web page. */
async function openAddWebPage(window: Page): Promise<void> {
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-add-web-page"));
}

/** The front Note's ⋯ menu in the sidebar, then History. */
async function openHistory(window: Page): Promise<void> {
  const row = window.getByTestId("mind-row").first();
  await row.hover();
  await pointAndClick(window, row.getByTestId("mind-menu"));
  await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.history"));
}

/** Help ▸ Send feedback, as the application menu has it. */
async function openFeedback(app: ElectronApplication, language: Language): Promise<void> {
  await app.evaluate(
    ({ Menu }, label) => {
      const help = Menu.getApplicationMenu()?.items.find((each) => each.role === "help");
      help?.submenu?.items.find((each) => each.label.startsWith(label))?.click();
    },
    translate(language, "menu.sendFeedback").replace(/…$/, ""),
  );
}

const CASES: readonly DialogCase[] = [
  {
    name: "Settings",
    testId: "settings",
    open: async (window, _app, language) => {
      await window.getByRole("button", { name: settingsButton(language), exact: true }).click();
      await showSettingsPage(window, "privacy");
    },
    ask: (window, _app, language) =>
      window.getByRole("button", { name: settingsButton(language), exact: true }).click(),
    // The sidebar's Settings always opens General, while the dialog it just showed was on Privacy.
    afterAsk: async (window) => {
      await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "general");
    },
  },
  {
    name: "Manage Tags",
    testId: "tags-dialog",
    prepare: async (window, sources) => {
      const path = join(sources, "Tides.md");
      await writeFile(path, "# Tides\n\nSpring tides come twice a month, at new and full moon.\n");
      await addDocuments(window, [path]);
    },
    open: (window) => openTagsDialog(window),
    ask: (window) => openTagsDialog(window),
  },
  {
    name: "Send feedback",
    testId: "feedback-dialog",
    open: (_window, app, language) => openFeedback(app, language),
    ask: (_window, app, language) => openFeedback(app, language),
  },
  {
    name: "Add a web page",
    testId: "add-web-page-dialog",
    open: (window) => openAddWebPage(window),
    ask: (window) => openAddWebPage(window),
  },
  {
    name: "History",
    testId: "history",
    prepare: (window) => newMind(window),
    open: (window) => openHistory(window),
    ask: (window) => openHistory(window),
  },
  {
    name: "Export options",
    testId: "export-dialog",
    prepare: (window) => newMind(window),
    open: (window) => openExportOptions(window),
    ask: (window) => openExportOptions(window),
  },
  {
    name: "Connect an agent, over Settings",
    testId: "connect-agent-dialog",
    prepare: async (window) => {
      await openSettings(window, "agents");
      const enabled = window.getByTestId("agents-enabled");
      await expect(enabled).toBeVisible();
      if ((await enabled.getAttribute("aria-checked")) !== "true") await enabled.click();
    },
    open: (window) => window.getByTestId("agent-connect").first().click(),
    ask: (window) => window.getByTestId("agent-connect").first().click(),
  },
];

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

for (const each of CASES) {
  test(`${each.name}: Esc, then asking for it again at once, shows it, in English and Chinese`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await each.prepare?.(window, sources);
      for (const language of LANGUAGES) {
        await setLanguage(window, language);
        await each.open(window, app, language);
        const dialog = window.getByTestId(each.testId);
        await expect(dialog, `${language}: ${each.name} opened`).toBeVisible();

        // As the User meets it: Esc, then asking for it again at once.
        await window.keyboard.press("Escape");
        await expect(dialog, `${language}: ${each.name} closes on Esc`).toBeHidden();
        await each.ask(window, app, language);
        await expect(dialog, `${language}: ${each.name} asked for again`).toBeVisible();
        await each.afterAsk?.(window);

        // The close the ask pushed aside still closes it when the User means it.
        await window.keyboard.press("Escape");
        await expect(dialog, `${language}: ${each.name} closes on a later Esc`).toBeHidden();
      }
    } finally {
      await app.close();
    }
  });
}

test("a dialog that prevents Esc stays open, and the store still agrees", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    // A provider chosen before choosing was the consent: the first Question asks.
    await saveProviderUnasked(window, {
      kind: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      modelId: "example-model",
    });
    await newMindAndType(window, "Alpha");
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("A first Question?");
    const consent = window.getByTestId("consent-dialog");
    await window.keyboard.press("Enter");
    await expect(consent).toBeVisible();

    // Esc is the dialog's own to refuse, and the shared rule leaves a refused Esc alone.
    await window.keyboard.press("Escape");
    await expect(consent).toBeVisible();
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            document.querySelector('[data-testid="consent-dialog"]')?.matches(":modal") ?? false,
        ),
      )
      .toBe(true);

    // The store agrees: the answer the dialog holds is still the one it answers.
    await consent.getByTestId("consent-allow").click();
    await expect(consent).toBeHidden();
  } finally {
    await app.close();
  }
});

test("Esc out of a dialog leaves the Note able to type the whole word, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    for (const [language, word] of [
      ["en", "harvest"],
      ["zh-CN", "调查"],
    ] as const) {
      await setLanguage(window, language);
      await newMind(window);
      await enterContent(window);
      await window.keyboard.type("Alpha");
      await openFeedback(app, language);
      const dialog = window.getByTestId("feedback-dialog");
      await expect(dialog).toBeVisible();

      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      // Straight away, as a person types: the whole word lands where the caret was.
      await window.keyboard.type(word);
      await expect(frontMind(window).getByTestId("mind-editor")).toHaveText(`Alpha${word}`);
    }
  } finally {
    await app.close();
  }
});
