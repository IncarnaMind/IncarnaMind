import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { EXAMPLE_SETS } from "../src/core/exampleSets";
import {
  acceptPlainTextKeys,
  askFirstQuestion,
  createDataFolder,
  exampleRow,
  frontMindName,
  launchApp,
  openSettings,
  removeDataFolder,
  setWindowSize,
  startFakePostHog,
} from "./app";

/*
 * The first run's setup (#3296): a fresh profile opens on four short steps before the example
 * (what the User works on, their AI, sorting, meeting transcription), every one skippable, and
 * Settings › AI with nothing set leads to it. Every launch uses the scripted chat model, so no key
 * reaches a service and no Ollama is asked. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const OPENROUTER_KEY = `sk-or-v1-${"0f9a".repeat(16)}`;

const bridge = (window: Page) => ({
  settings: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
    ),
  library: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary(),
    ),
  setLanguage: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  setAppearance: (appearance: "light" | "dark") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          device: { appearance: value },
        }),
      appearance,
    ),
});

let dataDir: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
});

async function launch(options: Parameters<typeof launchApp>[1] = {}, width = 1440) {
  const launched = await launchApp(dataDir, { fakeChat: true, firstRunSetup: true, ...options });
  app = launched.app;
  await setWindowSize(launched.app, launched.window, width, 900);
  return launched.window;
}

const setupOf = (window: Page) => window.getByTestId("first-run-setup");
const panelOf = (window: Page) => setupOf(window).getByTestId("setup-panel");

/** Waits for the step to show, and returns its panel. */
async function atStep(window: Page, step: string): Promise<Locator> {
  const panel = panelOf(window);
  await expect(panel).toHaveAttribute("data-step", step);
  return panel;
}

/** The setup's skip on each step from here to the end. */
async function skipTheRest(window: Page) {
  for (const step of ["ai", "sorting", "meetings"]) {
    const panel = await atStep(window, step);
    await panel.getByTestId("setup-skip").click();
  }
  await expect(setupOf(window)).toHaveCount(0);
}

// protects=a fresh profile opens on the setup's first step, its order kept with Something else last and standing alone; two picks lead to the first pick's example with both listed, the card in that work's words, and the picks sent once on Send and continue; fails_when=the example opens first, Something else can be picked with another, the wrong example leads, a pick is lost, or nothing reaches PostHog; no_claim=PostHog itself.
test("a fresh profile opens on the setup: two picks, sent once, lead to their examples", async () => {
  test.setTimeout(120_000);
  const posthog = await startFakePostHog();
  try {
    const window = await launch({ usageData: { host: posthog.host } });
    await expect(setupOf(window)).toBeVisible();
    await expect(window.getByTestId("plus-menu")).toHaveCount(0);
    const panel = await atStep(window, "work");
    await expect(panel.getByTestId("setup-progress-step")).toHaveText([
      "Your work",
      "Your AI",
      "Sorting",
      "Meetings",
    ]);
    const choices = panel.getByTestId("setup-work");
    await expect(choices).toHaveCount(6);
    await expect(choices.last()).toHaveAttribute("data-value", "other");
    // The focus is on the first choice, and nothing picked offers Skip.
    await expect(choices.first().locator("input")).toBeFocused();
    await expect(panel.getByTestId("setup-skip")).toBeVisible();
    await expect(panel.getByTestId("setup-next")).toBeDisabled();
    await shot(window, "setup-work-en-1440");

    const pick = (value: string) =>
      panel.locator(`[data-testid="setup-work"][data-value="${value}"] input`);
    // Something else stands alone, either way round.
    await pick("legal").check();
    await pick("other").check();
    await expect(pick("legal")).not.toBeChecked();
    await pick("legal").check();
    await expect(pick("other")).not.toBeChecked();
    await pick("research").check();
    await expect(panel.getByTestId("setup-work-sent")).toHaveText(
      "Sent with no name and no files, to help us decide what to build.",
    );
    await expect(panel.getByTestId("setup-skip")).toHaveCount(0);
    await expect(panel.getByTestId("setup-work-dont-send")).toHaveText("Continue without sending");
    await expect(panel.getByTestId("setup-next")).toHaveText("Send and continue");
    await shot(window, "setup-work-picked-en-1440");
    await panel.getByTestId("setup-next").click();

    // Sent once by itself, holding only which kinds were picked; usage data stays off.
    await expect
      .poll(() => posthog.events().filter((each) => each.event === "work_picked"), {
        timeout: 15_000,
      })
      .toHaveLength(1);
    const [sent] = posthog.events().filter((each) => each.event === "work_picked");
    expect(sent?.properties).toMatchObject({
      finance: false,
      legal: true,
      research: true,
      reports: false,
      meetings: false,
      other: false,
    });
    const privacy = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getPrivacySettings(),
    );
    expect(privacy.usageData.enabled).toBe(false);

    await skipTheRest(window);
    // The first pick's example opens with Get started in that work's words; both are listed.
    await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS.contracts.en.title);
    await expect(exampleRow(window)).toHaveText([
      EXAMPLE_SETS.contracts.en.title,
      EXAMPLE_SETS.papers.en.title,
    ]);
    const card = window.getByTestId("first-open-steps");
    await expect(card.getByTestId("first-open-step")).toHaveText([
      /Add your files/,
      /Ask what they say/,
      /Check a quote against the record/,
    ]);
    expect((await bridge(window).settings()).device).toMatchObject({
      work: ["legal", "research"],
      setupFinished: true,
    });
    await shot(window, "after-setup-legal-en-1440");
    expect(posthog.events().map((each) => each.event)).toEqual(["work_picked"]);
  } finally {
    await posthog.close();
  }
});

// protects=Skip on every step reaches the credit paper with nothing set up, a setup quit halfway shows again, a finished one never does, and a skipped model is asked for at the first own Question as today; fails_when=a step sets something up when skipped, the example is made before the end, the setup shows again once ended, or the composer doesn't ask for a model; no_claim=the composer's setup card itself (modelSetup.spec.ts).
test("Skip on every step: nothing set, the setup gone for good, and the first Question still asks for a model", async () => {
  test.setTimeout(120_000);
  let window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await atStep(window, "ai");
  // Quit halfway: nothing was made, and the next launch opens on the setup again.
  expect(
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds(),
    ),
  ).toEqual([]);
  await app?.close();
  window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await skipTheRest(window);

  await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS.credit.en.title);
  await expect(window.getByTestId("first-open-steps").getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask/,
    /Check a Citation/,
  ]);
  const { device, user } = await bridge(window).settings();
  expect(device).toMatchObject({ work: [], setupFinished: true, transcriptionRoute: null });
  expect(user.chatModel).toBeNull();
  expect((await bridge(window).library()).settings.classifier).toEqual({ kind: "automatic" });

  const card = await askFirstQuestion(window);
  await expect(card.getByTestId("setup-key")).toBeVisible();

  await app?.close();
  window = await launch();
  await expect(window.getByTestId("plus-menu")).toBeVisible();
  await expect(setupOf(window)).toHaveCount(0);
});

// protects=a pasted key works with no other click, More services… opens the directory inside the step and Esc comes back to it, and the next step reaches the key's decision model host with nothing more to enter and offers the Answers model, saving only the choice; fails_when=Settings opens, the setup is left, a click is needed after the paste, the decision model asks for a key the User gave, or tagging is turned on; no_claim=the hosts' own requests.
test("a pasted key works at once, More services… stays in the setup, and sorting uses the key's host", async () => {
  test.setTimeout(120_000);
  const window = await launch({}, 900);
  await acceptPlainTextKeys(window);
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  const ai = await atStep(window, "ai");
  const field = ai.getByTestId("setup-key");
  await expect(field).toBeFocused();
  await expect(ai.getByTestId("setup-keys-stay")).toHaveText("Keys stay on this computer.");
  await expect(ai.getByTestId("setup-next")).toBeDisabled();
  // The other ways: cloud first, a model on this computer last.
  await expect(ai.locator('[data-testid^="setup-way-"]:not([data-testid$="-open"])')).toHaveText([
    "Use my ChatGPT plan",
    "Use my Claude plan",
    "More services…",
    "A model on this computer",
  ]);
  await shot(window, "setup-ai-en-900");

  // More services…: the directory in the step, its search focused; Esc goes back.
  await ai.getByTestId("setup-way-more-open").click();
  const services = setupOf(window).getByTestId("setup-services");
  await expect(services.getByTestId("provider-directory-search")).toBeFocused();
  await expect(window.getByTestId("settings")).toHaveCount(0);
  const groups = await services
    .getByTestId("provider-directory-group")
    .evaluateAll((all) => all.map((each) => each.getAttribute("data-group")));
  expect(groups.at(-1)).toBe("local");
  expect(groups).not.toContain("meetings");
  await shot(window, "setup-services-en-900");
  await window.keyboard.press("Escape");
  await expect(services).toHaveCount(0);
  await atStep(window, "ai");

  // A service chosen there is set up in the step, and the crumb comes back.
  await ai.getByTestId("setup-way-more-open").click();
  await services.locator('[data-entry="provider:anthropic"]').click();
  await expect(services.getByTestId("provider-form")).toBeVisible();
  await expect(setupOf(window)).toBeVisible();
  await setupOf(window).getByTestId("setup-crumb").click();
  await expect(services).toHaveCount(0);

  // A pasted key is recognised by its form and works with no other click.
  await field.fill(OPENROUTER_KEY);
  await field.press("Enter");
  await expect(ai.getByTestId("setup-ai-works")).toBeVisible({ timeout: 20_000 });
  await expect(ai.getByTestId("setup-next")).toBeEnabled();
  await ai.getByTestId("setup-next").click();

  const sorting = await atStep(window, "sorting");
  const radios = sorting.getByTestId("setup-sorting");
  await expect(radios.first()).toHaveAttribute("data-value", "decision");
  await expect(radios.first().locator("input")).toBeChecked();
  await expect(radios.last()).toHaveAttribute("data-value", "local");
  await expect(sorting.locator('[data-testid="setup-sorting"][data-value="chat"]')).toContainText(
    "Use ",
  );
  await expect(sorting.getByTestId("setup-decision-host")).toHaveValue("openrouter");
  await expect(sorting.getByTestId("setup-decision-works")).toContainText(
    "Uses your OpenRouter key",
  );
  await shot(window, "setup-sorting-en-900");
  await sorting.getByTestId("setup-next").click();

  const meetings = await atStep(window, "meetings");
  const routes = meetings.getByTestId("setup-transcription");
  await expect(routes.first()).toHaveAttribute("data-value", "cloud");
  await expect(routes.first().locator("input")).toBeChecked();
  await expect(routes.last()).toHaveAttribute("data-value", "local");
  await shot(window, "setup-meetings-en-900");
  await routes.last().locator("input").check();
  await meetings.getByTestId("setup-next").click();
  await expect(setupOf(window)).toHaveCount(0);

  const library = (await bridge(window).library()).settings;
  expect(library.classifier).toMatchObject({ kind: "decision", host: "openrouter" });
  expect(library.automatic).toBe(false);
  expect((await bridge(window).settings()).device.transcriptionRoute).toBe("local");
});

// protects=Settings › AI with no account or key leads with No AI yet and its two actions in view at 900 and 1,440, in English and Chinese, says No model yet as text, and Set up step by step opens the setup's three model steps and comes back; fails_when=the add button needs a scroll, the Answers row is a dead picker, or the steps open Settings or the first step; no_claim=the add sheet itself (aiSettings.spec.ts).
test("Settings › AI with nothing set leads with No AI yet, and Set up step by step opens the model steps", async () => {
  test.setTimeout(120_000);
  const { app: launched, window } = await launchApp(dataDir, { fakeChat: true });
  app = launched;
  const settings = await openSettings(window, "ai");
  for (const [language, width] of [
    ["en", 1440],
    ["en", 900],
    ["zh-CN", 900],
    ["zh-CN", 1440],
  ] as const) {
    await setWindowSize(launched, window, width, 900);
    await bridge(window).setLanguage(language);
    const none = settings.getByTestId("ai-none");
    await expect(none.getByTestId("ai-none-add")).toHaveText(
      language === "en" ? "Add an account or key…" : "添加账户或密钥…",
    );
    await expect(none.getByTestId("ai-none-add")).toBeInViewport();
    await expect(none.getByTestId("ai-none-step-by-step")).toBeInViewport();
    await expect(settings.getByTestId("model-default-chatModel")).toHaveText(
      language === "en" ? "No model yet" : "还没有模型",
    );
    await shot(window, `settings-ai-empty-${language}-${width}`);
  }
  await bridge(window).setLanguage("en");
  await settings.getByTestId("ai-none-step-by-step").click();
  await expect(window.getByTestId("settings")).toBeHidden();
  await expect(setupOf(window)).toHaveAttribute("data-from", "ai");
  await expect(panelOf(window).getByTestId("setup-progress-step")).toHaveText([
    "Your AI",
    "Sorting",
    "Meetings",
  ]);
  await expect(panelOf(window).getByTestId("setup-back")).toHaveCount(0);
  await skipTheRest(window);
  await expect(window.getByTestId("plus-menu")).toBeVisible();
});

// protects=in Local mode the model steps offer only what runs on this computer: no key field, plan, service list, decision model or cloud transcription; fails_when=a cloud choice shows; no_claim=Local mode's own switch.
test("in Local mode, every model step offers only this computer", async () => {
  test.setTimeout(120_000);
  const { app: launched, window } = await launchApp(dataDir, { fakeChat: true });
  app = launched;
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(true),
  );
  const settings = await openSettings(window, "ai");
  await settings.getByTestId("ai-none-step-by-step").click();
  const ai = await atStep(window, "ai");
  await expect(ai.getByTestId("setup-local-mode")).toBeVisible();
  await expect(ai.getByTestId("setup-key")).toHaveCount(0);
  await expect(ai.locator('[data-testid^="setup-way-"]:not([data-testid$="-open"])')).toHaveText([
    "A model on this computer",
  ]);
  await ai.getByTestId("setup-skip").click();
  const sorting = await atStep(window, "sorting");
  await expect(sorting.getByTestId("setup-sorting")).toHaveCount(1);
  await expect(sorting.getByTestId("setup-sorting")).toHaveAttribute("data-value", "local");
  await expect(sorting.getByTestId("setup-decision")).toHaveCount(0);
  await sorting.getByTestId("setup-skip").click();
  const meetings = await atStep(window, "meetings");
  await expect(meetings.getByTestId("setup-transcription")).toHaveCount(1);
  await expect(meetings.getByTestId("setup-transcription")).toHaveAttribute("data-value", "local");
  await meetings.getByTestId("setup-skip").click();
  await expect(setupOf(window)).toHaveCount(0);
});

// protects=the setup holds its layout at 900 and 1,440 px, in English and Chinese, light and dark: one panel, no sideways scroll, the title where it was from step to step and the foot's buttons in view; fails_when=the panel overflows the window, the title moves between steps, or a button is cut off; no_claim=the steps' behaviour, tested above.
test("the setup holds at 900 and 1,440 px, in English and Chinese, light and dark", async () => {
  test.setTimeout(180_000);
  const window = await launch();
  for (const [language, appearance] of [
    ["en", "light"],
    ["zh-CN", "light"],
    ["zh-CN", "dark"],
    ["en", "dark"],
  ] as const) {
    await bridge(window).setLanguage(language);
    await bridge(window).setAppearance(appearance);
    for (const width of [900, 1440]) {
      await setWindowSize(app as ElectronApplication, window, width, 900);
      const tops: number[] = [];
      for (const step of ["work", "ai", "sorting", "meetings"]) {
        const panel = await atStep(window, step);
        const fits = await window.evaluate(
          () => document.documentElement.scrollWidth <= globalThis.innerWidth,
        );
        expect(fits, `${language} ${appearance} ${width} ${step}`).toBe(true);
        await expect(panel.getByTestId("setup-next")).toBeInViewport();
        tops.push((await panel.locator("#setup-title").boundingBox())?.y ?? -1);
        await shot(window, `setup-${step}-${language}-${appearance}-${width}`);
        if (step !== "meetings") await panel.getByTestId("setup-skip").click();
      }
      expect(new Set(tops).size, `${language} ${appearance} ${width}`).toBe(1);
      // Back to the first step for the next size.
      for (let at = 0; at < 3; at++) await panelOf(window).getByTestId("setup-back").click();
    }
  }
});
