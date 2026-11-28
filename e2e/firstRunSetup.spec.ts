import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { EXAMPLE_SETS } from "../src/core/exampleSets";
import {
  createDataFolder,
  exampleRow,
  expectExampleInFront,
  frontMindName,
  launchApp,
  openExample,
  openSettings,
  paletteOffers,
  removeDataFolder,
  setWindowSize,
  startFakePostHog,
} from "./app";

/*
 * The first run's setup (#3296): a fresh profile opens on three short steps before the example
 * (what the User works on, their AI and meeting transcription), every one skippable. No step
 * sets up a model in IncarnaMind, and Settings › AI with nothing set offers none (#3767). Every launch
 * uses the scripted chat model, and Ollama and the decision model hosts are pointed nowhere, so no
 * key reaches a service. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Nowhere: a request to it fails at once. */
const NOWHERE = "http://127.0.0.1:9";
const STAND_INS = { fakeChat: true, ollama: NOWHERE, decisions: NOWHERE } as const;

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
  const launched = await launchApp(dataDir, { ...STAND_INS, firstRunSetup: true, ...options });
  app = launched.app;
  await setWindowSize(launched.app, launched.window, width, 900);
  return launched.window;
}

const setupOf = (window: Page) => window.getByTestId("first-run-setup");
/** The step shown, on the first run's page or in the dialog: one at a time. */
const panelOf = (window: Page) => window.getByTestId("setup-panel");

/** Waits for the step to show, and returns its panel. */
async function atStep(window: Page, step: string): Promise<Locator> {
  const panel = panelOf(window);
  await expect(panel).toHaveAttribute("data-step", step);
  return panel;
}

/** The setup's skip on each step from here to the end. */
async function skipTheRest(window: Page, steps = ["ai", "meetings"]) {
  for (const step of steps) {
    const panel = await atStep(window, step);
    await panel.getByTestId("setup-skip").click();
  }
  await expect(panelOf(window)).toHaveCount(0);
}

// protects=a fresh profile opens on the setup's first step, its order kept with Something else last and every choice a pick of its own; two picks lead to the first pick's example with both listed, the card in that work's words with no empty band under it, and the picks sent once on Send and continue, the step offering no second send when the User comes back to it; fails_when=the example opens first, Something else can be picked with another, the wrong example leads, a pick is lost, nothing reaches PostHog, the picks go twice, or the card keeps room it never fills; no_claim=PostHog itself.
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
    // Every choice is a pick of its own: Something else sits beside another.
    await pick("legal").check();
    await pick("other").check();
    await expect(pick("legal")).toBeChecked();
    await pick("other").uncheck();
    await pick("research").check();
    await expect(pick("legal")).toBeChecked();
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

    // Back on the first step, the picks went already: it only continues.
    await (await atStep(window, "ai")).getByTestId("setup-back").click();
    const again = await atStep(window, "work");
    await expect(pick("legal")).toBeChecked();
    await expect(again.getByTestId("setup-next")).toHaveText("Continue");
    await expect(again.getByTestId("setup-work-dont-send")).toHaveCount(0);
    await expect(again.getByTestId("setup-work-sent")).toHaveCount(0);
    await again.getByTestId("setup-next").click();

    await skipTheRest(window);
    // The first pick's example is in front (#3791), and both examples are listed, its first.
    await expectExampleInFront(window);
    await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS.contracts.en.title);
    await expect(exampleRow(window)).toHaveText([
      EXAMPLE_SETS.contracts.en.title,
      EXAMPLE_SETS.papers.en.title,
    ]);
    await expect(window.getByTestId("example-line")).toContainText("Add your own files");
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

// protects=Skip on every step reaches the credit paper with nothing set up, a setup quit halfway returns to the same step, a finished one never shows again, and ⌘J with no AI connected leads to Connect your AI, with no assistant column (#3819, #3767); fails_when=a step sets something up when skipped, the example is made before the end, the setup loses its step or shows again once ended, or ⌘J opens the assistant; no_claim=Connect your AI's own page.
test("Skip on every step: nothing set, the setup gone for good, and ⌘J leads to Connect your AI", async () => {
  test.setTimeout(120_000);
  let window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await atStep(window, "ai");
  // Quit halfway: nothing was made, and the next launch returns to the Your AI step (#3819).
  expect(
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds(),
    ),
  ).toEqual([]);
  await app?.close();
  window = await launch();
  await atStep(window, "ai");
  await skipTheRest(window);

  await expectExampleInFront(window);
  await expect(frontMindName(window)).toHaveText(EXAMPLE_SETS.credit.en.title);
  // With no AI connected and no model, the example's foot says how to ask (#3791).
  await expect(window.getByTestId("note-ask-no-ai")).toHaveText(/Connect your AI to ask/);
  const { device, user } = await bridge(window).settings();
  expect(device).toMatchObject({ work: [], setupFinished: true, transcriptionRoute: null });
  expect(user.chatModel).toBeNull();
  expect((await bridge(window).library()).settings.classifier).toEqual({ kind: "automatic" });

  // ⌘J with no AI app connected focuses Connect your AI, and no assistant opens (#3819, #3767).
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("note-ask-connect")).toBeFocused();
  await expect(window.getByTestId("assistant")).toBeHidden();

  await app?.close();
  window = await launch();
  await expect(window.getByTestId("plus-menu")).toBeVisible();
  await expect(setupOf(window)).toHaveCount(0);
});

// protects=a User with no transcription key can end the setup by its main button: with the cloud service picked and no key typed, Finish leaves the choice to the first recording, as "Set up when I record" does, and nothing is chosen or sent (#3536); fails_when=Finish is greyed, chooses a service, or the setup stays; no_claim=what the first recording's sheet then asks, which meetingStart covers.
test("with no transcription key, Finish ends the setup as Set up when I record does, choosing nothing", async () => {
  test.setTimeout(120_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await (await atStep(window, "ai")).getByTestId("setup-skip").click();
  const meetings = await atStep(window, "meetings");
  await expect(meetings.getByTestId("setup-transcription").first().locator("input")).toBeChecked();
  await expect(meetings.getByTestId("setup-transcription-key")).toHaveValue("");
  const finish = meetings.getByTestId("setup-next");
  await expect(finish).toBeEnabled();
  await finish.click();

  await expect(panelOf(window)).toHaveCount(0);
  const { device } = await bridge(window).settings();
  expect(device).toMatchObject({ setupFinished: true, transcriptionRoute: null });
});

// protects=Settings › AI with nothing set up leads with Your AI (its line, then the agents to connect) at 900 and 1,440, in English and Chinese, lists no job that needs a model (#3645), and offers no way to set up a model in IncarnaMind, neither a row nor ⌘K's Set up step by step (#3767); fails_when=a job that needs a model is listed, the Use a model in IncarnaMind row shows, or ⌘K offers the steps; no_claim=the add sheet itself (aiSettings.spec.ts).
test("Settings › AI with nothing set: Your AI, and no way to set up a model in IncarnaMind", async () => {
  test.setTimeout(120_000);
  const { app: launched, window } = await launchApp(dataDir, { ...STAND_INS, examples: true });
  app = launched;
  await openExample(window);
  const settings = await openSettings(window, "ai");
  for (const [language, width] of [
    ["en", 1440],
    ["en", 900],
    ["zh-CN", 900],
    ["zh-CN", 1440],
  ] as const) {
    await setWindowSize(launched, window, width, 900);
    await bridge(window).setLanguage(language);
    await expect(settings.getByTestId("ai-lede")).toHaveText(
      language === "en"
        ? "Let the AI tool you use read your Documents."
        : "让你常用的 AI 工具读取你的文档。",
    );
    await expect(settings.getByTestId("agents-list")).toBeVisible();
    await expect(settings.getByTestId("ai-use-model-open")).toHaveCount(0);
    await expect(
      settings.getByText(
        language === "en" ? "Use a model in IncarnaMind" : "在 IncarnaMind 里用一个模型",
      ),
    ).toHaveCount(0);
    await expect(settings.getByTestId("model-default-row-chatModel")).toHaveCount(0);
    await expect(settings.getByTestId("web-search-settings")).toHaveCount(0);
    await expect(settings.getByTestId("check-writes-settings")).toContainText(
      language === "en" ? "Check what your own AI writes" : "自动核对你自己的 AI 写入的内容",
    );
    await shot(window, `settings-ai-empty-${language}-${width}`);
  }
  await bridge(window).setLanguage("en");
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  expect(await paletteOffers(window, "settings.setUpStepByStep", "Set up step by step")).toBe(0);
  expect(await paletteOffers(window, "settings.addProvider", "Add an account or key")).toBe(0);
});

// protects=the setup holds its layout at 900 and 1,280 px, in English and Chinese, light and dark: one panel, no sideways scroll, the title where it was from step to step and the foot's buttons in view; fails_when=the panel overflows the window, the title moves between steps, or a button is cut off; no_claim=the steps' behaviour, tested above.
test("the setup holds at 900 and 1,280 px, in English and Chinese, light and dark", async () => {
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
    for (const width of [900, 1280]) {
      await setWindowSize(app as ElectronApplication, window, width, 900);
      const tops: number[] = [];
      for (const step of ["work", "ai", "meetings"]) {
        const panel = await atStep(window, step);
        const fits = await window.evaluate(
          () => document.documentElement.scrollWidth <= globalThis.innerWidth,
        );
        expect(fits, `${language} ${appearance} ${width} ${step}`).toBe(true);
        // With no AI app found, Your AI's way on is Set up later (#3791).
        const wayOn = panel.getByTestId(step === "ai" ? "setup-skip" : "setup-next");
        await expect(wayOn).toBeInViewport();
        tops.push((await panel.locator("#setup-title").boundingBox())?.y ?? -1);
        await shot(window, `setup-${step}-${language}-${appearance}-${width}`);
        if (step !== "meetings") await panel.getByTestId("setup-skip").click();
      }
      expect(new Set(tops).size, `${language} ${appearance} ${width}`).toBe(1);
      // Back to the first step for the next size.
      for (let at = 0; at < 2; at++) await panelOf(window).getByTestId("setup-back").click();
    }
  }
});
