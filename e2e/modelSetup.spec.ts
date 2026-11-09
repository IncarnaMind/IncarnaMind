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
  exampleRow,
  firstTranscriptLine,
  interceptOpenExternal,
  launchApp,
  newMind,
  ollamaListing,
  openSettings,
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
 * First run, to the first checked Answer (#1922): a pasted key named by its form and working at
 * once, or another way in. Each choice is the consent for its flow (ADR-0022). Meeting
 * transcription and sorting are set up where they are first used, not here.
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

test("a pasted key is named by its form and works at once: the waiting Question runs, and the composer is back with nothing more asked", async () => {
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
    // The Question that waited is asked at once, and the composer is back (#2310).
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
    await expect(window.getByTestId("composer-input")).toBeVisible();
    await expect(card).toHaveCount(0);

    // Nothing else was set up on the way: transcription and sorting are chosen where they are
    // first used, and tagging stays off until Turn on… (#2308).
    expect((await bridge(window).settings()).device.transcriptionRoute).toBeNull();
    const library = await bridge(window).library();
    expect(library.classifier.kind).toBe("automatic");
    expect(library.automatic).toBe(false);
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`after the first Answer the composer is there, ⌘J takes it and a follow-up is asked, with no setup step in the way (${language}, 1280 × 800) (#2310)`, async () => {
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

      // The setup no longer takes the composer's place, and nothing waits above it.
      const composer = window.getByTestId("composer-input");
      await expect(composer).toBeVisible();
      await expect(card).toHaveCount(0);

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
      await expect(composer).toBeVisible();
    } finally {
      await app.close();
    }
  });
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

/** What the sorting line shows to the User. */
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

        // Anthropic is removed with Settings open: sorting goes back to Automatic (#2693), and the
        // line names Automatic's pick, never the model that is gone.
        await removeAnthropic(window);
        await expect
          .poll(() => sortingWords(settings))
          .toContain(translate(language, "setup.sorting.sendsWhenOn", { service: "OpenAI" }));
        const after = await sortingWords(settings);
        expect(after).not.toContain(model);
        expect(after).not.toContain("Anthropic");
        const classifier = await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await core.getLibrary()).settings.classifier;
        });
        expect(classifier).toEqual({ kind: "automatic" });
      } finally {
        await app.close();
      }
    });
  }

  for (const { modelId, shown, cloud } of OLLAMA_MODELS) {
    for (const chatDefault of ["the same", "another"] as const) {
      test(`Settings › Models: a sorting choice on ${modelId}, ${cloud ? "a cloud model" : "a model on this computer"} of one Ollama server, with ${chatDefault} chat default, says what the core says of where it goes (${language})`, async () => {
        const { app, window } = await launchApp(dataDir, { fakeChat: true });
        try {
          await setWindowSize(app, window, 1280, 800);
          await acceptPlainTextKeys(window);
          await setLocalChatModel(window);
          await saveSortingOnOllama(window, modelId);
          if (chatDefault === "the same") await saveOllamaDefault(window, modelId);
          else await saveOpenAiAsDefault(window);
          await dismissChatSetup(window);
          // The button that opens Settings is named in English until the language is changed inside it.
          const settings = await openSettings(window, "models");
          await setLanguage(window, language);
          await expect(settings.getByTestId("models-sorting")).toBeEnabled();
          await expect.poll(() => sortingWords(settings)).not.toBe("");
          const words = await sortingWords(settings);
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
              translate(language, "setup.sorting.sendsWhenOn", {
                service: told.answer.service.name,
              }),
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
              translate(language, "setup.sorting.sendsWhenOn", { service: "" }),
            );
          }

          // Its provider is removed: sorting goes back to Automatic (#2693), and the line names
          // Automatic's pick, never the model that is gone.
          if (chatDefault === "another") {
            await removeOllama(window);
            await expect
              .poll(async () => (await bridge(window).library()).classifier.kind)
              .toBe("automatic");
            await expect
              .poll(() => sortingWords(settings))
              .toContain(translate(language, "setup.sorting.sendsWhenOn", { service: "OpenAI" }));
            expect(await sortingWords(settings)).not.toContain(shown);
          }
        } finally {
          await app.close();
        }
      });
    }
  }
}

// What Settings › Models reads to say what sorts: the core's models, with its answer for the
// saved choice. The core is the only thing it asks, so it is the one read that can fail.
const SORTING_READS = [
  { channel: "core:getTaggingModels", name: "the models that can sort", atFirst: true },
] as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const { channel, name, atFirst } of SORTING_READS) {
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
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
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
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );
      await expect(problem).toHaveCount(0);
    } finally {
      await app.close();
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

/** Opens Settings on Models with the keyboard, where Your providers keeps the transcription keys. */
async function settingsOnModels(window: Page): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+,");
  return showSettingsPage(window, "models");
}

const sonioxRow = (settings: Locator) =>
  settings.locator('[data-testid="transcription-key-row"][data-host="soniox"]');

async function closeSettingsDialog(window: Page): Promise<void> {
  await window.getByTestId("settings-close").click();
  await expect(window.getByTestId("settings")).toBeHidden();
}

test("Settings › Models offers a cloud route once a key is saved, says what choosing it sends before the choice, and this computer stays chosen until then", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLocalChatModel(window);
    await dismissChatSetup(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-a-test-key" });
    });
    const settings = await openSettings(window, "models");
    const route = settings
      .getByTestId("model-default-row-transcription")
      .getByTestId("meetings-route");
    await expect(route).toHaveValue("local");
    await expect
      .poll(() =>
        route.evaluate((select) =>
          [...select.children].flatMap((each) =>
            each instanceof HTMLOptionElement ? [each.textContent] : [],
          ),
        ),
      )
      .toEqual(["On this computer", "Soniox"]);
    // Choosing a cloud route is the consent, so its line is on screen first, and nothing is chosen.
    const consent = settings.getByTestId("meetings-route-consent");
    await expect(consent).toHaveText("A cloud service gets the meeting’s audio while you record.");
    expect((await bridge(window).settings()).device.transcriptionRoute).toBeNull();

    await route.selectOption("soniox");
    await expect(consent).toHaveText("Audio goes to Soniox while you record.");
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("soniox");
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`Try again keeps the focus as a retry fails again (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await dismissChatSetup(window);
      await controlReads(app, SERVICES, { failing: true });
      const meetings = (await settingsOnMeetings(window)).getByTestId("meetings-settings");
      const retry = meetings.getByTestId("meetings-route-problem-retry");
      await expect(retry).toBeVisible();

      // Focused, Try again disables itself while the retry runs, and that failing too gives it back
      // with the focus.
      await retry.focus();
      await controlReads(app, SERVICES, { failing: false, hold: 1 });
      await window.keyboard.press("Enter");
      await expect(retry).toBeDisabled();
      await controlReads(app, SERVICES, { settle: "reject" });
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      await expect(meetings.getByTestId("meetings-route-line")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(`a read that fails while the focus is elsewhere leaves it there, and the problem still shows (${language})`, async () => {
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

      // Settings › Models is open, and the User is on the meeting transcription row.
      const settings = await openSettings(window, "models");
      await setLanguage(window, language);
      await expect(settings.getByTestId("models-sorting")).toBeEnabled();
      const elsewhere = settings
        .getByTestId("model-default-row-transcription")
        .getByTestId("meetings-route");
      await elsewhere.focus();
      await expect(elsewhere).toBeFocused();

      // The sorting read is made again, as another model becomes the default, and fails: the
      // problem shows, and the focus stays where the User put it.
      await controlReads(app, "core:getTaggingModels", { failing: true });
      await saveOpenAiAsDefault(window);
      await expect(settings.getByTestId("models-sorting-problem")).toContainText(
        translate(language, "setup.sorting.failed"),
      );
      await paints(window);
      await expect(elsewhere).toBeFocused();
      await expect(settings.getByTestId("models-sorting-problem-retry")).not.toBeFocused();
    } finally {
      await app.close();
    }
  });

  test(`a read of the services that was overtaken changes nothing when it fails after a newer one has landed (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.updateSettings({ device: { transcriptionRoute: "openai" } });
      });
      await dismissChatSetup(window);

      // Meetings opens and its read, A, is held. Settings is closed and opened again, and the
      // read of this showing, B, lands. Then A fails, long after.
      await controlReads(app, SERVICES, { hold: 1 });
      await settingsOnMeetings(window);
      await closeSettingsDialog(window);
      const dialog = await settingsOnMeetings(window);
      const meetings = dialog.getByTestId("meetings-settings");
      const line = meetings.getByTestId("meetings-route-line");
      await expect(line).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );
      await paints(window);
      const before = await meetings.boundingBox();

      await controlReads(app, SERVICES, { settle: "reject" });
      await paints(window);
      // The newer read stands: its list is drawn, nothing says a read failed, and nothing moved.
      await expect(line).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );
      await expect(meetings.getByTestId("meetings-route-problem")).toHaveCount(0);
      expect(await meetings.boundingBox()).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test(`a failed read stays with the view that asked: older reads landing with the list change neither its problem nor its Try again (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await dismissChatSetup(window);

      // Meetings opens and its read is held. Settings goes to Models, whose own read is the one
      // that fails.
      await controlReads(app, SERVICES, { hold: 1 });
      const dialog = await settingsOnMeetings(window);
      await controlReads(app, SERVICES, { failNext: 1 });
      await showSettingsPage(window, "models");
      const models = dialog.getByTestId("model-defaults");
      const problem = models.getByTestId("meetings-route-problem");
      const retry = models.getByTestId("meetings-route-problem-retry");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      await expect(retry).toBeEnabled();

      // The older read lands with the list: the problem is the view's own, and stays.
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await paints(window);
      await expect(problem).toBeVisible();
      await expect(retry).toBeEnabled();

      // Try again reads for this view, and the problem goes.
      await pointAndClick(window, retry);
      await expect(problem).toHaveCount(0);
      await expect(models.getByTestId("meetings-route")).toBeEnabled();
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
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
      // The picker's own routes, without the services its foot sets up.
      const offered = (scope: Locator) =>
        scope
          .getByTestId("meetings-route")
          .evaluate((select) =>
            [...select.children].flatMap((each) =>
              each instanceof HTMLOptionElement ? [each.value] : [],
            ),
          );

      // Every read of the list fails as Settings opens: Meetings says so once, and offers only the
      // route that is saved.
      await controlReads(app, SERVICES, { failing: true });
      const dialog = await settingsOnMeetings(window);
      const meetings = dialog.getByTestId("meetings-settings");
      const problem = meetings.getByTestId("meetings-route-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      await expect.poll(() => offered(meetings)).toEqual(["local", "soniox"]);
      // Settings › Models reads once for its page when it is first shown, and fails as well: its
      // picker offers the saved route, and Your providers lists no transcription key.
      await showSettingsPage(window, "models");
      const models = dialog.getByTestId("model-defaults");
      const modelsProblem = models.getByTestId("meetings-route-problem");
      await expect(modelsProblem).toBeVisible();
      await expect.poll(() => offered(models)).toEqual(["local", "soniox"]);
      await expect(sonioxRow(dialog)).toHaveCount(0);
      await showSettingsPage(window, "meetings");

      // The core is back, and the one Try again brings back all of Meetings.
      await controlReads(app, SERVICES, { failing: false });
      await pointAndClick(window, meetings.getByTestId("meetings-route-problem-retry"));
      await expect(problem).toHaveCount(0);
      await expect(meetings.getByTestId("meetings-route-line")).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "Soniox" }),
      );
      await expect.poll(() => offered(meetings)).toEqual(["local", "openai", "soniox"]);

      // Settings › Models read for itself, so its failure stands until it is tried again; its
      // Try again brings back the picker and the key row together.
      await showSettingsPage(window, "models");
      await expect(modelsProblem).toBeVisible();
      await expect.poll(() => offered(models)).toEqual(["local", "soniox"]);
      await pointAndClick(window, models.getByTestId("meetings-route-problem-retry"));
      await expect(modelsProblem).toHaveCount(0);
      await expect.poll(() => offered(models)).toEqual(["local", "openai", "soniox"]);
      await expect(sonioxRow(dialog)).toBeVisible();
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
      const first = await settingsOnModels(window);
      await first
        .getByTestId("model-default-row-transcription")
        .getByTestId("meetings-route")
        .selectOption("set-up:soniox");
      const form = first.getByTestId("transcription-key-form-soniox");
      await form.getByTestId("transcription-key-input").fill(OWN_KEY);

      // Use this is pressed and held before the core has the key; Models is closed and opened
      // again, and its newer reads say there is no key.
      await controlReads(app, "core:setTranscriptionKey", { hold: 1 });
      await form.getByTestId("transcription-key-save").click();
      await expect.poll(() => controlReads(app, "core:setTranscriptionKey", {})).toBe(1);
      await closeSettingsDialog(window);
      const again = await settingsOnModels(window);
      await expect(again.getByTestId("your-providers")).toBeVisible();
      await expect(sonioxRow(again)).toHaveCount(0);

      // The core keeps the key: Your providers lists it, though the reads that came back are
      // newer. The form went with Settings, so nothing was chosen.
      await controlReads(app, "core:setTranscriptionKey", { settle: "resolve" });
      await expect(sonioxRow(again)).toBeVisible();
      await expect(
        again.getByTestId("model-default-row-transcription").getByTestId("meetings-route"),
      ).toHaveValue("local");
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
      const first = await settingsOnModels(window);
      await expect(sonioxRow(first)).toBeVisible();

      // Remove key is pressed and held before the core has it; Models is closed and opened
      // again, and its newer reads still have the key.
      await controlReads(app, "core:removeTranscriptionKey", { hold: 1 });
      await sonioxRow(first).getByTestId("transcription-key-remove").click();
      await expect.poll(() => controlReads(app, "core:removeTranscriptionKey", {})).toBe(1);
      await closeSettingsDialog(window);
      const again = await settingsOnModels(window);
      await expect(sonioxRow(again)).toBeVisible();

      // The core forgets the key: its row goes.
      await controlReads(app, "core:removeTranscriptionKey", { settle: "resolve" });
      await expect(sonioxRow(again)).toHaveCount(0);
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
      const first = await settingsOnModels(window);
      await expect(sonioxRow(first)).toBeVisible();
      await closeSettingsDialog(window);

      // Models is opened again: the core answers its reads with the key, and they are held.
      await controlReads(app, SERVICES, { hold: 50, after: true });
      const again = await settingsOnModels(window);
      const row = sonioxRow(again);
      await expect.poll(() => controlReads(app, SERVICES, {})).toBeGreaterThanOrEqual(1);
      await row.getByTestId("transcription-key-remove").click();
      await expect(row).toHaveCount(0);

      // The held answers, older than the removal, arrive: nothing changes.
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await paints(window);
      await expect(row).toHaveCount(0);
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
    // The composer is back (#2310).
    await expect(window.getByTestId("composer-input")).toBeVisible({ timeout: 15_000 });
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
    await expect(exampleRow(window)).toBeVisible();

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

test("with no key and no AI model, the Example still opens and Set up later returns the words", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
  try {
    await setWindowSize(app, window, 900, 760);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("setup-chatgpt")).toBeVisible();
    await expect(exampleRow(window)).toBeVisible();
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

test("Local mode offers only choices on this computer, in the setup card and in Settings › Models", async () => {
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
    await expect(card).toHaveCount(0);
    const settings = await openSettings(window, "models");
    await expect(settings.getByTestId("meetings-route").locator("option")).toHaveText([
      "On this computer",
    ]);
    await expect(settings.getByTestId("models-sorting").locator("option")).toHaveText([
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

test("a Question waiting for a model is kept if the app quits before a model works", async () => {
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
    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("composer-input")).toBeVisible();
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
    await expect(bar).toBeVisible();
    await firstTranscriptLine(window);
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
