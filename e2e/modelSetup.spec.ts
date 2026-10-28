import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { createFakeAnthropic } from "../tests/helpers/fakeAnthropic";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  ollamaListing,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
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

async function askFirstQuestion(window: Page): Promise<Locator> {
  await newMind(window);
  await window.getByTestId("mind-editor").focus();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is in my Documents?");
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await expect(card).toBeVisible();
  return card;
}

/** A key as a real one is shaped, for a stand-in provider: never a real key. */
const ANTHROPIC_KEY = "sk-ant-api03-a-test-key-for-first-run";

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
    await expect(card.getByTestId("setup-ready-title")).toHaveText("Anthropic works", {
      timeout: 15_000,
    });
    // The Question that waited is asked at once, while the two steps stay below its Answer.
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
    await expect(card.getByTestId("setup-step-transcription")).toBeVisible();

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
  } finally {
    await app.close();
  }
});

/** Where the card and its step in hand's buttons are, as the User's eye holds them. */
interface StepsFrame {
  step: string;
  card: Box;
  buttons: Box[];
  later: Box;
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
    const later = card?.querySelector('[data-testid="setup-later"]');
    const thread = document.querySelector('[data-testid="assistant-thread"]');
    if (!card || !open || !later || !thread) throw new Error("The steps aren't showing.");
    return {
      step: open.getAttribute("data-testid") ?? "",
      card: box(card),
      buttons: [...open.querySelectorAll("button")].map(box),
      later: box(later),
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
      const later = card?.querySelector('[data-testid="setup-later"]');
      const thread = document.querySelector('[data-testid="assistant-thread"]');
      if (card && open && later && thread) {
        record.frames.push({
          step: open.getAttribute("data-testid"),
          card: box(card),
          buttons: [...open.querySelectorAll("button")].map(box),
          later: box(later),
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
    const foot = card?.querySelector("[data-setup-foot]");
    const thread = document.querySelector('[data-testid="assistant-thread"]');
    if (!card || !open || !foot || !thread) throw new Error("The steps aren't showing.");
    const room = card.getBoundingClientRect();
    const under = foot.getBoundingClientRect().top;
    const outside = [...open.querySelectorAll("button")]
      .filter((button) => {
        const { top, bottom } = button.getBoundingClientRect();
        return top < room.top - 0.5 || bottom > room.bottom + 0.5 || bottom > under + 0.5;
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

/** Whether the "·" of a line of text and a link sits on the line where the text before it ends. */
function separatorFollowsText(window: Page, testId: string) {
  return window.evaluate((id) => {
    const text = document.querySelector(`[data-testid="${id}"] p`)?.firstChild;
    const dot = document.querySelector(`[data-testid="${id}"] [aria-hidden="true"]`);
    if (!text || !dot) throw new Error("The line isn't showing.");
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = [...range.getClientRects()];
    const last = lines[lines.length - 1];
    return last ? Math.abs(dot.getBoundingClientRect().top - last.top) < 3 : false;
  }, testId);
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

/** While on, every call of the core's `channel` fails, as a core that can't answer would. */
function failReads(app: ElectronApplication, channel: string, on: boolean): Promise<void> {
  return app.evaluate(
    ({ ipcMain }, { name, failing }) => {
      const store = globalThis as unknown as { failingReads?: Record<string, boolean> };
      const failures = store.failingReads ?? {};
      store.failingReads = failures;
      if (!(name in failures)) {
        const handlers = (
          ipcMain as unknown as {
            _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
          }
        )._invokeHandlers;
        const original = handlers.get(name);
        if (!original) throw new Error(`The ${name} handler is unavailable.`);
        ipcMain.removeHandler(name);
        ipcMain.handle(name, (event, ...args) => {
          if (failures[name]) throw new Error(`${name} is temporarily unavailable.`);
          return original(event, ...args);
        });
      }
      failures[name] = failing;
    },
    { name: channel, failing: on },
  );
}

// A model on this computer and a cloud model Ollama forwards to ollama.com, on one server.
const OLLAMA_MODELS = [
  { modelId: "qwen3.5:4b", cloud: false },
  { modelId: "gpt-oss:120b-cloud", cloud: true },
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
  test(`the line naming where the questions go never starts with its separator at 1280 × 800 (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(card.getByTestId("setup-ready-sends")).toBeVisible({ timeout: 15_000 });
      expect(await separatorFollowsText(window, "setup-ready-sends")).toBe(true);
    } finally {
      await app.close();
    }
  });
}

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
      await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });

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
      expect(spread(frames, (frame) => frame.later)).toBeLessThan(0.5);
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
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });

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
      await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });

      // The conversation keeps room, whatever the step needs.
      expect((await buttonsInView(window)).thread).toBeGreaterThanOrEqual(100);

      // Whether a part of the card shows between its title and its foot, which stay in view.
      const shows = (selector: string) =>
        window.evaluate((query) => {
          const card = document.querySelector('[data-testid="model-setup"]');
          const target = document.querySelector(query);
          const head = card?.querySelector("[data-setup-title]");
          const foot = card?.querySelector("[data-setup-foot]");
          if (!card || !target || !head || !foot) throw new Error("The steps aren't showing.");
          const { top, bottom } = target.getBoundingClientRect();
          const floor = Math.min(
            card.getBoundingClientRect().bottom,
            foot.getBoundingClientRect().top,
          );
          return top >= head.getBoundingClientRect().bottom - 0.5 && bottom <= floor + 0.5;
        }, selector);

      // Step 3 is taller than the room: the card scrolls, and the step opens with its title
      // and its choice in view; its buttons are a scroll away.
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
      await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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

      // Nothing moved: the card's edge, step 3's buttons and Set up later are where they were.
      expect(settled.card).toEqual(opened.card);
      expect(settled.buttons).toEqual(opened.buttons);
      expect(settled.later).toEqual(opened.later);
      // The words were there from the first paint, and only the list changed under them.
      expect(opened.line).toContain(
        translate(language, "setup.sorting.chat", { model: "qwen3.5:4b" }),
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
      const problem = card.getByTestId("setup-services-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"), {
        timeout: 15_000,
      });
      await expect(card.getByTestId("setup-ready-title")).toBeVisible();
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
  test(`when the read of the transcription services fails, the focus goes to Try again, and stays there as a retry fails again (${language})`, async () => {
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

      // The problem replaces the key field the focus was in: it takes the focus.
      const retry = card.getByTestId("setup-services-problem-retry");
      await expect(retry).toBeVisible({ timeout: 15_000 });
      await expect(retry).toBeFocused();

      // Enter retries, the second read fails too, and the focus is on Try again again.
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
        await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
          translate(language, "setup.sorting.sends", { service: "Anthropic" }),
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
        await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
      await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });

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

  for (const { modelId, cloud } of OLLAMA_MODELS) {
    for (const chatDefault of ["the same", "another"] as const) {
      test(`a sorting choice on ${modelId}, ${cloud ? "a cloud model" : "a model on this computer"} of one Ollama server, with ${chatDefault} chat default, says what the core says of where it goes (${language})`, async () => {
        const { app, window } = await launchApp(dataDir, { fakeChat: true });
        try {
          await setWindowSize(app, window, 1280, 800);
          await acceptPlainTextKeys(window);
          await setLanguage(window, language);
          const card = await askFirstQuestion(window);
          await setLocalChatModel(window);
          await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
              translate(language, "setup.sorting.chatHere", { model: modelId }),
            );
          } else {
            expect(told.answer?.kind).toBe("here");
            expect(words).toContain(
              translate(language, "setup.sorting.chatHere", { model: modelId }),
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
      await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });

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
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
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
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (const provider of await core.listChatProviders())
        await core.deleteChatProvider(provider.id);
    });
    await expect(window.getByTestId("setup-ready-title")).toHaveCount(0);
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
