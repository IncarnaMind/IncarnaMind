import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { createFakeAnthropic } from "../tests/helpers/fakeAnthropic";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  addDocuments,
  askFirstQuestion,
  assistantAnswers,
  controlReads,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  ollamaListing,
  openSettings,
  openSetupSteps,
  paletteOffers,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  showSettingsPage,
  startRecording,
  urlsOpened,
} from "./app";

/*
 * First run in three short steps (#1922): your AI, a pasted key named by its form and working at
 * once; meeting transcription, this computer first; and what sorts Documents and names meeting
 * hints, the best the keys reach. Each choice is the consent for its flow (ADR-0022).
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const bridge = (window: Page) => ({
  settings: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
    ),
  library: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.getLibrary()).settings;
    }),
});

test("a pasted key is named by its form and works at once: the waiting Question runs, and steps 2 and 3 take one click each", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);

    // No provider list and no Continue: the field is the way in, and it takes the focus.
    await expect(card.getByTestId("provider-form")).toHaveCount(0);
    await expect(card.getByTestId("setup-continue")).toHaveCount(0);
    const field = card.getByTestId("setup-key");
    await expect(field).toBeFocused();
    await expect(card.getByTestId("setup-key-line")).toHaveText(
      "OpenAI, Anthropic, Google, OpenRouter and xAI keys are recognized here.",
    );

    await field.fill(ANTHROPIC_KEY);
    await field.press("Enter");
    // The Question that waited is asked at once, and the composer is back: the steps left wait
    // as a line above it (#2310).
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
    await expect(window.getByTestId("composer-input")).toBeVisible();
    await expect(card).toHaveCount(0);
    await openSetupSteps(window);
    await expect(card.getByTestId("setup-step-transcription")).toBeVisible({ timeout: 15_000 });

    // Step 2: this computer, free, nothing leaves, and one click uses it.
    const transcription = card.getByTestId("setup-transcription");
    await expect(transcription).toBeFocused();
    await expect(transcription).toHaveValue("local");
    await expect(card.getByTestId("setup-transcription-line")).toHaveText(
      "Free · nothing leaves this computer",
    );
    await pointAndClick(window, card.getByTestId("setup-transcription-use"));
    await expect(card.getByTestId("setup-step-transcription")).toHaveAttribute("data-done", "true");

    // Step 3: the best the key reaches is the AI model just set up, and hints say what they need.
    const sorting = card.getByTestId("models-sorting");
    await expect(sorting).toBeFocused();
    await expect(sorting.locator("option:checked")).toHaveText("Use your AI model");
    await expect(card.getByTestId("models-sorting-line")).toContainText(
      "Tags and Folders use Claude Haiku 5.5",
    );
    await expect(card.getByTestId("models-sorting-line")).toContainText(
      "Meeting hints stay off until a decision model is chosen",
    );
    await pointAndClick(window, card.getByTestId("setup-sorting-use"));

    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("composer-input")).toBeVisible();
    // Each step's choice is saved as it is made: waited for, not read the moment it is clicked.
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("local");
    await expect.poll(async () => (await bridge(window).library()).classifier.kind).toBe("chat");
    // "Tags and Folders use Claude Haiku 5.5" is the choice to tag with it: tagging is on (#2308).
    await expect.poll(async () => (await bridge(window).library()).automatic).toBe(true);
  } finally {
    await app.close();
  }
});

/** The line above the composer, as it reads with `count` steps left. */
function setupLine(language: "en" | "zh-CN", count: 1 | 2): string {
  const titles = (
    count === 2
      ? [translate(language, "setup.step.transcription"), translate(language, "setup.step.sorting")]
      : [translate(language, "setup.step.sorting")]
  ).join(language === "zh-CN" ? "、" : ", ");
  return translate(language, "setup.steps.line", { count, steps: titles });
}

/** The step in hand's line naming what goes where, above its Use this. */
async function consentBeforeUse(card: Locator, lineId: string, useId: string): Promise<void> {
  const consent = card.getByTestId(lineId);
  const useThis = card.getByTestId(useId);
  await expect(consent).toBeVisible();
  await expect(useThis).toBeVisible();
  const consentBox = await consent.boundingBox();
  const useBox = await useThis.boundingBox();
  if (!consentBox || !useBox) throw new Error("The line and its Use this aren't on screen.");
  expect(consentBox.y + consentBox.height).toBeLessThanOrEqual(useBox.y);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`after the first Answer the composer is there, ⌘J takes it and a follow-up is asked, then Set up opens step 2 and step 3 above it (${language}, 1280 × 800) (#2310)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });

      // The setup no longer takes the composer's place: meeting transcription and sorting wait
      // by name in one quiet line above it, which is not the composer and is not its card.
      const composer = window.getByTestId("composer-input");
      const line = window.getByTestId("assistant-setup-line");
      await expect(composer).toBeVisible();
      await expect(card).toHaveCount(0);
      await expect(line).toBeVisible();
      await expect(line).toHaveText(setupLine(language, 2));
      await expect(card.getByTestId("setup-step-transcription")).toHaveCount(0);

      // ⌘J puts the cursor in the composer, from the Mind.
      await window.getByTestId("mind-editor").click();
      await window.keyboard.press("ControlOrMeta+j");
      await expect(composer).toBeFocused();

      // A follow-up is typed and sent, with no setup step ever taken.
      const followUp = language === "zh-CN" ? "再说得具体一点？" : "Tell me more about that?";
      await window.keyboard.type(followUp);
      await window.keyboard.press("Enter");
      await expect(assistantAnswers(window)).toHaveCount(2, { timeout: 20_000 });
      await expect(window.getByTestId("assistant-question").last()).toContainText(followUp);
      await expect(line).toBeVisible();
      await expect(composer).toBeVisible();

      // Set up opens step 2 above the composer, which stays at the panel's foot and takes keys.
      await pointAndClick(window, line);
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible({ timeout: 15_000 });
      await expect(line).toHaveText(setupLine(language, 2));
      await expect(composer).toBeVisible();
      const cardBox = await card.boundingBox();
      const composerBox = await composer.boundingBox();
      if (!cardBox || !composerBox) throw new Error("The card and the composer aren't on screen.");
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(composerBox.y + 1);
      await composer.click();
      await expect(composer).toBeFocused();
      await window.keyboard.type("x");
      await expect(composer).toHaveValue("x");
      await composer.fill("");

      // What goes where is on screen before the button that is its consent.
      await consentBeforeUse(card, "setup-transcription-line", "setup-transcription-use");
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));

      // Step 3 opens in turn, under the same line; one step is left.
      await expect(card.getByTestId("setup-step-sorting")).toHaveAttribute("data-open", "true");
      await expect(line).toHaveText(setupLine(language, 1));
      await expect(composer).toBeVisible();
      await consentBeforeUse(card, "models-sorting-line", "setup-sorting-use");
      await expect(card.getByTestId("setup-sorting-use")).toBeEnabled();
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));

      // After the last, the card and its line go, and the composer has the panel.
      await expect(card).toHaveCount(0);
      await expect(line).toHaveCount(0);
      await expect(composer).toBeVisible();
      await expect
        .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
        .toBe("local");
      expect((await bridge(window).library()).classifier.kind).toBe("chat");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`skipping the steps with the line's ✕ puts the cursor in the composer, by click (${language}) (#2310)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      const line = window.getByTestId("assistant-setup-line");
      const composer = window.getByTestId("composer-input");
      await expect(line).toBeVisible();

      await pointAndClick(window, window.getByTestId("assistant-setup-skip"));
      await expect(line).toHaveCount(0);
      await expect(card).toHaveCount(0);
      await expect(composer).toBeFocused();
      await window.keyboard.type("next");
      await expect(composer).toHaveValue("next");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`skipping the steps with the keyboard puts the cursor in the composer (${language}) (#2310)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      const line = window.getByTestId("assistant-setup-line");
      const composer = window.getByTestId("composer-input");
      const skip = window.getByTestId("assistant-setup-skip");
      await expect(line).toBeVisible();
      await expect(composer).toBeFocused();

      // The line is two stops above the composer: its ✕ first, then Set up.
      await window.keyboard.press("Shift+Tab");
      await expect(skip).toBeFocused();
      await window.keyboard.press(language === "en" ? "Enter" : "Space");
      await expect(line).toHaveCount(0);
      await expect(card).toHaveCount(0);
      await expect(composer).toBeFocused();
      await window.keyboard.type("next");
      await expect(composer).toHaveValue("next");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the last step done puts the cursor in the composer, with the line gone (${language}) (#2310)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      const line = window.getByTestId("assistant-setup-line");
      const composer = window.getByTestId("composer-input");
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));
      await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));

      await expect(card).toHaveCount(0);
      await expect(line).toHaveCount(0);
      await expect(composer).toBeFocused();
      await window.keyboard.type("next");
      await expect(composer).toHaveValue("next");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`skipping the steps while the transcription services are read puts the cursor in the composer (${language}) (#2310)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      await controlReads(app, SERVICES, { hold: 50 });
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      const line = window.getByTestId("assistant-setup-line");
      const composer = window.getByTestId("composer-input");
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-services-reading")).toBeVisible({ timeout: 15_000 });

      await pointAndClick(window, window.getByTestId("assistant-setup-skip"));
      await expect(card).toHaveCount(0);
      await expect(line).toHaveCount(0);
      await expect(composer).toBeFocused();
      await window.keyboard.type("next");
      await expect(composer).toHaveValue("next");
    } finally {
      await controlReads(app, SERVICES, { settle: "resolveAll" }).catch(() => undefined);
      await app.close();
    }
  });
}

/** Where the card and its step in hand's buttons are, as the User's eye holds them. */
interface StepsFrame {
  step: string;
  card: Box;
  buttons: Box[];
  /** How tall the conversation above the card is, so a test can tell the Answer grew. */
  thread: number;
  /** Whether step 2 shows its consent line for a cloud route, and its Add a key link. */
  consent: boolean;
  addKey: boolean;
  line: string;
  reading: boolean;
}
type Box = { top: number; left: number; width: number; height: number };

/** The card, the buttons of its step in hand and Set up later, in the one frame they share. */
function stepsFrame(window: Page): Promise<StepsFrame> {
  return window.evaluate(() => {
    const box = (element: Element): Box => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return { top, left, width, height };
    };
    const card = document.querySelector('[data-testid="model-setup"]');
    const open = card?.querySelector('[data-testid^="setup-step-"][data-open]');
    const thread = document.querySelector('[data-testid="assistant-thread"]');
    if (!card || !open || !thread) throw new Error("The steps aren't showing.");
    return {
      step: open.getAttribute("data-testid") ?? "",
      card: box(card),
      buttons: [...open.querySelectorAll("button")].map(box),
      thread: thread.scrollHeight,
      consent: card.querySelector('[data-testid="meetings-route-consent"]') !== null,
      addKey: card.querySelector('[data-testid="setup-transcription-add-key"]') !== null,
      line: open.querySelector('[data-testid="models-sorting-line"]')?.textContent ?? "",
      reading:
        open.querySelector('[data-testid="models-sorting"]')?.hasAttribute("disabled") ?? false,
    };
  });
}

/** Films every frame from now on, until `stopRecording`, so a move between two looks can't hide. */
async function recordSteps(window: Page): Promise<void> {
  await window.evaluate(() => {
    const filmed = globalThis as unknown as { steps?: { frames: unknown[]; running: boolean } };
    const record = { frames: [] as unknown[], running: true };
    filmed.steps = record;
    const box = (element: Element) => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return { top, left, width, height };
    };
    const tick = () => {
      if (!record.running) return;
      const card = document.querySelector('[data-testid="model-setup"]');
      const open = card?.querySelector('[data-testid^="setup-step-"][data-open]');
      const thread = document.querySelector('[data-testid="assistant-thread"]');
      if (card && open && thread) {
        record.frames.push({
          step: open.getAttribute("data-testid"),
          card: box(card),
          buttons: [...open.querySelectorAll("button")].map(box),
          thread: thread.scrollHeight,
          consent: card.querySelector('[data-testid="meetings-route-consent"]') !== null,
          addKey: card.querySelector('[data-testid="setup-transcription-add-key"]') !== null,
        });
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

async function stopRecording(window: Page): Promise<StepsFrame[]> {
  return window.evaluate(() => {
    const filmed = globalThis as unknown as { steps: { frames: unknown[]; running: boolean } };
    filmed.steps.running = false;
    return filmed.steps.frames as StepsFrame[];
  });
}

/** The most any box's edge moved over the frames: 0 is a card that held still. */
function spread(frames: StepsFrame[], of: (frame: StepsFrame) => Box): number {
  const edges = (pick: (box: Box) => number) => frames.map((frame) => pick(of(frame)));
  return Math.max(
    ...[(box: Box) => box.top, (box: Box) => box.left, (box: Box) => box.height].map(
      (pick) => Math.max(...edges(pick)) - Math.min(...edges(pick)),
    ),
  );
}

function buttonOf(frame: StepsFrame, index: number): Box {
  const button = frame.buttons[index];
  if (!button) throw new Error(`The step in hand has no button ${index}.`);
  return button;
}

/** Whether every button of the step in hand shows in the card, with no scrolling in the card. */
function buttonsInView(window: Page): Promise<{
  scrolls: boolean;
  outside: string[];
  thread: number;
}> {
  return window.evaluate(() => {
    const card = document.querySelector('[data-testid="model-setup"]');
    const open = card?.querySelector('[data-testid^="setup-step-"][data-open]');
    const thread = document.querySelector('[data-testid="assistant-thread"]');
    if (!card || !open || !thread) throw new Error("The steps aren't showing.");
    const room = card.getBoundingClientRect();
    const outside = [...open.querySelectorAll("button")]
      .filter((button) => {
        const { top, bottom } = button.getBoundingClientRect();
        return top < room.top - 0.5 || bottom > room.bottom + 0.5;
      })
      .map((button) => button.getAttribute("data-testid") ?? button.textContent ?? "a button");
    return {
      scrolls: card.scrollHeight > card.clientHeight + 1,
      outside,
      thread: thread.clientHeight,
    };
  });
}

/** How a finished step's line lays out its title and choice: whole, and either side by side or one under the other. */
function foldedLine(window: Page, step: "transcription" | "sorting") {
  return window.evaluate((testId) => {
    const button = document.querySelector(`[data-testid="setup-step-${testId}-open"]`);
    const title = button?.querySelector(`[data-testid="setup-step-${testId}-title"]`);
    const choice = button?.querySelector(`[data-testid="setup-step-${testId}-choice"]`);
    if (!button || !title || !choice) throw new Error("The step isn't a folded line.");
    const edge = button.getBoundingClientRect();
    const head = title.getBoundingClientRect();
    const tail = choice.getBoundingClientRect();
    const below = tail.top > head.top + head.height / 2;
    return {
      cut: title.scrollWidth > title.clientWidth || head.right > edge.right + 0.5,
      title: title.textContent ?? "",
      below,
      // Under the title it starts where the title's text does; beside it, one space after it.
      offset: below ? tail.left - head.left : tail.left - head.right,
    };
  }, step);
}

/** Notes the sorting step's line, its use button and the card's box at every change the page makes, from now on. */
function watchSortingStep(window: Page): Promise<void> {
  return window.evaluate(() => {
    const seen: unknown[] = [];
    (globalThis as unknown as { sortingSteps: unknown[] }).sortingSteps = seen;
    const note = () => {
      const card = document.querySelector('[data-testid="model-setup"]');
      const line = card?.querySelector('[data-testid="models-sorting-line"]');
      const use = card?.querySelector('[data-testid="setup-sorting-use"]');
      if (!card || !line) return;
      const { top, height } = card.getBoundingClientRect();
      seen.push({
        line: (line as HTMLElement).innerText,
        usable: use !== null && !use?.hasAttribute("disabled"),
        top,
        height,
      });
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
}

function sortingStepsSeen(
  window: Page,
): Promise<{ line: string; usable: boolean; top: number; height: number }[]> {
  return window.evaluate(
    () =>
      (
        globalThis as unknown as {
          sortingSteps: { line: string; usable: boolean; top: number; height: number }[];
        }
      ).sortingSteps,
  );
}

/** The first `failures` reads of the transcription services fail and the reads after them wait for `releaseServices`. */
function failThenHoldServices(app: ElectronApplication, failures = 1): Promise<void> {
  return app.evaluate(({ ipcMain }, failing) => {
    const channel = "core:listTranscriptionServices";
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get(channel);
    if (!original) throw new Error("The services handler is unavailable.");
    const held = { reads: 0, release: () => {} };
    const released = new Promise<void>((done) => {
      held.release = done;
    });
    Object.assign(globalThis, { heldServices: held });
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      held.reads += 1;
      if (held.reads <= failing) throw new Error("The transcription services are unavailable.");
      await released;
      return original(event, ...args);
    });
  }, failures);
}

function releaseServices(app: ElectronApplication): Promise<void> {
  return app.evaluate(() =>
    (globalThis as unknown as { heldServices: { release(): void } }).heldServices.release(),
  );
}

function servicesRead(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    () => (globalThis as unknown as { heldServices: { reads: number } }).heldServices.reads,
  );
}

const failReads = async (app: ElectronApplication, channel: string, failing: boolean) => {
  await controlReads(app, channel, { failing });
};

/** Lets the page paint `count` times, so what a settled read changes has been drawn. */
function paints(window: Page, count = 15): Promise<void> {
  return window.evaluate(
    (times) =>
      new Promise<void>((done) => {
        let seen = 0;
        const next = () => (++seen >= times ? done() : requestAnimationFrame(next));
        next();
      }),
    count,
  );
}

// A model on this computer and a cloud model Ollama forwards to ollama.com, on one server.
const OLLAMA_MODELS = [
  { modelId: "qwen3.5:4b", shown: "Qwen 3.5 4B", cloud: false },
  { modelId: "gpt-oss:120b-cloud", shown: "gpt-oss:120b-cloud", cloud: true },
] as const;

/** Saves `modelId` on the saved Ollama server for sorting, as the Other model form does. */
async function saveSortingOnOllama(window: Page, modelId: string): Promise<void> {
  await window.evaluate(async (model) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const ollama = (await core.listChatProviders()).find((each) => each.kind === "ollama");
    if (!ollama) throw new Error("No Ollama server is saved.");
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: { kind: "chat", choice: { providerId: ollama.id, modelId: model } },
    });
  }, modelId);
}

/** Makes `modelId` on the saved Ollama server the chat default. */
async function saveOllamaDefault(window: Page, modelId: string): Promise<void> {
  await window.evaluate(async (model) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "ollama", modelId: model });
  }, modelId);
}

async function removeOllama(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const provider of await core.listChatProviders()) {
      if (provider.kind === "ollama") await core.deleteChatProvider(provider.id);
    }
  });
}

const OPENAI_KEY = "sk-proj-a-test-key-for-first-run";

for (const language of ["en", "zh-CN"] as const) {
  test(`the card holds its place and every button of the step in hand shows at 1280 × 800, before the Answer and as it grows (${language}) (#2147)`, async () => {
    test.setTimeout(150_000);
    const sources = await mkdtemp(join(tmpdir(), "incarnamind-2147-"));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await writeFile(
        join(sources, "Tides.txt"),
        "Tides and the Moon.\nThe Moon raises two bulges of water on the Earth.\n",
      );
      await addDocuments(window, [join(sources, "Tides.txt")]);
      await newMind(window);
      await window.getByTestId("mind-editor").focus();
      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type("What do tides do with forty citations");
      await window.keyboard.press("Enter");
      const card = window.getByTestId("model-setup");
      await expect(card).toBeVisible();

      // Film from the moment the steps first show, with a key whose service also transcribes, so
      // the lists the steps read (services, models) have rows to add if they were late.
      await recordSteps(window);
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible({
        timeout: 15_000,
      });

      const first = await buttonsInView(window);
      expect(first.outside, "buttons outside the card at first paint").toEqual([]);
      expect(first.scrolls, "the card scrolls at first paint").toBe(false);
      const before = await stepsFrame(window);

      // The Answer's text lands and grows past the room above the card.
      await expect
        .poll(async () => (await stepsFrame(window)).thread, { timeout: 60_000 })
        .toBeGreaterThan(before.thread + 200);
      const frames = (await stopRecording(window)).filter((each) => each.step === before.step);

      // The card's top edge and every button held still the whole time: no frame differs from
      // the others, while the conversation above grew.
      expect(frames.length).toBeGreaterThan(30);
      expect(frames.every((frame) => frame.buttons.length === before.buttons.length)).toBe(true);
      expect(spread(frames, (frame) => frame.card)).toBeLessThan(0.5);
      for (const index of before.buttons.keys()) {
        expect(
          spread(frames, (frame) => buttonOf(frame, index)),
          `button ${index} of the step in hand`,
        ).toBeLessThan(0.5);
      }
      const grown = frames.map((frame) => frame.thread);
      expect(Math.max(...grown) - Math.min(...grown)).toBeGreaterThan(200);

      const after = await buttonsInView(window);
      expect(after.outside, "buttons outside the card after the Answer").toEqual([]);
      expect(after.scrolls, "the card scrolls after the Answer").toBe(false);
      // The conversation follows its end while the reader is at it.
      const fromFoot = await window
        .getByTestId("assistant-thread")
        .evaluate((thread) => thread.scrollHeight - thread.scrollTop - thread.clientHeight);
      expect(fromFoot).toBeLessThanOrEqual(24);

      // Step 3, opened by finishing step 2, shows all of its buttons too, and the card changes
      // only for that.
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));
      await expect(card.getByTestId("setup-step-sorting")).toHaveAttribute("data-open", "true");
      await expect(card.getByTestId("models-sorting")).toBeEnabled({ timeout: 15_000 });
      // Step 2 is a line with its choice: its title whole, the choice beside it where one line
      // holds both (Chinese) and under it, aligned with its text, where one doesn't.
      const folded = await foldedLine(window, "transcription");
      expect(folded.cut, "the folded title is cut").toBe(false);
      expect(folded.title).toContain(translate(language, "setup.step.transcription"));
      if (folded.below) expect(Math.abs(folded.offset)).toBeLessThan(1.5);
      else expect(folded.offset).toBeLessThan(8);
      if (language === "zh-CN") expect(folded.below, "the Chinese line wraps").toBe(false);
      const sorting = await buttonsInView(window);
      expect(sorting.outside, "buttons outside the card in step 3").toEqual([]);
      expect(sorting.scrolls, "the card scrolls in step 3").toBe(false);
    } finally {
      await app.close();
      await rm(sources, { recursive: true, force: true });
    }
  });
}

test("a later step's title opens it, a finished step is a line with its choice that opens again, and the steps are an order, never a gate", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1280, 800);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await openSetupSteps(window);
    await expect(
      card
        .getByTestId("setup-step-transcription")
        .or(card.getByTestId("setup-step-sorting"))
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    // Only the step in hand shows its details; the later step is its title, as a button.
    const transcription = card.getByTestId("setup-step-transcription");
    const sorting = card.getByTestId("setup-step-sorting");
    await expect(transcription).toHaveAttribute("data-open", "true");
    await expect(card.getByTestId("setup-transcription")).toBeVisible();
    await expect(sorting).not.toHaveAttribute("data-open", "true");
    await expect(card.getByTestId("models-sorting")).toHaveCount(0);
    await expect(card.getByTestId("setup-sorting-use")).toHaveCount(0);
    const title = card.getByTestId("setup-step-sorting-open");
    await expect(title).toContainText("Sorting and meeting hints");

    // By keyboard: in the tab order after step 2's buttons, with its focus showing.
    await card.getByTestId("setup-transcription-later").focus();
    for (
      let presses = 0;
      presses < 4 && !(await title.evaluate((e) => e === document.activeElement));
      presses++
    ) {
      await window.keyboard.press("Tab");
    }
    await expect(title).toBeFocused();
    expect(await title.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      "none",
    );
    await window.keyboard.press("Enter");

    // Opened ahead of step 2: step 2 is a line, not done, and the focus is in step 3.
    await expect(sorting).toHaveAttribute("data-open", "true");
    await expect(transcription).not.toHaveAttribute("data-open", "true");
    await expect(transcription).not.toHaveAttribute("data-done", "true");
    await expect(card.getByTestId("setup-transcription")).toHaveCount(0);
    await expect(card.getByTestId("models-sorting")).toBeFocused();
    // What goes where is on screen before the button that is its consent.
    await expect(card.getByTestId("models-sorting-line")).toBeVisible();
    await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
    await expect(transcription).toHaveAttribute("data-open", "true");
    await expect(card.getByTestId("setup-transcription")).toBeFocused();
    await expect(card.getByTestId("setup-transcription-line")).toBeVisible();

    // Step 2 done: a tick and its choice on one line, and step 3 is in hand.
    await pointAndClick(window, card.getByTestId("setup-transcription-use"));
    await expect(transcription).toHaveAttribute("data-done", "true");
    await expect(sorting).toHaveAttribute("data-open", "true");
    const line = card.getByTestId("setup-step-transcription-open");
    await expect(line).toContainText("Meeting transcription");
    await expect(line).toContainText("On this computer");
    const folded = await foldedLine(window, "transcription");
    expect(folded.cut, "the folded title is cut").toBe(false);
    expect(folded.title).toContain("Meeting transcription");
    if (folded.below) expect(Math.abs(folded.offset)).toBeLessThan(1.5);
    else expect(folded.offset).toBeLessThan(8);

    // Clicking the line opens it again, with what was chosen kept.
    await pointAndClick(window, line);
    await expect(transcription).toHaveAttribute("data-open", "true");
    await expect(transcription).toHaveAttribute("data-done", "true");
    await expect(card.getByTestId("setup-transcription")).toHaveValue("local");
    await expect(sorting).not.toHaveAttribute("data-open", "true");

    // Skipping step 3 finishes both.
    await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
    await pointAndClick(window, card.getByTestId("setup-sorting-skip"));
    await expect(card).toHaveCount(0);
    expect((await bridge(window).library()).classifier).toEqual({ kind: "automatic" });
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("local");
  } finally {
    await app.close();
  }
});

// At 900 px the assistant is docked at the foot and step 3 is taller than its room on any font;
// at 1000 px it is at the side, and whether step 3 scrolls depends on the font.
for (const [width, height, mustScroll] of [
  [900, 560, true],
  [1000, 560, false],
] as const) {
  test(`a shorter window (${width} × ${height}) scrolls the card, keeps the room for the conversation, and keeps the step in hand in view`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      const card = await askFirstQuestion(window);
      await setLocalChatModel(window);
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible({
        timeout: 15_000,
      });

      // The conversation keeps room, whatever the step needs.
      expect((await buttonsInView(window)).thread).toBeGreaterThanOrEqual(100);

      // Whether a part of the step in hand shows within the card.
      const shows = (selector: string) =>
        window.evaluate((query) => {
          const card = document.querySelector('[data-testid="model-setup"]');
          const target = document.querySelector(query);
          if (!card || !target) throw new Error("The steps aren't showing.");
          const { top, bottom } = target.getBoundingClientRect();
          const box = card.getBoundingClientRect();
          return top >= box.top - 0.5 && bottom <= box.bottom + 0.5;
        }, selector);

      // Step 3 is taller than the room: the card scrolls, and the step opens with its title and
      // its choice in view; its buttons are a scroll away.
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));
      await expect(card.getByTestId("models-sorting")).toBeEnabled({ timeout: 15_000 });
      const taller = await buttonsInView(window);
      if (mustScroll) expect(taller.scrolls, "step 3 scrolls in a short window").toBe(true);
      expect(taller.thread).toBeGreaterThanOrEqual(100);
      expect(await shows('[data-testid="setup-step-sorting"] h3')).toBe(true);
      expect(await shows('[data-testid="models-sorting"]')).toBe(true);

      // Opened again from its line, step 2 is in view the same way.
      await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
      await expect(card.getByTestId("setup-transcription")).toBeFocused();
      expect(await shows('[data-testid="setup-step-transcription"] h3')).toBe(true);
      expect(await shows('[data-testid="setup-transcription"]')).toBe(true);

      // Nothing is cut sideways, and the click on a button a scroll away lands on it.
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await expect(card.getByTestId("models-sorting")).toBeEnabled({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));
      await expect(card).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`step 3 holds its buttons where they were while the model list is read (${language}) (#2130)`, async () => {
    // Listed a second and a half after it is asked, as a busy machine's server answers.
    const server = await ollamaListing(["qwen3.5:4b"], { delayMs: 1500 });
    const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: server.url });
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      await setLocalChatModel(window, "qwen3.5:4b");
      await openSetupSteps(window);
      await expect(
        card
          .getByTestId("setup-step-transcription")
          .or(card.getByTestId("setup-step-sorting"))
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      const first = await stepsFrame(window);
      expect(first.step).toBe("setup-step-transcription");

      // Step 3 opens as the list is asked for: it already names the model that will sort, and
      // holds the rows its line keeps once the list lands.
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await expect(card.getByTestId("setup-step-sorting")).toHaveAttribute("data-open", "true");
      const opened = await stepsFrame(window);
      expect(opened.reading, "the model list was still being read").toBe(true);
      // The title that opened it is gone and the picker can't take the focus yet: the step holds it.
      expect(
        await window.evaluate(
          () =>
            document
              .querySelector('[data-testid="setup-step-sorting"]')
              ?.contains(document.activeElement) ?? false,
        ),
        "the focus left the step while its list was read",
      ).toBe(true);
      await expect(card.getByTestId("models-sorting")).toBeEnabled({ timeout: 15_000 });
      await expect(card.getByTestId("models-sorting")).toBeFocused();
      const settled = await stepsFrame(window);
      expect(settled.reading).toBe(false);

      // Nothing moved: the card's edge and step 3's buttons are where they were.
      expect(settled.card).toEqual(opened.card);
      expect(settled.buttons).toEqual(opened.buttons);
      // The words were there from the first paint, and only the list changed under them.
      expect(opened.line).toContain(
        translate(language, "setup.sorting.chat", { model: "Qwen 3.5 4B" }),
      );
      expect(opened.line).toContain(translate(language, "setup.sorting.chat.hints"));
      expect(settled.line).toBe(opened.line);
    } finally {
      await app.close();
      server.server.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a failed read of the transcription services is said in place with Try again, and the steps then open once, from a read list (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      await failThenHoldServices(app);
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");

      // The model works, but its first read of the services failed: the steps don't open on a
      // list that wasn't read. The card says so in place, with the way out.
      await openSetupSteps(window);
      const problem = card.getByTestId("setup-services-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"), {
        timeout: 15_000,
      });
      await expect(card.getByTestId("setup-step-transcription")).toHaveCount(0);
      await expect(card.getByTestId("setup-transcription-add-key")).toHaveCount(0);

      // Try again reads the list; held, it can't open the steps. Once it lands they open, with
      // the consent line a key of this service brings and no Add a key, and nothing moves as the
      // reads the steps make by themselves land.
      await recordSteps(window);
      await pointAndClick(window, card.getByTestId("setup-services-problem-retry"));
      await expect(card.getByTestId("setup-services-problem-retry")).toBeDisabled();
      await releaseServices(app);
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible();
      await expect(card.getByTestId("meetings-route-consent")).toBeVisible();
      await expect(card.getByTestId("setup-transcription-add-key")).toHaveCount(0);
      await expect.poll(() => servicesRead(app)).toBeGreaterThanOrEqual(3);
      // The reads the steps make as they open land in the frames that follow.
      await window.evaluate(
        () =>
          new Promise<void>((done) => {
            let frames = 0;
            const next = () => (++frames >= 15 ? done() : requestAnimationFrame(next));
            next();
          }),
      );
      const frames = await stopRecording(window);
      expect(frames.length).toBeGreaterThan(5);
      expect(frames.every((frame) => frame.consent && !frame.addKey)).toBe(true);
      expect(spread(frames, (frame) => frame.card)).toBeLessThan(0.5);
      for (const index of [0, 1]) {
        expect(spread(frames, (frame) => buttonOf(frame, index))).toBeLessThan(0.5);
      }
    } finally {
      await app.evaluate(() =>
        (globalThis as unknown as { heldServices?: { release(): void } }).heldServices?.release(),
      );
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a failed read of the transcription services stays above the composer, and Try again keeps the focus as a retry fails again (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      await failThenHoldServices(app, 2);
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");

      // The problem is above the composer, which stays usable: a failed read never takes it away
      // (#2310).
      await openSetupSteps(window);
      const retry = card.getByTestId("setup-services-problem-retry");
      await expect(retry).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId("composer-input")).toBeVisible();

      // Focused, Try again disables itself as the retry runs, and that failing too gives it back.
      await retry.focus();
      await window.keyboard.press("Enter");
      await expect.poll(() => servicesRead(app)).toBeGreaterThanOrEqual(2);
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      await expect(card.getByTestId("setup-step-transcription")).toHaveCount(0);
    } finally {
      await app.evaluate(() =>
        (globalThis as unknown as { heldServices?: { release(): void } }).heldServices?.release(),
      );
      await app.close();
    }
  });
}

/** Saves Anthropic with `modelId`, which makes that model the chat default. */
async function saveAnthropicAsDefault(window: Page, modelId: string): Promise<void> {
  await window.evaluate(
    async ({ id, key }) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({ kind: "anthropic", apiKey: key, modelId: id });
    },
    { id: modelId, key: ANTHROPIC_KEY },
  );
}

/** Saves OpenAI, which makes OpenAI the chat default. */
async function saveOpenAiAsDefault(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test-b", modelId: "gpt-6-luna" });
  });
}

/** Removes Anthropic's provider and its key, so a choice saved on it names a model that is gone. */
async function removeAnthropic(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const provider of await core.listChatProviders()) {
      if (provider.kind === "anthropic") await core.deleteChatProvider(provider.id);
    }
  });
}

/** What the sorting line shows to the User: its held rows are invisible and don't count. */
function sortingWords(scope: Locator): Promise<string> {
  return scope
    .getByTestId("models-sorting-line")
    .evaluate((line) => (line as HTMLElement).innerText);
}

// A role model, one that is no role, and one the User added: each saved for sorting.
const SORTING_MODELS = [
  { modelId: "claude-haiku-5-5", model: "Claude Haiku 5.5" },
  { modelId: "claude-sonnet-5-5", model: "Claude Sonnet 5.5" },
  { modelId: "claude-added-by-the-user", model: "claude-added-by-the-user" },
] as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const { modelId, model } of SORTING_MODELS) {
    test(`a sorting choice saved on ${model} says where it goes once the list is read when another is the chat default, and says nothing when its provider is gone (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, 1280, 800);
        await acceptPlainTextKeys(window);
        await setLanguage(window, language);
        const card = await askFirstQuestion(window);
        const field = card.getByTestId("setup-key");
        await field.fill(ANTHROPIC_KEY);
        await field.press("Enter");
        await openSetupSteps(window);
        await expect(
          card
            .getByTestId("setup-step-transcription")
            .or(card.getByTestId("setup-step-sorting"))
            .first(),
        ).toBeVisible({ timeout: 15_000 });
        // The model to save for sorting is the chat default, which step 3 offers as the AI model.
        await saveAnthropicAsDefault(window, modelId);
        await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
        await expect(card.getByTestId("models-sorting-line")).toContainText(
          translate(language, "setup.sorting.chat", { model }),
          { timeout: 15_000 },
        );
        await expect(card.getByTestId("models-sorting")).toBeEnabled();
        await pointAndClick(window, card.getByTestId("setup-sorting-use"));
        await expect(card.getByTestId("setup-step-sorting")).toHaveAttribute("data-done", "true");

        // Reopened while its model is still the chat default: the line says where it goes.
        const sends = translate(language, "setup.sorting.sends", { service: "Anthropic" });
        await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
        await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
        expect(await sortingWords(card)).toContain(sends);
        await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));

        // OpenAI is the chat default now; the saved choice is still Anthropic's. Reopened,
        // the step names where it goes as soon as the list is read, and it can be used.
        await saveOpenAiAsDefault(window);
        const pickedModel = card.getByTestId("models-sorting").locator("option:checked");
        await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
        await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
        await expect(pickedModel).toHaveText(model);
        const words = await sortingWords(card);
        expect(words).toContain(translate(language, "setup.sorting.chat", { model }));
        expect(words).toContain(sends);
        expect(words).not.toContain(translate(language, "setup.sorting.chatHere", { model }));

        // Anthropic is removed: the choice names a model that is gone. Nothing is said about where
        // it goes, and it can't be used, once the list shows it isn't there.
        await removeAnthropic(window);
        await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
        await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
        await expect(
          card
            .getByTestId("models-sorting")
            .locator("option", { hasText: translate(language, "models.sorting.chat") }),
        ).toHaveCount(1);
        await expect(card.getByTestId("setup-sorting-use")).toBeDisabled();
        expect(await sortingWords(card)).toBe("");
      } finally {
        await app.close();
      }
    });

    test(`Settings › Models says the same of ${model} saved for sorting when it isn't the chat default (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, 1280, 800);
        await acceptPlainTextKeys(window);
        await saveAnthropicAsDefault(window, modelId);
        await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const chosen = (await core.getSettings()).user.chatModel;
          const library = (await core.getLibrary()).settings;
          if (chosen)
            await core.saveLibrarySettings({
              ...library,
              classifier: { kind: "chat", choice: chosen },
            });
        });
        await saveOpenAiAsDefault(window);
        await dismissChatSetup(window);
        // The button that opens Settings is named in English until the language is changed inside it.
        const settings = await openSettings(window, "models");
        await setLanguage(window, language);
        await expect(
          settings
            .getByTestId("models-sorting")
            .locator("option", { hasText: translate(language, "models.sorting.chat") }),
        ).toHaveCount(1);
        await expect(settings.getByTestId("models-sorting").locator("option:checked")).toHaveText(
          model,
        );
        const words = await sortingWords(settings);
        expect(words).toContain(translate(language, "setup.sorting.chat", { model }));
        expect(words).toContain(
          translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }),
        );
        expect(words).not.toContain(translate(language, "setup.sorting.chatHere", { model }));

        // Anthropic is removed with Settings open: the list is read again, and the line says
        // nothing about a choice whose model is gone.
        await removeAnthropic(window);
        await expect.poll(() => sortingWords(settings)).toBe("");
      } finally {
        await app.close();
      }
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`step 2 reads the transcription services again when it opens, and a read that fails says so in place and drops the list (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-transcription")).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId("meetings-route-consent")).toBeVisible();

      // Step 3 opens, and step 2 is opened again while the core can't list the services: the step
      // says so in place, with Try again, and draws nothing from the list it had.
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await failReads(app, "core:listTranscriptionServices", true);
      await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
      const problem = card.getByTestId("setup-transcription-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      const retry = card.getByTestId("setup-transcription-problem-retry");
      await expect(retry).toBeFocused();
      await expect(card.getByTestId("setup-transcription")).toHaveCount(0);
      await expect(card.getByTestId("meetings-route-consent")).toHaveCount(0);
      await expect(card.getByTestId("setup-transcription-use")).toHaveCount(0);

      // Try again reads it, and the step is drawn from what was read.
      await failReads(app, "core:listTranscriptionServices", false);
      await window.keyboard.press("Enter");
      await expect(card.getByTestId("setup-transcription")).toBeVisible();
      await expect(card.getByTestId("meetings-route-consent")).toBeVisible();
      await expect(problem).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

// What step 3 and Settings › Models read to say what sorts: the core's models, with its answer for
// the saved choice. The core is the only thing they ask, so it is the one read that can fail.
const SORTING_READS = [
  { channel: "core:getTaggingModels", name: "the models that can sort", atFirst: true },
] as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const { channel, name, atFirst } of SORTING_READS) {
    test(`step 3 says in place when ${name} can't be read, at first and on a read again, and draws nothing from stale data (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, 1280, 800);
        await acceptPlainTextKeys(window);
        await setLanguage(window, language);
        const card = await askFirstQuestion(window);
        const field = card.getByTestId("setup-key");
        await field.fill(ANTHROPIC_KEY);
        await field.press("Enter");
        await openSetupSteps(window);
        await expect(
          card
            .getByTestId("setup-step-transcription")
            .or(card.getByTestId("setup-step-sorting"))
            .first(),
        ).toBeVisible({ timeout: 15_000 });
        const problem = card.getByTestId("setup-sorting-problem");
        const retry = card.getByTestId("setup-sorting-problem-retry");
        const words = translate(language, "setup.sorting.failed");

        // At first: the read fails as step 3 opens. Try again reads it, and the step is drawn.
        await failReads(app, channel, true);
        await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
        await expect(problem).toContainText(words);
        await expect(retry).toBeFocused();
        await expect(card.getByTestId("models-sorting")).toHaveCount(0);
        await expect(card.getByTestId("models-sorting-line")).toHaveCount(0);
        await expect(card.getByTestId("setup-sorting-use")).toHaveCount(0);
        await failReads(app, channel, false);
        await window.keyboard.press("Enter");
        await expect(card.getByTestId("models-sorting")).toBeEnabled();
        await expect(card.getByTestId("setup-sorting-use")).toBeVisible();
        await expect(problem).toHaveCount(0);

        // Read again: another model becomes the default while the core can't answer. The step
        // had its choice drawn from the first read, and now says the read failed instead.
        await failReads(app, channel, true);
        await saveOpenAiAsDefault(window);
        await expect(problem).toContainText(words);
        await expect(card.getByTestId("models-sorting")).toHaveCount(0);
        await expect(card.getByTestId("setup-sorting-use")).toHaveCount(0);
        await failReads(app, channel, false);
        await pointAndClick(window, retry);
        await expect(card.getByTestId("models-sorting")).toBeEnabled();
        await expect(problem).toHaveCount(0);
      } finally {
        await app.close();
      }
    });

    test(`Settings › Models says in place when ${name} can't be read, ${atFirst ? "at first and " : ""}on a read again (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, 1280, 800);
        await acceptPlainTextKeys(window);
        await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.saveChatProvider({
            kind: "anthropic",
            apiKey: "sk-ant-test-a",
            modelId: "claude-haiku-5-5",
          });
        });
        await dismissChatSetup(window);
        const problem = window.getByTestId("models-sorting-problem");
        const words = translate(language, "setup.sorting.failed");

        // At first: Settings opens while the core can't answer.
        // The button that opens Settings is named in English until the language is changed inside it.
        if (atFirst) await failReads(app, channel, true);
        const settings = await openSettings(window, "models");
        await setLanguage(window, language);
        if (atFirst) {
          await expect(problem).toContainText(words);
          await expect(settings.getByTestId("models-sorting")).toHaveCount(0);
          await expect(settings.getByTestId("models-sorting-line")).toHaveCount(0);
          await failReads(app, channel, false);
          await pointAndClick(window, settings.getByTestId("models-sorting-problem-retry"));
        }
        await expect(settings.getByTestId("models-sorting")).toBeEnabled();
        await expect(problem).toHaveCount(0);

        // Read again: another model becomes the default while the core can't answer.
        await failReads(app, channel, true);
        await saveOpenAiAsDefault(window);
        await expect(problem).toContainText(words);
        await expect(settings.getByTestId("models-sorting")).toHaveCount(0);
        await failReads(app, channel, false);
        await pointAndClick(window, settings.getByTestId("models-sorting-problem-retry"));
        await expect(settings.getByTestId("models-sorting")).toBeEnabled();
      } finally {
        await app.close();
      }
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a read of the services that was overtaken changes nothing when it fails after a newer one has landed (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      await expect(card.getByTestId("meetings-route-consent")).toBeVisible({ timeout: 15_000 });
      const channel = "core:listTranscriptionServices";

      // Step 2 is opened again and its read, A, is held; the step is left and opened again, and
      // its read, B, lands. Then A fails, long after.
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await controlReads(app, channel, { hold: 1 });
      await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
      await expect(card.getByTestId("meetings-route-consent")).toBeVisible();
      await expect(card.getByTestId("setup-transcription-use")).toBeEnabled();
      await paints(window);
      const before = await stepsFrame(window);

      await controlReads(app, channel, { settle: "reject" });
      await paints(window);
      // The newer read stands: its list is drawn, nothing says a read failed, and nothing moved.
      await expect(card.getByTestId("meetings-route-consent")).toBeVisible();
      await expect(card.getByTestId("setup-transcription-use")).toBeEnabled();
      await expect(card.getByTestId("setup-transcription-problem")).toHaveCount(0);
      const after = await stepsFrame(window);
      expect(after.card).toEqual(before.card);
      expect(after.buttons).toEqual(before.buttons);
    } finally {
      await app.close();
    }
  });

  test(`Settings › Meetings says a failed read of the services in place, and keeps the saved cloud route (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveOpenAiAsDefault(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.updateSettings({ device: { transcriptionRoute: "openai" } });
      });
      await dismissChatSetup(window);
      // The button that opens Settings is named in English until the language is changed inside it.
      const dialog = await openSettings(window, "meetings");
      await setLanguage(window, language);
      const settings = dialog.getByTestId("meetings-settings");
      const line = settings.getByTestId("meetings-route-line");
      await expect(line).toContainText(
        translate(language, "meetings.route.cloudLine", { service: "OpenAI" }),
      );

      // Settings is closed and opened again while the core can't list the services.
      await controlReads(app, "core:listTranscriptionServices", { failing: true });
      await closeSettingsDialog(window);
      const again = await settingsOnMeetings(window);
      const problem = again.getByTestId("meetings-settings").getByTestId("meetings-route-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      const meetings = again.getByTestId("meetings-settings");
      await expect(meetings.getByTestId("meetings-route-line")).toHaveCount(0);
      // The saved route is still OpenAI: nothing says it is on this computer.
      await expect(meetings.getByTestId("meetings-route")).toHaveValue("openai");
      await expect(meetings).not.toContainText(translate(language, "meetings.route.hereLine"));

      await controlReads(app, "core:listTranscriptionServices", { failing: false });
      await pointAndClick(window, meetings.getByTestId("meetings-route-problem-retry"));
      await expect(meetings.getByTestId("meetings-route-line")).toContainText(
        translate(language, "meetings.route.cloudLine", { service: "OpenAI" }),
      );
      await expect(problem).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(`a read that fails while the focus is elsewhere leaves it there, and the problem still shows (${language})`, async () => {
    const sources = await mkdtemp(join(tmpdir(), "incarnamind-2147-focus-"));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await writeFile(join(sources, "Tides.txt"), "Tides and the Moon.\n");
      await addDocuments(window, [join(sources, "Tides.txt")]);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      await expect(
        card
          .getByTestId("setup-step-transcription")
          .or(card.getByTestId("setup-step-sorting"))
          .first(),
      ).toBeVisible({ timeout: 15_000 });

      // Step 3 opens and its read is held. The User opens Document Info, which takes the focus.
      await controlReads(app, "core:getTaggingModels", { hold: 1 });
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await window.getByTestId("document-list-item").first().getByTestId("open-document").focus();
      await window.keyboard.press("ControlOrMeta+i");
      const info = window.getByTestId("info-panel");
      await expect(info).toBeVisible();
      await expect
        .poll(() => info.evaluate((panel) => panel.contains(document.activeElement)))
        .toBe(true);

      // The read fails: the problem shows, and the focus stays in Document Info.
      await controlReads(app, "core:getTaggingModels", { settle: "reject" });
      await expect(card.getByTestId("setup-sorting-problem")).toContainText(
        translate(language, "setup.sorting.failed"),
      );
      await paints(window);
      await expect(info).toBeVisible();
      expect(await info.evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
      await expect(card.getByTestId("setup-sorting-problem-retry")).not.toBeFocused();
    } finally {
      await app.close();
      await rm(sources, { recursive: true, force: true });
    }
  });
}

const SERVICES = "core:listTranscriptionServices";
const OWN_KEY = "soniox-test-key";

/** Opens Settings on Meetings with the keyboard: its button is named in English only. */
async function settingsOnMeetings(window: Page): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+,");
  return showSettingsPage(window, "meetings");
}

async function closeSettingsDialog(window: Page): Promise<void> {
  await window.getByTestId("settings-close").click();
  await expect(window.getByTestId("settings")).toBeHidden();
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a key save that fails changes nothing, and the steps open when the reads held behind it end (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      // Settings › Meetings has read the list, and is closed with it kept.
      const first = await settingsOnMeetings(window);
      await expect(first.getByTestId("transcription-key-soniox")).toBeVisible();
      await closeSettingsDialog(window);

      // The model works, and the setup card's own read of the list is held.
      const card = await askFirstQuestion(window);
      await controlReads(app, SERVICES, { hold: 50 });
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      await expect.poll(() => controlReads(app, SERVICES, {})).toBeGreaterThanOrEqual(1);
      // Reading the list, the card says so rather than offering a key again; the steps wait.
      await expect(card.getByTestId("setup-services-reading")).toBeVisible();
      await expect(card.getByTestId("setup-step-transcription")).toHaveCount(0);

      // Meetings is opened again, its reads held too, and a key the service refuses is tried.
      const settings = await settingsOnMeetings(window);
      const row = settings.getByTestId("transcription-key-soniox");
      await row.getByTestId("transcription-key-add").click();
      const input = row.getByTestId("transcription-key-input");
      await input.fill("soniox-wrong-key");
      await input.press("Enter");
      await expect(row.getByTestId("transcription-key-problem")).toBeVisible();
      await expect.poll(() => controlReads(app, SERVICES, {})).toBeGreaterThanOrEqual(2);

      // Every read ends: the failed save changed nothing, so the steps open.
      await closeSettingsDialog(window);
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible();
      await expect(card.getByTestId("setup-services-problem")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(`a read that fails belongs to the view that asked: its problem and Try again stay until the User retries, whatever other reads do (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      // Settings › Meetings has read the list, and is closed with it kept.
      const first = await settingsOnMeetings(window);
      await expect(first.getByTestId("transcription-key-soniox")).toBeVisible();
      await closeSettingsDialog(window);

      // Meetings and Models are opened again: their two refresh reads are held, and Settings is
      // closed.
      await controlReads(app, SERVICES, { hold: 2 });
      await settingsOnMeetings(window);
      await showSettingsPage(window, "models");
      await expect.poll(() => controlReads(app, SERVICES, {})).toBe(2);
      await closeSettingsDialog(window);

      // The model works, and the setup card's own read, the only one that fails, fails.
      const card = await askFirstQuestion(window);
      await controlReads(app, SERVICES, { failNext: 1 });
      const field = card.getByTestId("setup-key");
      await field.fill(OPENAI_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      const problem = card.getByTestId("setup-services-problem");
      const retry = card.getByTestId("setup-services-problem-retry");
      await expect(problem).toBeVisible({ timeout: 15_000 });
      await expect(retry).toBeEnabled();
      // The card is above the composer, which stays usable (#2310).
      await expect(window.getByTestId("composer-input")).toBeVisible();

      // The two older reads land with the list: the card's problem is its own, and stays.
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await paints(window);
      await expect(problem).toBeVisible();
      await expect(card.getByTestId("setup-step-transcription")).toHaveCount(0);
      await expect(retry).toBeEnabled();
      await expect(window.getByTestId("composer-input")).toBeVisible();

      // The User retries: the card's read ends, and the steps open once.
      await pointAndClick(window, retry);
      await expect(card.getByTestId("setup-step-transcription")).toBeVisible();
      await expect(problem).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(`a view reads once for everything it shows, so its Try again brings back the line, the key rows and the alternatives together (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await window.evaluate(async (apiKey) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey });
        await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
      }, OWN_KEY);
      await dismissChatSetup(window);
      const offered = (scope: Locator) =>
        scope
          .getByTestId("meetings-route")
          .evaluate((select) => [...(select as HTMLSelectElement).options].map((o) => o.value));

      // Every read of the list fails as Settings opens: Meetings says so once, and offers only the
      // route that is saved, with no key rows.
      await controlReads(app, SERVICES, { failing: true });
      const dialog = await settingsOnMeetings(window);
      const meetings = dialog.getByTestId("meetings-settings");
      const problem = meetings.getByTestId("meetings-route-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      await expect(meetings.getByTestId("transcription-key-soniox")).toHaveCount(0);
      await expect.poll(() => offered(meetings)).toEqual(["local", "soniox"]);
      // Settings › Models reads for itself when it is first shown, and fails as well.
      const models = (await showSettingsPage(window, "models")).getByTestId("model-defaults");
      const modelsProblem = models.getByTestId("meetings-route-problem");
      await expect(modelsProblem).toBeVisible();
      await expect.poll(() => offered(models)).toEqual(["local", "soniox"]);
      await showSettingsPage(window, "meetings");

      // The core is back, and the one Try again brings back all of it.
      await controlReads(app, SERVICES, { failing: false });
      await pointAndClick(window, meetings.getByTestId("meetings-route-problem-retry"));
      await expect(problem).toHaveCount(0);
      await expect(meetings.getByTestId("meetings-route-line")).toContainText(
        translate(language, "meetings.route.cloudLine", { service: "Soniox" }),
      );
      await expect(
        meetings.getByTestId("transcription-key-soniox").getByTestId("transcription-key-saved"),
      ).toBeVisible();
      await expect.poll(() => offered(meetings)).toEqual(["local", "openai", "soniox"]);

      // Settings › Models read for itself, so its failure stands until it is tried again.
      await showSettingsPage(window, "models");
      await expect(modelsProblem).toBeVisible();
      await expect.poll(() => offered(models)).toEqual(["local", "soniox"]);
      await pointAndClick(window, models.getByTestId("meetings-route-problem-retry"));
      await expect(modelsProblem).toHaveCount(0);
      await expect.poll(() => offered(models)).toEqual(["local", "openai", "soniox"]);
    } finally {
      await app.close();
    }
  });

  test(`a key saved while newer reads come back without it shows as saved when the save lands (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const first = await settingsOnMeetings(window);
      const row = first.getByTestId("transcription-key-soniox");
      await row.getByTestId("transcription-key-add").click();
      await row.getByTestId("transcription-key-input").fill(OWN_KEY);

      // Save is pressed and held before the core has it; Meetings is closed and opened again, and
      // its newer reads say there is no key.
      await controlReads(app, "core:setTranscriptionKey", { hold: 1 });
      await row.getByTestId("transcription-key-save").click();
      await expect.poll(() => controlReads(app, "core:setTranscriptionKey", {})).toBe(1);
      await closeSettingsDialog(window);
      const again = await settingsOnMeetings(window);
      const reopened = again.getByTestId("transcription-key-soniox");
      await expect(reopened.getByTestId("transcription-key-add")).toBeVisible();
      await expect(reopened.getByTestId("transcription-key-saved")).toHaveCount(0);

      // The core keeps the key: the row says so, though the reads that came back are newer.
      await controlReads(app, "core:setTranscriptionKey", { settle: "resolve" });
      await expect(reopened.getByTestId("transcription-key-saved")).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test(`a key removed while newer reads still have it shows as removed when the removal lands (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await window.evaluate(async (apiKey) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey });
      }, OWN_KEY);
      const first = await settingsOnMeetings(window);
      const row = first.getByTestId("transcription-key-soniox");
      await expect(row.getByTestId("transcription-key-saved")).toBeVisible();

      // Remove is pressed and held before the core has it; Meetings is closed and opened again,
      // and its newer reads still have the key.
      await controlReads(app, "core:removeTranscriptionKey", { hold: 1 });
      await row.getByTestId("transcription-key-remove").click();
      await expect.poll(() => controlReads(app, "core:removeTranscriptionKey", {})).toBe(1);
      await closeSettingsDialog(window);
      const again = await settingsOnMeetings(window);
      const reopened = again.getByTestId("transcription-key-soniox");
      await expect(reopened.getByTestId("transcription-key-saved")).toBeVisible();

      // The core forgets the key: the row says so.
      await controlReads(app, "core:removeTranscriptionKey", { settle: "resolve" });
      await expect(reopened.getByTestId("transcription-key-saved")).toHaveCount(0);
      await expect(reopened.getByTestId("transcription-key-add")).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a read the core answered before a removal changes nothing when it arrives after it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await window.evaluate(async (apiKey) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey });
      }, OWN_KEY);
      const first = await settingsOnMeetings(window);
      await expect(
        first.getByTestId("transcription-key-soniox").getByTestId("transcription-key-saved"),
      ).toBeVisible();
      await closeSettingsDialog(window);

      // Meetings is opened again: the core answers its reads with the key, and they are held.
      await controlReads(app, SERVICES, { hold: 50, after: true });
      const again = await settingsOnMeetings(window);
      const row = again.getByTestId("transcription-key-soniox");
      await expect.poll(() => controlReads(app, SERVICES, {})).toBeGreaterThanOrEqual(1);
      await row.getByTestId("transcription-key-remove").click();
      await expect(row.getByTestId("transcription-key-add")).toBeVisible();
      await expect(row.getByTestId("transcription-key-saved")).toHaveCount(0);

      // The held answers, older than the removal, arrive: nothing changes.
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await paints(window);
      await expect(row.getByTestId("transcription-key-saved")).toHaveCount(0);
      await expect(row.getByTestId("transcription-key-add")).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a saved cloud choice, folded and reopened while the model list is read, says where it goes in every state it passes through, and nothing moves when the list lands (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await openSetupSteps(window);
      await expect(
        card
          .getByTestId("setup-step-transcription")
          .or(card.getByTestId("setup-step-sorting"))
          .first(),
      ).toBeVisible({ timeout: 15_000 });

      // Step 3 first: its choice, the AI model that works, is saved and the step folds to a line.
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await expect(card.getByTestId("models-sorting")).toBeEnabled({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));
      await expect(card.getByTestId("setup-step-sorting")).toHaveAttribute("data-done", "true");
      await expect.poll(async () => (await bridge(window).library()).classifier.kind).toBe("chat");

      // Opened again, the step is built before the core has said where the choice goes. Every
      // state it passes through, from that first one to the core's answer, says nothing and can't
      // be used, or says what the choice is: it goes to Anthropic, which the sends row says.
      await watchSortingStep(window);
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      const picked = card.getByTestId("models-sorting").locator("option:checked");
      await expect(picked).toHaveText(translate(language, "models.sorting.chat"), {
        timeout: 15_000,
      });
      const seen = await sortingStepsSeen(window);
      const model = "Claude Haiku 5.5";
      expect(seen.length, "no state of the reopened step was seen").toBeGreaterThan(1);
      const says = (line: string) =>
        line.includes(translate(language, "setup.sorting.chat", { model })) &&
        line.includes(translate(language, "setup.sorting.sends", { service: "Anthropic" }));
      for (const state of seen) {
        expect(state.line).not.toContain(translate(language, "setup.sorting.chatHere", { model }));
        expect(state.usable, "usable before the core has said where it goes").toBe(
          says(state.line),
        );
        expect(state.top).toBeCloseTo(seen[0]?.top ?? 0, 0);
        expect(state.height).toBeCloseTo(seen[0]?.height ?? 0, 0);
      }
      expect(says(seen.at(-1)?.line ?? "")).toBe(true);
    } finally {
      await app.close();
    }
  });

  for (const { modelId, shown, cloud } of OLLAMA_MODELS) {
    for (const chatDefault of ["the same", "another"] as const) {
      test(`a sorting choice on ${modelId}, ${cloud ? "a cloud model" : "a model on this computer"} of one Ollama server, with ${chatDefault} chat default, says what the core says of where it goes (${language})`, async () => {
        const { app, window } = await launchApp(dataDir, { fakeChat: true });
        try {
          await setWindowSize(app, window, 1280, 800);
          await acceptPlainTextKeys(window);
          await setLanguage(window, language);
          const card = await askFirstQuestion(window);
          await setLocalChatModel(window);
          await openSetupSteps(window);
          await expect(
            card
              .getByTestId("setup-step-transcription")
              .or(card.getByTestId("setup-step-sorting"))
              .first(),
          ).toBeVisible({ timeout: 15_000 });
          await saveSortingOnOllama(window, modelId);
          if (chatDefault === "the same") await saveOllamaDefault(window, modelId);
          else await saveOpenAiAsDefault(window);

          await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
          await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
          const words = await sortingWords(card);
          // The core's own answer: where the saved choice goes, and what it registers for tagging.
          const told = await window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const answer = (await core.getTaggingModels()).saved?.destination;
            const flows = await core.listRegisteredDataFlows();
            return {
              answer,
              registered: flows
                .find((flow) => flow.id === "tagging")
                ?.services.map((each) => each.flow.service.id),
            };
          });
          if (cloud) {
            if (told.answer?.kind !== "service") throw new Error("The core says nothing leaves.");
            expect(told.registered).toContain(told.answer.service.id);
            expect(words).toContain(
              translate(language, "setup.sorting.sends", { service: told.answer.service.name }),
            );
            expect(words).not.toContain(
              translate(language, "setup.sorting.chatHere", { model: shown }),
            );
          } else {
            expect(told.answer?.kind).toBe("here");
            expect(words).toContain(
              translate(language, "setup.sorting.chatHere", { model: shown }),
            );
            expect(words).not.toContain(
              translate(language, "setup.sorting.sends", { service: "" }),
            );
          }

          // Its provider is removed: the core can't say, so nothing is said and it can't be used.
          if (chatDefault === "another") {
            await removeOllama(window);
            await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
            await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
            await expect(card.getByTestId("setup-sorting-use")).toBeDisabled();
            expect(await sortingWords(card)).toBe("");
          }
        } finally {
          await app.close();
        }
      });
    }
  }

  test(`a saved cloud service, folded and reopened in step 2, still says where the audio goes (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await newMind(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-a-test-key" });
      });
      const card = await askFirstQuestion(window);
      await setLocalChatModel(window);
      await openSetupSteps(window);
      await expect(
        card
          .getByTestId("setup-step-transcription")
          .or(card.getByTestId("setup-step-sorting"))
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await card.getByTestId("setup-transcription").selectOption("soniox");
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));
      await expect(card.getByTestId("setup-step-transcription")).toHaveAttribute(
        "data-done",
        "true",
      );
      await expect
        .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
        .toBe("soniox");

      await pointAndClick(window, card.getByTestId("setup-step-transcription-open"));
      await expect(card.getByTestId("setup-transcription")).toHaveValue("soniox");
      await expect(card.getByTestId("setup-transcription-line")).toHaveText(
        translate(language, "meetings.route.cloudLine", { service: "Soniox" }),
      );
      await expect(card.getByTestId("setup-transcription-use")).toBeEnabled();
    } finally {
      await app.close();
    }
  });
}

test("with no key, the ChatGPT plan comes first, the Claude account second, and a model on this computer third", async () => {
  const openai = await createFakeOpenAI();
  const claude = await createFakeAnthropic();
  const ollama = await ollamaListing(["qwen3.5:4b"]);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    chatGpt: openai.endpoints.issuer,
    claude: claude.origin,
    ollama: ollama.url,
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("way-claude")).toBeVisible();
    const order = await card.evaluate((element) =>
      [
        ...element.querySelectorAll(
          '[data-testid="setup-chatgpt"], [data-testid="way-claude"], [data-testid="way-local"]',
        ),
      ].map((each) => each.getAttribute("data-testid")),
    );
    expect(order).toEqual(["setup-chatgpt", "way-claude", "way-local"]);

    // The plan's sign-in is the first choice, and it finishes first run as a key does.
    await pointAndClick(window, card.getByTestId("setup-chatgpt"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [authorize] = await urlsOpened(app);
    expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
    await window.getByTestId("chatgpt-welcome-ok").click();
    // The composer is back, and the steps left wait as a line above it (#2310).
    await expect(window.getByTestId("assistant-setup-line")).toBeVisible({ timeout: 15_000 });
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
  } finally {
    await app.close();
    await openai.close();
    await claude.close();
    await new Promise<void>((done) => ollama.server.close(() => done()));
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a silent model app settles to not heard from, never to missing, and Check again finds it (${language})`, async () => {
    // The app's probe gives up after two seconds and then asks again once; a server that holds
    // its answer, as a loaded computer's app may, is asked a second time only after the first
    // look ran out. Two silent looks settle the card: it says it wasn't heard from, offers no
    // Get, and keeps Check again, which finds the app once it answers.
    const waiting: (() => void)[] = [];
    let answers = false;
    let asked = 0;
    const server = createServer((request, response) => {
      request.resume();
      if (request.url !== "/api/tags") {
        response.writeHead(404);
        response.end();
        return;
      }
      asked += 1;
      const answer = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ name: "qwen3.5:4b", model: "qwen3.5:4b" }] }));
      };
      if (answers) answer();
      else waiting.push(answer);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      examples: true,
      ollama: `http://127.0.0.1:${port}`,
    });
    try {
      await setWindowSize(app, window, 1100, 900);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const way = card.getByTestId("way-local");
      const status = way.getByTestId("ollama-status");
      // The first frame, before anything has been looked at.
      await expect(status).toHaveAttribute("data-looking", "true");
      await expect(way).toContainText(translate(language, "providers.ollama.checking"));
      await expect(way).not.toContainText(translate(language, "setup.way.local.install"));
      await expect(way).not.toContainText(translate(language, "setup.way.local.notRunning"));
      await expect(card.getByTestId("ollama-get")).toHaveCount(0);

      // A second request is the first look given up on: the card still says it is looking.
      await expect.poll(() => asked, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      await expect(status).toHaveAttribute("data-looking", "true");
      await expect(way).toContainText(translate(language, "providers.ollama.checking"));
      await expect(card.getByTestId("ollama-get")).toHaveCount(0);

      // Both looks are silent: it settles, out of looking, saying it wasn't heard from — not
      // that the app is missing, so there is no Get, and Check again stays.
      await expect(status).not.toHaveAttribute("data-looking", "true", { timeout: 25_000 });
      await expect(status).toHaveAttribute("data-read", "no-answer");
      await expect(way).toContainText(translate(language, "providers.ollama.noAnswer"));
      await expect(way).not.toContainText(translate(language, "setup.way.local.install"));
      await expect(way).not.toContainText(translate(language, "setup.way.local.notRunning"));
      await expect(card.getByTestId("ollama-get")).toHaveCount(0);
      await expect(card.getByTestId("ollama-check-again")).toBeEnabled();

      // The app answers now: Check again finds it.
      answers = true;
      for (const answer of waiting.splice(0)) answer();
      await pointAndClick(window, card.getByTestId("ollama-check-again"));
      await expect(way).toContainText(translate(language, "setup.way.local.running"), {
        timeout: 15_000,
      });
    } finally {
      await app.close();
      server.close();
    }
  });
}

test("nothing at all: installing a model on this computer is offered, the example still opens, and Set up later gives the words back", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    examples: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    const card = await askFirstQuestion(window);
    // A refused address is an answer: it is not running, so Get is offered (a silent look
    // settles to not heard from instead, with Check again and no Get).
    await expect(card.getByTestId("ollama-status")).toHaveAttribute("data-read", "not-running");
    await expect(card.getByTestId("way-local")).toContainText("Install a model on this computer…");
    await expect(card.getByTestId("way-local")).toContainText("Needs the free Ollama app");
    await card.getByTestId("ollama-get").click();
    await expect.poll(() => urlsOpened(app)).toContain("https://ollama.com/download");

    // The example the app opens on is still there.
    await expect(window.getByTestId("mind-list-item").getByTestId("example-chip")).toBeVisible();

    await pointAndClick(window, card.getByTestId("setup-later"));
    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  } finally {
    await app.close();
  }
});

test("a refused key, a key with no credit and a key from a service we don’t list each say what to do in one line", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    const field = card.getByTestId("setup-key");

    await field.fill("sk-ant-a-key-that-is-refused");
    await field.press("Enter");
    await expect(card.getByTestId("setup-key-refused")).toHaveText(
      "The key was refused · Check the key",
    );

    await field.fill("sk-ant-a-key-with-no-credit");
    await field.press("Enter");
    const credit = card.getByTestId("setup-key-refused");
    await expect(credit).toHaveText("No credit on this key · Add credit · Use another key");
    await credit.getByTestId("setup-key-credit").click();
    expect((await urlsOpened(app))[0]).toBe("https://platform.claude.com/settings/billing");
    await credit.getByTestId("setup-key-another").click();
    await expect(field).toBeFocused();

    // A form no prefix names: one line, and the way on is to say which service it is.
    await field.fill("pk-live-a-key-from-a-service-we-dont-list");
    await field.press("Enter");
    await expect(card.getByTestId("setup-key-unrecognised")).toHaveText(
      "We don’t recognize this key’s service · Choose the service",
    );
    await pointAndClick(window, card.getByTestId("setup-key-choose-service"));
    await expect(card.getByTestId("provider-form")).toBeVisible();
    // The form opens on the service the key belongs to, its key kept.
    await expect(card.getByTestId("provider-form").locator('input[type="password"]')).toHaveValue(
      "pk-live-a-key-from-a-service-we-dont-list",
    );
  } finally {
    await app.close();
  }
});

test("each step is skippable: Set up when I record and Skip leave both settings as they were, in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "zh-CN");
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await openSetupSteps(window);
    await expect(
      card
        .getByTestId("setup-step-transcription")
        .or(card.getByTestId("setup-step-sorting"))
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    await expect(card.getByTestId("setup-step-transcription")).toContainText("会议转写");
    await expect(card.getByTestId("setup-step-sorting")).toContainText("整理和会议提示");
    await expect(card.getByTestId("setup-transcription-line")).toHaveText(
      "免费 · 不会离开这台电脑",
    );
    await pointAndClick(window, card.getByTestId("setup-transcription-later"));
    await expect(card.getByTestId("models-sorting")).toBeFocused();
    await pointAndClick(window, card.getByTestId("setup-sorting-skip"));
    await expect(card).toHaveCount(0);

    expect((await bridge(window).settings()).device.transcriptionRoute).toBeNull();
    expect((await bridge(window).library()).classifier).toEqual({ kind: "automatic" });
  } finally {
    await app.close();
  }
});

test("with no key and no AI model, the Example still opens and Set up later returns the words", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
  try {
    await setWindowSize(app, window, 900, 760);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("setup-chatgpt")).toBeVisible();
    await expect(window.getByTestId("mind-list-item").getByTestId("example-chip")).toBeVisible();
    await pointAndClick(window, card.getByTestId("setup-later"));
    await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  } finally {
    await app.close();
  }
});

test("Settings › Models shows the same three rows, editable in place, with Quick tasks and Reading images automatic", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLocalChatModel(window);
    await dismissChatSetup(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
      await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    });
    const settings = await openSettings(window, "models");

    await expect(settings.getByTestId("model-default-chatModel")).toBeVisible();
    await expect(settings.getByTestId("model-default-quickTasksModel")).toHaveCount(0);
    await expect(settings.getByTestId("model-default-imageModel")).toHaveCount(0);
    await expect(settings.getByTestId("models-follow-answers")).toHaveText(
      "Quick tasks and reading images are automatic.",
    );

    // Meeting transcription, changed where it is shown: one line tall, as a field in its row.
    const meetings = settings.getByTestId("meetings-route");
    await expect(meetings).toHaveValue("soniox");
    expect((await meetings.boundingBox())?.height ?? 0).toBeLessThan(48);
    await meetings.selectOption("local");
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("local");

    // What sorts, saved where it is shown: the select is the setting, one line tall.
    const sorting = settings.getByTestId("models-sorting");
    await expect(sorting.locator("option:checked")).toHaveText("Use your AI model");
    expect((await sorting.boundingBox())?.height ?? 0).toBeLessThan(48);
    await sorting.selectOption({ label: "Use your AI model" });
    await expect.poll(async () => (await bridge(window).library()).classifier.kind).toBe("chat");
  } finally {
    await app.close();
  }
});

test("with a Soniox key a cloud route is offered in step 2 and named as the consent; this computer stays chosen", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await newMind(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-a-test-key" });
    });
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await openSetupSteps(window);
    await expect(
      card
        .getByTestId("setup-step-transcription")
        .or(card.getByTestId("setup-step-sorting"))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    const route = card.getByTestId("setup-transcription");
    await expect(route).toHaveValue("local");
    await expect(route.locator("option")).toHaveText(["On this computer", "Soniox"]);
    // Choosing a cloud route is the consent, so its line is on screen first.
    await expect(card.getByTestId("meetings-route-consent")).toHaveText(
      "A cloud service gets the meeting’s audio while you record.",
    );
    await route.selectOption("soniox");
    await expect(card.getByTestId("setup-transcription-line")).toHaveText(
      "Audio goes to Soniox while you record",
    );
    await pointAndClick(window, card.getByTestId("setup-transcription-use"));
    await expect(card.getByTestId("setup-step-transcription")).toHaveAttribute("data-done", "true");
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("soniox");
  } finally {
    await app.close();
  }
});

test("Local mode offers only choices on this computer, in step 1 and in the steps after it", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setLocalOnly(true);
    });
    await expect(card.getByTestId("setup-local-mode")).toContainText(
      "Cloud models are off: “Keep everything on this computer”.",
    );
    await expect(card.getByTestId("setup-key")).toHaveCount(0);
    await expect(card.getByTestId("setup-chatgpt")).toHaveCount(0);
    await expect(card.getByTestId("way-local")).toBeVisible();

    await setLocalChatModel(window);
    await openSetupSteps(window);
    await expect(
      card
        .getByTestId("setup-step-transcription")
        .or(card.getByTestId("setup-step-sorting"))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("setup-transcription").locator("option")).toHaveText([
      "On this computer",
    ]);
    await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
    await expect(card.getByTestId("models-sorting").locator("option")).toHaveText([
      "Use your AI model",
    ]);
  } finally {
    await app.close();
  }
});

test("the card holds at 900 px and 1,600 px, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    for (const [width, height] of [
      [900, 700],
      [1600, 900],
    ] as const) {
      await setWindowSize(app, window, width, height);
      for (const language of ["en", "zh-CN"] as const) {
        await setLanguage(window, language);
        await dismissChatSetup(window);
        const card = await askFirstQuestion(window);
        const box = await card.boundingBox();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        expect(
          await window.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        await expect(card.getByTestId("setup-key")).toBeVisible();
        await expect(card.getByTestId("way-local")).toBeVisible();
        await pointAndClick(window, card.getByTestId("setup-later"));
        // Each language's own words, at the card's title.
        expect(await card.count()).toBe(0);
      }
    }
  } finally {
    await app.close();
  }
});

test("a Question waiting for a model is kept if the app quits before step 1 works", async () => {
  const first = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(first.app, first.window, 1100, 900);
  await acceptPlainTextKeys(first.window);
  await askFirstQuestion(first.window);
  await first.app.close();

  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await expect(window.getByTestId("home")).toBeVisible();
  await window.getByTestId("mind-tab").click();
  await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  await app.close();
});

test("when the model that worked goes, the card asks for one again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await openSetupSteps(window);
    await expect(
      card
        .getByTestId("setup-step-transcription")
        .or(card.getByTestId("setup-step-sorting"))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (const provider of await core.listChatProviders())
        await core.deleteChatProvider(provider.id);
    });
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Set up your AI");
    await expect(card.getByTestId("setup-key")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("call help with no model offers the key field where the help was asked, and the buttons come back once a model works", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "en");
    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
    await window.getByTestId("mind-editor").click();
    const needs = window.getByTestId("meeting-needs-model");
    await expect(needs).toBeVisible();
    await expect(needs.getByTestId("meeting-needs-model-key")).toBeVisible();
    await setLocalChatModel(window);
    await expect(window.getByTestId("meeting-starters")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("Compare Documents with no model offers the key field in place, and the comparison runs once a key works", async () => {
  const sources = await mkdtemp(join(tmpdir(), "incarnamind-1922-compare-"));
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    const corvane = join(sources, "Corvane.txt");
    const altmark = join(sources, "Altmark.txt");
    await writeFile(corvane, "Termination needs 90 days' notice.\n");
    await writeFile(altmark, "Termination needs 30 days' notice.\n");
    await addDocuments(window, [corvane, altmark]);

    await newMind(window);
    await window.keyboard.type("Shortlist: contract terms");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Two suppliers made the shortlist.");
    await window.keyboard.press("Enter");
    await window.keyboard.type("/compare");
    await expect(window.getByTestId("slash-item-compare")).toBeVisible();
    await window.keyboard.press("Enter");
    const sheet = window.getByTestId("compare-sheet");
    await expect(sheet.getByTestId("compare-sheet-question").first()).toBeFocused();
    await window.keyboard.type("Termination notice");
    await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));

    const needs = sheet.getByTestId("compare-sheet-needs-model");
    await expect(needs).toContainText(
      "Compare Documents needs an AI model. It sends the Documents you chose to the model you set up.",
    );
    const field = needs.getByTestId("compare-sheet-needs-model-key");
    await expect(field).toBeVisible();
    await field.fill(ANTHROPIC_KEY);
    await field.press("Enter");

    // The comparison goes on by itself once the key works.
    await expect(window.getByTestId("comparison-table")).toBeVisible({ timeout: 30_000 });
    await expect(sheet).toHaveCount(0);
  } finally {
    await app.close();
    await rm(sources, { recursive: true, force: true });
  }
});

// Choosing the model for Tags turns tagging on only where its line, saying what each new Document
// sends and to whom, is on screen before the choice (#2308, ADR-0022's amendment).
for (const language of ["en", "zh-CN"] as const) {
  test(`step 3 says what each new Document sends to Anthropic before Use this turns tagging on, and Skip leaves it off (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });

      const sends = translate(language, "setup.sorting.sends", { service: "Anthropic" });
      expect(await sortingWords(card)).toContain(sends);
      expect((await bridge(window).library()).automatic).toBe(false);

      await pointAndClick(window, card.getByTestId("setup-sorting-skip"));
      await expect(card.getByTestId("setup-step-sorting")).toHaveAttribute("data-done", "true");
      expect((await bridge(window).library()).automatic).toBe(false);

      await pointAndClick(window, card.getByTestId("setup-step-sorting-open"));
      await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
      expect(await sortingWords(card)).toContain(sends);
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));
      await expect.poll(async () => (await bridge(window).library()).automatic).toBe(true);
    } finally {
      await app.close();
    }
  });

  test(`Settings › Models' choice for sorting says what goes once tagging is on, and leaves the switch where it was (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveAnthropicAsDefault(window, "claude-haiku-5-5");
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const chosen = (await core.getSettings()).user.chatModel;
        const library = (await core.getLibrary()).settings;
        if (chosen)
          await core.saveLibrarySettings({
            ...library,
            classifier: { kind: "chat", choice: chosen },
          });
      });
      await saveOpenAiAsDefault(window);
      await dismissChatSetup(window);
      const settings = await openSettings(window, "models");
      await setLanguage(window, language);
      const select = settings.getByTestId("models-sorting");
      await expect(select.locator("option:checked")).toHaveText("Claude Haiku 5.5");
      expect(await sortingWords(settings)).toContain(
        translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }),
      );
      expect(await sortingWords(settings)).not.toContain(
        translate(language, "setup.sorting.sends", { service: "Anthropic" }),
      );
      expect((await bridge(window).library()).automatic).toBe(false);

      await select.selectOption({ label: translate(language, "models.sorting.chat") });
      await expect
        .poll(async () => (await bridge(window).library()).classifier)
        .toMatchObject({
          kind: "chat",
          choice: { modelId: "gpt-6-luna" },
        });
      expect((await bridge(window).library()).automatic).toBe(false);
    } finally {
      await app.close();
    }
  });
}

// With tagging new Documents off, a model chosen in Settings › Models tags nothing: the row says
// so, and Turn on… shows what goes before Use this turns it on (#2308).
for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › Models says tagging new Documents is off, and Turn on… shows what goes before turning it on (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveAnthropicAsDefault(window, "claude-haiku-5-5");
      await dismissChatSetup(window);
      await setLanguage(window, language);
      expect(
        await paletteOffers(
          window,
          "tagging.turnOn",
          translate(language, "command.tagging.turnOn"),
        ),
      ).toBe(1);
      // The button that opens Settings is named in English until the language is changed inside it.
      await setLanguage(window, "en");
      const settings = await openSettings(window, "models");
      await setLanguage(window, language);
      const row = settings.getByTestId("model-default-row-sorting");
      const off = row.getByTestId("models-tagging-off");
      await expect(off).toContainText(translate(language, "models.sorting.off"));
      const turnOn = row.getByTestId("models-tagging-turn-on");
      await expect(turnOn).toHaveText(translate(language, "models.sorting.turnOn"));

      // By keyboard from the choice, Turn on… is next.
      await row.getByTestId("models-sorting").focus();
      await window.keyboard.press("Tab");
      await expect(turnOn).toBeFocused();
      await window.keyboard.press("Enter");
      const consent = row.getByTestId("models-tagging-consent");
      const sends = translate(language, "setup.sorting.sends", { service: "Anthropic" });
      expect(await sortingWords(consent)).toContain(sends);
      expect((await bridge(window).library()).automatic).toBe(false);

      // Esc closes it, and nothing was turned on.
      await window.keyboard.press("Escape");
      await expect(consent).toHaveCount(0);
      await expect(settings).toBeVisible();
      expect((await bridge(window).library()).automatic).toBe(false);
      await expect(off).toBeVisible();

      // Use this, with the line on screen, turns it on, and the line that it's off goes.
      await pointAndClick(window, turnOn);
      expect(await sortingWords(consent)).toContain(sends);
      await pointAndClick(window, row.getByTestId("models-tagging-use"));
      await expect.poll(async () => (await bridge(window).library()).automatic).toBe(true);
      await expect(off).toHaveCount(0);
      await closeSettingsDialog(window);
      expect(
        await paletteOffers(
          window,
          "tagging.turnOn",
          translate(language, "command.tagging.turnOn"),
        ),
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  test(`⌘K's Turn on tagging opens the same line in Settings › Models, and Cancel leaves it off (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveAnthropicAsDefault(window, "claude-haiku-5-5");
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await runCommand(window, "tagging.turnOn", translate(language, "command.tagging.turnOn"));
      const consent = window.getByTestId("models-tagging-consent");
      await expect(consent).toBeVisible();
      await expect(window.getByTestId("models-tagging-use")).toBeFocused();
      expect(await sortingWords(consent)).toContain(
        translate(language, "setup.sorting.sends", { service: "Anthropic" }),
      );
      await pointAndClick(window, window.getByTestId("models-tagging-cancel"));
      await expect(consent).toHaveCount(0);
      expect((await bridge(window).library()).automatic).toBe(false);
    } finally {
      await app.close();
    }
  });
}
