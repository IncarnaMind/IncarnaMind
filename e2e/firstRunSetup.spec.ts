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
  runCommand,
  setWindowSize,
  startFakePostHog,
} from "./app";

/*
 * The first run's setup (#3296): a fresh profile opens on four short steps before the example
 * (what the User works on, their AI, sorting, meeting transcription), every one skippable, and
 * Settings › AI with nothing set leads to its model steps, in a dialog over the app. Every launch
 * uses the scripted chat model, and Ollama and the decision model hosts are pointed nowhere, so no
 * key reaches a service. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const OPENROUTER_KEY = `sk-or-v1-${"0f9a".repeat(16)}`;
const OPENAI_KEY = "sk-proj-a-made-up-key";
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
  /** The catalog entry of the saved account that answers Questions, or null with none. */
  answersFrom: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { chatModel } = (await core.getSettings()).user;
      const providers = await core.listChatProviders();
      return providers.find((each) => each.id === chatModel?.providerId)?.catalogId ?? null;
    }),
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
const dialogOf = (window: Page) => window.getByTestId("setup-dialog");
/** The step shown, on the first run's page or in the dialog: one at a time. */
const panelOf = (window: Page) => window.getByTestId("setup-panel");

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
    // The card is as tall as what it shows: no room kept for a state it can't reach.
    const band = await card.evaluate(
      (section) =>
        (section.parentElement?.getBoundingClientRect().height ?? 0) -
        section.getBoundingClientRect().height,
    );
    expect(band).toBeLessThanOrEqual(1);
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
  await expect(sorting.getByTestId("setup-sorting-sends")).toContainText("to OpenRouter.");
  await shot(window, "setup-sorting-uses-key-en-900");
  await sorting.getByTestId("setup-next").click();

  const meetings = await atStep(window, "meetings");
  const routes = meetings.getByTestId("setup-transcription");
  await expect(routes.first()).toHaveAttribute("data-value", "cloud");
  await expect(routes.first().locator("input")).toBeChecked();
  await expect(routes.last()).toHaveAttribute("data-value", "local");
  await routes.last().locator("input").check();
  await meetings.getByTestId("setup-next").click();
  await expect(setupOf(window)).toHaveCount(0);

  const library = (await bridge(window).library()).settings;
  expect(library.classifier).toMatchObject({ kind: "decision", host: "openrouter" });
  expect(library.automatic).toBe(false);
  expect((await bridge(window).settings()).device.transcriptionRoute).toBe("local");
});

// protects=Settings › AI with no account or key starts with its lede, then No AI yet with its two actions together in one row in view at 900 and 1,440, in English and Chinese, and says No model yet as text; Set up step by step opens the three model steps in a dialog over Settings, which Esc and its ✕ close with the focus back on the button, Esc in More services going back first; from ⌘K the same dialog leaves the Note in front as it was; fails_when=No AI yet comes before the lede, the buttons split or need a scroll, the Answers row is a dead picker, the steps replace the window or close Settings, Esc or ✕ leaves the focus elsewhere, or the app loses its place; no_claim=the add sheet itself (aiSettings.spec.ts).
test("Settings › AI with nothing set: the lede, then No AI yet, whose Set up step by step opens a dialog over the app", async () => {
  test.setTimeout(120_000);
  const { app: launched, window } = await launchApp(dataDir, { ...STAND_INS, examples: true });
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
    const add = none.getByTestId("ai-none-add");
    const stepByStep = none.getByTestId("ai-none-step-by-step");
    await expect(add).toHaveText(language === "en" ? "Add an account or key…" : "添加账户或密钥…");
    await expect(add).toBeInViewport();
    await expect(stepByStep).toBeInViewport();
    const lede = await settings.getByTestId("ai-lede").boundingBox();
    const card = await none.boundingBox();
    expect(lede && card && lede.y + lede.height <= card.y, `${language} ${width}`).toBe(true);
    // Together in one row beside the words, Set up step by step first.
    const [before, after] = [await stepByStep.boundingBox(), await add.boundingBox()];
    const words = await none.locator("p").boundingBox();
    expect(before && after && Math.abs(before.y - after.y) < 1, `${language} ${width}`).toBe(true);
    expect(before && after && before.x + before.width < after.x).toBe(true);
    expect(before && words && before.y < words.y + words.height, `${language} ${width}`).toBe(true);
    await expect(settings.getByTestId("model-default-chatModel")).toHaveText(
      language === "en" ? "No model yet" : "还没有模型",
    );
    await shot(window, `settings-ai-empty-${language}-${width}`);
  }
  await bridge(window).setLanguage("en");
  await setWindowSize(launched, window, 1440, 900);

  // A dialog over Settings, which stays where it was.
  const stepByStep = settings.getByTestId("ai-none-step-by-step");
  await stepByStep.click();
  const dialog = dialogOf(window);
  await expect(dialog).toBeVisible();
  await expect(setupOf(window)).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(panelOf(window).getByTestId("setup-progress-step")).toHaveText([
    "Your AI",
    "Sorting",
    "Meetings",
  ]);
  await expect(panelOf(window).getByTestId("setup-back")).toHaveCount(0);
  await expect(dialog.getByTestId("setup-key")).toBeFocused();
  await shot(window, "setup-dialog-ai-en-1440");
  // Esc in More services goes back to the step; Esc again closes the dialog.
  await dialog.getByTestId("setup-way-more-open").click();
  await expect(dialog.getByTestId("provider-directory-search")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(dialog.getByTestId("setup-services")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(stepByStep).toBeFocused();

  // ✕ closes it the same way.
  await stepByStep.click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("setup-close").click();
  await expect(dialog).toBeHidden();
  await expect(stepByStep).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // From ⌘K, over the Note in front, which is still there once the steps are skipped through.
  const front = await frontMindName(window).textContent();
  await runCommand(window, "settings.setUpStepByStep", "Set up step by step");
  await expect(dialog).toBeVisible();
  await skipTheRest(window);
  await expect(dialog).toBeHidden();
  await expect(frontMindName(window)).toHaveText(front ?? "");
  await expect(window.getByTestId("plus-menu")).toBeVisible();
});

// protects=with no AI, the sorting step asks only for the host's key, under its name with where to get one, with the line that says what sorting sends and, as that key will also answer Questions, that line and the chat's; a refused key says so in one line under the field and puts the focus back; Use this then checks, keeps and chooses at once, the key becoming the Answers model; the transcription step asks for its service's key the same way, Finish enabled once one is typed; fails_when=a model line, a price link or a button of the form's own shows, the primary is enabled with no key, a refusal leaves the step or loses the focus, the key is not chosen, or the Answers model is not set; no_claim=the hosts' own checks.
test("with no AI yet, sorting and transcription each ask for one key, and one press checks, keeps and chooses", async () => {
  test.setTimeout(120_000);
  const window = await launch({}, 900);
  await acceptPlainTextKeys(window);
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await (await atStep(window, "ai")).getByTestId("setup-skip").click();

  const sorting = await atStep(window, "sorting");
  const next = sorting.getByTestId("setup-next");
  await expect(sorting.getByTestId("setup-decision-host")).toHaveValue("openrouter");
  const decision = sorting.getByTestId("setup-decision");
  await expect(decision.getByText("OpenRouter key", { exact: true })).toBeVisible();
  await expect(decision.getByRole("link", { name: /Get a key/ })).toBeVisible();
  await expect(decision.getByTestId("setup-keys-stay")).toHaveText("Keys stay on this computer.");
  await expect(decision.getByTestId("setup-sorting-sends")).toContainText("to OpenRouter.");
  await expect(decision.getByTestId("setup-decision-answers")).toHaveText(
    "OpenRouter will also answer your Questions.",
  );
  await expect(decision.getByTestId("setup-decision-chat-sends")).toBeVisible();
  await expect(decision.getByRole("link", { name: /Pricing/ })).toHaveCount(0);
  await expect(decision.getByTestId("decision-sorting-line")).toHaveCount(0);
  await expect(decision.getByRole("button", { name: /Use this|Cancel|Save/ })).toHaveCount(0);
  await expect(next).toBeDisabled();
  await shot(window, "setup-sorting-needs-key-en-900");

  const key = sorting.getByTestId("setup-decision-key");
  await key.fill("sk-or-v1-a-key-that-is-refused");
  await next.click();
  await expect(sorting.getByTestId("setup-decision-key-problem")).toContainText(
    "The key was refused",
  );
  await expect(key).toBeFocused();
  await atStep(window, "sorting");

  await key.fill(OPENROUTER_KEY);
  await expect(sorting.getByTestId("setup-decision-key-problem")).toHaveCount(0);
  await expect(next).toBeEnabled();
  await shot(window, "setup-sorting-key-typed-en-900");
  await next.click();

  const meetings = await atStep(window, "meetings");
  const finish = meetings.getByTestId("setup-next");
  const library = (await bridge(window).library()).settings;
  expect(library.classifier).toMatchObject({ kind: "decision", host: "openrouter" });
  expect(library.automatic).toBe(false);
  expect(await bridge(window).answersFrom()).toBe("openrouter");

  await expect(meetings.getByTestId("setup-transcription").first()).toContainText(
    "Soniox, Deepgram and others",
  );
  const service = await meetings.getByTestId("setup-transcription-service").inputValue();
  const cloud = meetings.getByTestId("setup-cloud");
  await expect(cloud.getByText(/ key$/)).toBeVisible();
  await expect(cloud.getByRole("link", { name: /Get a key/ })).toBeVisible();
  await expect(cloud.getByTestId("setup-keys-stay")).toBeVisible();
  await expect(cloud.getByTestId("setup-transcription-sends")).toContainText("an hour");
  await expect(cloud.getByRole("button", { name: /Use this|Cancel|Save/ })).toHaveCount(0);
  await expect(finish).toBeDisabled();
  await shot(window, `setup-meetings-needs-key-${service}-en-900`);
  await meetings.getByTestId("setup-transcription-key").fill("a-made-up-transcription-key");
  await expect(finish).toBeEnabled();
  await shot(window, `setup-meetings-key-typed-${service}-en-900`);
  // Not pressed with that key: it would be checked with the service. This computer instead.
  await meetings.getByTestId("setup-transcription").last().locator("input").check();
  await finish.click();
  await expect(setupOf(window)).toHaveCount(0);
  expect((await bridge(window).settings()).device.transcriptionRoute).toBe("local");
});

// protects=a key from the AI step reaches the steps after it: sorting uses it where its host offers a decision model, transcription where it transcribes, each saying so; a key typed for another host keeps the Answers model as it was and says nothing of answering; fails_when=a step asks again for a key the User gave, the line about answering shows with an Answers model, or the Answers model changes; no_claim=the hosts' own checks.
test("an OpenAI key from the AI step is used by sorting and transcription, and another host's key keeps the Answers model", async () => {
  test.setTimeout(120_000);
  const window = await launch({}, 900);
  await acceptPlainTextKeys(window);
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  const ai = await atStep(window, "ai");
  await ai.getByTestId("setup-key").fill(OPENAI_KEY);
  await ai.getByTestId("setup-key").press("Enter");
  await expect(ai.getByTestId("setup-ai-works")).toBeVisible({ timeout: 20_000 });
  await ai.getByTestId("setup-next").click();

  const sorting = await atStep(window, "sorting");
  await expect(sorting.getByTestId("setup-decision-host")).toHaveValue("openai");
  await expect(sorting.getByTestId("setup-decision-works")).toContainText("Uses your OpenAI key");
  await expect(sorting.getByTestId("setup-next")).toBeEnabled();
  await shot(window, "setup-sorting-uses-openai-key-en-900");

  await sorting.getByTestId("setup-decision-host").selectOption("openrouter");
  await expect(sorting.getByText("OpenRouter key", { exact: true })).toBeVisible();
  await expect(sorting.getByTestId("setup-decision-answers")).toHaveCount(0);
  await expect(sorting.getByTestId("setup-decision-chat-sends")).toHaveCount(0);
  await sorting.getByTestId("setup-decision-key").fill(OPENROUTER_KEY);
  await sorting.getByTestId("setup-next").click();

  const meetings = await atStep(window, "meetings");
  expect(await bridge(window).answersFrom()).toBe("openai");
  expect((await bridge(window).library()).settings.classifier).toMatchObject({
    kind: "decision",
    host: "openrouter",
  });
  await expect(meetings.getByTestId("setup-transcription").first()).toContainText(
    "Uses the key you already added",
  );
  await expect(meetings.getByTestId("setup-transcription-works")).toContainText(
    "Uses your OpenAI key",
  );
  await expect(meetings.getByTestId("setup-transcription-service")).toHaveCount(0);
  await expect(meetings.getByTestId("setup-transcription-sends")).toContainText("OpenAI");
  await shot(window, "setup-meetings-uses-openai-key-en-900");
  await meetings.getByTestId("setup-next").click();
  await expect(setupOf(window)).toHaveCount(0);
  expect((await bridge(window).settings()).device.transcriptionRoute).toBe("openai");
});

// protects=in Local mode the model steps offer only what runs on this computer: no key field, plan, service list, decision model or cloud transcription; fails_when=a cloud choice shows; no_claim=Local mode's own switch.
test("in Local mode, every model step offers only this computer", async () => {
  test.setTimeout(120_000);
  const { app: launched, window } = await launchApp(dataDir, STAND_INS);
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
  await expect(dialogOf(window)).toBeHidden();
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
